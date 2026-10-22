import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import { createPublicClient, decodeEventLog, erc20Abi, http, toEventSelector, type Address, type Hex } from 'viem';
import { parseDescription, ponsCurveAbi, ponsFactoryAbi, ponsTokenAbi, type NetworkConfig } from '@hood/shared';
import { schema, type Db } from '../db';
import { storedScore } from '../routes/score';

export type RawLaunch = {
  token: Address;
  curve: Address;
  deployer: Address;
  pairToken: Address;
  graduationThreshold: bigint;
  blockNumber: number;
  timestamp: Date;
};

export type TokenMetadata = { name: string; symbol: string; logo: string; description: string };
export type CurveState = { phase: number; quoteReserve: bigint; tokenReserve: bigint; realQuoteReserve: bigint };

/** Where launches come from: the Envio indexer (services/envio.ts) or, locally, raw RPC logs. */
export interface LaunchSource {
  latestBlock(): Promise<number>;
  launches(fromBlock: number, toBlock: number): Promise<RawLaunch[]>;
  metadata(tokens: Address[]): Promise<Map<Address, TokenMetadata>>;
  state(items: { token: Address; curve: Address }[]): Promise<Map<Address, CurveState>>;
  /** Gross quote volume and trade count since a unix time. Needs trade history, so Envio only. */
  activity?(tokens: Address[], since: number): Promise<Map<Address, Activity>>;
}

export type Activity = { volume: bigint; trades: number };

const TOKEN_LAUNCHED_TOPIC = toEventSelector(ponsFactoryAbi.find((x) => x.type === 'event' && x.name === 'TokenLaunched')!);

const noNul = (s: string) => s.replace(/\u0000/g, '');

export function rpcLaunchSource(network: NetworkConfig): LaunchSource {
  const client = createPublicClient({ chain: network.chain, transport: http(network.rpcUrl, { retryCount: 3 }) });
  const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

  return {
    latestBlock: async () => Number(await client.getBlockNumber()),

    async launches(fromBlock, toBlock) {
      // Raw request: Nitro returns blockTimestamp on each log, which saves a block lookup per launch.
      const logs = (await client.request({
        method: 'eth_getLogs',
        params: [
          {
            address: network.pons.launchFactory,
            topics: [TOKEN_LAUNCHED_TOPIC],
            fromBlock: `0x${fromBlock.toString(16)}`,
            toBlock: `0x${toBlock.toString(16)}`,
          },
        ],
      } as never)) as { topics: [Hex, ...Hex[]]; data: Hex; blockNumber: Hex; blockTimestamp?: Hex }[];
      // Nitro sends blockTimestamp as 0x0 on logs, so look the blocks up (once each, 8 at a time: the public
      // RPC answers JSON-RPC batches with a Cloudflare challenge).
      const blocks = [...new Set(logs.filter((l) => !Number(l.blockTimestamp ?? 0)).map((l) => l.blockNumber))];
      const times = new Map<Hex, number>();
      for (let i = 0; i < blocks.length; i += 8) {
        const chunk = blocks.slice(i, i + 8);
        const fetched = await Promise.all(chunk.map((b) => client.getBlock({ blockNumber: BigInt(b) })));
        chunk.forEach((b, j) => times.set(b, Number(fetched[j].timestamp)));
      }
      return logs.map((log) => {
        const { args } = decodeEventLog({ abi: ponsFactoryAbi, eventName: 'TokenLaunched', topics: log.topics, data: log.data });
        const seconds = Number(log.blockTimestamp ?? 0) || times.get(log.blockNumber)!;
        return { ...args, blockNumber: Number(log.blockNumber), timestamp: new Date(seconds * 1000) };
      });
    },

    async metadata(tokens) {
      const results = await client.multicall({
        allowFailure: true,
        batchSize: 16_384,
        contracts: tokens.flatMap((address) => [
          { address, abi: ponsTokenAbi, functionName: 'getTokenInfo' } as const,
          { address, abi: erc20Abi, functionName: 'name' } as const,
          { address, abi: erc20Abi, functionName: 'symbol' } as const,
        ]),
      });
      const out = new Map<Address, TokenMetadata>();
      tokens.forEach((token, i) => {
        const [info, name, symbol] = results.slice(i * 3, i * 3 + 3);
        const tuple = info.status === 'success' ? (info.result as readonly [Address, string, string, unknown]) : null;
        out.set(token, {
          name: clip(name.status === 'success' ? String(name.result) : '', 64),
          symbol: clip(symbol.status === 'success' ? String(symbol.result) : '', 16),
          logo: clip(tuple?.[1] ?? '', 512),
          description: clip(tuple?.[2] ?? '', 2048),
        });
      });
      return out;
    },

    async state(items) {
      const results = await client.multicall({
        allowFailure: true,
        batchSize: 16_384,
        contracts: items.flatMap(({ token, curve }) => [
          { address: network.pons.launchFactory, abi: ponsFactoryAbi, functionName: 'getLaunchedToken', args: [token] } as const,
          { address: curve, abi: ponsCurveAbi, functionName: 'getReserves' } as const,
          { address: curve, abi: ponsCurveAbi, functionName: 'realQuoteReserve' } as const,
        ]),
      });
      const out = new Map<Address, CurveState>();
      items.forEach(({ token }, i) => {
        const [launched, reserves, real] = results.slice(i * 3, i * 3 + 3);
        if (launched.status !== 'success') return;
        const phase = (launched.result as { phase: number }).phase;
        const [quoteReserve, tokenReserve] = reserves.status === 'success' ? (reserves.result as readonly [bigint, bigint]) : [0n, 0n];
        out.set(token, { phase, quoteReserve, tokenReserve, realQuoteReserve: real.status === 'success' ? (real.result as bigint) : 0n });
      });
      return out;
    },
  };
}

export type TokenIndexOptions = {
  /** How far back the first run reaches. The public RPC serves logs for any range; state is live. */
  backfillBlocks: number;
  /** Blocks per eth_getLogs request (the RPC caps a response at 10,000 logs). */
  chunkBlocks: number;
  /** Curve state is refreshed for every hood.exe token plus this many of the newest launches. */
  refreshRecent: number;
  log?: (msg: string) => void;
};

const CURSOR = 'tokens:lastBlock';

export function tokenIndex(db: Db, source: LaunchSource, opts: TokenIndexOptions) {
  let syncing = false;
  let refreshing = false;
  const timers: NodeJS.Timeout[] = [];

  async function cursor(): Promise<number | null> {
    const [row] = await db.select().from(schema.indexState).where(eq(schema.indexState.key, CURSOR)).limit(1);
    return row ? Number(row.value) : null;
  }

  async function setCursor(block: number) {
    await db
      .insert(schema.indexState)
      .values({ key: CURSOR, value: String(block) })
      .onConflictDoUpdate({ target: schema.indexState.key, set: { value: String(block) } });
  }

  async function store(launches: RawLaunch[]) {
    for (let i = 0; i < launches.length; i += 100) {
      const batch = launches.slice(i, i + 100);
      const meta = await source.metadata(batch.map((l) => l.token));
      const rows = await Promise.all(
        batch.map(async (l) => {
          const raw = meta.get(l.token) ?? { name: '', symbol: '', logo: '', description: '' };
          // Anyone can launch a Pons coin with any metadata; Postgres text can't hold NUL, and one such coin
          // would fail the whole batch.
          const m = { name: noNul(raw.name), symbol: noNul(raw.symbol), logo: noNul(raw.logo), description: noNul(raw.description) };
          const parsed = parseDescription(m.description);
          const scored = parsed ? await storedScore(db, parsed.statement) : undefined;
          return {
            tokenAddress: l.token,
            curveAddress: l.curve,
            deployer: l.deployer,
            pairToken: l.pairToken,
            blockNumber: l.blockNumber,
            launchedAt: l.timestamp,
            ...m,
            hood: parsed != null,
            statement: parsed?.statement ?? null,
            metadataCid: parsed?.cid ?? null,
            rigorScore: scored?.score ?? null,
            graduationThreshold: l.graduationThreshold.toString(),
          };
        }),
      );
      if (rows.length) await db.insert(schema.tokens).values(rows).onConflictDoNothing();
    }
  }

  /** Pulls new TokenLaunched logs since the cursor. Returns how many launches were stored. */
  async function sync(): Promise<number> {
    if (syncing) return 0;
    syncing = true;
    try {
      const latest = await source.latestBlock();
      let last = await cursor();
      // Ahead of the chain means a different chain behind the same RPC URL (e.g. mainnet ↔ pnpm fork).
      if (last != null && last > latest) {
        opts.log?.(`token index cursor ${last} is past the chain head ${latest}; re-indexing from the backfill window`);
        last = null;
      }
      let from = (last ?? Math.max(0, latest - opts.backfillBlocks) - 1) + 1;
      let stored = 0;
      while (from <= latest) {
        const to = Math.min(from + opts.chunkBlocks - 1, latest);
        const launches = await source.launches(from, to);
        await store(launches);
        await setCursor(to);
        stored += launches.length;
        from = to + 1;
      }
      return stored;
    } finally {
      syncing = false;
    }
  }

  /** Re-reads phase and reserves for hood.exe tokens and the newest launches still on their curve. */
  async function refresh(): Promise<number> {
    if (refreshing) return 0;
    refreshing = true;
    try {
      const recent = db
        .select({ token: schema.tokens.tokenAddress })
        .from(schema.tokens)
        .orderBy(desc(schema.tokens.blockNumber))
        .limit(opts.refreshRecent);
      const rows = await db
        .select({ token: schema.tokens.tokenAddress, curve: schema.tokens.curveAddress, hood: schema.tokens.hood, statement: schema.tokens.statement, rigorScore: schema.tokens.rigorScore })
        .from(schema.tokens)
        .where(and(lt(schema.tokens.phase, 2), or(eq(schema.tokens.hood, true), inArray(schema.tokens.tokenAddress, recent))));
      const states = await source.state(rows.map((r) => ({ token: r.token as Address, curve: r.curve as Address })));
      const now = new Date();
      for (const r of rows) {
        const s = states.get(r.token as Address);
        if (!s) continue;
        await db
          .update(schema.tokens)
          .set({
            phase: s.phase,
            quoteReserve: s.quoteReserve.toString(),
            tokenReserve: s.tokenReserve.toString(),
            realQuoteReserve: s.realQuoteReserve.toString(),
            stateUpdatedAt: now,
          })
          .where(eq(schema.tokens.tokenAddress, r.token));
      }
      if (source.activity) {
        // The last 24 whole hours of candles, plus the hour in progress.
        const since = Math.floor(now.getTime() / 3_600_000) * 3_600 - 23 * 3_600;
        const activity = await source.activity(
          rows.map((r) => r.token as Address),
          since,
        );
        for (const r of rows) {
          const a = activity.get(r.token as Address) ?? { volume: 0n, trades: 0 };
          await db.update(schema.tokens).set({ volume24h: a.volume.toString(), trades24h: a.trades }).where(eq(schema.tokens.tokenAddress, r.token));
        }
      }
      // A hood.exe statement can be scored after the launch was indexed (e.g. a re-score).
      const unscored = rows.filter((r) => r.hood && r.statement && r.rigorScore == null);
      for (const r of unscored) {
        const scored = await storedScore(db, r.statement!);
        if (scored) await db.update(schema.tokens).set({ rigorScore: scored.score }).where(eq(schema.tokens.tokenAddress, r.token));
      }
      return rows.length;
    } finally {
      refreshing = false;
    }
  }

  const guard = (name: string, fn: () => Promise<unknown>) => () =>
    fn().catch((e) => {
      // Drizzle wraps the database's error (the useful part) as the cause of a long "Failed query: …" message.
      const cause = e instanceof Error && e.cause instanceof Error ? ` (${e.cause.message})` : '';
      opts.log?.(`token index ${name} failed: ${e instanceof Error ? e.message.split('\n')[0].slice(0, 120) : String(e)}${cause}`);
    });

  return {
    sync,
    refresh,
    /** Background loop: launches every 10 s, curve state every 30 s. */
    start() {
      void guard('sync', async () => {
        await sync();
        await refresh();
      })();
      timers.push(setInterval(guard('sync', sync), 10_000), setInterval(guard('refresh', refresh), 30_000));
    },
    stop() {
      for (const t of timers) clearInterval(t);
    },
  };
}

export type TokenIndex = ReturnType<typeof tokenIndex>;
