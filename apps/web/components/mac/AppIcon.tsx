'use client';

import { useId, type ReactNode } from 'react';
export type IconProps = { size?: number; className?: string };

const palettes = {
  launch: ['#659aff','#6845e8'], explore: ['#39d6b2','#079eca'], callouts: ['#ffb557','#f04e59'],
  portfolio: ['#efcb79','#a56b32'], theorem: ['#45526f','#17223d'], verification: ['#63e5b0','#149966'],
  games: ['#f394d8','#9757d9'], x: ['#38383d','#111114'], info: ['#74bcff','#2674e5'],
  solitaire: ['#57c5a1','#177b64'], minesweeper: ['#9e91ef','#5d58b4'],
} as const;
type Kind = keyof typeof palettes;
const glyphs: Record<Kind, ReactNode> = {
  launch: <><path d="M12 21c-1-5 2-12 13-14 0 11-7 14-12 13l-1 1Z"/><circle cx="20" cy="12" r="2"/><path d="m13 12-5 1-3 5 7 1m7 0-1 7-5 3-1-8M9 23l-3 3m2-5-3 1m6 2-1 3"/></>,
  explore: <><circle cx="16" cy="16" r="11"/><path d="m21 11-3 8-7 2 3-8 7-2Z"/><path d="m16 3 0 2m0 22v2M3 16h2m22 0h2"/></>,
  callouts: <><path d="m6 13 15-6v18L6 19v-6Zm15-3h4v12h-4M9 20l2 7h5l-2-5M4 14v4"/></>,
  portfolio: <><rect x="4" y="10" width="24" height="17" rx="3"/><path d="M11 10V6h10v4M4 16c7 5 17 5 24 0M14 18h4v4h-4z"/></>,
  theorem: <path d="M24 7H9l9 9-9 9h15M24 7v3m0 12v3"/>,
  verification: <><path d="M16 4 26 8v8c0 6-5 10-10 12C11 26 6 22 6 16V8l10-4Z"/><path d="m10 16 4 4 8-9"/></>,
  games: <><path d="M11 10h10c5 0 8 11 5 14-2 2-5-2-7-3h-6c-2 1-5 5-7 3-3-3 0-14 5-14Z"/><path d="M10 14v6m-3-3h6m8-2h.1m3 4h.1"/></>,
  x: <><path d="m7 6 18 20h-5L3 6h4Zm17 0L8 26"/></>,
  info: <><circle cx="16" cy="16" r="11"/><path d="M16 15v8m0-14v1"/></>,
  solitaire: <><path d="M10 7V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v19a2 2 0 0 1-2 2h-2"/><rect x="5" y="7" width="17" height="23" rx="2"/><path d="m13.5 12 4 6-4 6-4-6 4-6Z"/></>,
  minesweeper: <><circle cx="16" cy="16" r="7"/><path d="M16 3v6m0 14v6M3 16h6m14 0h6M7 7l4 4m10 10 4 4M7 25l4-4M21 11l4-4M13 13h.1"/></>,
};

export function AppIcon({ kind, size = 56, className }: IconProps & { kind: Kind }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [start, end] = palettes[kind];
  return <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false">
    <defs><linearGradient id={`app${id}`} x2=".8" y2="1"><stop stopColor={start}/><stop offset="1" stopColor={end}/></linearGradient></defs>
    <rect x="2" y="2" width="60" height="60" rx="14" fill={`url(#app${id})`}/>
    <rect x="2.5" y="2.5" width="59" height="59" rx="13.5" fill="none" stroke="white" strokeOpacity=".3"/>
    <g transform="translate(9 9) scale(1.44)" fill="none" stroke="white" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{glyphs[kind]}</g>
  </svg>;
}
export const LaunchIcon = (p: IconProps) => <AppIcon {...p} kind="launch"/>;
export const ExploreIcon = (p: IconProps) => <AppIcon {...p} kind="explore"/>;
export const CalloutsIcon = (p: IconProps) => <AppIcon {...p} kind="callouts"/>;
export const PortfolioIcon = (p: IconProps) => <AppIcon {...p} kind="portfolio"/>;
export const TheoremIcon = (p: IconProps) => <AppIcon {...p} kind="theorem"/>;
export const VerificationIcon = (p: IconProps) => <AppIcon {...p} kind="verification"/>;
export const GamesFolderIcon = (p: IconProps) => <AppIcon {...p} kind="games"/>;
export const SolitaireIcon = (p: IconProps) => <AppIcon {...p} kind="solitaire"/>;
export const MinesweeperIcon = (p: IconProps) => <AppIcon {...p} kind="minesweeper"/>;
export const XIcon = (p: IconProps) => <AppIcon {...p} kind="x"/>;
export const HelpIcon = (p: IconProps) => <AppIcon {...p} kind="info"/>;
export const InfoIcon = HelpIcon;
export const LockIcon = VerificationIcon;
export const WarningIcon = CalloutsIcon;
export const RecycleBinIcon = PortfolioIcon;

export function DockhoodLogo({ size = 32, className }: IconProps) {
  return <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true"><path d="M6 18C9 11 14 8 19 9L22 6L23 11C25 12 26 14 28 15L24 16C22 19 19 21 15 21L17 17C13 16 10 17 8 20L6 23L5 20L3 18H6Z" fill="currentColor"/><circle cx="23" cy="13.5" r=".8" fill="var(--bg-wallpaper-mid)"/><path d="M11 25H25" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>;
}
