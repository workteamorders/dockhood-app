import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectorsForWallets } from '@rainbow-me/rainbowkit';
import { injectedWallet } from '@rainbow-me/rainbowkit/wallets';
import { PUBLIC_RPC_MAINNET, PUBLIC_RPC_TESTNET } from '@hood/shared';

vi.mock('@rainbow-me/rainbowkit', () => ({ connectorsForWallets: vi.fn(() => []) }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const key of [
    'NEXT_PUBLIC_CHAIN_ID', 'NEXT_PUBLIC_RPC_URL', 'NEXT_PUBLIC_PONS_LAUNCH_FACTORY',
    'NEXT_PUBLIC_PONS_LAUNCH_AND_BUY', 'NEXT_PUBLIC_PAIR_TOKENS_JSON', 'NEXT_PUBLIC_OFFICIAL_TOKEN_ADDRESS',
    'NEXT_PUBLIC_DEV_WALLET', 'NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID',
  ]) vi.stubEnv(key, '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('selected-chain wagmi configuration', () => {
  it.each(['4663', '46630'])('uses only %s with its public RPC for SSR behind a relative proxy', async (chainId) => {
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', chainId);
    vi.stubEnv('NEXT_PUBLIC_RPC_URL', '/api/rpc');
    vi.stubEnv('NEXT_PUBLIC_PONS_LAUNCH_FACTORY', '0x1111111111111111111111111111111111111111');
    vi.stubEnv('NEXT_PUBLIC_PONS_LAUNCH_AND_BUY', '0x2222222222222222222222222222222222222222');
    const { chain, wagmiConfig } = await import('./wagmi');
    const fallback = chainId === '46630' ? PUBLIC_RPC_TESTNET : PUBLIC_RPC_MAINNET;
    expect(wagmiConfig.chains.map((c) => c.id)).toEqual([Number(chainId)]);
    expect(chain.rpcUrls.default.http).toEqual([fallback]);
    expect(wagmiConfig.getClient().transport.url).toBe(fallback);
  });

  it.each(['4663', '46630'])('resolves the browser proxy without advertising it to wallets on %s', async (chainId) => {
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', chainId);
    vi.stubEnv('NEXT_PUBLIC_PONS_LAUNCH_FACTORY', '0x1111111111111111111111111111111111111111');
    vi.stubEnv('NEXT_PUBLIC_PONS_LAUNCH_AND_BUY', '0x2222222222222222222222222222222222222222');
    vi.stubEnv('NEXT_PUBLIC_RPC_URL', '/api/rpc');
    vi.stubGlobal('window', Object.assign(new EventTarget(), {
      location: { origin: 'https://dockhood.example' },
      localStorage: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    }));
    const { chain, wagmiConfig } = await import('./wagmi');
    expect(chain.rpcUrls.default.http).toEqual([chainId === '46630' ? PUBLIC_RPC_TESTNET : PUBLIC_RPC_MAINNET]);
    expect(wagmiConfig.getClient().transport.url).toBe('https://dockhood.example/api/rpc');
  });

  it('offers only an injected wallet on testnet even with a Reown id and local dev-wallet flag', async () => {
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '46630');
    vi.stubEnv('NEXT_PUBLIC_RPC_URL', 'http://localhost:8545');
    vi.stubEnv('NEXT_PUBLIC_PONS_LAUNCH_FACTORY', '0x1111111111111111111111111111111111111111');
    vi.stubEnv('NEXT_PUBLIC_PONS_LAUNCH_AND_BUY', '0x2222222222222222222222222222222222222222');
    vi.stubEnv('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', 'test-project');
    vi.stubEnv('NEXT_PUBLIC_DEV_WALLET', '1');
    await import('./wagmi');
    expect(connectorsForWallets).toHaveBeenCalledWith(
      [{ groupName: 'Installed', wallets: [injectedWallet] }],
      expect.objectContaining({ appName: 'Dockhood' }),
    );
  });

  it.each(['https://rpc.example.test', '/api/rpc'])('checks the effective %s endpoint before testnet reads or wallet flows', async (rpcUrl) => {
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '46630');
    vi.stubEnv('NEXT_PUBLIC_RPC_URL', rpcUrl);
    vi.stubEnv('NEXT_PUBLIC_PONS_LAUNCH_FACTORY', '0x1111111111111111111111111111111111111111');
    vi.stubEnv('NEXT_PUBLIC_PONS_LAUNCH_AND_BUY', '0x2222222222222222222222222222222222222222');
    vi.stubGlobal('window', Object.assign(new EventTarget(), {
      location: { origin: 'https://dockhood.example' },
      localStorage: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    }));
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      expect(body.method).toBe('eth_chainId');
      return Response.json({ jsonrpc: '2.0', id: body.id, result: '0x1237' });
    });
    vi.stubGlobal('fetch', fetch);
    const { wagmiConfig, ensureRpcNetwork } = await import('./wagmi');
    await expect(ensureRpcNetwork()).rejects.toThrow('RPC network mismatch');
    await expect(wagmiConfig.getClient().request({ method: 'eth_call', params: [{}, 'latest'] })).rejects.toThrow('RPC network mismatch');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toBe(new URL(rpcUrl, 'https://dockhood.example').href);
  });
});
