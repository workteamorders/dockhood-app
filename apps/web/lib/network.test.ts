import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ETH_PAIR, EXPLORER_MAINNET, EXPLORER_TESTNET, HEXE_TOKEN, LAUNCH_PAIRS, NATIVE_PAIR,
  PAIR_TOKENS, PONS_V2, PUBLIC_RPC_MAINNET, PUBLIC_RPC_TESTNET, buildTokenParams, planLaunch,
} from '@hood/shared';
import { zeroHash } from 'viem';
import { useBalance, useReadContract, useReadContracts } from 'wagmi';

vi.mock('wagmi', () => ({ useBalance: vi.fn(() => ({})), useReadContract: vi.fn(() => ({})), useReadContracts: vi.fn(() => ({})) }));

const factory = '0x1111111111111111111111111111111111111111';
const router = '0x2222222222222222222222222222222222222222';
const token = '0x3333333333333333333333333333333333333333';
const pair = { address: '0x4444444444444444444444444444444444444444', symbol: 'TEST', name: 'Test USD', decimals: 6, kind: 'stable' } as const;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const key of [
    'NEXT_PUBLIC_CHAIN_ID', 'NEXT_PUBLIC_RPC_URL', 'NEXT_PUBLIC_PONS_LAUNCH_FACTORY',
    'NEXT_PUBLIC_PONS_LAUNCH_AND_BUY', 'NEXT_PUBLIC_PAIR_TOKENS_JSON', 'NEXT_PUBLIC_OFFICIAL_TOKEN_ADDRESS',
  ]) vi.stubEnv(key, '');
});
afterEach(() => vi.unstubAllEnvs());

function testnet() {
  vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '46630');
  vi.stubEnv('NEXT_PUBLIC_PONS_LAUNCH_FACTORY', factory);
  vi.stubEnv('NEXT_PUBLIC_PONS_LAUNCH_AND_BUY', router);
}

describe('web network configuration', () => {
  it('preserves mainnet defaults with an empty env example', async () => {
    const { network, appRpc } = await import('./network');
    expect(network.chainId).toBe(4663);
    expect(network.chain.id).toBe(4663);
    expect(appRpc).toBe(PUBLIC_RPC_MAINNET);
    expect(network.pons).toEqual({ launchFactory: PONS_V2.launchFactory, launchAndBuy: PONS_V2.launchAndBuy });
    expect(network.pairs).toEqual(PAIR_TOKENS);
    expect(network.launchPairs).toEqual(LAUNCH_PAIRS);
    expect(network.officialToken).toEqual({ address: HEXE_TOKEN.address, ticker: 'DOCK' });
    expect(network.txUrl('0x123')).toBe(`${EXPLORER_MAINNET}/tx/0x123`);
  });

  it('fails closed when testnet targets are missing or incomplete', async () => {
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '46630');
    await expect(import('./network')).rejects.toThrow();
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_PONS_LAUNCH_FACTORY', factory);
    await expect(import('./network')).rejects.toThrow();
  });

  it.each([
    ['NEXT_PUBLIC_PONS_LAUNCH_FACTORY', PONS_V2.launchFactory],
    ['NEXT_PUBLIC_PONS_LAUNCH_AND_BUY', PONS_V2.launchAndBuy],
  ])('rejects a mainnet deployment in testnet %s', async (key, value) => {
    testnet();
    vi.stubEnv(key, value);
    await expect(import('./network')).rejects.toThrow('mainnet Pons address');
  });

  it('does not expose the mainnet catalog, official token, RPC or explorer on testnet', async () => {
    testnet();
    const { network, appRpc, findPair, launchPairs, addressUrl, txUrl } = await import('./network');
    const { HOOD_TOKEN, displayTicker } = await import('./hoodToken');
    expect(network.chainId).toBe(46630);
    expect(network.chain.testnet).toBe(true);
    expect(network.chain.rpcUrls.default.http).toEqual([PUBLIC_RPC_TESTNET]);
    expect(appRpc).toBe(PUBLIC_RPC_TESTNET);
    expect(network.pons).toEqual({ launchFactory: factory, launchAndBuy: router });
    expect(network.pairs).toEqual([]);
    expect(launchPairs).toEqual([ETH_PAIR]);
    expect(findPair(NATIVE_PAIR)).toEqual(ETH_PAIR);
    expect(findPair(PAIR_TOKENS[0].address)).toBeUndefined();
    expect(network.officialToken).toBeNull();
    expect(HOOD_TOKEN).toBeNull();
    expect(displayTicker(HEXE_TOKEN.address, 'HEXE')).toBe('HEXE');
    expect(addressUrl(token)).toBe(`${EXPLORER_TESTNET}/address/${token}`);
    expect(txUrl('0x123')).toBe(`${EXPLORER_TESTNET}/tx/0x123`);
  });

  it('uses only the explicit pair and official token overrides on testnet', async () => {
    testnet();
    vi.stubEnv('NEXT_PUBLIC_PAIR_TOKENS_JSON', JSON.stringify([pair]));
    vi.stubEnv('NEXT_PUBLIC_OFFICIAL_TOKEN_ADDRESS', token);
    const { network, findPair, launchPairs } = await import('./network');
    const { HOOD_TOKEN, displayTicker } = await import('./hoodToken');
    expect(network.pairs).toEqual([pair]);
    expect(launchPairs).toEqual([ETH_PAIR, pair]);
    expect(findPair(pair.address.toUpperCase())).toEqual(pair);
    expect(HOOD_TOKEN).toEqual({ address: token, ticker: 'DOCK' });
    expect(displayTicker(token.toUpperCase(), 'TEST')).toBe('DOCK');
    expect(displayTicker(HEXE_TOKEN.address, 'HEXE')).toBe('HEXE');
    expect(displayTicker(token, null)).toBeNull();
    expect(displayTicker(token, undefined)).toBeUndefined();
  });

  it.each(['4663', '46630'])('keeps a relative app proxy with a chain-specific public wallet/SSR fallback on %s', async (chainId) => {
    if (chainId === '46630') testnet();
    vi.stubEnv('NEXT_PUBLIC_RPC_URL', '/api/rpc');
    const { appRpc, network } = await import('./network');
    const fallback = chainId === '46630' ? PUBLIC_RPC_TESTNET : PUBLIC_RPC_MAINNET;
    expect(appRpc).toBe('/api/rpc');
    expect(network.rpcUrl).toBe(fallback);
    expect(network.chain.rpcUrls.default.http).toEqual([fallback]);
  });

  it('uses an explicit absolute browser-safe RPC', async () => {
    testnet();
    vi.stubEnv('NEXT_PUBLIC_RPC_URL', 'https://rpc.example.test');
    const { appRpc, network } = await import('./network');
    expect(appRpc).toBe('https://rpc.example.test');
    expect(network.chain.rpcUrls.default.http).toEqual([appRpc]);
  });

  it.each([
    ['NEXT_PUBLIC_CHAIN_ID', '1'],
    ['NEXT_PUBLIC_RPC_URL', 'not-a-url'],
    ['NEXT_PUBLIC_RPC_URL', '//rpc.example.test'],
    ['NEXT_PUBLIC_PAIR_TOKENS_JSON', '{broken'],
    ['NEXT_PUBLIC_PAIR_TOKENS_JSON', '{}'],
    ['NEXT_PUBLIC_PAIR_TOKENS_JSON', 'null'],
    ['NEXT_PUBLIC_PAIR_TOKENS_JSON', 'false'],
    ['NEXT_PUBLIC_PAIR_TOKENS_JSON', '[{"address":"bad"}]'],
    ['NEXT_PUBLIC_PONS_LAUNCH_FACTORY', 'bad'],
    ['NEXT_PUBLIC_PONS_LAUNCH_AND_BUY', 'bad'],
    ['NEXT_PUBLIC_OFFICIAL_TOKEN_ADDRESS', 'bad'],
  ])('rejects invalid %s instead of silently using defaults', async (key, value) => {
    vi.stubEnv(key, value);
    await expect(import('./network')).rejects.toThrow();
  });

  it('plans bare, native-buy and ERC20-buy launches against the selected targets', async () => {
    testnet();
    const { network } = await import('./network');
    const params = buildTokenParams({
      name: 'Test', symbol: 'TEST', logo: '', description: '', socials: { twitter: '', telegram: '', website: '' },
      creatorFeeRecipient: token, creatorTaxBps: 0, buybackEnabled: false, expectedEconomics: zeroHash, salt: zeroHash,
    });
    const input = { params, launchConfigId: 0n, pairToken: NATIVE_PAIR, launchFee: 10n, quoteIn: 0n, minTokensOut: 0n, recipient: token } as const;
    expect(planLaunch(input, network.pons).request.address).toBe(factory);
    const native = planLaunch({ ...input, quoteIn: 20n }, network.pons);
    expect(native.request.address).toBe(router);
    expect(native.request.value).toBe(30n);
    expect(native.approval).toBeNull();
    const erc20 = planLaunch({ ...input, pairToken: pair.address, quoteIn: 20n }, network.pons);
    expect(erc20.request.address).toBe(router);
    expect(erc20.request.value).toBe(10n);
    expect(erc20.approval).toEqual({ token: pair.address, spender: router, amount: 20n });
  });

  it('reads Pons launch terms and permissions from the selected testnet factory', async () => {
    testnet();
    const { useLaunchTerms, useCanLaunch, pairSymbol } = await import('./pons/launch');
    useLaunchTerms(NATIVE_PAIR);
    useCanLaunch(token);
    const reads = vi.mocked(useReadContracts).mock.calls[0][0]?.contracts;
    expect(reads).toEqual(Array.from({ length: 6 }, () => expect.objectContaining({ address: factory, chainId: 46630 })));
    expect(useReadContract).toHaveBeenCalledWith(expect.objectContaining({ address: factory, chainId: 46630, functionName: 'canLaunch', args: [token] }));
    expect(pairSymbol(NATIVE_PAIR)).toBe('ETH');
    expect(pairSymbol(PAIR_TOKENS[0].address)).toBe('tokens');
  });

  it.each(['4663', '46630'])('pins curve and balance reads to selected chain %s', async (chainId) => {
    if (chainId === '46630') testnet();
    const { useLiveCurve, useTradeBalances } = await import('./pons/curve');
    useLiveCurve(router, token, true);
    useTradeBalances(token, NATIVE_PAIR, router, token);
    useTradeBalances(token, pair.address, router, token);
    expect(useBalance).toHaveBeenCalledWith(expect.objectContaining({ address: token, chainId: Number(chainId) }));
    for (const [index, count] of [7, 4, 4].entries()) {
      expect(vi.mocked(useReadContracts).mock.calls[index][0]?.contracts).toEqual(
        Array.from({ length: count }, () => expect.objectContaining({ chainId: Number(chainId) })),
      );
    }
  });
});
