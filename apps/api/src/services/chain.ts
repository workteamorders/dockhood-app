import {
  TransactionReceiptNotFoundError,
  createPublicClient,
  erc20Abi,
  http,
  isAddressEqual,
  parseEventLogs,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { ponsFactoryAbi, ponsTokenAbi, type NetworkConfig } from '@hood/shared';

export type LaunchOnChain = {
  token: Address;
  curve: Address;
  deployer: Address;
  pairToken: Address;
  blockNumber: bigint;
  description: string;
};

export interface ChainReader {
  /** EOA signatures and smart-contract wallets (ERC-1271 / ERC-6492). */
  verifySignature(address: Address, message: string, signature: Hex): Promise<boolean>;
  /** The Pons V2 launch in a mined transaction; 'pending' before it is mined, null when it isn't a launch. */
  launchFromTx(hash: Hash): Promise<LaunchOnChain | 'pending' | null>;
  /** Native ETH balance on the configured chain (posting callouts needs a non-zero one). */
  balance(address: Address): Promise<bigint>;
  /** ERC-20 balances of `owner` for each token; failed reads are left out. */
  tokenBalances(owner: Address, tokens: Address[]): Promise<Map<Address, bigint>>;
  /** getLaunchedToken for each token (Pons V2 only); tokens the factory doesn't know are left out. */
  launchRecords(tokens: Address[]): Promise<Map<Address, LaunchRecord>>;
}

export type LaunchRecord = { curve: Address; deployer: Address; pairToken: Address; graduationThreshold: bigint; launchedAt: Date | null };

export function rpcChainReader(network: NetworkConfig): ChainReader {
  const client = createPublicClient({ chain: network.chain, transport: http(network.rpcUrl, { retryCount: 3 }) });
  return {
    verifySignature: (address, message, signature) => client.verifyMessage({ address, message, signature }),
    balance: (address) => client.getBalance({ address }),

    async tokenBalances(owner, tokens) {
      const results = await client.multicall({
        allowFailure: true,
        batchSize: 16_384,
        contracts: tokens.map((address) => ({ address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }) as const),
      });
      const out = new Map<Address, bigint>();
      tokens.forEach((t, i) => {
        const r = results[i];
        if (r.status === 'success') out.set(t, r.result as bigint);
      });
      return out;
    },

    async launchRecords(tokens) {
      const results = await client.multicall({
        allowFailure: true,
        batchSize: 16_384,
        contracts: tokens.map((t) => ({ address: network.pons.launchFactory, abi: ponsFactoryAbi, functionName: 'getLaunchedToken', args: [t] }) as const),
      });
      const out = new Map<Address, LaunchRecord>();
      tokens.forEach((t, i) => {
        const r = results[i];
        if (r.status !== 'success') return;
        const rec = r.result as { exists: boolean; curve: Address; deployer: Address; pairToken: Address; graduationThreshold: bigint };
        // Launch time isn't on the record; the portfolio only needs it for coins we already index.
        if (rec.exists) out.set(t, { curve: rec.curve, deployer: rec.deployer, pairToken: rec.pairToken, graduationThreshold: rec.graduationThreshold, launchedAt: null });
      });
      return out;
    },

    async launchFromTx(hash) {
      let receipt;
      try {
        receipt = await client.getTransactionReceipt({ hash });
      } catch (e) {
        if (e instanceof TransactionReceiptNotFoundError) return 'pending';
        throw e;
      }
      if (receipt.status !== 'success') return null;
      const factoryLogs = receipt.logs.filter((l) => isAddressEqual(l.address, network.pons.launchFactory));
      const [launched] = parseEventLogs({ abi: ponsFactoryAbi, eventName: 'TokenLaunched', logs: factoryLogs });
      if (!launched) return null;
      const { token, curve, deployer, pairToken } = launched.args;
      const description = await client.readContract({ address: token, abi: ponsTokenAbi, functionName: 'description' });
      return { token, curve, deployer, pairToken, blockNumber: receipt.blockNumber, description };
    },
  };
}
