import type { Address } from 'viem';
import { z } from 'zod';
import type { NetworkConfig } from '@hood/shared';
import type { Activity, LaunchSource, RawLaunch } from './tokenIndex';

/**
 * The Envio indexer's GraphQL (apps/indexer, Hasura). Numerics arrive as strings
 * (HASURA_GRAPHQL_STRINGIFY_NUMERIC_TYPES), so uint256 amounts are parsed straight to bigint.
 */
export type EnvioClient = ReturnType<typeof envioClient>;

const big = z.coerce.bigint();
const decimal = z.union([z.string(), z.number()]).transform(String);

const tokenRow = z.object({
  id: z.string(),
  curve: z.string(),
  deployer: z.string(),
  pairToken: z.string(),
  graduationThreshold: big,
  launchBlock: z.number().int(),
  launchedAt: z.number().int(),
});

const candleRow = z.object({
  bucketStart: z.number().int(),
  open: decimal,
  high: decimal,
  low: decimal,
  close: decimal,
  volumeQuote: big,
  trades: z.number().int(),
});
export type EnvioCandle = z.output<typeof candleRow>;

const tradeRow = z.object({
  id: z.string(),
  trader: z.string(),
  isBuy: z.boolean(),
  quoteAmount: big,
  tokenAmount: big,
  price: decimal,
  timestamp: z.number().int(),
  txHash: z.string(),
});
export type EnvioTrade = z.output<typeof tradeRow>;

/**
 * Spaces requests so at most `perMinute` start in any 60 s window. Envio's hosted plans cap queries per minute
 * (100 on the free plan) across everything that uses the endpoint, so the API and the worker each get a share.
 */
export function minuteLimiter(perMinute: number, now = () => Date.now(), sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
  const started: number[] = [];
  let queue: Promise<void> = Promise.resolve();
  return function slot(): Promise<void> {
    const turn = queue.then(async () => {
      for (;;) {
        while (started.length && now() - started[0] >= 60_000) started.shift();
        if (started.length < perMinute) break;
        await sleep(60_000 - (now() - started[0]) + 5);
      }
      started.push(now());
    });
    queue = turn.catch(() => {});
    return turn;
  };
}

/** Background work (launch sync, volume, system callouts) and visitor requests (charts, trades, portfolio). */
type Lane = 'background' | 'interactive';

/**
 * `limits` caps queries per minute per lane, so a visitor's chart never queues behind a backfill. Unset lanes
 * are unlimited.
 */
export function envioClient(graphqlUrl: string, network: NetworkConfig, pageSize = 1_000, limits: Partial<Record<Lane, number>> = {}) {
  const expectedChainId = network.chainId;
  const lane = (n: number | undefined) => (n != null && Number.isFinite(n) ? minuteLimiter(n) : async () => {});
  const slots: Record<Lane, () => Promise<void>> = { background: lane(limits.background), interactive: lane(limits.interactive) };

  async function post(text: string, variables: Record<string, unknown>, which: Lane): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      await slots[which]();
      const res = await fetch(graphqlUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: text, variables }),
        signal: AbortSignal.timeout(15_000),
      });
      // Over the plan's rate limit anyway (other callers, a restart): wait it out a couple of times.
      if (res.status !== 429 || attempt >= 2) return res;
      const retryAfter = Number(res.headers.get('retry-after'));
      await new Promise((r) => setTimeout(r, Math.min(15_000, retryAfter > 0 ? retryAfter * 1_000 : 5_000)));
    }
  }

  async function rawQuery<T>(text: string, variables: Record<string, unknown>, schema: z.ZodType<T>, which: Lane): Promise<T> {
    const res = await post(text, variables, which);
    if (!res.ok) throw new Error(`Envio GraphQL answered ${res.status}`);
    const body = (await res.json()) as { data?: unknown; errors?: { message: string }[] };
    if (body.errors?.length) throw new Error(`Envio GraphQL: ${body.errors[0].message}`);
    return schema.parse(body.data);
  }

  let validated: Promise<number> | undefined;
  function validateChain(which: Lane, refresh = false): Promise<number> {
    if (!validated || refresh) {
      const pending = rawQuery(
        '{ chain_metadata { chain_id latest_processed_block } }',
        {},
        z.object({ chain_metadata: z.array(z.object({ chain_id: z.number(), latest_processed_block: z.number().nullable() })) }),
        which,
      ).then(({ chain_metadata: chains }) => {
        if (chains.some((c) => c.chain_id !== expectedChainId)) throw new Error(`Envio chain mismatch: expected only chain ${expectedChainId}`);
        const chain = chains[0];
        if (chain?.latest_processed_block == null) throw new Error(`Envio has not indexed Robinhood Chain ${expectedChainId} yet`);
        return chain.latest_processed_block;
      }).catch((error) => {
        if (validated === pending) validated = undefined;
        throw error;
      });
      validated = pending;
    }
    return validated;
  }

  async function query<T>(text: string, variables: Record<string, unknown>, schema: z.ZodType<T>, which: Lane = 'background'): Promise<T> {
    await validateChain(which);
    return rawQuery(text, variables, schema, which);
  }

  /** Runs a paged query (it must take $limit and $offset) until a short page; `field` names the rows. */
  async function all<T>(text: string, variables: Record<string, unknown>, schema: z.ZodType<T[]>, field: string, which: Lane = 'background', max = Infinity): Promise<T[]> {
    await validateChain(which);
    const out: T[] = [];
    for (let offset = 0; offset < max; offset += pageSize) {
      const page = await query(text, { ...variables, limit: pageSize, offset }, z.object({ [field]: schema }).transform((d) => d[field] as T[]), which);
      out.push(...page);
      if (page.length < pageSize) return out;
    }
    return out.slice(0, max);
  }

  return {
    latestBlock: () => validateChain('background', true),

    async launches(fromBlock: number, toBlock: number): Promise<RawLaunch[]> {
      const rows = await all(
        `query Launches($from: Int!, $to: Int!, $limit: Int!, $offset: Int!) {
          Token(where: { launchBlock: { _gte: $from, _lte: $to } }, order_by: [{ launchBlock: asc }, { id: asc }], limit: $limit, offset: $offset) {
            id curve deployer pairToken graduationThreshold launchBlock launchedAt
          }
        }`,
        { from: fromBlock, to: toBlock },
        z.array(tokenRow),
        'Token',
      );
      return rows.map((t) => ({
        token: t.id as Address,
        curve: t.curve as Address,
        deployer: t.deployer as Address,
        pairToken: t.pairToken as Address,
        graduationThreshold: t.graduationThreshold,
        blockNumber: t.launchBlock,
        timestamp: new Date(t.launchedAt * 1000),
      }));
    },

    /** Sums hourly candles per token since `since` (unix seconds, an hour boundary). */
    async activity(tokens: Address[], since: number): Promise<Map<Address, Activity>> {
      await validateChain('background');
      const out = new Map<Address, Activity>();
      for (let i = 0; i < tokens.length; i += 200) {
        const rows = await all(
          `query Activity($tokens: [String!]!, $since: Int!, $limit: Int!, $offset: Int!) {
            Candle(where: { token: { _in: $tokens }, interval: { _eq: 3600 }, bucketStart: { _gte: $since } }, order_by: { id: asc }, limit: $limit, offset: $offset) {
              token volumeQuote trades
            }
          }`,
          { tokens: tokens.slice(i, i + 200), since },
          z.array(z.object({ token: z.string(), volumeQuote: big, trades: z.number().int() })),
          'Candle',
        );
        for (const r of rows) {
          const a = out.get(r.token as Address) ?? { volume: 0n, trades: 0 };
          out.set(r.token as Address, { volume: a.volume + r.volumeQuote, trades: a.trades + r.trades });
        }
      }
      return out;
    },

    /** Newest `limit` candles, oldest first. */
    async candles(token: string, interval: number, limit: number): Promise<EnvioCandle[]> {
      const data = await query(
        `query Candles($token: String!, $interval: Int!, $limit: Int!) {
          Candle(where: { token: { _eq: $token }, interval: { _eq: $interval } }, order_by: { bucketStart: desc }, limit: $limit) {
            bucketStart open high low close volumeQuote trades
          }
        }`,
        { token, interval, limit },
        z.object({ Candle: z.array(candleRow) }),
        'interactive',
      );
      return data.Candle.reverse();
    },

    /** Buys of at least `minQuote` on these tokens after `afterBlock`, oldest first (system callouts). */
    async bigBuys(tokens: string[], minQuote: bigint, afterBlock: number, limit = 200): Promise<(EnvioTrade & { token: string; blockNumber: number })[]> {
      await validateChain('background');
      if (!tokens.length) return [];
      const data = await query(
        `query BigBuys($tokens: [String!]!, $min: numeric!, $after: Int!, $limit: Int!) {
          Trade(where: { token: { _in: $tokens }, isBuy: { _eq: true }, quoteAmount: { _gte: $min }, blockNumber: { _gt: $after } }, order_by: [{ blockNumber: asc }, { id: asc }], limit: $limit) {
            id token trader isBuy quoteAmount tokenAmount price timestamp txHash blockNumber
          }
        }`,
        { tokens, min: minQuote.toString(), after: afterBlock, limit },
        z.object({ Trade: z.array(tradeRow.extend({ token: z.string(), blockNumber: z.number().int() })) }),
      );
      return data.Trade;
    },

    /**
     * Buys and sells of at least each tier's size on that tier's tokens, oldest first (the desktop's trade
     * balloons). `afterBlock` resumes the worker's cursor; `since` (unix seconds) takes the newest `limit` instead.
     */
    async notableTrades(
      tiers: { tokens: string[]; minQuote: bigint }[],
      from: { afterBlock: number } | { since: number },
      limit = 200,
      which: Lane = 'background',
    ): Promise<(EnvioTrade & { token: string; blockNumber: number })[]> {
      await validateChain(which);
      const live = tiers.filter((t) => t.tokens.length);
      if (!live.length) return [];
      const newest = 'since' in from;
      const params = live.map((_, i) => `$t${i}: [String!]!, $m${i}: numeric!`).join(', ');
      const any = live.map((_, i) => `{ token: { _in: $t${i} }, quoteAmount: { _gte: $m${i} } }`).join(', ');
      const order = newest ? 'desc' : 'asc';
      const data = await query(
        `query NotableTrades(${params}, $from: Int!, $limit: Int!) {
          Trade(where: { _or: [${any}], ${newest ? 'timestamp: { _gte: $from }' : 'blockNumber: { _gt: $from }'} }, order_by: [{ blockNumber: ${order} }, { id: ${order} }], limit: $limit) {
            id token trader isBuy quoteAmount tokenAmount price timestamp txHash blockNumber
          }
        }`,
        { ...Object.fromEntries(live.flatMap((t, i) => [[`t${i}`, t.tokens], [`m${i}`, t.minQuote.toString()]])), from: newest ? from.since : from.afterBlock, limit },
        z.object({ Trade: z.array(tradeRow.extend({ token: z.string(), blockNumber: z.number().int() })) }),
        which,
      );
      return newest ? data.Trade.reverse() : data.Trade;
    },

    /**
     * The wallet's open positions (indexer `Position`: average-cost quantity and cost per coin, from its curve
     * trades, including dev buys the router made for it). Portfolio's cost basis.
     */
    async walletPositions(wallet: string, max = 2_000): Promise<WalletPosition[]> {
      return all(
        `query WalletPositions($wallet: String!, $limit: Int!, $offset: Int!) {
          Position(where: { wallet: { _eq: $wallet } }, order_by: { id: asc }, limit: $limit, offset: $offset) {
            token qty cost
          }
        }`,
        { wallet },
        z.array(z.object({ token: z.string(), qty: big, cost: big })),
        'Position',
        'interactive',
        max,
      );
    },

    /** The wallet's newest trade on `token` since `since` (unix seconds), as trader or recipient; null if none. */
    async latestWalletTrade(wallet: string, token: string, since: number): Promise<EnvioTrade | null> {
      const data = await query(
        `query LatestWalletTrade($token: String!, $wallet: String!, $since: Int!) {
          Trade(where: { token: { _eq: $token }, timestamp: { _gte: $since }, _or: [{ trader: { _eq: $wallet } }, { recipient: { _eq: $wallet } }] }, order_by: [{ blockNumber: desc }, { id: desc }], limit: 1) {
            id trader isBuy quoteAmount tokenAmount price timestamp txHash
          }
        }`,
        { token, wallet, since },
        z.object({ Trade: z.array(tradeRow) }),
        'interactive',
      );
      return data.Trade[0] ?? null;
    },

    /** Newest `limit` trades, newest first. */
    async trades(token: string, limit: number): Promise<EnvioTrade[]> {
      const data = await query(
        `query Trades($token: String!, $limit: Int!) {
          Trade(where: { token: { _eq: $token } }, order_by: [{ blockNumber: desc }, { id: desc }], limit: $limit) {
            id trader isBuy quoteAmount tokenAmount price timestamp txHash
          }
        }`,
        { token, limit },
        z.object({ Trade: z.array(tradeRow) }),
        'interactive',
      );
      return data.Trade;
    },
  };
}

/**
 * Launch discovery from Envio; token metadata and live curve state still come from the RPC, which only
 * needs eth_call (fine on a free-tier provider, unlike eth_getLogs).
 */
export function envioLaunchSource(envio: EnvioClient, rpc: LaunchSource): LaunchSource {
  return {
    latestBlock: () => envio.latestBlock(),
    launches: (from, to) => envio.launches(from, to),
    activity: (tokens, since) => envio.activity(tokens, since),
    metadata: (tokens) => rpc.metadata(tokens),
    state: (items) => rpc.state(items),
  };
}

export type WalletPosition = { token: string; qty: bigint; cost: bigint };
