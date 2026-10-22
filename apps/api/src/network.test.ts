import { afterEach, describe, expect, it, vi } from 'vitest';
import { PONS_V2, PUBLIC_RPC_MAINNET, PUBLIC_RPC_TESTNET, HEXE_TOKEN } from '@hood/shared';
import { loadEnv } from './env';
import { assertRpcChain } from './services/network';

const testnet = {
  DATABASE_URL: 'memory',
  CHAIN_ID: '46630',
  PONS_LAUNCH_FACTORY: '0x0000000000000000000000000000000000000011',
  PONS_LAUNCH_AND_BUY: '0x0000000000000000000000000000000000000012',
};

afterEach(() => vi.unstubAllGlobals());

describe('API network environment', () => {
  it('preserves mainnet deployments and public RPC by default', () => {
    const { network } = loadEnv({ DATABASE_URL: 'memory' });
    expect(network.chainId).toBe(4663);
    expect(network.rpcUrl).toBe(PUBLIC_RPC_MAINNET);
    expect(network.pons.launchFactory).toBe(PONS_V2.launchFactory);
    expect(network.pons.launchAndBuy).toBe(PONS_V2.launchAndBuy);
    expect(network.officialToken?.address).toBe(HEXE_TOKEN.address);
    expect(network.pairs.length).toBeGreaterThan(0);
  });

  it.each(['1', '31337', 'garbage', '-4663', '4663.5'])('rejects unsupported CHAIN_ID %s', (CHAIN_ID) => {
    expect(() => loadEnv({ DATABASE_URL: 'memory', CHAIN_ID })).toThrow(/CHAIN_ID/);
  });

  it('fails closed on missing or mainnet testnet targets', () => {
    expect(() => loadEnv({ DATABASE_URL: 'memory', CHAIN_ID: '46630' })).toThrow(/launchFactory/);
    expect(() => loadEnv({ ...testnet, PONS_LAUNCH_AND_BUY: '' })).toThrow(/launchAndBuy/);
    expect(() => loadEnv({ ...testnet, PONS_LAUNCH_FACTORY: PONS_V2.launchFactory })).toThrow(/mainnet/);
  });

  it('resolves testnet once, with no inherited mainnet pairs or official token', () => {
    const { network } = loadEnv(testnet);
    expect(network.chainId).toBe(46630);
    expect(network.chain.id).toBe(46630);
    expect(network.rpcUrl).toBe(PUBLIC_RPC_TESTNET);
    expect(network.pairs).toEqual([]);
    expect(network.launchPairs.map((p) => p.symbol)).toEqual(['ETH']);
    expect(network.officialToken).toBeNull();
  });

  it('accepts explicit RPC, pair catalog and official token overrides', () => {
    const pair = { address: '0x0000000000000000000000000000000000000013', symbol: 'TEST', name: 'Test USD', decimals: 6, kind: 'stable' };
    const { network } = loadEnv({ ...testnet, RPC_URL_SERVER: 'https://rpc.example', PAIR_TOKENS_JSON: JSON.stringify([pair]), OFFICIAL_TOKEN_ADDRESS: testnet.PONS_LAUNCH_AND_BUY });
    expect(network.rpcUrl).toBe('https://rpc.example');
    expect(network.findPair(pair.address)).toEqual(pair);
    expect(network.officialToken).toEqual({ address: testnet.PONS_LAUNCH_AND_BUY, ticker: 'DOCK' });
  });

  it.each(['not json', 'null', '{}', '[{}]', '[{"address":"invalid"}]'])('rejects malformed PAIR_TOKENS_JSON %s', (PAIR_TOKENS_JSON) => {
    expect(() => loadEnv({ ...testnet, PAIR_TOKENS_JSON })).toThrow(/PAIR_TOKENS_JSON/);
  });

  it('rejects invalid RPC and contract/token addresses', () => {
    for (const override of [{ RPC_URL_SERVER: 'ftp://example.com' }, { PONS_LAUNCH_FACTORY: 'invalid' }, { OFFICIAL_TOKEN_ADDRESS: 'invalid' }]) {
      expect(() => loadEnv({ ...testnet, ...override })).toThrow(/network configuration/);
    }
  });
});

describe('RPC startup chain guard', () => {
  it('requests eth_chainId from the selected endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: `0x${(46630).toString(16)}` })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(assertRpcChain(loadEnv(testnet).network)).resolves.toBeUndefined();
    expect(String(fetchMock.mock.calls[0][0])).toBe(PUBLIC_RPC_TESTNET + '/');
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).method).toBe('eth_chainId');
  });

  it('refuses a mainnet endpoint configured as testnet', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: `0x${(4663).toString(16)}` })));
    await expect(assertRpcChain(loadEnv(testnet).network)).rejects.toThrow(/expected 46630, received 4663/);
  });

  it('fails closed when RPC is unavailable', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('offline'); });
    await expect(assertRpcChain(loadEnv(testnet).network)).rejects.toThrow();
  });
});
