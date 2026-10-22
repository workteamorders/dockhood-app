import { bytesToHex, type Address, type Hex } from 'viem';
import { PONS_METADATA_CAPS, ponsFactoryAbi, ponsRouterAbi } from './abi';
import { NATIVE_PAIR, PONS_V2 } from './pons';
import type { LaunchSocials } from './launch';

const byteLength = (s: string) => new TextEncoder().encode(s).length;

/** Unused CREATE2 salt; Pons namespaces salts per launcher, so any fresh random value works. */
export function randomSalt(): Hex {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

/** `@name`, `name` or a full link → a full link, so every Pons frontend can render it. */
export function socialUrl(kind: 'twitter' | 'telegram', value: string): string {
  const v = value.trim();
  if (v === '' || /^https?:\/\//i.test(v)) return v;
  const handle = v.replace(/^@/, '').replace(/^(?:www\.)?(?:x\.com|twitter\.com|t\.me)\//i, '');
  return kind === 'twitter' ? `https://x.com/${handle}` : `https://t.me/${handle}`;
}

export type TokenParamsInput = {
  name: string;
  symbol: string;
  /** ipfs://cid of the pinned logo. */
  logo: string;
  description: string;
  socials: LaunchSocials;
  creatorFeeRecipient: Address;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  /** previewLaunchEconomics(configId, pair) read when the user reviewed the launch. */
  expectedEconomics: Hex;
  salt: Hex;
};

/** PonsV2LaunchFactory.TokenParams, checked against the deployer's byte caps before anything is signed. */
export function buildTokenParams(input: TokenParamsInput) {
  const socials = {
    twitter: socialUrl('twitter', input.socials.twitter),
    telegram: socialUrl('telegram', input.socials.telegram),
    discord: '',
    website: input.socials.website.trim(),
    farcaster: '',
  };
  const checks: [string, string, number][] = [
    ['name', input.name, PONS_METADATA_CAPS.name],
    ['symbol', input.symbol, PONS_METADATA_CAPS.symbol],
    ['logo', input.logo, PONS_METADATA_CAPS.logo],
    ['description', input.description, PONS_METADATA_CAPS.description],
    ...Object.entries(socials).map(([k, v]): [string, string, number] => [k, v, PONS_METADATA_CAPS.social]),
  ];
  for (const [field, value, cap] of checks) {
    if (byteLength(value) > cap) throw new Error(`${field} is longer than Pons allows (${cap} bytes).`);
  }
  if (!Number.isInteger(input.creatorTaxBps) || input.creatorTaxBps < 0) throw new Error('Creator tax must be whole basis points.');
  return {
    name: input.name,
    symbol: input.symbol,
    logo: input.logo,
    description: input.description,
    socials,
    creatorFeeRecipient: input.creatorFeeRecipient,
    creatorTaxBps: input.creatorTaxBps,
    buybackEnabled: input.buybackEnabled,
    expectedEconomics: input.expectedEconomics,
    salt: input.salt,
  } as const;
}

export type TokenParams = ReturnType<typeof buildTokenParams>;

export type LaunchPlanInput = {
  params: TokenParams;
  launchConfigId: bigint;
  pairToken: Address;
  launchFee: bigint;
  /** Dev buy in pair-token units; 0 launches without buying. */
  quoteIn: bigint;
  minTokensOut: bigint;
  recipient: Address;
};

/**
 * Which contract to call and with what value, verified by eth_call on 4663
 * (packages/shared/scripts/simulate-launch.ts):
 * - no dev buy → factory.launchToken, msg.value = launchFee (the router reverts ZeroAmount on quoteIn 0);
 * - ETH dev buy → router.launchAndBuy, msg.value = launchFee + quoteIn;
 * - ERC-20 dev buy → router.launchAndBuy, msg.value = launchFee, after approving the router for quoteIn.
 * The creator is snipe-tax exempt either way, so the atomic dev buy fills at the untaxed price.
 */
export function planLaunch(
  p: LaunchPlanInput,
  targets: { launchFactory: Address; launchAndBuy: Address } = PONS_V2,
) {
  if (p.quoteIn === 0n) {
    return {
      kind: 'launchToken',
      approval: null,
      request: {
        address: targets.launchFactory,
        abi: ponsFactoryAbi,
        functionName: 'launchToken',
        args: [p.params, p.launchConfigId, p.pairToken],
        value: p.launchFee,
      },
    } as const;
  }
  const native = p.pairToken === NATIVE_PAIR;
  return {
    kind: 'launchAndBuy',
    approval: native ? null : { token: p.pairToken, spender: targets.launchAndBuy, amount: p.quoteIn },
    request: {
      address: targets.launchAndBuy,
      abi: ponsRouterAbi,
      functionName: 'launchAndBuy',
      args: [p.params, p.launchConfigId, p.pairToken, p.quoteIn, p.minTokensOut, p.recipient, []],
      value: native ? p.launchFee + p.quoteIn : p.launchFee,
    },
  } as const;
}

export type LaunchPlan = ReturnType<typeof planLaunch>;
