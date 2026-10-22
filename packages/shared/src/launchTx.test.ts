import { describe, expect, it } from 'vitest';
import { parseEther, zeroHash, type Address } from 'viem';
import { PONS_V2, NATIVE_PAIR } from './pons';
import { buildTokenParams, planLaunch, randomSalt, socialUrl, type TokenParamsInput } from './launchTx';
import { freshCurveState, quoteBuy } from './quote';
import { LAUNCH_PAIRS, findPair } from './pairs';
import { resolveNetwork } from './network';

const creator: Address = '0x00000000000000000000000000000000000c0dE5';
const USDG: Address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

const input: TokenParamsInput = {
  name: 'Fermat',
  symbol: 'FLT',
  logo: 'ipfs://bafy',
  description: '∑ x^n + y^n = z^n',
  socials: { twitter: '@hoodexe', telegram: 't.me/hoodexe', website: 'https://hood.fun' },
  creatorFeeRecipient: creator,
  creatorTaxBps: 0,
  buybackEnabled: false,
  expectedEconomics: zeroHash,
  salt: zeroHash,
};

describe('socialUrl', () => {
  it.each([
    ['twitter', '@hoodexe', 'https://x.com/hoodexe'],
    ['twitter', 'https://x.com/hoodexe', 'https://x.com/hoodexe'],
    ['twitter', 'x.com/hoodexe', 'https://x.com/hoodexe'],
    ['telegram', 'hoodexe', 'https://t.me/hoodexe'],
    ['telegram', 't.me/hoodexe', 'https://t.me/hoodexe'],
    ['telegram', '', ''],
  ] as const)('%s %s', (kind, value, expected) => {
    expect(socialUrl(kind, value)).toBe(expected);
  });
});

describe('buildTokenParams', () => {
  it('fills the Pons socials struct', () => {
    expect(buildTokenParams(input).socials).toEqual({
      twitter: 'https://x.com/hoodexe',
      telegram: 'https://t.me/hoodexe',
      discord: '',
      website: 'https://hood.fun',
      farcaster: '',
    });
  });

  it('rejects fields over the deployer byte caps', () => {
    expect(() => buildTokenParams({ ...input, name: 'é'.repeat(33) })).toThrow(/name/);
    expect(() => buildTokenParams({ ...input, description: 'x'.repeat(2049) })).toThrow(/description/);
  });

  it('makes a fresh 32-byte salt each time', () => {
    const a = randomSalt();
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(randomSalt()).not.toBe(a);
  });
});

describe('planLaunch', () => {
  const params = buildTokenParams(input);
  const base = { params, launchConfigId: 0n, launchFee: parseEther('0.0005'), minTokensOut: 0n, recipient: creator };

  it('uses the factory with just the fee when there is no dev buy', () => {
    const plan = planLaunch({ ...base, pairToken: NATIVE_PAIR, quoteIn: 0n });
    expect(plan.kind).toBe('launchToken');
    expect(plan.request.address).toBe(PONS_V2.launchFactory);
    expect(plan.request.value).toBe(parseEther('0.0005'));
    expect(plan.approval).toBeNull();
  });

  it('sends fee + dev buy to the router for ETH', () => {
    const plan = planLaunch({ ...base, pairToken: NATIVE_PAIR, quoteIn: parseEther('0.05') });
    expect(plan.request.address).toBe(PONS_V2.launchAndBuy);
    expect(plan.request.value).toBe(parseEther('0.0505'));
    expect(plan.approval).toBeNull();
  });

  it('approves the router for an ERC-20 dev buy and sends only the fee', () => {
    const plan = planLaunch({ ...base, pairToken: USDG, quoteIn: 10_000_000n });
    expect(plan.request.value).toBe(parseEther('0.0005'));
    expect(plan.approval).toEqual({ token: USDG, spender: PONS_V2.launchAndBuy, amount: 10_000_000n });
  });

  it('uses the selected factory for a launch without a dev buy', () => {
    const { pons } = resolveNetwork({
      chainId: 46630,
      launchFactory: '0x0000000000000000000000000000000000001001',
      launchAndBuy: '0x0000000000000000000000000000000000001002',
    });
    const plan = planLaunch({ ...base, pairToken: NATIVE_PAIR, quoteIn: 0n }, pons);
    expect(plan.request.address).toBe(pons.launchFactory);
    expect(plan.request.value).toBe(base.launchFee);
    expect(plan.approval).toBeNull();
  });

  it.each([NATIVE_PAIR, USDG])('uses the selected router and approval spender for dev buy with %s', (pairToken) => {
    const { pons } = resolveNetwork({
      chainId: 46630,
      launchFactory: '0x0000000000000000000000000000000000001001',
      launchAndBuy: '0x0000000000000000000000000000000000001002',
    });
    const quoteIn = 10_000_000n;
    const plan = planLaunch({ ...base, pairToken, quoteIn }, pons);
    expect(plan.request.address).toBe(pons.launchAndBuy);
    expect(plan.request.args[2]).toBe(pairToken);
    expect(plan.request.value).toBe(pairToken === NATIVE_PAIR ? base.launchFee + quoteIn : base.launchFee);
    expect(plan.approval).toEqual(pairToken === NATIVE_PAIR ? null : {
      token: pairToken, spender: pons.launchAndBuy, amount: quoteIn,
    });
  });
});

// Config 0 on chain 4663 and router fills from eth_call (scripts/simulate-launch.ts, 9 Oct 2026).
describe('dev buy quotes on a fresh curve', () => {
  const supply = 1_000_000_000n * 10n ** 18n;
  const phantom = parseEther('1.68');
  const threshold = parseEther('4.2');

  it.each([
    [0n, '0.05', 28_620_988_725_065_047_701_647_875n],
    [150n, '0.05', 28_199_566_160_520_607_375_271_149n],
    [150n, '1', 367_231_638_418_079_096_045_197_740n],
  ])('creator tax %i bps, buy %s ETH', (tax, eth, filled) => {
    const q = quoteBuy(freshCurveState(supply, phantom, threshold, 100n, tax), parseEther(eth));
    expect(q?.tokensOut).toBe(filled);
    expect(q?.completesCurve).toBe(false);
  });

  it('clamps a dev buy big enough to graduate the launch', () => {
    const state = freshCurveState(supply, phantom, threshold, 100n, 150n);
    expect(state.sellable).toBe(714_285_714_285_714_285_714_285_715n);
    const q = quoteBuy(state, parseEther('10'))!;
    expect(q.tokensOut).toBe(state.sellable);
    expect(q.completesCurve).toBe(true);
    expect(q.refund).toBeGreaterThan(0n);
  });
});

describe('launch pairs', () => {
  it('offers ETH first, then USDG and cbBTC, then stock tokens', () => {
    expect(LAUNCH_PAIRS.slice(0, 3).map((p) => p.symbol)).toEqual(['ETH', 'USDG', 'cbBTC']);
    expect(LAUNCH_PAIRS.every((p) => p.kind !== 'other')).toBe(true);
  });

  it('finds pairs case-insensitively', () => {
    expect(findPair(USDG.toLowerCase())?.decimals).toBe(6);
    expect(findPair(NATIVE_PAIR)?.symbol).toBe('ETH');
  });
});
