'use client';

import { useId, type ReactNode } from 'react';

export type IconProps = { size?: number; className?: string };

const palettes = {
  launch: ['#ffb58b', '#f46b78', '#933a91'],
  explore: ['#91e6db', '#35b8bf', '#25678f'],
  finder: ['#b8e8f6', '#54b4d8', '#246a8d'],
  callouts: ['#ffd190', '#fa925e', '#ce4d6c'],
  portfolio: ['#f6dca1', '#dba359', '#a15b48'],
  theorem: ['#9b9edc', '#6268aa', '#343e72'],
  verification: ['#9ce5be', '#42bc9c', '#267b7b'],
  games: ['#f6b6db', '#bd7bcf', '#6d4b9d'],
  x: ['#777586', '#393848', '#191c2b'],
  info: ['#a5dcf9', '#609de1', '#4b5caa'],
  help: ['#c5c0ff', '#8c87dc', '#584e9e'],
  lock: ['#b4d4eb', '#7399be', '#455776'],
  warning: ['#ffe6a1', '#f5b953', '#d47743'],
  trash: ['#c5e5df', '#84b9bc', '#4b7c92'],
  solitaire: ['#94d8ba', '#419d88', '#285d70'],
  minesweeper: ['#c3b5ec', '#8a7ac2', '#514b8c'],
} as const;
type Kind = keyof typeof palettes;

export function AppIcon({ kind, size = 56, className }: IconProps & { kind: Kind }) {
  const id = `app-${useId()}`;
  const [light, mid, deep] = palettes[kind];
  const porcelain = `url(#${id}-porcelain)`;
  const sunset = `url(#${id}-sunset)`;
  const ink = `url(#${id}-ink)`;
  const glyphs: Record<Kind, () => ReactNode> = {
    launch: () => <>
      <path d="M25 36c-8 0-11 6-11 12l12-6 6 8c6-4 8-10 5-16Z" fill={sunset}/>
      <path d="M24 39c-5 2-7 6-8 12 6-1 10-3 12-8Z" fill="#ffd38a"/>
      <path d="M25 40c-2 1-4 3-4 6 3-1 5-2 6-4Z" fill="#fff5ce"/>
      <path d="M23 33c3-12 14-20 26-20 1 13-7 24-19 28Z" fill="#973957" opacity=".4" transform="translate(0 2)"/>
      <path d="M23 33c3-12 14-20 26-20 1 13-7 24-19 28Z" fill={porcelain}/>
      <path d="M39 15c3-1 6-2 10-2 0 4-1 7-2 10Z" fill={sunset}/>
      <circle cx="36" cy="27" r="5.5" fill="#dfb9c5"/>
      <circle cx="36" cy="26" r="4.3" fill={ink}/>
      <path d="M33.5 25a3 3 0 0 1 3-2" fill="none" stroke="#b2e7f3" strokeWidth="1.5"/>
      <path d="m23 35 5 5" stroke="#fff9e9" strokeWidth="2.5"/>
    </>,
    explore: () => <>
      <circle cx="32" cy="33.5" r="20" fill="#174d6e" opacity=".4"/>
      <circle cx="32" cy="31.5" r="20" fill={porcelain}/>
      <circle cx="32" cy="31.5" r="16.5" fill={ink}/>
      <circle cx="32" cy="31.5" r="14" fill="none" stroke="#b9e8e6" strokeOpacity=".3"/>
      <path d="M32 18v3m0 21v3M18.5 31.5h3m21 0h3" stroke="#d5f5e9" strokeWidth="2"/>
      <path d="m41 22-5 14-13 5 5-14Z" fill="#122b48" opacity=".5" transform="translate(0 1)"/>
      <path d="m41 21-5 14-8-8Z" fill={sunset}/>
      <path d="m23 41 5-14 8 8Z" fill={porcelain}/>
      <circle cx="32" cy="31" r="2" fill="#fff8e5"/>
    </>,
    finder: () => <>
      <path d="M32 8H21a11 11 0 0 0-11 11v22a11 11 0 0 0 11 11h11Z" fill={porcelain}/>
      <path d="M32 8h9a11 11 0 0 1 11 11v22a11 11 0 0 1-11 11h-9Z" fill="#3d96c0"/>
      <path d="M32 9v41" stroke="#1f5a78" strokeOpacity=".4"/>
      <path d="M42 10h5a7 7 0 0 1 5 4" fill="none" stroke="white" strokeOpacity=".5" strokeWidth="2"/>
      <path d="M23 25v5m18-5v5" fill="none" stroke={ink} strokeWidth="3.4"/>
      <path d="M23 35c2.7 4 5.7 6 9 6s6.3-2 9-6" fill="none" stroke={ink} strokeWidth="3" strokeLinecap="round"/>
    </>,
    callouts: () => <>
      <path d="m24 35 5 15h7l-5-17Z" fill="#8e3c55"/>
      <path d="m23 33 4 15h6l-4-15Z" fill={porcelain}/>
      <path d="M16 26h8v13h-8a4 4 0 0 1-4-4v-5a4 4 0 0 1 4-4Z" fill="#ba4e63"/>
      <path d="M19 24h7v14h-7a4 4 0 0 1-4-4v-6a4 4 0 0 1 4-4Z" fill={sunset}/>
      <path d="m24 24 20-10v34L24 38Z" fill="#b85462"/>
      <path d="m23 23 20-10v33L23 37Z" fill={porcelain}/>
      <ellipse cx="43" cy="29.5" rx="4" ry="16.5" fill="#e6b5a5"/>
      <ellipse cx="43" cy="29.5" rx="2.4" ry="12.5" fill={ink}/>
      <path d="m51 21 3-2m-2 11h4m-5 10 3 2" fill="none" stroke="#fff4d5" strokeWidth="2.5"/>
    </>,
    portfolio: () => <>
      <rect x="24" y="14" width="16" height="12" rx="4" fill="none" stroke="#885341" strokeWidth="5"/>
      <path d="M25 22v-4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4" fill="none" stroke="#fff0c6" strokeWidth="3"/>
      <rect x="12" y="23" width="40" height="27" rx="6" fill="#885341"/>
      <rect x="12" y="21" width="40" height="26" rx="6" fill={sunset}/>
      <path d="M12 27a6 6 0 0 1 6-6h28a6 6 0 0 1 6 6v4c-11 8-29 8-40 0Z" fill={porcelain}/>
      <path d="M17 33c9 5 21 5 30 0" fill="none" stroke="#b67552" strokeOpacity=".5"/>
      <rect x="27" y="32" width="10" height="9" rx="2" fill="#9c5c46"/>
      <rect x="28" y="31" width="8" height="8" rx="2" fill="#ffe2a0"/>
      <path d="M32 33v3" stroke="#a36b48" strokeWidth="2"/>
    </>,
    theorem: () => <>
      <rect x="12" y="12" width="40" height="40" rx="10" fill="#29345c" opacity=".35"/>
      <path d="M17 17h30M17 47h30" stroke="#c8c7f4" strokeOpacity=".3"/>
      <path d="M44 18H20v5l12 11-12 11v5h24v-9h-5v3H28l12-10-12-11h11v3h5Z" fill="#252c52" opacity=".6"/>
      <path d="M44 15H20v5l12 11-12 11v5h24v-9h-5v3H28l12-10-12-11h11v3h5Z" fill={porcelain}/>
      <path d="M22 17h20" stroke="white" strokeOpacity=".8"/>
    </>,
    verification: () => <>
      <path d="m32 13 18 7v13c0 11-12 18-18 21-6-3-18-10-18-21V20Z" fill="#1c6965" opacity=".5"/>
      <path d="m32 10 18 7v13c0 11-12 18-18 21-6-3-18-10-18-21V17Z" fill={porcelain}/>
      <path d="m32 15 13 5v10c0 8-8 14-13 17-5-3-13-9-13-17V20Z" fill={ink}/>
      <path d="m32 15 13 5v10c0 8-8 14-13 17Z" fill="#78d8bb" opacity=".2"/>
      <path d="m23 31 6 6 12-13" fill="none" stroke="#102f43" strokeWidth="5" transform="translate(0 1.5)"/>
      <path d="m23 30 6 6 12-13" fill="none" stroke="#e7ffe8" strokeWidth="4.5"/>
    </>,
    games: () => <>
      <path d="M12 22v-3a4 4 0 0 1 4-4h10l5 5h17a4 4 0 0 1 4 4v20H12Z" fill="#f3c7f0"/>
      <path d="M11 25a4 4 0 0 1 4-4h34a4 4 0 0 1 4 4l-2 22a4 4 0 0 1-4 4H17a4 4 0 0 1-4-4Z" fill="#633c87" opacity=".55"/>
      <path d="M11 24a4 4 0 0 1 4-4h34a4 4 0 0 1 4 4l-2 21a4 4 0 0 1-4 4H17a4 4 0 0 1-4-4Z" fill={sunset}/>
      <path d="M15 22h34" stroke="#ffe3f1" strokeOpacity=".65"/>
      <path d="M24 28h16c5 0 10 14 6 17-3 2-6-4-9-4H27c-3 0-6 6-9 4-4-3 1-17 6-17Z" fill="#773f72" opacity=".4" transform="translate(0 2)"/>
      <path d="M24 27h16c5 0 10 14 6 17-3 2-6-4-9-4H27c-3 0-6 6-9 4-4-3 1-17 6-17Z" fill={porcelain}/>
      <path d="M25 31v8m-4-4h8" stroke="#5e557f" strokeWidth="2.8"/>
      <circle cx="38" cy="32" r="2" fill="#ec927f"/>
      <circle cx="42" cy="37" r="2" fill="#8a81c5"/>
    </>,
    x: () => <>
      <path d="m15 15 26 34h9L24 15Zm3 0h7l24 31h-7Z" fill="#0d1425"/>
      <path d="M44 14h5L20 48h-5Z" fill={porcelain}/>
      <path d="M15 14h11l24 34H39Zm8 4h-1l19 26h2Z" fill={porcelain} fillRule="evenodd"/>
    </>,
    info: () => <>
      <circle cx="32" cy="33.5" r="19" fill="#334b83" opacity=".5"/>
      <circle cx="32" cy="31" r="19" fill={porcelain}/>
      <circle cx="32" cy="21" r="3" fill="#5264a0"/>
      <path d="M28 29h5v13m-6 0h12" fill="none" stroke="#5264a0" strokeWidth="4"/>
    </>,
    help: () => <>
      <path d="M51 30c0 11-8 19-19 19h-6l-10 5 2-12a19 19 0 1 1 33-12Z" fill="#4d407e" opacity=".5"/>
      <path d="M51 28c0 11-8 19-19 19h-6l-10 5 2-12a19 19 0 1 1 33-12Z" fill={porcelain}/>
      <path d="M26 23a6 6 0 1 1 10 5c-3 2-4 3-4 6" fill="none" stroke="#7060a7" strokeWidth="4.5"/>
      <circle cx="32" cy="40" r="2.6" fill="#7060a7"/>
    </>,
    lock: () => <>
      <path d="M22 29v-8a10 10 0 0 1 20 0v8" fill="none" stroke="#384c70" strokeWidth="7"/>
      <path d="M22 27v-7a10 10 0 0 1 20 0v7" fill="none" stroke="#eff5f2" strokeWidth="5"/>
      <rect x="15" y="26" width="34" height="26" rx="6" fill="#364d70" opacity=".6"/>
      <rect x="15" y="24" width="34" height="26" rx="6" fill={porcelain}/>
      <path d="M19 28h26" stroke="white" strokeOpacity=".8"/>
      <circle cx="32" cy="35" r="4" fill="#4a6084"/>
      <path d="m30 36-1 7h6l-1-7" fill="#4a6084"/>
    </>,
    warning: () => <>
      <path d="M28 15a4.6 4.6 0 0 1 8 0l19 33a4.6 4.6 0 0 1-4 7H13a4.6 4.6 0 0 1-4-7Z" fill="#9f5437" opacity=".45"/>
      <path d="M28 12a4.6 4.6 0 0 1 8 0l19 33a4.6 4.6 0 0 1-4 7H13a4.6 4.6 0 0 1-4-7Z" fill={sunset}/>
      <path d="m31 16-18 31a1 1 0 0 0 1 2h36a1 1 0 0 0 1-2L33 16a1.2 1.2 0 0 0-2 0Z" fill="#fff1ba"/>
      <path d="M32 25v11" stroke="#78503d" strokeWidth="5"/>
      <circle cx="32" cy="43" r="2.8" fill="#78503d"/>
    </>,
    trash: () => <>
      <path d="m18 24 3 24a5 5 0 0 0 5 5h12a5 5 0 0 0 5-5l3-24Z" fill="#355e75" opacity=".5"/>
      <path d="m18 22 3 24a5 5 0 0 0 5 5h12a5 5 0 0 0 5-5l3-24Z" fill={porcelain}/>
      <path d="m22 26 3 20h14l3-20Z" fill="#73a5ac" opacity=".35"/>
      <path d="m26 29 1 15m5-15v15m6-15-1 15" fill="none" stroke="#537f8c" strokeWidth="2.5"/>
      <path d="M26 18v-3a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v3" fill="none" stroke="#e8faf0" strokeWidth="3"/>
      <rect x="15" y="18" width="34" height="7" rx="3.5" fill="#4f7b89"/>
      <rect x="15" y="16" width="34" height="6" rx="3" fill={porcelain}/>
      <path d="M19 18h25" stroke="white" strokeOpacity=".8"/>
    </>,
    solitaire: () => <>
      <rect x="25" y="13" width="25" height="35" rx="4" fill="#214e58" opacity=".4" transform="rotate(12 37.5 30.5)"/>
      <g transform="rotate(12 37.5 28.5)">
        <rect x="25" y="11" width="25" height="35" rx="4" fill="#dcf2d8"/>
        <rect x="28" y="14" width="19" height="29" rx="2" fill={sunset}/>
        <path d="m31 18 13 21m-13 0 13-21" stroke="#ffe7c0" strokeOpacity=".6"/>
      </g>
      <g transform="rotate(-9 26 33)">
        <rect x="13" y="17" width="26" height="36" rx="4" fill="#214e58" opacity=".5"/>
        <rect x="13" y="15" width="26" height="36" rx="4" fill={porcelain}/>
        <path d="m26 24 7 9-7 9-7-9Z" fill={sunset}/>
        <path d="m19 19 2 3-2 3-2-3Zm14 22 2 3-2 3-2-3Z" fill="#d36966"/>
      </g>
    </>,
    minesweeper: () => <>
      <g stroke="#303451" strokeWidth="4">
        <path d="M32 12v40M12 32h40M18 18l28 28M18 46l28-28"/>
      </g>
      <circle cx="32" cy="34" r="15" fill="#3e355f" opacity=".5"/>
      <circle cx="32" cy="31.5" r="15" fill={ink}/>
      <path d="M21 29a11 11 0 0 1 12-8" fill="none" stroke="#b0b9de" strokeWidth="3" strokeOpacity=".7"/>
      <circle cx="26" cy="26" r="2.5" fill="#e2e8ff"/>
      <path d="M42 40a12 12 0 0 1-11 4" fill="none" stroke="#131e36" strokeWidth="2"/>
      <path d="m48 11 1.5 4.5L54 17l-4.5 1.5L48 23l-1.5-4.5L42 17l4.5-1.5Z" fill="#ffe7ab"/>
    </>,
  };

  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-tile`} x1="0" y1="0" x2=".75" y2="1">
          <stop stopColor={light}/><stop offset=".48" stopColor={mid}/><stop offset="1" stopColor={deep}/>
        </linearGradient>
        <radialGradient id={`${id}-gloss`} cx=".22" cy="0" r="1">
          <stop stopColor="#fff8e7" stopOpacity=".55"/><stop offset=".65" stopColor="#fff8e7" stopOpacity="0"/>
        </radialGradient>
        <linearGradient id={`${id}-rim`} x1="0" y1="0" x2=".3" y2="1">
          <stop stopColor="white" stopOpacity=".8"/><stop offset=".5" stopColor="white" stopOpacity=".1"/><stop offset="1" stopColor="white" stopOpacity=".25"/>
        </linearGradient>
        <linearGradient id={`${id}-porcelain`} x1=".2" y1="0" x2=".8" y2="1">
          <stop stopColor="#fffdf3"/><stop offset=".5" stopColor="#f9eedf"/><stop offset="1" stopColor="#d8c5cb"/>
        </linearGradient>
        <linearGradient id={`${id}-sunset`} x1="0" y1="0" x2=".65" y2="1">
          <stop stopColor="#ffe4a3"/><stop offset=".5" stopColor="#f9ac84"/><stop offset="1" stopColor="#d76b85"/>
        </linearGradient>
        <linearGradient id={`${id}-ink`} x1="0" y1="0" x2=".8" y2="1">
          <stop stopColor="#637a9f"/><stop offset=".55" stopColor="#344d70"/><stop offset="1" stopColor="#1c2948"/>
        </linearGradient>
      </defs>
      {/* Offset shells and a painted rim create depth without blur filters. */}
      <rect x="3" y="5" width="58" height="58" rx="15" fill="#201b37" fillOpacity=".16"/>
      <rect x="2" y="4" width="60" height="58" rx="15" fill={deep}/>
      <rect x="2" y="2" width="60" height="58" rx="15" fill={`url(#${id}-tile)`}/>
      <rect x="2" y="2" width="60" height="58" rx="15" fill={`url(#${id}-gloss)`}/>
      <path d="M17 4h30a13 13 0 0 1 13 13v8C43 16 23 34 4 26v-9A13 13 0 0 1 17 4Z" fill="white" fillOpacity=".1"/>
      <path d="M10 53c9 6 35 6 44 0" fill="none" stroke={light} strokeOpacity=".35"/>
      <rect x="3" y="3" width="58" height="56" rx="14" fill="none" stroke={`url(#${id}-rim)`}/>
      <g strokeLinecap="round" strokeLinejoin="round">{glyphs[kind]()}</g>
    </svg>
  );
}
export const LaunchIcon = (p: IconProps) => <AppIcon {...p} kind="launch"/>;
export const ExploreIcon = (p: IconProps) => <AppIcon {...p} kind="explore"/>;
export const FinderIcon = (p: IconProps) => <AppIcon {...p} kind="finder"/>
export const CalloutsIcon = (p: IconProps) => <AppIcon {...p} kind="callouts"/>;
export const PortfolioIcon = (p: IconProps) => <AppIcon {...p} kind="portfolio"/>;
export const TheoremIcon = (p: IconProps) => <AppIcon {...p} kind="theorem"/>;
export const VerificationIcon = (p: IconProps) => <AppIcon {...p} kind="verification"/>;
export const GamesFolderIcon = (p: IconProps) => <AppIcon {...p} kind="games"/>;
export const SolitaireIcon = (p: IconProps) => <AppIcon {...p} kind="solitaire"/>;
export const MinesweeperIcon = (p: IconProps) => <AppIcon {...p} kind="minesweeper"/>;
export const XIcon = (p: IconProps) => <AppIcon {...p} kind="x"/>;
export const HelpIcon = (p: IconProps) => <AppIcon {...p} kind="help"/>;
export const InfoIcon = (p: IconProps) => <AppIcon {...p} kind="info"/>;
export const LockIcon = (p: IconProps) => <AppIcon {...p} kind="lock"/>;
export const WarningIcon = (p: IconProps) => <AppIcon {...p} kind="warning"/>;
export const RecycleBinIcon = (p: IconProps) => <AppIcon {...p} kind="trash"/>;

export function DockhoodLogo({ size = 32, className }: IconProps) {
  return <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false"><path d="M6 18C9 11 14 8 19 9L22 6L23 11C25 12 26 14 28 15L24 16C22 19 19 21 15 21L17 17C13 16 10 17 8 20L6 23L5 20L3 18H6Z" fill="currentColor"/><circle cx="23" cy="13.5" r=".8" fill="var(--bg-wallpaper-mid)"/><path d="M11 25H25" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>;
}
