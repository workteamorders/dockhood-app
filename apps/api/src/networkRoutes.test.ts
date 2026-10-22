import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { parseEther, type Address } from 'viem';
import { HEXE_TOKEN, NATIVE_PAIR, PUBLIC_RPC_TESTNET } from '@hood/shared';
import { newGame, PRESETS, reveal, type RankedMove } from '@hood/shared/minesweeper';
import { schema } from './db';
import { envioClient, type EnvioClient } from './services/envio';
import { loadEnv } from './env';
import { alice, setup, signIn, siweMessage } from './test/helpers';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const env = { CHAIN_ID: '46630', PONS_LAUNCH_FACTORY: addr(11), PONS_LAUNCH_AND_BUY: addr(12) };
let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
  vi.unstubAllGlobals();
});

describe('testnet API routes', { timeout: 30_000 }, () => {
  it('accepts testnet SIWE and rejects a mainnet sign-in', async () => {
    ctx = await setup({ env });
    const message = await siweMessage(ctx, alice, { chainId: 4663 });
    const rejected = await ctx.app.inject({ method: 'POST', url: '/auth/siwe', payload: { message, signature: await alice.signMessage({ message }) } });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toMatch(/Testnet/);
    const cookie = await signIn(ctx);
    expect((await ctx.app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).json().wallet).toBe(alice.address);
  });

  it('falls back to the testnet RPC, not mainnet', async () => {
    ctx = await setup({ env });
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xb626' })));
    vi.stubGlobal('fetch', fetchMock);
    const response = await ctx.app.inject({ method: 'POST', url: '/rpc', payload: { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] } });
    expect(response.statusCode).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe(PUBLIC_RPC_TESTNET);
  });

  it.each([true, false])('values a six-decimal pair only with catalog metadata (configured=%s)', async (configured) => {
    const pair = { address: addr(13), symbol: 'TUSD', name: 'Test USD', decimals: 6, kind: 'stable' };
    const envio = {
      walletPositions: async () => [{ token: addr(1), qty: parseEther('1'), cost: 1_000_000n }],
      candles: async () => [{ bucketStart: 300, open: '2e-12', high: '2e-12', low: '2e-12', close: '2e-12', volumeQuote: 3_000_000n, trades: 1 }],
      trades: async () => [{ id: '1', trader: alice.address, isBuy: true, quoteAmount: 2_000_000n, tokenAmount: parseEther('1'), price: '2e-12', timestamp: 1, txHash: '0x1' }],
    } as unknown as EnvioClient;
    ctx = await setup({ env: { ...env, ...(configured ? { PAIR_TOKENS_JSON: JSON.stringify([pair]) } : {}) }, envio });
    await ctx.db.insert(schema.tokens).values({
      tokenAddress: addr(1), curveAddress: addr(2), deployer: alice.address, pairToken: pair.address,
      blockNumber: 1, launchedAt: ctx.now(), name: 'Test coin', symbol: 'TEST', logo: '', description: '',
      graduationThreshold: '4000000', quoteReserve: '2000000', tokenReserve: parseEther('1').toString(), realQuoteReserve: '2000000', volume24h: '3000000',
    });
    ctx.tokenBalances.set(`${addr(1)}:${alice.address.toLowerCase()}`, parseEther('1'));
    ctx.market.state.set(addr(1), { phase: 0, quoteReserve: 2_000_000n, tokenReserve: parseEther('1'), realQuoteReserve: 2_000_000n });
    const get = async (url: string) => {
      const response = await ctx!.app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      return response.json();
    };
    const metadata = { address: pair.address, symbol: configured ? 'TUSD' : '?', decimals: configured ? 6 : null };
    const price = configured ? 2 : null;
    expect((await get('/tokens')).items[0]).toMatchObject({ pair: metadata, price, marketCap: configured ? 2e9 : null, volume24h: configured ? 3 : null, progress: 0.5 });
    expect(await get(`/tokens/${addr(1)}`)).toMatchObject({ pair: metadata, price });
    expect((await get(`/tokens/${addr(1)}/candles`)).candles[0]).toMatchObject({ open: price, high: price, low: price, close: price, volume: configured ? 3 : null });
    expect((await get(`/tokens/${addr(1)}/trades`)).trades[0]).toMatchObject({ quote: price, tokens: 1, price });
    const portfolio = await get(`/portfolio/${alice.address}`);
    expect(portfolio.holdings[0]).toMatchObject({ pair: metadata, balance: 1, price, value: price, costBasis: configured ? 1 : null, pnl: configured ? 1 : null, pnlPct: configured ? 100 : null });
    expect(portfolio.launches[0]).toMatchObject({ pair: metadata, price });
  });

  it('serves non-indexer routes while Envio is offline or unready, then recovers gated reads', async () => {
    const network = loadEnv({ DATABASE_URL: 'memory', ...env }).network;
    let head: number | null = null;
    let offline = true;
    const queries: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(init.body as string);
      queries.push(query);
      if (offline) return new Response('', { status: 503 });
      const data = query.includes('chain_metadata') ? { chain_metadata: [{ chain_id: network.chainId, latest_processed_block: head }] } : { Trade: [] };
      return new Response(JSON.stringify({ data }));
    });
    ctx = await setup({ env, envio: envioClient('http://envio.test', network) });
    await ctx.db.insert(schema.tokens).values({
      tokenAddress: addr(1), curveAddress: addr(2), deployer: alice.address, pairToken: NATIVE_PAIR,
      blockNumber: 1, launchedAt: ctx.now(), name: 'Test', symbol: 'TEST', logo: '', description: '', graduationThreshold: '1',
    });
    for (const url of ['/health', '/tokens', '/auth/siwe']) {
      expect((await ctx.app.inject({ method: 'GET', url })).statusCode).toBe(200);
    }
    expect(queries).toEqual([]);
    const trades = () => ctx!.app.inject({ method: 'GET', url: `/tokens/${addr(1)}/trades` });
    expect((await trades()).statusCode).toBe(503);
    offline = false;
    expect((await trades()).statusCode).toBe(503);
    expect(queries.every((query) => query.includes('chain_metadata'))).toBe(true);
    head = 10;
    expect((await trades()).json()).toEqual({ trades: [] });
    expect(queries.filter((query) => !query.includes('chain_metadata'))).toHaveLength(1);
  });

  it.each([false, true])('scopes the DOCK search and callout alias to the official address (configured=%s)', async (configured) => {
    ctx = await setup({ env: { ...env, ...(configured ? { OFFICIAL_TOKEN_ADDRESS: addr(30) } : {}) } });
    const values = { curveAddress: addr(2), deployer: alice.address, pairToken: NATIVE_PAIR, launchedAt: ctx.now(), logo: '', description: '', graduationThreshold: '1' };
    await ctx.db.insert(schema.tokens).values([
      { ...values, tokenAddress: addr(30), name: 'Legacy token', symbol: 'HEXE', blockNumber: 1, hood: false },
      { ...values, tokenAddress: addr(31), name: 'Unrelated token', symbol: 'DOCK', blockNumber: 100, hood: true },
    ]);
    const search = async (text: string) => (await ctx!.app.inject({ method: 'GET', url: `/tokens?q=${encodeURIComponent(text)}` })).json().items;
    const matches = await search('$dOcK');
    expect(matches.map((item: { token: string }) => item.token)).toEqual(configured ? [addr(30)] : [addr(31)]);
    expect(matches[0].symbol).toBe(configured ? 'HEXE' : 'DOCK');
    expect((await search('HEXE'))[0]).toMatchObject({ token: addr(30), symbol: 'HEXE' });
    expect((await search('do'))[0].token).toBe(configured ? addr(30) : addr(31));
    const cookie = await signIn(ctx);
    const response = await ctx.app.inject({ method: 'POST', url: '/callouts', headers: { cookie }, payload: { text: '$dOcK looks good' } });
    expect(response.statusCode).toBe(201);
    expect(response.json().callout).toMatchObject({ tokenAddress: configured ? addr(30) : addr(31), ticker: 'DOCK' });
    if (configured) {
      await ctx.db.delete(schema.tokens).where(eq(schema.tokens.tokenAddress, addr(30)));
      expect(await search('DOCK')).toEqual([]);
      const missing = await ctx.app.inject({ method: 'POST', url: '/callouts', headers: { cookie }, payload: { text: '$DOCK is not indexed' } });
      expect(missing.json().callout).toMatchObject({ tokenAddress: null, ticker: null });
    }
  });

  it.each([false, true])('only badges holders of a configured official token (configured=%s)', async (configured) => {
    ctx = await setup({ env: { ...env, ...(configured ? { OFFICIAL_TOKEN_ADDRESS: addr(30) } : {}) } });
    const balances = vi.spyOn(ctx.app.deps.chain, 'tokenBalances');
    ctx.tokenBalances.set(`${HEXE_TOKEN.address.toLowerCase()}:${alice.address.toLowerCase()}`, parseEther('1'));
    ctx.tokenBalances.set(`${addr(30)}:${alice.address.toLowerCase()}`, parseEther('1'));
    const cookie = await signIn(ctx);
    const run = (await ctx.app.inject({ method: 'POST', url: '/games/minesweeper/start', headers: { cookie }, payload: { level: 'beginner' } })).json();
    const game = reveal(newGame(PRESETS.beginner, true), 0, 0, 0, run.seed);
    const moves: RankedMove[] = [['r', 0, 0]];
    game.board.forEach((row, r) => row.forEach((cell, c) => !cell.isMine && moves.push(['r', r, c])));
    ctx.advance(40_000);
    expect((await ctx.app.inject({ method: 'POST', url: `/games/minesweeper/${run.id}/finish`, headers: { cookie }, payload: { marks: true, moves } })).statusCode).toBe(200);
    const board = (await ctx.app.inject({ method: 'GET', url: '/leaderboard/minesweeper' })).json();
    expect(board.entries[0].holder).toBe(configured);
    if (configured) expect(balances).toHaveBeenCalledWith(alice.address, [addr(30)]);
    else expect(balances).not.toHaveBeenCalled();
  });

  it('does not watch the mainnet official token for testnet activity', async () => {
    const notableTrades = vi.fn<EnvioClient['notableTrades']>(async () => []);
    ctx = await setup({ env, envio: { notableTrades } as unknown as EnvioClient });
    const values = { curveAddress: addr(2), deployer: alice.address, pairToken: NATIVE_PAIR, blockNumber: 1, launchedAt: ctx.now(), name: 'Test', logo: '', description: '', graduationThreshold: '1' };
    await ctx.db.insert(schema.tokens).values([
      { ...values, tokenAddress: HEXE_TOKEN.address, symbol: 'MAINNET', hood: false },
      { ...values, tokenAddress: addr(1), symbol: 'TEST', hood: true },
    ]);
    expect((await ctx.app.inject({ method: 'GET', url: '/activity/recent' })).statusCode).toBe(200);
    expect(notableTrades.mock.calls[0][0]).toEqual([
      { tokens: [], minQuote: 10_000_000_000_000_000n },
      { tokens: [addr(1)], minQuote: 50_000_000_000_000_000n },
    ]);
  });
});
