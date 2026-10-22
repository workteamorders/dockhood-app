import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveNetwork } from '@hood/shared';
import { envioClient, minuteLimiter } from './services/envio';

const mainnet = resolveNetwork();
afterEach(() => vi.unstubAllGlobals());

describe('minuteLimiter', () => {
  it('lets n requests start per 60 s and makes the next one wait', async () => {
    let t = 0;
    const waits: number[] = [];
    const slot = minuteLimiter(3, () => t, async (ms) => {
      waits.push(ms);
      t += ms;
    });
    for (let i = 0; i < 3; i++) await slot();
    expect(waits).toEqual([]);
    t = 10_000;
    await slot(); // the 4th waits until the 1st is a minute old
    expect(waits).toHaveLength(1);
    expect(t).toBeGreaterThanOrEqual(60_000);
  });
});

describe('envioClient', () => {
  it('uses the configured chain metadata and rejects other or mixed networks', async () => {
    const network = resolveNetwork({ chainId: 46630, launchFactory: '0x0000000000000000000000000000000000000011', launchAndBuy: '0x0000000000000000000000000000000000000012' });
    const client = envioClient('http://envio.test', network);
    const respond = (chains: number[]) => vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: { chain_metadata: chains.map((chain_id) => ({ chain_id, latest_processed_block: 123 })) } })));
    respond([46630]);
    expect(await client.latestBlock()).toBe(123);
    respond([4663]);
    await expect(client.latestBlock()).rejects.toThrow(/chain mismatch.*46630/);
    respond([4663, 46630]);
    await expect(client.latestBlock()).rejects.toThrow(/chain mismatch/);
    respond([]);
    await expect(client.latestBlock()).rejects.toThrow(/not indexed/);
  });

  it('shares lazy validation across concurrent reads and refreshes identity on every head read', async () => {
    let chainId = mainnet.chainId;
    const queries: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(init.body as string);
      queries.push(query);
      const data = query.includes('chain_metadata') ? { chain_metadata: [{ chain_id: chainId, latest_processed_block: 123 }] } : { Trade: [] };
      return new Response(JSON.stringify({ data }));
    });
    const client = envioClient('http://envio.test', mainnet);
    expect(queries).toEqual([]);
    await Promise.all([client.trades('token', 1), client.trades('token', 1)]);
    expect(queries.filter((query) => query.includes('chain_metadata'))).toHaveLength(1);
    expect(queries.filter((query) => query.includes('query Trades'))).toHaveLength(2);
    expect(await client.latestBlock()).toBe(123);
    expect(queries.filter((query) => query.includes('chain_metadata'))).toHaveLength(2);
    chainId = 46630;
    await expect(client.latestBlock()).rejects.toThrow(/chain mismatch/);
    await expect(client.trades('token', 1)).rejects.toThrow(/chain mismatch/);
    expect(queries.filter((query) => query.includes('query Trades'))).toHaveLength(2);
    chainId = mainnet.chainId;
    await expect(client.trades('token', 1)).resolves.toEqual([]);
  });

  it.each(['offline', 'unready', 'empty'] as const)('retries failed validation after an %s indexer without fetching unvalidated data', async (failure) => {
    let ready = false;
    const queries: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(init.body as string);
      queries.push(query);
      if (!ready && failure === 'offline') return new Response('', { status: 503 });
      const chains = !ready && failure === 'empty' ? [] : [{ chain_id: mainnet.chainId, latest_processed_block: ready ? 123 : null }];
      const data = query.includes('chain_metadata') ? { chain_metadata: chains } : { Trade: [] };
      return new Response(JSON.stringify({ data }));
    });
    const client = envioClient('http://envio.test', mainnet);
    await expect(client.trades('token', 1)).rejects.toThrow(failure === 'offline' ? /503/ : /not indexed/);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('chain_metadata');
    ready = true;
    await expect(client.trades('token', 1)).resolves.toEqual([]);
    expect(queries).toHaveLength(3);
  });

  const reads = [
    (client: ReturnType<typeof envioClient>) => client.launches(0, 1),
    (client: ReturnType<typeof envioClient>) => client.activity([], 0),
    (client: ReturnType<typeof envioClient>) => client.candles('token', 300, 1),
    (client: ReturnType<typeof envioClient>) => client.bigBuys([], 1n, 0),
    (client: ReturnType<typeof envioClient>) => client.notableTrades([], { afterBlock: 0 }),
    (client: ReturnType<typeof envioClient>) => client.walletPositions('wallet'),
    (client: ReturnType<typeof envioClient>) => client.latestWalletTrade('wallet', 'token', 0),
    (client: ReturnType<typeof envioClient>) => client.trades('token', 1),
  ];
  it.each(reads.map((read, i) => ({ read, method: i })))('blocks data method $method on wrong-chain or mixed-chain metadata', async ({ read }) => {
    for (const chains of [[46630], [4663, 46630]]) {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { chain_metadata: chains.map((chain_id) => ({ chain_id, latest_processed_block: 123 })) } })));
      vi.stubGlobal('fetch', fetchMock);
      await expect(read(envioClient('http://envio.test', mainnet))).rejects.toThrow(/chain mismatch/);
      expect(fetchMock).toHaveBeenCalledOnce();
    }
  });

  it('waits and retries when Envio answers 429', async () => {
    const answers = [
      new Response('', { status: 429, headers: { 'retry-after': '1' } }),
      new Response(JSON.stringify({ data: { chain_metadata: [{ chain_id: 4663, latest_processed_block: 123 }] } }), { status: 200 }),
    ];
    const fetchMock = vi.fn(async () => answers.shift()!);
    vi.stubGlobal('fetch', fetchMock);
    expect(await envioClient('http://envio.test', mainnet).latestBlock()).toBe(123);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after a few 429s', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429, headers: { 'retry-after': '1' } })));
    await expect(envioClient('http://envio.test', mainnet).latestBlock()).rejects.toThrow(/429/);
  }, 10_000);
});
