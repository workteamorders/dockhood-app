import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const token = {
  token: '0x1111111111111111111111111111111111111111', curve: '0x2222222222222222222222222222222222222222',
  name: 'Test', symbol: 'TEST', logo: '', pair: { address: '0x3333333333333333333333333333333333333333', symbol: 'Unknown', decimals: null },
  hood: false, statement: null, blurb: null, rigorScore: null, phase: 0, price: null, marketCap: null, progress: null,
  volume24h: null, trades24h: null, launchedAt: '', stateUpdatedAt: null,
};

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_API_URL', '/api');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each([null, 0, 6, 18])('accepts pair decimals %s in token lists, detail and portfolio', async (decimals) => {
  const item = { ...token, pair: { ...token.pair, decimals } };
  const holding = {
    ...item, launchedByMe: true, balance: 1, value: null, costBasis: null, pnl: null, pnlPct: null,
  };
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ items: [item], total: 1, hoodCount: 0, offset: 0, volume: false }))
    .mockResolvedValueOnce(Response.json({ ...item, deployer: item.token, description: '', metadataCid: null }))
    .mockResolvedValueOnce(Response.json({ wallet: item.token, holdings: [holding], launches: [item], tradeHistory: false }));
  vi.stubGlobal('fetch', fetch);
  const { fetchTokens, fetchToken, fetchPortfolio } = await import('./api');
  expect((await fetchTokens({ tab: 'all', sort: 'latest', limit: 10, offset: 0 })).items[0].pair.decimals).toBe(decimals);
  expect((await fetchToken(item.token)).pair.decimals).toBe(decimals);
  const portfolio = await fetchPortfolio(item.token);
  expect(portfolio.holdings[0].pair.decimals).toBe(decimals);
  expect(portfolio.launches[0].pair.decimals).toBe(decimals);
});

it.each([-1, 256, 1.5])('rejects invalid pair decimals %s', async (decimals) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    ...token, pair: { ...token.pair, decimals }, deployer: token.token, description: '', metadataCid: null,
  })));
  const { fetchToken } = await import('./api');
  await expect(fetchToken(token.token)).rejects.toThrow('unexpected response');
});
