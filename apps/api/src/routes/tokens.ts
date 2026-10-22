import type { FastifyInstance } from 'fastify';
import { and, asc, count, desc, eq, or, sql, type SQL } from 'drizzle-orm';
import { formatUnits, isAddress } from 'viem';
import { z } from 'zod';
import { PONS_TOTAL_SUPPLY, type NetworkConfig } from '@hood/shared';
import { HttpError } from '../app';
import { schema, type Db } from '../db';
import type { EnvioCandle } from '../services/envio';

const CACHE_MS = 10_000;

const query = z.object({
  tab: z.enum(['all', 'hood']).default('all'),
  sort: z.enum(['latest', 'volume', 'mcap', 'rigor']).default('latest'),
  limit: z.coerce.number().int().min(1).max(60).default(36),
  offset: z.coerce.number().int().min(0).max(5_000).default(0),
  /** Ticker (prefix, optional $), name (substring) or contract address (exact). */
  q: z.string().trim().max(64).optional(),
});

/** LIKE pattern text with its wildcards escaped. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Explore's search: the WHERE clause, and the ordering that puts an exact ticker match first. */
function searchFilter(raw: string | undefined, network: NetworkConfig): { where?: SQL; first?: SQL } {
  const text = raw?.replace(/^\$/, '').trim().toLowerCase();
  if (!text) return {};
  if (isAddress(text, { strict: false })) return { where: sql`lower(${schema.tokens.tokenAddress}) = ${text}` };
  const symbol = sql`lower(${schema.tokens.symbol})`;
  const like = likeEscape(text);
  const official = network.officialToken;
  const alias = official?.ticker.toLowerCase().startsWith(text)
    ? sql`lower(${schema.tokens.tokenAddress}) = ${official.address.toLowerCase()}`
    : undefined;
  if (alias && text === official?.ticker.toLowerCase()) return { where: alias };
  return {
    where: or(alias, sql`${symbol} like ${`${like}%`}`, sql`lower(${schema.tokens.name}) like ${`%${like}%`}`),
    first: alias ? sql`case when ${alias} then 2 when ${symbol} = ${text} then 1 else 0 end desc` : sql`(${symbol} = ${text}) desc`,
  };
}

/** Chart intervals (docs/BRIEF.md §5.4). 15m is built from 5m candles; the indexer stores the rest. */
export const CHART_INTERVALS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3_600, '1d': 86_400 } as const;

const candleQuery = z.object({
  interval: z.enum(Object.keys(CHART_INTERVALS) as [keyof typeof CHART_INTERVALS]).default('5m'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const tradeQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(50) });

type TokenRow = typeof schema.tokens.$inferSelect;

const units = (raw: bigint | string | null, decimals: number | null) => (raw == null || decimals == null ? null : Number(formatUnits(BigInt(raw), decimals)));

/**
 * Display numbers in pair-asset units. Prices are floats on purpose: they are only shown, never used to
 * build a transaction (trades quote from live reserves with packages/shared/quote.ts).
 */
export function toItem(row: TokenRow, network: NetworkConfig) {
  const pair = network.findPair(row.pairToken);
  const decimals = pair?.decimals ?? null;
  const onCurve = row.phase === 0 && row.quoteReserve != null && row.tokenReserve != null && BigInt(row.tokenReserve) > 0n;
  const price = onCurve && decimals != null ? units(row.quoteReserve, decimals)! / units(row.tokenReserve, 18)! : null;
  const threshold = BigInt(row.graduationThreshold);
  const raised = row.realQuoteReserve != null ? BigInt(row.realQuoteReserve) : null;
  return {
    token: row.tokenAddress,
    curve: row.curveAddress,
    name: row.name,
    symbol: row.symbol,
    logo: row.logo,
    pair: { address: row.pairToken, symbol: pair?.symbol ?? '?', decimals },
    hood: row.hood,
    statement: row.statement,
    /** First line of a non-hood.exe coin's description, for the card. Untrusted text. */
    blurb: row.hood ? null : (row.description.split('\n')[0] ?? '').slice(0, 140),
    /** Formally verified coins are Σ 100 (brief §1.3); others keep their AI estimate. */
    rigorScore: row.formal ? 100 : row.rigorScore,
    /** FORMAL ✓: a Lean proof passed the checker and the review, and the pool marked it on-chain. */
    formal: row.formal,
    phase: row.phase,
    /** Pair asset per token. */
    price,
    marketCap: price != null ? price * Number(PONS_TOTAL_SUPPLY) : null,
    /** Share of the graduation threshold raised, 0–1; 1 once the curve is done. */
    progress: row.phase > 0 ? 1 : raised != null && threshold > 0n ? Math.min(1, Number((raised * 10_000n) / threshold) / 10_000) : null,
    /** Pair asset traded over ~24 h; null without the indexer. */
    volume24h: units(row.volume24h, decimals),
    trades24h: row.trades24h,
    launchedAt: row.launchedAt.toISOString(),
    stateUpdatedAt: row.stateUpdatedAt?.toISOString() ?? null,
  };
}

export type TokenItem = ReturnType<typeof toItem>;

/** Indexer prices are raw quote units per raw token unit; this is pair asset per whole token. */
export const toPairPrice = (raw: string, pairDecimals: number | null) => pairDecimals == null ? null : Number(raw) * 10 ** (18 - pairDecimals);

/** Merges consecutive candles into `size`-second buckets (15m from 5m). Input oldest first. */
export function mergeCandles(candles: EnvioCandle[], size: number): EnvioCandle[] {
  const out: EnvioCandle[] = [];
  for (const c of candles) {
    const bucketStart = c.bucketStart - (c.bucketStart % size);
    const last = out.at(-1);
    if (last && last.bucketStart === bucketStart) {
      if (Number(c.high) > Number(last.high)) last.high = c.high;
      if (Number(c.low) < Number(last.low)) last.low = c.low;
      last.close = c.close;
      last.volumeQuote += c.volumeQuote;
      last.trades += c.trades;
    } else {
      out.push({ ...c, bucketStart });
    }
  }
  return out;
}

async function findToken(db: Db, address: string): Promise<TokenRow> {
  if (!isAddress(address, { strict: false })) throw new HttpError(400, 'Invalid token address.');
  const [row] = await db
    .select()
    .from(schema.tokens)
    .where(sql`lower(${schema.tokens.tokenAddress}) = ${address.toLowerCase()}`)
    .limit(1);
  if (!row) throw new HttpError(404, 'hood.exe has not indexed this token yet.');
  return row;
}

/** GET /tokens (Explore), GET /tokens/:address (+ /candles, /trades) (docs/BRIEF.md §9). */
export async function tokenRoutes(app: FastifyInstance) {
  const { db, envio, env: { network } } = app.deps;
  const cache = new Map<string, { at: number; body: unknown }>();
  const cached = async <T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> => {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < ttl) return hit.body as T;
    const body = await load();
    cache.set(key, { at: now, body });
    if (cache.size > 1_000) cache.delete(cache.keys().next().value!);
    return body;
  };
  const needEnvio = () => {
    if (!envio) throw new HttpError(503, 'Charts and trades need the indexer, which is not configured.');
    return envio;
  };
  /** The indexer failing (down, or over its plan's rate limit) is a 503 the client can retry, not a 500. */
  const fromIndexer = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (e) {
      if (e instanceof HttpError) throw e;
      app.log.warn(`indexer request failed: ${e instanceof Error ? e.message : String(e)}`);
      throw new HttpError(503, 'Charts and trades are busy right now. Try again in a moment.');
    }
  };

  app.get('/tokens', async (req) => {
    const q = query.parse(req.query);
    return cached(JSON.stringify(q), CACHE_MS, async () => {
      const search = searchFilter(q.q, network);
      const where = and(q.tab === 'hood' ? eq(schema.tokens.hood, true) : undefined, search.where);
      // Amounts across pairs aren't comparable without USD prices (Phase 2). Pons sizes each pair's
      // graduation threshold to a similar value, and every curve has the same shape relative to it, so
      // ranking by amount ÷ threshold compares coins across pairs.
      const perThreshold = (column: typeof schema.tokens.volume24h | typeof schema.tokens.realQuoteReserve) =>
        sql`(${column} / nullif(${schema.tokens.graduationThreshold}, 0)) desc nulls last`;
      const order: SQL[] =
        q.sort === 'volume'
          ? [perThreshold(schema.tokens.volume24h), desc(schema.tokens.blockNumber)]
          : q.sort === 'mcap'
            ? [desc(sql`${schema.tokens.phase} > 0`), perThreshold(schema.tokens.realQuoteReserve), desc(schema.tokens.blockNumber)]
            : q.sort === 'rigor'
              ? [sql`${schema.tokens.rigorScore} desc nulls last`, desc(schema.tokens.blockNumber)]
              : [desc(schema.tokens.blockNumber), asc(schema.tokens.tokenAddress)];
      const [rows, [{ total }], [{ hoodCount }]] = await Promise.all([
        db
          .select()
          .from(schema.tokens)
          .where(where)
          .orderBy(...(search.first ? [search.first, ...order] : order))
          .limit(q.limit)
          .offset(q.offset),
        db.select({ total: count() }).from(schema.tokens).where(where),
        db.select({ hoodCount: count() }).from(schema.tokens).where(eq(schema.tokens.hood, true)),
      ]);
      return { items: rows.map((row) => toItem(row, network)), total, hoodCount, offset: q.offset, volume: envio != null };
    });
  });

  app.get<{ Params: { address: string } }>('/tokens/:address', async (req) =>
    cached(`token:${req.params.address.toLowerCase()}`, CACHE_MS, async () => {
      const row = await findToken(db, req.params.address);
      return { ...toItem(row, network), deployer: row.deployer, description: row.description, metadataCid: row.metadataCid };
    }),
  );

  app.get<{ Params: { address: string } }>('/tokens/:address/candles', async (req) => {
    const q = candleQuery.parse(req.query);
    return fromIndexer(() => cached(`candles:${req.params.address.toLowerCase()}:${q.interval}:${q.limit}`, CACHE_MS, async () => {
      const source = needEnvio();
      const row = await findToken(db, req.params.address);
      const decimals = network.findPair(row.pairToken)?.decimals ?? null;
      const seconds = CHART_INTERVALS[q.interval];
      const raw =
        seconds === 900
          ? mergeCandles(await source.candles(row.tokenAddress, 300, q.limit * 3), 900).slice(-q.limit)
          : await source.candles(row.tokenAddress, seconds, q.limit);
      return {
        interval: q.interval,
        candles: raw.map((c) => ({
          time: c.bucketStart,
          open: toPairPrice(c.open, decimals),
          high: toPairPrice(c.high, decimals),
          low: toPairPrice(c.low, decimals),
          close: toPairPrice(c.close, decimals),
          volume: units(c.volumeQuote, decimals),
          trades: c.trades,
        })),
      };
    }));
  });

  app.get<{ Params: { address: string } }>('/tokens/:address/trades', async (req) => {
    const q = tradeQuery.parse(req.query);
    // 10 s: viewers of one coin share it, which keeps them inside Envio's per-minute query budget.
    return fromIndexer(() => cached(`trades:${req.params.address.toLowerCase()}:${q.limit}`, 10_000, async () => {
      const source = needEnvio();
      const row = await findToken(db, req.params.address);
      const decimals = network.findPair(row.pairToken)?.decimals ?? null;
      const trades = await source.trades(row.tokenAddress, q.limit);
      return {
        trades: trades.map((t) => ({
          id: t.id,
          trader: t.trader,
          side: t.isBuy ? ('buy' as const) : ('sell' as const),
          quote: units(t.quoteAmount, decimals),
          tokens: units(t.tokenAmount, 18)!,
          price: toPairPrice(t.price, decimals),
          time: t.timestamp,
          txHash: t.txHash,
        })),
      };
    }));
  });
}
