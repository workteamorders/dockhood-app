import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import { MAX_RANKED_MOVES, replayRanked } from '@hood/shared/minesweeper';
import { MAX_SOLITAIRE_MOVES, replaySolitaire } from '@hood/shared/solitaire';
import { HttpError } from '../app';
import { schema } from '../db';
import { allow } from '../kv';

type Run = typeof schema.gameRuns.$inferSelect;
type Game = Run['game'];
type Level = Run['level'];

const sweepMove = z.union([z.tuple([z.enum(['r', 'f', 'c']), z.number().int(), z.number().int()]), z.tuple([z.literal('m'), z.union([z.literal(0), z.literal(1)])])]);
const solitaireMove = z.union([z.tuple([z.literal('d')]), z.tuple([z.literal('m'), z.string().max(3), z.number().int(), z.string().max(3)])]);

/**
 * Each ranked game: its levels (the first is the default), how long a run may take, and the check that a submitted
 * game really won the board the run's seed deals.
 */
const GAMES: Record<Game, { levels: readonly Level[]; ttlMs: number; won: (run: Run, body: unknown) => boolean }> = {
  minesweeper: {
    levels: ['beginner', 'intermediate', 'expert'],
    ttlMs: 60 * 60_000,
    won: (run, body) => {
      const { marks, moves } = z.object({ marks: z.boolean(), moves: z.array(sweepMove).min(1).max(MAX_RANKED_MOVES) }).parse(body);
      return replayRanked(run.level as 'beginner' | 'intermediate' | 'expert', run.seed, marks, moves).status === 'won';
    },
  },
  solitaire: {
    levels: ['klondike'],
    ttlMs: 2 * 60 * 60_000,
    won: (run, body) => {
      const { moves } = z.object({ moves: z.array(solitaireMove).min(1).max(MAX_SOLITAIRE_MOVES) }).parse(body);
      return replaySolitaire(run.seed, moves).status === 'won';
    },
  },
};

const gameParam = z.enum(['minesweeper', 'solitaire']);
const TOP = 20;
const CACHE_MS = 10_000;

function levelOf(game: Game, raw: unknown): Level {
  const levels = GAMES[game].levels;
  return z.enum(levels as [Level, ...Level[]]).default(levels[0]).parse(raw);
}

/** Midnight UTC that starts the day `now` falls in, and the next one: a leaderboard day. */
function utcDay(now: Date): { start: Date; end: Date; label: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start, end: new Date(start.getTime() + 86_400_000), label: start.toISOString().slice(0, 10) };
}

type Entry = { rank: number; wallet: string; nickname: string | null; timeMs: number; holder: boolean };

/**
 * Daily leaderboards for Minesweeper (Beginner, Intermediate, Expert) and Solitaire; days run midnight to midnight
 * UTC. POST /games/:game/start deals a seed and starts the server's clock, POST /games/:game/:id/finish replays
 * the moves and records the time if they won, GET /leaderboard/:game reads today's best per wallet.
 */
export async function gameRoutes(app: FastifyInstance) {
  const { db, kv, chain, now, env: { network } } = app.deps;
  const runs = schema.gameRuns;

  /** Today's best run per wallet on a board, fastest first; the earlier finish wins a tie. */
  async function standings(game: Game, level: Level): Promise<Entry[]> {
    const day = utcDay(now());
    const best = await db
      .selectDistinctOn([runs.wallet], { wallet: runs.wallet, timeMs: runs.timeMs, holder: runs.holder, finishedAt: runs.finishedAt })
      .from(runs)
      .where(and(eq(runs.game, game), eq(runs.level, level), isNotNull(runs.timeMs), gte(runs.finishedAt, day.start), lt(runs.finishedAt, day.end)))
      .orderBy(runs.wallet, asc(runs.timeMs), asc(runs.finishedAt));
    best.sort((a, b) => a.timeMs! - b.timeMs! || a.finishedAt!.getTime() - b.finishedAt!.getTime());
    const names = best.length
      ? new Map(
          (await db.select({ wallet: schema.profiles.wallet, nickname: schema.profiles.nickname }).from(schema.profiles).where(inArray(schema.profiles.wallet, best.map((b) => b.wallet)))).map((p) => [
            p.wallet,
            p.nickname,
          ]),
        )
      : new Map<string, string | null>();
    return best.map((b, i) => ({ rank: i + 1, wallet: b.wallet, nickname: names.get(b.wallet) ?? null, timeMs: b.timeMs!, holder: b.holder }));
  }

  // One read per board shared by every visitor for 10 s; a new win on that board clears it.
  const cache = new Map<string, { at: number; day: string; entries: Entry[] }>();
  async function cachedStandings(game: Game, level: Level) {
    const key = `${game}:${level}`;
    const day = utcDay(now()).label;
    const hit = cache.get(key);
    if (hit && hit.day === day && Date.now() - hit.at < CACHE_MS) return hit.entries;
    const entries = await standings(game, level);
    cache.set(key, { at: Date.now(), day, entries });
    return entries;
  }

  app.post<{ Params: { game: string } }>('/games/:game/start', { preHandler: app.requireSession }, async (req) => {
    const wallet = req.wallet!;
    const game = gameParam.parse(req.params.game);
    const level = levelOf(game, (req.body as { level?: unknown } | undefined)?.level);
    if (!(await allow(kv, `game-start:${wallet}`, 30, 60))) throw new HttpError(429, 'Slow down: up to 30 ranked games a minute.');
    const at = now();
    // Abandoned runs (lost, or the tab closed) are no use after a day.
    await db.delete(runs).where(and(eq(runs.wallet, wallet), isNull(runs.finishedAt), lt(runs.startedAt, new Date(at.getTime() - 86_400_000))));
    const [run] = await db.insert(runs).values({ wallet, game, level, seed: randomInt(0, 2 ** 31), startedAt: at }).returning({ id: runs.id, seed: runs.seed });
    return run;
  });

  app.post<{ Params: { game: string; id: string } }>('/games/:game/:id/finish', { preHandler: app.requireSession }, async (req) => {
    const wallet = req.wallet!;
    const game = gameParam.parse(req.params.game);
    const at = now();
    const id = z.uuid().safeParse(req.params.id);
    if (!id.success) throw new HttpError(404, 'No such ranked game.');
    const [run] = await db.select().from(runs).where(and(eq(runs.id, id.data), eq(runs.wallet, wallet), eq(runs.game, game))).limit(1);
    if (!run) throw new HttpError(404, 'No such ranked game.');
    if (run.finishedAt) throw new HttpError(409, 'This game was already submitted.');
    const rules = GAMES[game];
    // A malformed body is a 400 before the run is used up, so a client bug doesn't cost the player the game.
    const won = rules.won(run, req.body);
    const elapsed = at.getTime() - run.startedAt.getTime();
    // Claim the run before the slow parts, so two submissions can't both count.
    const claimed = await db.update(runs).set({ finishedAt: at }).where(and(eq(runs.id, run.id), isNull(runs.finishedAt))).returning({ id: runs.id });
    if (!claimed.length) throw new HttpError(409, 'This game was already submitted.');
    if (elapsed > rules.ttlMs) throw new HttpError(410, `Ranked games have to be finished within ${rules.ttlMs / 3_600_000} hour${rules.ttlMs > 3_600_000 ? 's' : ''}.`);
    if (!won) throw new HttpError(422, "Those moves don't win this game.");

    const official = network.officialToken?.address;
    const holder = official
      ? await chain.tokenBalances(wallet, [official]).then((m) => (m.get(official) ?? 0n) > 0n).catch(() => false)
      : false;
    await db.update(runs).set({ timeMs: elapsed, holder }).where(eq(runs.id, run.id));
    cache.delete(`${game}:${run.level}`);

    const entries = await cachedStandings(game, run.level);
    const mine = entries.find((e) => e.wallet === wallet);
    return { level: run.level, timeMs: elapsed, best: mine?.timeMs ?? elapsed, rank: mine?.rank ?? null, players: entries.length };
  });

  app.get<{ Params: { game: string } }>('/leaderboard/:game', async (req) => {
    const game = gameParam.parse(req.params.game);
    const level = levelOf(game, (req.query as { level?: unknown }).level);
    const entries = await cachedStandings(game, level);
    const wallet = await app.sessionWallet(req);
    const you = wallet ? (entries.find((e) => e.wallet === wallet) ?? null) : null;
    return { level, day: utcDay(now()).label, players: entries.length, entries: entries.slice(0, TOP), you };
  });
}
