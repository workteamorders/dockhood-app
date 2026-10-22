import { describe, expect, it } from 'vitest';
import { HEXE_TOKEN } from '@hood/shared';
import { displayTicker } from './hoodToken';

describe('displayTicker', () => {
  it('renames only the official contract, case-insensitively', () => {
    expect(displayTicker(HEXE_TOKEN.address, 'HEXE')).toBe('DOCK');
    expect(displayTicker(HEXE_TOKEN.address.toUpperCase(), 'HEXE')).toBe('DOCK');
    expect(displayTicker('0x0000000000000000000000000000000000000001', 'HEXE')).toBe('HEXE');
    expect(displayTicker('0x0000000000000000000000000000000000000001', 'OTHER')).toBe('OTHER');
  });

  it('preserves missing addresses and tickers', () => {
    expect(displayTicker(null, 'HEXE')).toBe('HEXE');
    expect(displayTicker(undefined, 'HEXE')).toBe('HEXE');
    expect(displayTicker(HEXE_TOKEN.address, null)).toBeNull();
    expect(displayTicker(HEXE_TOKEN.address, undefined)).toBeUndefined();
  });
});
