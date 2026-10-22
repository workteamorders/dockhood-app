import type { FastifyInstance } from 'fastify';
import { desc, inArray, sql } from 'drizzle-orm';
import { formatUnits, getAddress, isAddress, type Address } from 'viem';
import { parseDescription } from '@hood/shared';
import { HttpError } from '../app';
import { schema } from '../db';
import type { WalletPosition } from '../services/envio';
import { storedScore } from './score';
import { toItem } from './tokens';

const CACHE_MS = 15_000;
/** Enough for any real wallet; keeps one request bounded. */
const MAX_COINS = 200;

const units = (raw: bigint | null, decimals: number | null) => (raw == null || decimals == null ? null : Number(formatUnits(raw, decimals)));

/** GET /portfolio/:wallet (docs/BRIEF.md §5.7, §9): the wallet's launches and holdings with unrealized P&L. */
export async function portfolioRoutes(app: FastifyInstance) {
  const { db, chain, envio, market, env: { network } } = app.deps;
  const cache = new Map<string, { at: number; body: unknown }>();

  app.get<{ Params: { wallet: string } }>('/portfolio/:wallet', async (req) => {
    if (!isAddress(req.params.wallet, { strict: false })) throw new HttpError(400, 'Invalid wallet.');
    const wallet = getAddress(req.params.wallet);
    const hit = cache.get(wallet);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.body;

    const launched = await db
      .select()
      .from(schema.tokens)
      .where(sql`lower(${schema.tokens.deployer}) = ${wallet.toLowerCase()}`)
      .orderBy(desc(schema.tokens.blockNumber))
      .limit(MAX_COINS);

    // Coins the wallet has a position in (indexer) plus the ones it launched; balances decide what it holds.
    // Without positions (no indexer, or it failed) holdings still come from balances, just without cost basis.
    let tradeHistory = envio != null;
    let positions: WalletPosition[] = [];
    if (envio) {
      try {
        positions = await envio.walletPositions(wallet);
      } catch (e) {
        req.log.warn(`portfolio positions failed: ${e instanceof Error ? e.message : String(e)}`);
        tradeHistory = false;
      }
    }
    const ledger = new Map(positions.map((pos) => [pos.token.toLowerCase(), pos]));
    const candidates = [...new Set([...launched.map((r) => r.tokenAddress), ...positions.map((pos) => pos.token)].map((a) => getAddress(a)))].slice(0, MAX_COINS);
    const balances = candidates.length ? await chain.tokenBalances(wallet, candidates) : new Map<Address, bigint>();
    const held = candidates.filter((t) => (balances.get(t) ?? 0n) > 0n);

    // Coins outside the token table (older than its window): ask the factory and the token directly.
    const known = held.length
      ? await db
          .select()
          .from(schema.tokens)
          .where(
            inArray(
              sql`lower(${schema.tokens.tokenAddress})`,
              held.map((h) => h.toLowerCase()),
            ),
          )
      : [];
    const knownBy = new Map(known.map((r) => [r.tokenAddress.toLowerCase(), r]));
    const missing = held.filter((t) => !knownBy.has(t.toLowerCase()));
    const [records, meta] = missing.length ? await Promise.all([chain.launchRecords(missing), market.metadata(missing)]) : [new Map(), new Map()];

    const coins = held.flatMap((token) => {
      const row = knownBy.get(token.toLowerCase());
      const rec = row ? null : records.get(token);
      if (!row && !rec) return []; // not a Pons V2 coin
      return [{ token, row, rec, curve: (row?.curveAddress ?? rec!.curve) as Address, pairToken: (row?.pairToken ?? rec!.pairToken) as Address }];
    });
    const states = coins.length ? await market.state(coins.map((c) => ({ token: c.token, curve: c.curve }))) : new Map();

    const holdings = await Promise.all(
      coins.map(async ({ token, row, curve, pairToken }) => {
        const pair = network.findPair(pairToken);
        const decimals = pair?.decimals ?? null;
        const balance = balances.get(token)!;
        const state = states.get(token);
        const m = row ?? meta.get(token);
        const parsed = !row && m ? parseDescription(m.description) : null;
        const rigorScore = row?.formal ? 100 : row ? row.rigorScore : parsed ? ((await storedScore(db, parsed.statement))?.score ?? null) : null;
        const phase = state?.phase ?? row?.phase ?? 0;

        // Marked at the curve's spot price; graduated coins trade on Uniswap V4, which isn't priced here yet.
        const value = phase === 0 && state && state.tokenReserve > 0n ? (balance * state.quoteReserve) / state.tokenReserve : null;
        const l = ledger.get(token.toLowerCase());
        // More tokens than the trades explain (transfers in): the cost of the difference is unknown.
        const cost = l && l.qty > 0n && balance <= l.qty ? (l.cost * balance) / l.qty : null;
        const pnl = value != null && cost != null ? value - cost : null;

        return {
          token,
          curve,
          symbol: m?.symbol ?? '?',
          name: m?.name ?? '',
          logo: m?.logo ?? '',
          pair: { address: pairToken, symbol: pair?.symbol ?? '?', decimals },
          hood: row?.hood ?? parsed != null,
          rigorScore,
          formal: row?.formal ?? false,
          phase,
          launchedByMe: launched.some((r) => r.tokenAddress.toLowerCase() === token.toLowerCase()),
          balance: units(balance, 18)!,
          /** Pair asset per token at the curve now. */
          price: decimals != null && state && state.tokenReserve > 0n && phase === 0 ? units(state.quoteReserve, decimals)! / units(state.tokenReserve, 18)! : null,
          value: units(value, decimals),
          costBasis: units(cost, decimals),
          pnl: units(pnl, decimals),
          pnlPct: decimals != null && pnl != null && cost != null && cost > 0n ? Number((pnl * 10_000n) / cost) / 100 : null,
        };
      }),
    );

    const body = {
      wallet,
      holdings,
      launches: launched.map((row) => toItem(row, network)),
      /** False without the indexer: holdings then only cover the wallet's own launches, with no cost basis. */
      tradeHistory,
    };
    cache.set(wallet, { at: Date.now(), body });
    if (cache.size > 2_000) cache.delete(cache.keys().next().value!);
    return body;
  });
}
