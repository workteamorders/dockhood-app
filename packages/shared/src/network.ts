import { isAddress, type Address } from 'viem';
import {
  EXPLORER_MAINNET, EXPLORER_TESTNET, PUBLIC_RPC_MAINNET, PUBLIC_RPC_TESTNET,
  ROBINHOOD_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID, robinhoodChain, robinhoodTestnet,
} from './chain';
import { HEXE_TOKEN } from './hexe';
import { ETH_PAIR, PAIR_TOKENS, findPair, type PairToken } from './pairs';
import { NATIVE_PAIR, PONS_V1_FACTORY, PONS_V2 } from './pons';

export type NetworkConfig = {
  chainId: number;
  chain: ReturnType<typeof robinhoodChain> | ReturnType<typeof robinhoodTestnet>;
  rpcUrl: string;
  explorerUrl: string;
  pons: { launchFactory: Address; launchAndBuy: Address };
  pairs: readonly PairToken[];
  launchPairs: readonly PairToken[];
  officialToken: { address: Address; ticker: 'DOCK' } | null;
  findPair(address: string): PairToken | undefined;
  txUrl(hash: string): string;
  addressUrl(address: string): string;
};

function nonzeroAddress(value: string | undefined, field: string): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false }) || value.toLowerCase() === NATIVE_PAIR) {
    throw new Error(`${field} must be a valid nonzero address.`);
  }
  return value as Address;
}

/** Resolve explicit network inputs without reading environment or sharing deployments across chains. */
export function resolveNetwork(input: {
  chainId?: string | number;
  rpcUrl?: string;
  launchFactory?: string;
  launchAndBuy?: string;
  pairs?: readonly PairToken[];
  officialToken?: string | null;
} = {}): NetworkConfig {
  const id = input.chainId ?? ROBINHOOD_CHAIN_ID;
  if (id !== ROBINHOOD_CHAIN_ID && id !== ROBINHOOD_TESTNET_CHAIN_ID && id !== '4663' && id !== '46630') {
    throw new Error(`Unsupported chain ID: ${id}. Expected 4663 or 46630.`);
  }
  const chainId = Number(id);
  const testnet = chainId === ROBINHOOD_TESTNET_CHAIN_ID;
  const rpcUrl = input.rpcUrl ?? (testnet ? PUBLIC_RPC_TESTNET : PUBLIC_RPC_MAINNET);
  let rpc: URL;
  try {
    rpc = new URL(rpcUrl);
  } catch {
    throw new Error('rpcUrl must be a valid HTTP(S) URL.');
  }
  if (rpc.protocol !== 'http:' && rpc.protocol !== 'https:') {
    throw new Error('rpcUrl must be a valid HTTP(S) URL.');
  }

  const pons = {
    launchFactory: nonzeroAddress(input.launchFactory ?? (testnet ? undefined : PONS_V2.launchFactory), 'launchFactory'),
    launchAndBuy: nonzeroAddress(input.launchAndBuy ?? (testnet ? undefined : PONS_V2.launchAndBuy), 'launchAndBuy'),
  };
  if (testnet) {
    const mainnetAddresses = [PONS_V1_FACTORY, ...Object.values(PONS_V2)].map((address) => address.toLowerCase());
    for (const [field, address] of Object.entries(pons)) {
      if (mainnetAddresses.includes(address.toLowerCase())) {
        throw new Error(`${field} cannot use a mainnet Pons address on testnet.`);
      }
    }
  }

  const catalog = input.pairs ?? (testnet ? [] : PAIR_TOKENS);
  if (!Array.isArray(catalog)) throw new Error('pairs must be an ERC20 catalog.');
  const seen = new Set<string>();
  const pairs = catalog.map((pair, index): PairToken => {
    const field = `pairs[${index}]`;
    if (!pair || typeof pair !== 'object') throw new Error(`${field} must be an ERC20 pair.`);
    nonzeroAddress(pair.address, `${field}.address`);
    if (!Number.isInteger(pair.decimals) || pair.decimals < 0 || pair.decimals > 255) {
      throw new Error(`${field}.decimals must be an integer from 0 to 255.`);
    }
    if (!['stable', 'crypto', 'stock', 'other'].includes(pair.kind)) {
      throw new Error(`${field}.kind must be an ERC20 kind (stable, crypto, stock, other); native ETH is added separately.`);
    }
    if (typeof pair.symbol !== 'string' || !pair.symbol.trim() || typeof pair.name !== 'string' || !pair.name.trim()) {
      throw new Error(`${field} must have a nonempty symbol and name.`);
    }
    const key = pair.address.toLowerCase();
    if (seen.has(key)) throw new Error(`${field} has a duplicate pair address.`);
    seen.add(key);
    return { ...pair };
  });
  // Preserve the wizard's existing eligible kinds and ordering for the selected catalog.
  const launchPairs = [
    ETH_PAIR,
    ...pairs.filter((pair) => pair.kind === 'stable'),
    ...pairs.filter((pair) => pair.kind === 'crypto'),
    ...pairs.filter((pair) => pair.kind === 'stock').sort((a, b) => a.symbol.localeCompare(b.symbol)),
  ];
  const officialAddress = input.officialToken === undefined ? (testnet ? null : HEXE_TOKEN.address) : input.officialToken;
  const officialToken = officialAddress === null ? null : {
    address: nonzeroAddress(officialAddress, 'officialToken'),
    ticker: 'DOCK' as const,
  };
  const explorerUrl = testnet ? EXPLORER_TESTNET : EXPLORER_MAINNET;
  return {
    chainId,
    chain: testnet ? robinhoodTestnet(rpcUrl) : robinhoodChain(rpcUrl),
    rpcUrl,
    explorerUrl,
    pons,
    pairs,
    launchPairs,
    officialToken,
    findPair: (address) => findPair(address, pairs),
    txUrl: (hash) => `${explorerUrl}/tx/${hash}`,
    addressUrl: (address) => `${explorerUrl}/address/${address}`,
  };
}
