import {
  BaseError,
  ContractFunctionRevertedError,
  TransactionReceiptNotFoundError,
  createPublicClient,
  createWalletClient,
  http,
  isAddressEqual,
  parseEventLogs,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tierIndex, verificationPoolAbi, type NetworkConfig, type Tier } from '@hood/shared';
import { assertRpcChain } from './network';

/** A VerificationPool submission, from its Submitted event. */
export type PoolSubmission = {
  id: Hex;
  submitter: Address;
  token: Address;
  proofHash: Hex;
  ipfsCid: string;
  submittedAt: Date;
  txHash: Hash;
  blockNumber: bigint;
};

/** On-chain Status enum of a submission. */
export const POOL_STATUS = ['None', 'Pending', 'Verified', 'Failed', 'Refunded'] as const;
export type PoolStatus = (typeof POOL_STATUS)[number];

/** Reads the VerificationPool (API and verifier worker). */
export interface PoolReader {
  readonly address: Address;
  /** The submissions a mined transaction made; 'pending' before it is mined. */
  submissionsFromTx(hash: Hash): Promise<PoolSubmission[] | 'pending'>;
  /** Submissions in a block range (the worker's backup scan), and the head it stopped at. */
  submissionsBetween(fromBlock: bigint, toBlock: bigint): Promise<PoolSubmission[]>;
  head(): Promise<bigint>;
  status(id: Hex): Promise<PoolStatus>;
  rewardWei(tier: Tier): Promise<bigint>;
  submissionFee(): Promise<bigint>;
  balances(): Promise<{ balance: bigint; available: bigint }>;
}

/** Posts results (verifier worker only: it holds the bot key). Throws PoolRevert with the contract's error name. */
export interface PoolWriter {
  readonly bot: Address;
  markVerified(id: Hex, tier: Tier): Promise<Hash>;
  markFailed(id: Hex, reason: string): Promise<Hash>;
}

export class PoolRevert extends Error {
  constructor(readonly errorName: string) {
    super(`VerificationPool reverted: ${errorName}`);
  }
}

/** How long a bot approval stays valid: the worker relays it at once, so an hour is plenty. */
const APPROVAL_TTL_S = 3_600n;

export function rpcPool(network: NetworkConfig, address: Address): PoolReader {
  const client = createPublicClient({ chain: network.chain, transport: http(network.rpcUrl, { retryCount: 3 }) });
  const blockTimes = new Map<bigint, Date>();
  const timeOf = async (blockNumber: bigint) => {
    let t = blockTimes.get(blockNumber);
    if (!t) {
      t = new Date(Number((await client.getBlock({ blockNumber })).timestamp) * 1000);
      blockTimes.set(blockNumber, t);
      if (blockTimes.size > 1_000) blockTimes.delete(blockTimes.keys().next().value!);
    }
    return t;
  };
  const decode = async (logs: Parameters<typeof parseEventLogs>[0]['logs']): Promise<PoolSubmission[]> => {
    const events = parseEventLogs({ abi: verificationPoolAbi, eventName: 'Submitted', logs }).filter((l) => isAddressEqual(l.address, address));
    return Promise.all(
      events.map(async (e) => ({
        id: e.args.id,
        submitter: e.args.submitter,
        token: e.args.token,
        proofHash: e.args.proofHash,
        ipfsCid: e.args.ipfsCid,
        submittedAt: await timeOf(e.blockNumber),
        txHash: e.transactionHash,
        blockNumber: e.blockNumber,
      })),
    );
  };

  return {
    address,
    async submissionsFromTx(hash) {
      let receipt;
      try {
        receipt = await client.getTransactionReceipt({ hash });
      } catch (e) {
        if (e instanceof TransactionReceiptNotFoundError) return 'pending';
        throw e;
      }
      if (receipt.status !== 'success') return [];
      return decode(receipt.logs);
    },
    async submissionsBetween(fromBlock, toBlock) {
      const logs = await client.getLogs({ address, fromBlock, toBlock });
      return decode(logs);
    },
    head: () => client.getBlockNumber(),
    async status(id) {
      const s = await client.readContract({ address, abi: verificationPoolAbi, functionName: 'getSubmission', args: [id] });
      return POOL_STATUS[s.status] ?? 'None';
    },
    rewardWei: (tier) => client.readContract({ address, abi: verificationPoolAbi, functionName: 'rewardAmount', args: [tierIndex(tier)] }),
    submissionFee: () => client.readContract({ address, abi: verificationPoolAbi, functionName: 'submissionFee' }),
    async balances() {
      const [balance, available] = await Promise.all([
        client.getBalance({ address }),
        client.readContract({ address, abi: verificationPoolAbi, functionName: 'availableBalance' }),
      ]);
      return { balance, available };
    },
  };
}

/** The contract error name in a failed simulation or call, if it is one of the pool's. */
function revertName(e: unknown): string | null {
  if (!(e instanceof BaseError)) return null;
  const revert = e.walk((err) => err instanceof ContractFunctionRevertedError);
  return revert instanceof ContractFunctionRevertedError ? (revert.data?.errorName ?? null) : null;
}

export function rpcPoolWriter(network: NetworkConfig, address: Address, botKey: Hex): PoolWriter {
  const { chain, rpcUrl } = network;
  const account = privateKeyToAccount(botKey);
  const client = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 3 }) });
  const wallet = createWalletClient({ chain, account, transport: http(rpcUrl, { retryCount: 3 }) });

  /** Simulates first (so a revert names its reason without spending gas), sends, and waits for success. */
  async function send(request: Parameters<typeof client.simulateContract>[0]): Promise<Hash> {
    await assertRpcChain(network);
    let simulated;
    try {
      simulated = await client.simulateContract({ ...request, account });
    } catch (e) {
      const name = revertName(e);
      if (name) throw new PoolRevert(name);
      throw e;
    }
    const hash = await wallet.writeContract(simulated.request);
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`);
    return hash;
  }

  return {
    bot: account.address,
    async markVerified(id, tier) {
      // From the chain's clock, not this machine's: a drifting server clock can't make approvals expire on arrival.
      const deadline = (await client.getBlock()).timestamp + APPROVAL_TTL_S;
      const signature = await account.signTypedData({
        domain: { name: 'hood.exe VerificationPool', version: '1', chainId: network.chainId, verifyingContract: address },
        types: { Verify: [{ name: 'id', type: 'bytes32' }, { name: 'tier', type: 'uint8' }, { name: 'deadline', type: 'uint256' }] },
        primaryType: 'Verify',
        message: { id, tier: tierIndex(tier), deadline },
      });
      return send({ address, abi: verificationPoolAbi, functionName: 'markVerified', args: [id, tierIndex(tier), deadline, signature] });
    },
    markFailed: (id, reason) => send({ address, abi: verificationPoolAbi, functionName: 'markFailed', args: [id, reason.slice(0, 256)] }),
  };
}
