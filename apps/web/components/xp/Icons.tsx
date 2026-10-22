import type { ReactNode } from 'react';
import type { IconProps } from '../mac/AppIcon';

export { LaunchIcon, ExploreIcon, CalloutsIcon, PortfolioIcon, TheoremIcon, InfoIcon, XIcon, WarningIcon, HelpIcon, RecycleBinIcon, LockIcon, SolitaireIcon, MinesweeperIcon, GamesFolderIcon, VerificationIcon, DockhoodLogo as HoodLogo } from '../mac/AppIcon';
export type { IconProps } from '../mac/AppIcon';

function Glyph({ size = 32, className, children }: IconProps & { children: ReactNode }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{children}</svg>;
}
export const QuestionIcon = (p: IconProps) => <Glyph {...p}><circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 4 3c-1 .5-1 1-1 2m0 3h.01"/></Glyph>;
export const ErrorIcon = (p: IconProps) => <Glyph {...p}><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/></Glyph>;
export const KeyIcon = (p: IconProps) => <Glyph {...p}><circle cx="8" cy="9" r="4"/><path d="m11 12 9 9m-4-4 2-2m-5-1 2-2"/></Glyph>;
export const TurnOffIcon = (p: IconProps) => <Glyph {...p}><path d="M12 2v10M7 5a9 9 0 1 0 10 0"/></Glyph>;
export const StandByIcon = (p: IconProps) => <Glyph {...p}><path d="M19 15A8 8 0 0 1 9 5a8 8 0 1 0 10 10Z"/></Glyph>;
export const RestartIcon = (p: IconProps) => <Glyph {...p}><path d="M20 11a8 8 0 1 0-2 7M20 4v7h-7"/></Glyph>;
export const WalletIcon = (p: IconProps) => <Glyph {...p}><rect x="3" y="6" width="18" height="15" rx="3"/><path d="M3 9V5l14-3v4m4 7h-6v4h6m-3-2h.01"/></Glyph>;
export const SpeakerIcon = (p: IconProps) => <Glyph {...p}><path d="M11 4 5 9H2v6h3l6 5V4Zm5 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></Glyph>;
