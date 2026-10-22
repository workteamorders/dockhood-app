import { and, eq, sql } from 'drizzle-orm';
import { formatEther } from 'viem';
import { NATIVE_PAIR, type NetworkConfig } from '@hood/shared';
import { schema, type Db } from './db';
import type { EnvioClient } from './services/envio';
import { CALLOUTS_CHANNEL, type PubSub } from './services/pubsub';

/** Official-token trades (either side) at or above this many ETH raise a trade balloon on every open desktop. */
export const HEXE_MIN_ETH = 10_000_000_000_000_000n;
/** The same for hood.exe's theorem coins. Other Pons coins never do. */
export const HOOD_MIN_ETH = 50_000_000_000_000_000n;
/** Older trades move the cursor but aren't pushed, so a first run or a catch-up doesn't spray balloons. */
const LIVE_WINDOW_MS = 10 * 60_000;
/** GET /activity/recent looks back this far: enough for the first visit's balloon, which shows "N min ago". */
export const RECENT_WINDOW_S = 15 * 60;
const CURSOR = 'worker:activityBlock';

/** One trade as the desktop's balloon shows it. Not stored: it lives on the WebSocket and in /activity/recent. */
export type ActivityItem = {
  id: string;
  side: 'buy' | 'sell';
  token: string;
  ticker: string;
  trader: string;
  /** ETH, as a decimal string. */
  eth: string;
  /** Unix seconds. */
  time: number;
  txHash: string;
};

type Watched = { tiers: { tokens: string[]; minQuote: bigint }[]; tickers: Map<string, string> };

/** The official token and ETH-paired hood coins, with addresses as the token table (and indexer) store them. */
export async function watchedTokens(db: Db, network: NetworkConfig): Promise<Watched> {
  const official = network.officialToken?.address.toLowerCase();
  const rows = await db
    .select({ token: schema.tokens.tokenAddress, symbol: schema.tokens.symbol, hood: schema.tokens.hood })
    .from(schema.tokens)
    .where(
      and(
        eq(sql`lower(${schema.tokens.pairToken})`, NATIVE_PAIR.toLowerCase()),
        official ? sql`(${schema.tokens.hood} or lower(${schema.tokens.tokenAddress}) = ${official})` : eq(schema.tokens.hood, true),
      ),
    );
  const isOfficial = (a: string) => a.toLowerCase() === official;
  return {
    tiers: [
      { tokens: rows.filter((r) => isOfficial(r.token)).map((r) => r.token), minQuote: HEXE_MIN_ETH },
      { tokens: rows.filter((r) => r.hood && !isOfficial(r.token)).map((r) => r.token), minQuote: HOOD_MIN_ETH },
    ],
    tickers: new Map(rows.map((r) => [r.token.toLowerCase(), r.symbol])),
  };
}

type Trade = Awaited<ReturnType<EnvioClient['notableTrades']>>[number];

export const toActivity = (t: Trade, tickers: Map<string, string>): ActivityItem => ({
  id: t.id,
  side: t.isBuy ? 'buy' : 'sell',
  token: t.token,
  ticker: tickers.get(t.token.toLowerCase()) ?? '',
  trader: t.trader,
  eth: formatEther(t.quoteAmount),
  time: t.timestamp,
  txHash: t.txHash,
});

type Deps = { db: Db; pubsub: PubSub; envio: EnvioClient; network: NetworkConfig; now: () => Date; log?: (msg: string) => void };

/** One pass of the worker: new notable trades since the cursor, pushed live when recent. Returns how many were pushed. */
export async function activityTick({ db, pubsub, envio, network, now, log }: Deps): Promise<number> {
  const { tiers, tickers } = await watchedTokens(db, network);
  if (!tiers.some((t) => t.tokens.length)) return 0;
  const [cursor] = await db.select().from(schema.indexState).where(eq(schema.indexState.key, CURSOR)).limit(1);
  // First run: start at the indexer's head instead of replaying history.
  let after = cursor ? Number(cursor.value) : await envio.latestBlock();
  const trades = await envio.notableTrades(tiers, { afterBlock: after });
  let pushed = 0;
  for (const t of trades) {
    after = Math.max(after, t.blockNumber);
    if (now().getTime() - t.timestamp * 1000 >= LIVE_WINDOW_MS) continue;
    // The WebSocket relays everything on the callouts channel; clients tell activity apart by type.
    await pubsub.publish(CALLOUTS_CHANNEL, { type: 'activity', activity: toActivity(t, tickers) });
    pushed++;
  }
  await db
    .insert(schema.indexState)
    .values({ key: CURSOR, value: String(after) })
    .onConflictDoUpdate({ target: schema.indexState.key, set: { value: String(after) } });
  if (pushed) log?.(`pushed ${pushed} trade balloon(s)`);
  return pushed;
}
