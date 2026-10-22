import { defineChain } from 'viem';

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;

export const PUBLIC_RPC_MAINNET = 'https://rpc.mainnet.chain.robinhood.com';
export const PUBLIC_RPC_TESTNET = 'https://rpc.testnet.chain.robinhood.com';
export const EXPLORER_MAINNET = 'https://robinhoodchain.blockscout.com';
export const EXPLORER_TESTNET = 'https://explorer.testnet.chain.robinhood.com';

/** The public RPC is rate-limited; production must pass a dedicated provider URL. */
export function robinhoodChain(rpcUrl: string = PUBLIC_RPC_MAINNET) {
  return defineChain({
    id: ROBINHOOD_CHAIN_ID,
    name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: {
      default: { name: 'Blockscout', url: EXPLORER_MAINNET },
    },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
}

export function robinhoodTestnet(rpcUrl: string = PUBLIC_RPC_TESTNET) {
  return defineChain({
    id: ROBINHOOD_TESTNET_CHAIN_ID,
    name: 'Robinhood Chain Testnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: {
      default: { name: 'Blockscout', url: EXPLORER_TESTNET },
    },
    contracts: { multicall3: { address: MULTICALL3 } },
    testnet: true,
  });
}

/** Canonical Multicall3, verified deployed on 4663 and 46630. */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

export const txUrl = (hash: string) => `${EXPLORER_MAINNET}/tx/${hash}`;
export const addressUrl = (address: string) => `${EXPLORER_MAINNET}/address/${address}`;
