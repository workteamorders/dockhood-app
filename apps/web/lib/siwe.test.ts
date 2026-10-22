import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseSiweMessage } from 'viem/siwe';
import { signMessage } from 'wagmi/actions';
import { verifySiwe } from './api';
import { ensureRpcNetwork } from './wagmi';

vi.mock('wagmi/actions', () => ({ signMessage: vi.fn(async () => '0xsigned') }));
vi.mock('./wagmi', () => ({ wagmiConfig: {}, ensureRpcNetwork: vi.fn(async () => {}) }));
vi.mock('./api', () => ({
  currentSession: vi.fn(async () => null), logout: vi.fn(),
  siweNonce: vi.fn(async () => 'testnonce123'), verifySiwe: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const key of [
    'NEXT_PUBLIC_RPC_URL', 'NEXT_PUBLIC_PAIR_TOKENS_JSON', 'NEXT_PUBLIC_OFFICIAL_TOKEN_ADDRESS',
  ]) vi.stubEnv(key, '');
  vi.stubEnv('NEXT_PUBLIC_PONS_LAUNCH_FACTORY', '0x1111111111111111111111111111111111111111');
  vi.stubEnv('NEXT_PUBLIC_PONS_LAUNCH_AND_BUY', '0x2222222222222222222222222222222222222222');
  vi.stubGlobal('window', { location: { host: 'dockhood.example', origin: 'https://dockhood.example' } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each(['4663', '46630'])('signs SIWE for the configured chain %s', async (chainId) => {
  vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', chainId);
  const { ensureSession } = await import('./siwe');
  const address = '0x3333333333333333333333333333333333333333';
  await ensureSession(address);
  const message = vi.mocked(signMessage).mock.calls[0][1].message;
  expect(typeof message).toBe('string');
  expect(parseSiweMessage(message as string)).toMatchObject({
    chainId: Number(chainId), address, domain: 'dockhood.example', uri: 'https://dockhood.example',
  });
  expect(verifySiwe).toHaveBeenCalledWith(message, '0xsigned');
});

it('does not sign or verify SIWE when the RPC network check fails', async () => {
  vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '46630');
  vi.mocked(ensureRpcNetwork).mockRejectedValueOnce(new Error('RPC network mismatch.'));
  const { ensureSession } = await import('./siwe');
  await expect(ensureSession('0x3333333333333333333333333333333333333333')).rejects.toThrow('RPC network mismatch');
  expect(signMessage).not.toHaveBeenCalled();
  expect(verifySiwe).not.toHaveBeenCalled();
});
