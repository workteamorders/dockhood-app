import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { NetworkConfig } from '@hood/shared';
import { schema, type Db } from './db';

export const REACTION_KINDS = ['rocket', 'eyes', 'skull'] as const;
export type ReactionKind = (typeof REACTION_KINDS)[number];
export type Reactions = Record<ReactionKind, number>;

/** docs/BRIEF.md §5.5 `Callout`, plus `mine` (the viewer's own reactions) when signed in. */
export type CalloutDto = {
  id: string;
  wallet: string;
  nickname?: string;
  tokenAddress: string | null;
  ticker: string | null;
  text: string;
  kind: 'user' | 'system';
  createdAt: string;
  reactions: Reactions;
  official?: boolean;
  verified?: boolean;
  mine?: ReactionKind[];
  txHash?: string;
  txSide?: 'buy' | 'sell';
};

type CalloutRow = typeof schema.callouts.$inferSelect;

/** Keyset cursor over (created_at, id), newest first. */
export const encodeCursor = (row: { createdAt: Date; id: string }) => Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url');

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const createdAt = new Date(iso ?? '');
  if (!id || Number.isNaN(createdAt.getTime()) || !/^[0-9a-f-]{36}$/.test(id)) return null;
  return { createdAt, id };
}

/**
 * `$TICKER` links only to indexed tokens. The official alias is reserved for its configured address;
 * other collisions prefer a hood.exe launch, else the most recent (docs/BRIEF.md §5.5).
 */
export async function resolveTicker(db: Db, text: string, network: NetworkConfig): Promise<{ tokenAddress: string; ticker: string } | null> {
  const match = /\$([A-Za-z0-9]{2,16})\b/.exec(text);
  if (!match) return null;
  const official = network.officialToken;
  const alias = official && match[1].toUpperCase() === official.ticker;
  const [row] = await db
    .select({ tokenAddress: schema.tokens.tokenAddress, ticker: schema.tokens.symbol })
    .from(schema.tokens)
    .where(alias ? sql`lower(${schema.tokens.tokenAddress}) = ${official.address.toLowerCase()}` : sql`upper(${schema.tokens.symbol}) = ${match[1].toUpperCase()}`)
    .orderBy(desc(schema.tokens.hood), desc(schema.tokens.blockNumber))
    .limit(1);
  return row ? { ...row, ticker: alias ? official.ticker : row.ticker } : null;
}

export async function reactionCounts(db: Db, ids: string[]): Promise<Map<string, Reactions>> {
  const out = new Map<string, Reactions>(ids.map((id) => [id, { rocket: 0, eyes: 0, skull: 0 }]));
  if (!ids.length) return out;
  const rows = await db
    .select({ id: schema.reactions.calloutId, kind: schema.reactions.kind, n: sql<number>`count(*)::int` })
    .from(schema.reactions)
    .where(inArray(schema.reactions.calloutId, ids))
    .groupBy(schema.reactions.calloutId, schema.reactions.kind);
  for (const r of rows) out.get(r.id)![r.kind] = r.n;
  return out;
}

/** Turns rows into DTOs: reaction counts, nicknames, official (env list) and verified flags. */
export async function presentCallouts(db: Db, rows: CalloutRow[], opts: { official: readonly string[]; viewer?: string | null }): Promise<CalloutDto[]> {
  const ids = rows.map((r) => r.id);
  const wallets = [...new Set(rows.filter((r) => r.kind === 'user').map((r) => r.wallet))];
  const official = new Set(opts.official.map((w) => w.toLowerCase()));

  const [counts, profiles, graduated, mine] = await Promise.all([
    reactionCounts(db, ids),
    wallets.length ? db.select().from(schema.profiles).where(inArray(schema.profiles.wallet, wallets)) : Promise.resolve([]),
    // Verified without Bix's flag: launched a hood.exe coin that reached its Uniswap pool.
    wallets.length
      ? db
          .selectDistinct({ wallet: schema.tokens.deployer })
          .from(schema.tokens)
          .where(and(inArray(schema.tokens.deployer, wallets), eq(schema.tokens.hood, true), gte(schema.tokens.phase, 2)))
      : Promise.resolve([]),
    opts.viewer && ids.length
      ? db
          .select({ id: schema.reactions.calloutId, kind: schema.reactions.kind })
          .from(schema.reactions)
          .where(and(inArray(schema.reactions.calloutId, ids), eq(schema.reactions.wallet, opts.viewer)))
      : Promise.resolve([]),
  ]);
  const profileBy = new Map(profiles.map((p) => [p.wallet, p]));
  const graduatedBy = new Set(graduated.map((g) => g.wallet));

  return rows.map((r) => {
    const p = profileBy.get(r.wallet);
    const dto: CalloutDto = {
      id: r.id,
      wallet: r.kind === 'system' ? 'hood.exe' : r.wallet,
      tokenAddress: r.tokenAddress,
      ticker: r.ticker,
      text: r.text,
      kind: r.kind,
      createdAt: r.createdAt.toISOString(),
      reactions: counts.get(r.id)!,
    };
    if (p?.nickname) dto.nickname = p.nickname;
    if (r.kind === 'system' || official.has(r.wallet.toLowerCase())) dto.official = true;
    if (r.kind === 'user' && (p?.verified || graduatedBy.has(r.wallet))) dto.verified = true;
    if (opts.viewer) dto.mine = mine.filter((m) => m.id === r.id).map((m) => m.kind);
    if (r.txHash) dto.txHash = r.txHash;
    if (r.txSide) dto.txSide = r.txSide;
    return dto;
  });
}

/** Writes a system callout once per source event; returns null if that event was already posted. */
export async function insertSystemCallout(
  db: Db,
  c: { sourceKey: string; text: string; tokenAddress: string | null; ticker: string | null; createdAt?: Date; txHash?: string | null; txSide?: 'buy' | 'sell' },
): Promise<CalloutRow | null> {
  const [row] = await db
    .insert(schema.callouts)
    .values({ wallet: '', kind: 'system', text: c.text, tokenAddress: c.tokenAddress, ticker: c.ticker, sourceKey: c.sourceKey, createdAt: c.createdAt, txHash: c.txHash, txSide: c.txSide })
    .onConflictDoNothing({ target: schema.callouts.sourceKey })
    .returning();
  return row ?? null;
}
