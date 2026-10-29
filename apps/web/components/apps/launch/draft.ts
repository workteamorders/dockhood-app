import { isAddress, parseUnits, type Address } from 'viem';
import {
  LAUNCH_LIMITS,
  LOGO_TYPES,
  NATIVE_PAIR,
  nameSchema,
  normalizeStatement,
  proofSchema,
  socialsSchema,
  statementSchema,
  tickerSchema,
  type LaunchSocials,
  type RigorScore,
} from '@hood/shared';

export type Draft = {
  name: string;
  ticker: string;
  logo: { blob: Blob; url: string } | null;
  statement: string;
  proof: string;
  /** The score and the statement it was computed for; stale once the statement changes. */
  rigor: { statement: string; result: RigorScore } | null;
  pair: Address;
  /** Creator fee recipient; empty means the connected wallet. */
  creator: string;
  creatorTaxPct: string;
  buyback: boolean;
  devBuy: string;
  socials: LaunchSocials;
};

export const EMPTY_DRAFT: Draft = {
  name: '',
  ticker: '',
  logo: null,
  statement: '',
  proof: '',
  rigor: null,
  pair: NATIVE_PAIR,
  creator: '',
  creatorTaxPct: '0',
  buyback: false,
  devBuy: '',
  socials: { twitter: '', telegram: '', website: 'https://www.dockhood.com' },
};

export const PAGES = ['identity', 'theorem', 'economics', 'review'] as const;
export type Page = (typeof PAGES)[number];

export type Errors = Partial<Record<string, string>>;

const firstIssue = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? undefined : r.error?.issues[0]?.message;

/** The score that will be frozen into the launch: only one computed for the current statement counts. */
export function currentRigor(d: Draft): RigorScore | null {
  if (!d.rigor) return null;
  return d.rigor.statement === normalizeStatement(d.statement) ? d.rigor.result : null;
}

export function creatorTaxBps(d: Draft): number | null {
  const v = d.creatorTaxPct.trim() === '' ? 0 : Number(d.creatorTaxPct);
  if (!Number.isFinite(v) || v < 0) return null;
  const bps = Math.round(v * 100);
  return Math.abs(bps - v * 100) < 1e-6 ? bps : null;
}

/** Dev buy in pair-token units, or null when the text isn't a valid amount. Empty is 0. */
export function devBuyAmount(d: Draft, decimals: number): bigint | null {
  const v = d.devBuy.trim();
  if (v === '') return 0n;
  if (!/^\d*\.?\d*$/.test(v) || v === '.') return null;
  try {
    return parseUnits(v, decimals);
  } catch {
    return null;
  }
}

export function validateIdentity(d: Draft): Errors {
  return {
    name: firstIssue(nameSchema.safeParse(d.name)),
    ticker: firstIssue(tickerSchema.safeParse(d.ticker)),
    logo: d.logo ? undefined : 'Choose a logo image.',
  };
}

export function validateTheorem(d: Draft, latexErrors: string[]): Errors {
  return {
    statement: firstIssue(statementSchema.safeParse(d.statement)) ?? (latexErrors.length ? `LaTeX error: ${latexErrors[0]}` : undefined),
    proof: firstIssue(proofSchema.safeParse(d.proof)),
  };
}

export function validateEconomics(d: Draft, ctx: { maxCreatorTaxBps?: number; decimals?: number; pairApproved?: boolean }): Errors {
  const socials = socialsSchema.safeParse(d.socials);
  const socialError = (key: keyof LaunchSocials) =>
    socials.success ? undefined : socials.error.issues.find((i) => i.path[0] === key)?.message;
  const bps = creatorTaxBps(d);
  return {
    pair: ctx.pairApproved === false ? 'Pons no longer accepts this pair asset.' : undefined,
    creator: d.creator.trim() === '' || isAddress(d.creator.trim()) ? undefined : 'Enter a 0x… wallet address.',
    creatorTax:
      bps == null
        ? 'Use a percentage with at most two decimals.'
        : ctx.maxCreatorTaxBps != null && bps > ctx.maxCreatorTaxBps
          ? `Pons allows at most ${ctx.maxCreatorTaxBps / 100}%.`
          : undefined,
    devBuy: ctx.decimals != null && devBuyAmount(d, ctx.decimals) == null ? 'Enter an amount like 0.05.' : undefined,
    twitter: socialError('twitter'),
    telegram: socialError('telegram'),
    website: socialError('website'),
  };
}

export const hasErrors = (e: Errors) => Object.values(e).some(Boolean);

export const ACCEPTED_LOGOS = LOGO_TYPES.join(',');

/** File-picker checks (docs/BRIEF.md §5.2): PNG/JPG/WebP up to 1 MB. */
export function logoFileError(file: File): string | undefined {
  if (!(LOGO_TYPES as readonly string[]).includes(file.type)) return 'Use a PNG, JPG or WebP image.';
  if (file.size > LAUNCH_LIMITS.logoBytes) return 'Use an image of 1 MB or less.';
  return undefined;
}
