import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEther, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { resolveNetwork } from '@hood/shared';
import { rpcChainReader } from './services/chain';
import { rpcLaunchSource } from './services/tokenIndex';
import { rpcPool, rpcPoolWriter } from './services/poolChain';

const mocks = vi.hoisted(() => ({
  createPublicClient: vi.fn(),
  createWalletClient: vi.fn(),
  getChainId: vi.fn(),
  getBalance: vi.fn(),
  getBlock: vi.fn(),
  multicall: vi.fn(),
  request: vi.fn(),
  readContract: vi.fn(),
  simulateContract: vi.fn(),
  writeContract: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
}));

vi.mock('viem', async (original) => ({
  ...await original<typeof import('viem')>(),
  createPublicClient: mocks.createPublicClient,
  createWalletClient: mocks.createWalletClient,
}));

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const network = resolveNetwork({ chainId: 46630, rpcUrl: 'https://testnet.example', launchFactory: address(11), launchAndBuy: address(12) });
const tx = `0x${'1'.repeat(64)}` as Hex;
// Only used by mocked clients in unit tests. No transaction is broadcast.
const key = `0x${'2'.repeat(64)}` as Hex;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.createPublicClient.mockReturnValue(mocks);
  mocks.createWalletClient.mockReturnValue(mocks);
  mocks.getChainId.mockResolvedValue(network.chainId);
  mocks.getBlock.mockResolvedValue({ timestamp: 100n });
  mocks.simulateContract.mockImplementation(async (request) => ({ request }));
  mocks.writeContract.mockResolvedValue(tx);
  mocks.waitForTransactionReceipt.mockResolvedValue({ status: 'success' });
});

describe('network-aware RPC services', () => {
  it('reads balances and launch records using the selected chain and factory', async () => {
    mocks.getBalance.mockResolvedValue(parseEther('1'));
    mocks.multicall.mockResolvedValue([{ status: 'success', result: { exists: true, curve: address(21), deployer: address(22), pairToken: address(0), graduationThreshold: 1n } }]);
    const reader = rpcChainReader(network);
    expect(await reader.balance(address(20))).toBe(parseEther('1'));
    expect((await reader.launchRecords([address(20)])).get(address(20))?.curve).toBe(address(21));
    expect(mocks.createPublicClient.mock.calls[0][0].chain.id).toBe(46630);
    expect(mocks.createPublicClient.mock.calls[0][0].chain.contracts.multicall3).toEqual(network.chain.contracts.multicall3);
    expect(mocks.multicall.mock.calls[0][0].contracts[0].address).toBe(network.pons.launchFactory);
  });

  it('scans the configured factory instead of mainnet', async () => {
    mocks.request.mockResolvedValue([]);
    await expect(rpcLaunchSource(network).launches(10, 20)).resolves.toEqual([]);
    expect(mocks.request.mock.calls[0][0]).toMatchObject({ method: 'eth_getLogs', params: [{ address: network.pons.launchFactory, fromBlock: '0xa', toBlock: '0x14' }] });
    expect(mocks.createPublicClient.mock.calls[0][0].chain.id).toBe(46630);
  });

  it('reads the verification pool on the selected chain', async () => {
    mocks.readContract.mockResolvedValue(42n);
    expect(await rpcPool(network, address(30)).submissionFee()).toBe(42n);
    expect(mocks.createPublicClient.mock.calls[0][0].chain.id).toBe(46630);
    expect(mocks.readContract.mock.calls[0][0].address).toBe(address(30));
  });

  it('uses the selected chain and factory for token metadata and curve state', async () => {
    mocks.multicall.mockResolvedValue(Array.from({ length: 3 }, () => ({ status: 'failure' })));
    const source = rpcLaunchSource(network);
    await source.metadata([address(20)]);
    await source.state([{ token: address(20), curve: address(21) }]);
    expect(mocks.multicall).toHaveBeenCalledTimes(2);
    expect(mocks.createPublicClient.mock.calls[0][0].chain).toBe(network.chain);
    expect(mocks.multicall.mock.calls[0][0].contracts[0].address).toBe(address(20));
    expect(mocks.multicall.mock.calls[1][0].contracts[0].address).toBe(network.pons.launchFactory);
  });

  it('signs verification approvals for the configured EIP-712 chain', async () => {
    const pool = address(30);
    const writer = rpcPoolWriter(network, pool, key);
    expect(await writer.markVerified(tx, 'SIMPLE')).toBe(tx);
    const args = mocks.simulateContract.mock.calls[0][0].args as [Hex, number, bigint, Hex];
    expect(args[2]).toBe(3700n);
    const signer = await recoverTypedDataAddress({
      domain: { name: 'hood.exe VerificationPool', version: '1', chainId: 46630, verifyingContract: pool },
      types: { Verify: [{ name: 'id', type: 'bytes32' }, { name: 'tier', type: 'uint8' }, { name: 'deadline', type: 'uint256' }] },
      primaryType: 'Verify',
      message: { id: args[0], tier: args[1], deadline: args[2] },
      signature: args[3],
    });
    expect(signer).toBe(writer.bot);
    expect(mocks.createWalletClient.mock.calls[0][0].chain.id).toBe(46630);
    expect(mocks.getChainId).toHaveBeenCalledOnce();
  });

  it('refuses both verification writes when the endpoint changes chain', async () => {
    mocks.getChainId.mockResolvedValue(4663);
    const writer = rpcPoolWriter(network, address(30), key);
    await expect(writer.markVerified(tx, 'SIMPLE')).rejects.toThrow(/chain mismatch/);
    await expect(writer.markFailed(tx, 'failed')).rejects.toThrow(/chain mismatch/);
    expect(mocks.simulateContract).not.toHaveBeenCalled();
    expect(mocks.writeContract).not.toHaveBeenCalled();
  });
});
