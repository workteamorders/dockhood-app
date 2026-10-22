import type { Address } from 'viem';
import { NATIVE_PAIR } from './pons';
import { PAIR_TOKENS } from './pairTokens';

export type PairKind = 'native' | 'stable' | 'crypto' | 'stock' | 'other';

export type PairToken = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  kind: PairKind;
};

export const ETH_PAIR: PairToken = { address: NATIVE_PAIR, symbol: 'ETH', name: 'Ether', decimals: 18, kind: 'native' };

export { PAIR_TOKENS };

/** Pair assets the wizard offers (docs/BRIEF.md §5.2): ETH, USDG, cbBTC and the stock/ETF tokens. */
export const LAUNCH_PAIRS: readonly PairToken[] = [
  ETH_PAIR,
  ...PAIR_TOKENS.filter((p) => p.kind === 'stable'),
  ...PAIR_TOKENS.filter((p) => p.kind === 'crypto'),
  ...PAIR_TOKENS.filter((p) => p.kind === 'stock').slice().sort((a, b) => a.symbol.localeCompare(b.symbol)),
];

export function findPair(address: string, catalog: readonly PairToken[] = PAIR_TOKENS): PairToken | undefined {
  const a = address.toLowerCase();
  return a === NATIVE_PAIR ? ETH_PAIR : catalog.find((p) => p.address.toLowerCase() === a);
}

/** Buy presets (docs/BRIEF.md §5.4): ETH 0.01–0.5, stablecoins 10–500; other pairs have none. */
export function buyPresets(pair: PairToken): string[] {
  if (pair.kind === 'native') return ['0.01', '0.05', '0.1', '0.5'];
  if (pair.kind === 'stable') return ['10', '50', '100', '500'];
  return [];
}
