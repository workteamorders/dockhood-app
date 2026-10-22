import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import {
  ETH_PAIR, EXPLORER_MAINNET, EXPLORER_TESTNET, HEXE_TOKEN, LAUNCH_PAIRS, MULTICALL3,
  NATIVE_PAIR, PAIR_TOKENS, PONS_V1_FACTORY, PONS_V2, PUBLIC_RPC_MAINNET, PUBLIC_RPC_TESTNET,
  findPair, resolveNetwork, robinhoodChain, robinhoodTestnet, type NetworkConfig, type PairToken,
} from './index';

const targets = {
  launchFactory: '0x0000000000000000000000000000000000001001',
  launchAndBuy: '0x0000000000000000000000000000000000001002',
} as const;
const testnetInput = { chainId: 46630, ...targets };
const token: PairToken = {
  address: '0xabcdef0000000000000000000000000000001003',
  symbol: 'TEST', name: 'Test Dollar', decimals: 6, kind: 'stable',
};

describe('resolveNetwork', () => {
  it('preserves the shipped mainnet defaults and launch ordering', () => {
    const network: NetworkConfig = resolveNetwork({});
    expect(network.chainId).toBe(4663);
    expect(network.chain).toEqual({ ...robinhoodChain(), extend: expect.any(Function) });
    expect(network.rpcUrl).toBe(PUBLIC_RPC_MAINNET);
    expect(network.explorerUrl).toBe(EXPLORER_MAINNET);
    expect(network.pons).toEqual({ launchFactory: PONS_V2.launchFactory, launchAndBuy: PONS_V2.launchAndBuy });
    expect(network.pairs).toEqual(PAIR_TOKENS);
    expect(network.pairs.every((pair) => pair.kind !== 'native' && pair.address !== NATIVE_PAIR)).toBe(true);
    expect(network.launchPairs).toEqual(LAUNCH_PAIRS);
    expect(network.officialToken).toEqual({ address: HEXE_TOKEN.address, ticker: 'DOCK' });
    expect(network.txUrl('0x123')).toBe(`${EXPLORER_MAINNET}/tx/0x123`);
    expect(network.addressUrl(token.address)).toBe(`${EXPLORER_MAINNET}/address/${token.address}`);
  });

  it.each([4663, '4663', 46630, '46630'])('selects chain %s explicitly', (chainId) => {
    const network = resolveNetwork({ chainId, ...targets });
    const testnet = Number(chainId) === 46630;
    expect(network.chainId).toBe(Number(chainId));
    expect(network.chain).toEqual({ ...(testnet ? robinhoodTestnet() : robinhoodChain()), extend: expect.any(Function) });
    expect(network.rpcUrl).toBe(testnet ? PUBLIC_RPC_TESTNET : PUBLIC_RPC_MAINNET);
    expect(network.chain.contracts.multicall3.address).toBe(MULTICALL3);
  });

  it('binds RPC, explorer helpers and Multicall3 to testnet', () => {
    const network = resolveNetwork({ ...testnetInput, rpcUrl: 'http://127.0.0.1:8545' });
    expect(network.pons).toEqual(targets);
    expect(network.chain).toEqual({ ...robinhoodTestnet('http://127.0.0.1:8545'), extend: expect.any(Function) });
    expect(network.rpcUrl).toBe('http://127.0.0.1:8545');
    expect(network.chain.testnet).toBe(true);
    expect(network.explorerUrl).toBe(EXPLORER_TESTNET);
    expect(network.txUrl('0x123')).toBe(`${EXPLORER_TESTNET}/tx/0x123`);
    expect(network.addressUrl(token.address)).toBe(`${EXPLORER_TESTNET}/address/${token.address}`);
  });

  it.each(['', '1', 1, 0, -4663, 46630.1, Number.NaN, Number.POSITIVE_INFINITY, '0x1237', '46630.0', ' 46630'])('rejects unsupported chain ID %s', (chainId) => {
    expect(() => resolveNetwork({ chainId, ...targets })).toThrow(/Unsupported chain ID/);
  });

  it.each(['', 'not-a-url', 'file:///tmp/rpc', 'ws://localhost:8545'])('rejects invalid RPC URL %s', (rpcUrl) => {
    expect(() => resolveNetwork({ rpcUrl })).toThrow(/rpcUrl/);
  });

  it('requires both explicit testnet deployments, never a partial mainnet fallback', () => {
    expect(() => resolveNetwork({ chainId: 46630 })).toThrow(/launchFactory/);
    expect(() => resolveNetwork({ chainId: 46630, launchAndBuy: targets.launchAndBuy })).toThrow(/launchFactory/);
    expect(() => resolveNetwork({ chainId: 46630, launchFactory: targets.launchFactory })).toThrow(/launchAndBuy/);
  });

  it.each(['launchFactory', 'launchAndBuy'] as const)('rejects invalid or zero %s on either chain', (field) => {
    for (const chainId of [4663, 46630]) {
      for (const address of ['', '0x123', '0x' + 'g'.repeat(40), NATIVE_PAIR]) {
        expect(() => resolveNetwork({ chainId, ...targets, [field]: address })).toThrow(new RegExp(field));
      }
    }
  });

  it.each(['launchFactory', 'launchAndBuy'] as const)('rejects every known mainnet Pons deployment as testnet %s', (field) => {
    for (const address of [PONS_V1_FACTORY, ...Object.values(PONS_V2)]) {
      expect(() => resolveNetwork({ ...testnetInput, [field]: address.toLowerCase() })).toThrow(/mainnet Pons/);
    }
  });

  it('does not inherit mainnet catalog or official-token identity on testnet', () => {
    const network = resolveNetwork(testnetInput);
    expect(network.pairs).toEqual([]);
    expect(network.launchPairs).toEqual([ETH_PAIR]);
    expect(network.officialToken).toBeNull();
    expect(network.findPair(PAIR_TOKENS[0].address)).toBeUndefined();
    expect(network.findPair(HEXE_TOKEN.address)).toBeUndefined();
    expect(network.findPair(NATIVE_PAIR)).toEqual(ETH_PAIR);
    expect(resolveNetwork({}).officialToken?.address).toBe(HEXE_TOKEN.address);
  });

  it('uses only the explicitly selected catalog and official address', () => {
    const network = resolveNetwork({ ...testnetInput, pairs: [token], officialToken: token.address });
    expect(network.pairs).toEqual([token]);
    expect(network.launchPairs).toEqual([ETH_PAIR, token]);
    expect(network.findPair(token.address.toUpperCase())).toEqual(token);
    expect(network.findPair(PAIR_TOKENS[0].address)).toBeUndefined();
    expect(network.officialToken).toEqual({ address: token.address, ticker: 'DOCK' });
    expect(resolveNetwork(testnetInput).officialToken).toBeNull();
    expect(resolveNetwork({}).findPair(token.address)).toBeUndefined();
    expect(resolveNetwork({ pairs: [], officialToken: null }).pairs).toEqual([]);
    expect(resolveNetwork({ officialToken: null }).officialToken).toBeNull();
    expect(resolveNetwork({ pairs: [token], officialToken: token.address }).officialToken?.address).toBe(token.address);
  });

  it('copies catalog entries rather than sharing caller or default catalog mutations', () => {
    const custom = { ...token };
    const network = resolveNetwork({ ...testnetInput, pairs: [custom] });
    custom.symbol = 'CHANGED';
    expect(network.findPair(token.address)?.symbol).toBe('TEST');
    const mainnet = resolveNetwork({});
    mainnet.pairs[0].symbol = 'CHANGED';
    expect(resolveNetwork({}).pairs[0].symbol).toBe(PAIR_TOKENS[0].symbol);
  });

  it.each(['', 'invalid', NATIVE_PAIR])('rejects invalid official token %s', (officialToken) => {
    expect(() => resolveNetwork({ ...testnetInput, officialToken })).toThrow(/officialToken/);
  });

  it.each([-1, 1.5, 256, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid decimals %s', (decimals) => {
    expect(() => resolveNetwork({ pairs: [{ ...token, decimals }] })).toThrow(/decimals/);
  });

  it.each([0, 6, 18, 255])('accepts ERC20 uint8 decimals %s', (decimals) => {
    expect(resolveNetwork({ pairs: [{ ...token, decimals }] }).pairs[0].decimals).toBe(decimals);
  });

  it('rejects invalid kinds, native conflicts, malformed addresses and duplicates', () => {
    for (const pair of [
      ETH_PAIR,
      { ...token, kind: 'native' },
      { ...token, address: NATIVE_PAIR },
      { ...token, address: '0x123' as Address },
      { ...token, kind: 'invalid' as PairToken['kind'] },
      { ...token, symbol: '' },
      { ...token, name: ' ' },
    ] satisfies PairToken[]) {
      expect(() => resolveNetwork({ pairs: [pair] })).toThrow(/pairs\[0\]/);
    }
    expect(() => resolveNetwork({ pairs: [token, { ...token, address: `0x${token.address.slice(2).toUpperCase()}` }] })).toThrow(/duplicate/);
  });

  it('allows an explicit empty catalog without changing the legacy findPair default', () => {
    expect(findPair(PAIR_TOKENS[0].address)).toEqual(PAIR_TOKENS[0]);
    expect(findPair(PAIR_TOKENS[0].address, [])).toBeUndefined();
    expect(findPair(token.address.toUpperCase(), [token])).toEqual(token);
    expect(findPair(NATIVE_PAIR, [])).toEqual(ETH_PAIR);
  });
});
