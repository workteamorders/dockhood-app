import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { GamesFolder } from '@/components/games/GamesFolder';
import type { WindowState } from '@/store/windows';
import type { AppId } from './meta';
import { About } from './About';
import { Callouts } from './callouts/Callouts';
import { Explore } from './explore/Explore';
import { TokenDetail } from './token/TokenDetail';
import { Launch } from './launch/Launch';
import { Privacy, Risk, Terms } from './legal/Legal';
import { Portfolio } from './portfolio/Portfolio';
import { RecycleBin } from './RecycleBin';
import { TheoremBoard } from './TheoremBoard';
import { Welcome } from './Welcome';

type AppComponent = ComponentType<{ win: WindowState }>;

const FinderWindow = lazy(() => import('@/components/apps/finder/Finder').then((m) => ({ default: m.Finder })));
// The games are code-split: their code loads the first time someone opens them (hood-exe-games-brief.md §9).
const SolitaireWindow = lazy(() => import('@/components/games/Solitaire/SolitaireWindow'));
const MinesweeperWindow = lazy(() => import('@/components/games/Minesweeper/MinesweeperWindow'));
// Formal verification (hood-exe-formal-verification-brief.md §7), also loaded on first open.
const VerificationWindow = lazy(() => import('@/components/verification/VerificationWindow').then((m) => ({ default: m.VerificationWindow })));
const VerificationAdmin = lazy(() => import('@/components/verification/VerificationAdmin').then((m) => ({ default: m.VerificationAdmin })));

export const APP_COMPONENTS: Record<AppId, AppComponent | LazyExoticComponent<AppComponent>> = {
  welcome: Welcome,
  finder: FinderWindow,
  launch: Launch,
  explore: Explore,
  callouts: Callouts,
  portfolio: Portfolio,
  theorem: TheoremBoard,
  about: About,
  recycle: RecycleBin,
  token: TokenDetail,
  terms: Terms,
  risk: Risk,
  privacy: Privacy,
  games: GamesFolder,
  solitaire: SolitaireWindow,
  minesweeper: MinesweeperWindow,
  verification: VerificationWindow,
  verificationAdmin: VerificationAdmin,
};
