import { resolveNetwork } from '@hood/shared';

// Keep literal env reads: Next.js inlines these public values into the client bundle.
const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL?.trim();
const pairTokensJson = process.env.NEXT_PUBLIC_PAIR_TOKENS_JSON?.trim();
const pairs = pairTokensJson ? JSON.parse(pairTokensJson) : undefined;
if (pairTokensJson && !Array.isArray(pairs)) {
  throw new Error('NEXT_PUBLIC_PAIR_TOKENS_JSON must be an ERC20 array.');
}
const proxyRpc = rpcUrl?.startsWith('/') && !rpcUrl.startsWith('//');

export const network = resolveNetwork({
  chainId: process.env.NEXT_PUBLIC_CHAIN_ID?.trim() || undefined,
  // Wallets and SSR need an absolute public RPC, not the app's same-origin proxy.
  rpcUrl: proxyRpc ? undefined : rpcUrl || undefined,
  launchFactory: process.env.NEXT_PUBLIC_PONS_LAUNCH_FACTORY?.trim() || undefined,
  launchAndBuy: process.env.NEXT_PUBLIC_PONS_LAUNCH_AND_BUY?.trim() || undefined,
  pairs,
  officialToken: process.env.NEXT_PUBLIC_OFFICIAL_TOKEN_ADDRESS?.trim() || undefined,
});

export const appRpc = rpcUrl || network.rpcUrl;
export const { findPair, launchPairs, txUrl, addressUrl } = network;
