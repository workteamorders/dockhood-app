import type { FastifyInstance } from 'fastify';
import { and, count, countDistinct, desc, eq, gt, gte, lt, or, sql } from 'drizzle-orm';
import { getAddress, isAddress, type Address } from 'viem';
import { z } from 'zod';
import { HttpError } from '../app';
import { CALLOUT_MAX, blocklistHit, cleanCalloutText } from '../services/moderation';
import { CALLOUTS_CHANNEL } from '../services/pubsub';
import { REACTION_KINDS, decodeCursor, encodeCursor, presentCallouts, reactionCounts, resolveTicker } from '../callouts';
import { schema } from '../db';
import { allow } from '../kv';

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(30),
  /** Older than this cursor (infinite scroll). */
  before: z.string().max(200).optional(),
  /** Newer than this cursor (the 8 s polling fallback). */
  after: z.string().max(200).optional(),
  token: z.string().refine((s) => isAddress(s, { strict: false }), 'Invalid token address.').optional(),
});

const postBody = z.object({
  text: z.string().max(2_000),
  tokenAddress: z
    .string()
    .refine((s) => isAddress(s, { strict: false }), 'Invalid token address.')
    .optional(),
});

const reactBody = z.object({ kind: z.enum(REACTION_KINDS) });
const nicknameBody = z.object({ nickname: z.string().regex(/^[a-z0-9_]{3,15}$/, 'Use 3–15 characters: a–z, 0–9 and _.') });

const NICKNAME_COOLDOWN_MS = 86_400_000;
/** A callout on a coin carries the poster's latest trade on it from this far back. */
const TRADE_WINDOW_S = 86_400;
/** Posting never waits longer than this on the indexer; past it the callout goes up without a trade. */
const TRADE_LOOKUP_MS = 3_000;

/** Callouts, reactions and nicknames (docs/BRIEF.md §5.5, §9, §10). */
export async function calloutRoutes(app: FastifyInstance) {
  const { db, kv, chain, moderator, pubsub, env, envio } = app.deps;

  /** The poster's own latest trade on the coin, from the indexer, so the link can't be made up. */
  async function latestTrade(wallet: string, token: string) {
    if (!envio) return null;
    const since = Math.floor(app.deps.now().getTime() / 1000) - TRADE_WINDOW_S;
    const timeout = new Promise<null>((resolve) => setTimeout(resolve, TRADE_LOOKUP_MS, null).unref());
    return Promise.race([envio.latestWalletTrade(getAddress(wallet), getAddress(token), since).catch(() => null), timeout]);
  }


  let stats: { at: number; value: { callouts: number; users: number } } | null = null;
  async function liveStats() {
    if (stats && Date.now() - stats.at < 10_000) return stats.value;
    const since = new Date(app.deps.now().getTime() - 86_400_000);
    const [row] = await db
      .select({ callouts: count(), users: countDistinct(sql`nullif(${schema.callouts.wallet}, '')`) })
      .from(schema.callouts)
      .where(and(eq(schema.callouts.hidden, false), gte(schema.callouts.createdAt, since)));
    stats = { at: Date.now(), value: { callouts: row.callouts, users: Number(row.users) } };
    return stats.value;
  }

  app.get('/callouts', async (req) => {
    const q = listQuery.parse(req.query);
    const before = q.before ? decodeCursor(q.before) : null;
    const after = q.after ? decodeCursor(q.after) : null;
    if ((q.before && !before) || (q.after && !after)) throw new HttpError(400, 'Invalid cursor.');

    const c = schema.callouts;
    const where = and(
      eq(c.hidden, false),
      q.token ? sql`lower(${c.tokenAddress}) = ${q.token.toLowerCase()}` : undefined,
      before ? or(lt(c.createdAt, before.createdAt), and(eq(c.createdAt, before.createdAt), lt(c.id, before.id))) : undefined,
      after ? or(gt(c.createdAt, after.createdAt), and(eq(c.createdAt, after.createdAt), gt(c.id, after.id))) : undefined,
    );
    const rows = await db.select().from(c).where(where).orderBy(desc(c.createdAt), desc(c.id)).limit(q.limit);
    const items = await presentCallouts(db, rows, { official: env.OFFICIAL_WALLETS, viewer: await app.sessionWallet(req) });
    return {
      items,
      /** Pass as `before` for the next older page; null at the end. */
      nextCursor: rows.length === q.limit ? encodeCursor(rows.at(-1)!) : null,
      /** Pass as `after` to poll for newer callouts. */
      newestCursor: rows[0] ? encodeCursor(rows[0]) : (q.after ?? null),
      live: await liveStats(),
    };
  });

  app.post('/callouts', { preHandler: app.requireSession }, async (req, reply) => {
    const wallet = req.wallet!;
    const body = postBody.parse(req.body);

    // §10 limits: 5/min and 60/day per wallet, 20/min per IP.
    const limited =
      !(await allow(kv, `callout:ip:${req.clientIp}`, 20, 60)) ||
      !(await allow(kv, `callout:w:${wallet}:m`, 5, 60)) ||
      !(await allow(kv, `callout:w:${wallet}:d`, 60, 86_400));
    if (limited) throw new HttpError(429, 'Slow down: up to 5 callouts a minute and 60 a day.');

    // §10 moderation, in order: strip URLs → length → blocklist → model (→ held hidden if it fails).
    const text = cleanCalloutText(body.text);
    if (!text) throw new HttpError(400, 'Say something (links are removed).');
    if (text.length > CALLOUT_MAX) throw new HttpError(400, `Keep callouts to ${CALLOUT_MAX} characters.`);
    if ((await chain.balance(wallet as Address)) === 0n) throw new HttpError(403, 'Hold some ETH on Robinhood Chain to post callouts.');

    let hiddenReason: string | null = null;
    const hit = blocklistHit(text, env.BLOCKLIST_EXTRA);
    if (hit) hiddenReason = 'blocklist';
    else {
      const verdict = await moderator.check(text);
      if (!verdict) hiddenReason = 'moderation_unavailable';
      else if (!verdict.allow) hiddenReason = `model: ${verdict.reason}`.slice(0, 80);
    }

    let link: { tokenAddress: string; ticker: string } | null = null;
    if (body.tokenAddress) {
      const [row] = await db
        .select({ tokenAddress: schema.tokens.tokenAddress, ticker: schema.tokens.symbol })
        .from(schema.tokens)
        .where(sql`lower(${schema.tokens.tokenAddress}) = ${body.tokenAddress.toLowerCase()}`)
        .limit(1);
      link = row ?? null;
    }
    link ??= await resolveTicker(db, text, env.network);
    const trade = link ? await latestTrade(wallet, link.tokenAddress) : null;

    const [row] = await db
      .insert(schema.callouts)
      .values({
        wallet,
        kind: 'user',
        text,
        tokenAddress: link?.tokenAddress ?? null,
        ticker: link?.ticker ?? null,
        hidden: hiddenReason != null,
        hiddenReason,
        txHash: trade?.txHash ?? null,
        txSide: trade ? (trade.isBuy ? 'buy' : 'sell') : null,
      })
      .returning();
    const [dto] = await presentCallouts(db, [row], { official: env.OFFICIAL_WALLETS });
    if (!row.hidden) {
      await pubsub.publish(CALLOUTS_CHANNEL, { type: 'callout', callout: dto });
      stats = null;
    }
    reply.code(201);
    // The poster learns it was held, not why: no help tuning around the filter.
    return { callout: dto, hidden: row.hidden };
  });

  app.post<{ Params: { id: string } }>('/callouts/:id/react', { preHandler: app.requireSession }, async (req) => {
    const wallet = req.wallet!;
    const { kind } = reactBody.parse(req.body);
    const id = req.params.id;
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, 'Invalid callout.');
    if (!(await allow(kv, `react:${wallet}`, 60, 60))) throw new HttpError(429, 'Slow down: up to 60 reactions a minute.');

    const [callout] = await db
      .select({ id: schema.callouts.id })
      .from(schema.callouts)
      .where(and(eq(schema.callouts.id, id), eq(schema.callouts.hidden, false)))
      .limit(1);
    if (!callout) throw new HttpError(404, 'That callout is gone.');

    const r = schema.reactions;
    const deleted = await db
      .delete(r)
      .where(and(eq(r.calloutId, id), eq(r.wallet, wallet), eq(r.kind, kind)))
      .returning({ kind: r.kind });
    if (!deleted.length) await db.insert(r).values({ calloutId: id, wallet, kind }).onConflictDoNothing();

    const reactions = (await reactionCounts(db, [id])).get(id)!;
    await pubsub.publish(CALLOUTS_CHANNEL, { type: 'reactions', id, reactions });
    return { id, reactions, reacted: !deleted.length };
  });

  app.put('/profile', { preHandler: app.requireSession }, async (req) => {
    const wallet = req.wallet!;
    const { nickname } = nicknameBody.parse(req.body);
    const [profile] = await db.select().from(schema.profiles).where(eq(schema.profiles.wallet, wallet)).limit(1);
    if (profile?.nickname === nickname) return { wallet, nickname };
    const now = app.deps.now();
    if (profile?.nicknameChangedAt && now.getTime() - profile.nicknameChangedAt.getTime() < NICKNAME_COOLDOWN_MS) {
      throw new HttpError(429, 'You can change your nickname once every 24 hours.');
    }
    const [taken] = await db.select({ wallet: schema.profiles.wallet }).from(schema.profiles).where(eq(schema.profiles.nickname, nickname)).limit(1);
    if (taken && taken.wallet !== wallet) throw new HttpError(409, 'That nickname is taken.');
    await db
      .insert(schema.profiles)
      .values({ wallet, nickname, nicknameChangedAt: now })
      .onConflictDoUpdate({ target: schema.profiles.wallet, set: { nickname, nicknameChangedAt: now } });
    return { wallet, nickname };
  });

  app.get<{ Params: { wallet: string } }>('/profile/:wallet', async (req) => {
    if (!isAddress(req.params.wallet, { strict: false })) throw new HttpError(400, 'Invalid wallet.');
    const wallet = getAddress(req.params.wallet);
    const [profile] = await db.select().from(schema.profiles).where(eq(schema.profiles.wallet, wallet)).limit(1);
    return { wallet, nickname: profile?.nickname ?? null, official: env.OFFICIAL_WALLETS.some((w) => w.toLowerCase() === wallet.toLowerCase()) };
  });
}
