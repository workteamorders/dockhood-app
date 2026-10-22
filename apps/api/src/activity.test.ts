import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HEXE_TOKEN, NATIVE_PAIR, resolveNetwork } from '@hood/shared';
import { HEXE_MIN_ETH, HOOD_MIN_ETH, activityTick, watchedTokens, type ActivityItem } from './activity';
import { schema } from './db';
import type { EnvioClient } from './services/envio';
import { CALLOUTS_CHANNEL } from './services/pubsub';
import { setup } from './test/helpers';

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.close();
});

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const HEXE = HEXE_TOKEN.address;

async function coin(address: string, symbol: string, opts: { hood?: boolean; pair?: string } = {}) {
  await ctx.db.insert(schema.tokens).values({
    tokenAddress: address,
    curveAddress: addr(Number.parseInt(address.slice(-6), 16) + 5_000),
    deployer: addr(1),
    pairToken: opts.pair ?? NATIVE_PAIR,
    blockNumber: 1,
    launchedAt: ctx.now(),
    name: symbol,
    symbol,
    logo: '',
    description: '',
    hood: opts.hood ?? true,
    graduationThreshold: '4200000000000000000',
    phase: 0,
  });
}

type Trade = Awaited<ReturnType<EnvioClient['notableTrades']>>[number];
const trade = (id: string, token: string, eth: bigint, block: number, at: number, isBuy = true): Trade => ({
  id,
  token,
  trader: '0x12ab000000000000000000000000000000009f0c',
  isBuy,
  quoteAmount: eth,
  tokenAmount: 1n,
  price: '1',
  timestamp: at,
  txHash: `0xt${id}`,
  blockNumber: block,
});

/** An indexer stand-in that answers notableTrades like the real query: by tier, side-blind, by block or by time. */
function fakeEnvio(trades: Trade[], head = 1_000) {
  const asked: Parameters<EnvioClient['notableTrades']>[] = [];
  const envio = {
    latestBlock: async () => head,
    notableTrades: async (...args: Parameters<EnvioClient['notableTrades']>) => {
      asked.push(args);
      const [tiers, from, limit = 200] = args;
      const hit = trades.filter((t) => tiers.some((tier) => tier.tokens.includes(t.token) && t.quoteAmount >= tier.minQuote));
      if ('since' in from) return hit.filter((t) => t.timestamp >= from.since).sort((a, b) => b.blockNumber - a.blockNumber).slice(0, limit).reverse();
      return hit.filter((t) => t.blockNumber > from.afterBlock).sort((a, b) => a.blockNumber - b.blockNumber);
    },
  } as unknown as EnvioClient;
  return { envio, asked };
}

const eth = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

describe('trade balloons', () => {
  it('uses an explicitly configured official token, without inheriting the mainnet token', async () => {
    await coin(HEXE, 'HEXE', { hood: false });
    await coin(addr(1), 'TEST', { hood: false });
    await coin(addr(2), 'THEOREM');
    const network = resolveNetwork({ chainId: 46630, launchFactory: addr(11), launchAndBuy: addr(12), officialToken: addr(1) });
    const { tiers } = await watchedTokens(ctx.db, network);
    expect(tiers).toEqual([
      { tokens: [addr(1)], minQuote: HEXE_MIN_ETH },
      { tokens: [addr(2)], minQuote: HOOD_MIN_ETH },
    ]);
  });

  it('watches $HEXE at its own threshold and ETH-paired hood coins at theirs, nothing else', async () => {
    await coin(HEXE, 'HEXE', { hood: false });
    await coin(addr(1), 'EULER');
    await coin(addr(2), 'STABLE', { pair: USDG });
    await coin(addr(3), 'RANDO', { hood: false });
    const { tiers, tickers } = await watchedTokens(ctx.db, ctx.app.deps.env.network);
    expect(tiers).toEqual([
      { tokens: [HEXE], minQuote: HEXE_MIN_ETH },
      { tokens: [addr(1)], minQuote: HOOD_MIN_ETH },
    ]);
    expect(tickers.get(HEXE.toLowerCase())).toBe('HEXE');
  });

  it('pushes buys and sells over the thresholds, from the indexer head, following a cursor', async () => {
    await coin(HEXE, 'HEXE', { hood: false });
    await coin(addr(1), 'EULER');
    const at = Math.floor(ctx.now().getTime() / 1000);
    const trades = [
      trade('1001-1', HEXE, eth(0.01), 1_001, at), // exactly $HEXE's bar
      trade('1002-1', HEXE, eth(0.0099), 1_002, at), // just under it
      trade('1003-1', addr(1), eth(0.03), 1_003, at), // under a hood coin's bar
      trade('1004-1', addr(1), eth(0.2), 1_004, at, false), // a sell over it
      trade('900-1', HEXE, eth(1), 900, at), // before the first run's head
    ];
    const f = fakeEnvio(trades);
    const seen: { type: string; activity: ActivityItem }[] = [];
    await ctx.pubsub.subscribe(CALLOUTS_CHANNEL, (m) => seen.push(m as (typeof seen)[number]));
    const tick = () => activityTick({ db: ctx.db, pubsub: ctx.pubsub, envio: f.envio, network: ctx.app.deps.env.network, now: ctx.now });

    expect(await tick()).toBe(2);
    expect(f.asked[0][1]).toEqual({ afterBlock: 1_000 });
    expect(seen).toEqual([
      { type: 'activity', activity: { id: '1001-1', side: 'buy', token: HEXE, ticker: 'HEXE', trader: trades[0].trader, eth: '0.01', time: at, txHash: '0xt1001-1' } },
      { type: 'activity', activity: expect.objectContaining({ id: '1004-1', side: 'sell', ticker: 'EULER', eth: '0.2' }) },
    ]);

    trades.push(trade('1010-1', HEXE, eth(0.5), 1_010, at));
    expect(await tick()).toBe(1);
    expect(f.asked[1][1]).toEqual({ afterBlock: 1_004 });
    expect(await tick()).toBe(0);
  });

  it('moves past old trades without pushing them', async () => {
    await coin(HEXE, 'HEXE', { hood: false });
    const at = Math.floor(ctx.now().getTime() / 1000);
    const f = fakeEnvio([trade('1001-1', HEXE, eth(1), 1_001, at - 3_600), trade('1002-1', HEXE, eth(1), 1_002, at)]);
    expect(await activityTick({ db: ctx.db, pubsub: ctx.pubsub, envio: f.envio, network: ctx.app.deps.env.network, now: ctx.now })).toBe(1);
    expect(await activityTick({ db: ctx.db, pubsub: ctx.pubsub, envio: f.envio, network: ctx.app.deps.env.network, now: ctx.now })).toBe(0);
    expect(f.asked[1][1]).toEqual({ afterBlock: 1_002 });
  });

  it('serves the last 15 minutes of notable trades, oldest first, and an empty list without an indexer', async () => {
    const at = Math.floor(ctx.now().getTime() / 1000);
    const f = fakeEnvio([trade('1-1', HEXE, eth(0.1), 1, at - 20 * 60), trade('2-1', HEXE, eth(0.1), 2, at - 120), trade('3-1', HEXE, eth(0.02), 3, at - 60, false)]);
    await ctx.close();
    ctx = await setup({ envio: f.envio });
    await coin(HEXE, 'HEXE', { hood: false });
    const res = await ctx.app.inject({ method: 'GET', url: '/activity/recent' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: ActivityItem) => [i.id, i.side, i.ticker])).toEqual([
      ['2-1', 'buy', 'HEXE'],
      ['3-1', 'sell', 'HEXE'],
    ]);
    expect(f.asked[0][1]).toEqual({ since: at - 15 * 60 });

    await ctx.close();
    ctx = await setup();
    expect((await ctx.app.inject({ method: 'GET', url: '/activity/recent' })).json()).toEqual({ items: [] });
  }, 30_000);

  it('answers an empty list when the indexer fails', async () => {
    const envio = { notableTrades: async () => Promise.reject(new Error('Envio GraphQL answered 429')) } as unknown as EnvioClient;
    await ctx.close();
    ctx = await setup({ envio });
    await coin(HEXE, 'HEXE', { hood: false });
    const res = await ctx.app.inject({ method: 'GET', url: '/activity/recent' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
  });
});
