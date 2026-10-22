import { network } from './network';

export type HoodToken = { address: `0x${string}`; ticker: string };

/**
 * Dockhood's official token on the selected network. Hidden when none is configured.
 */
export const HOOD_TOKEN: HoodToken | null = network.officialToken;

/** Rename only the official token, never an unrelated coin with the same symbol. */
export function displayTicker<T extends string | null | undefined>(address: string | null | undefined, ticker: T): string | T {
  return ticker != null && HOOD_TOKEN && address?.toLowerCase() === HOOD_TOKEN.address.toLowerCase() ? HOOD_TOKEN.ticker : ticker;
}
