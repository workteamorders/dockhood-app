import { createPublicClient, http } from 'viem';
import type { NetworkConfig } from '@hood/shared';

/** Check the actual endpoint, not the chain declared on a viem client, before any indexing or writes. */
export async function assertRpcChain(network: NetworkConfig): Promise<void> {
  const client = createPublicClient({ transport: http(network.rpcUrl, { retryCount: 0, timeout: 15_000 }) });
  const actual = await client.getChainId();
  if (actual !== network.chainId) throw new Error(`RPC chain mismatch: expected ${network.chainId}, received ${actual}`);
}
