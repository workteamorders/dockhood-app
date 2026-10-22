'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/xp/Button';
import { Dialog, MessageBox } from '@/components/xp/Dialog';
import { SolitaireIcon } from '@/components/xp/Icons';
import { track } from '@/lib/analytics';
import { finishRankedGame, startRankedGame, type RankedLevel, type RankedResult } from '@/lib/api';
import { useWindows, type WindowState } from '@/store/windows';
import { MenuBar, MenuButton, MenuItem } from '../GameMenu';
import { LeaderboardDialog, RankedBar, leaderboardKey } from '../Leaderboard';
import { useRankedSession } from '../useRankedSession';
import { canAutoComplete, displayScore, elapsedSeconds } from './solitaire.logic';
import { SolitaireBoard } from './Solitaire';
import { useSolitaire, type SolitaireHost } from './useSolitaire';
import styles from './solitaire.module.css';

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

type Modal = 'stats' | 'board' | 'help' | 'about' | null;

const BOARD: [RankedLevel, string][] = [['klondike', 'Klondike']];

/** Solitaire.exe (hood-exe-games-brief.md §2): menu bar, board, status bar, dialogs. Lazy-loaded. */
export default function SolitaireWindow({ win }: { win: WindowState }) {
  // Ranked play (the daily leaderboard) while the connected wallet is signed in.
  const { signedIn, signIn, signingIn } = useRankedSession();
  const queryClient = useQueryClient();
  const host = useMemo<SolitaireHost<RankedResult> | null>(
    () =>
      signedIn
        ? {
            start: () => startRankedGame('solitaire'),
            finish: async (id, game) => {
              const result = await finishRankedGame('solitaire', id, game);
              void queryClient.invalidateQueries({ queryKey: leaderboardKey('solitaire', 'klondike') });
              return result;
            },
          }
        : null,
    [signedIn, queryClient],
  );
  const g = useSolitaire<RankedResult>({ ranked: host });
  const { state, settings, stats } = g;
  const active = useWindows((s) => s.activeId === win.id);
  const [modal, setModal] = useState<Modal>(null);
  // Both refer to one finished game (its finishedAt), so a new deal starts fresh without resetting them.
  const [celebratedAt, setCelebratedAt] = useState<number | null>(null);
  const [winSeenAt, setWinSeenAt] = useState<number | null>(null);
  const celebrated = state.finishedAt != null && celebratedAt === state.finishedAt;
  const winSeen = state.finishedAt != null && winSeenAt === state.finishedAt;
  const setCelebrated = () => setCelebratedAt(state.finishedAt);
  const setWinSeen = () => setWinSeenAt(state.finishedAt);
  const [, tick] = useState(0);
  const close = () => useWindows.getState().close(win.id);

  // Analytics: opened, and how long the window stayed open.
  const openedAt = useRef(0);
  useEffect(() => {
    openedAt.current = Date.now();
    track('game_opened', { game: 'solitaire' });
    return () => track('solitaire_closed', { duration: Math.round((Date.now() - openedAt.current) / 1_000) });
  }, []);

  // The clock ticks while a game is under way.
  useEffect(() => {
    if (state.startedAt == null || state.status !== 'playing') return;
    const id = window.setInterval(() => tick((n) => n + 1), 1_000);
    return () => window.clearInterval(id);
  }, [state.startedAt, state.status]);

  // Auto-complete: once everything is face up, play the rest one card at a time.
  const { autoStep } = g;
  useEffect(() => {
    if (!settings.autoComplete || !canAutoComplete(state)) return;
    const id = window.setTimeout(autoStep, 110);
    return () => window.clearTimeout(id);
  }, [state, settings.autoComplete, autoStep]);

  // Keyboard (§2.5): F2 / Ctrl+N new game, Ctrl+Z undo. Only while this window is the focused one.
  const { newGame, undo } = g;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest('input, textarea, select')) return;
      if (e.key === 'F2' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n')) {
        e.preventDefault();
        newGame();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, newGame, undo]);

  const seconds = elapsedSeconds(state);
  const score = displayScore(state);

  return (
    <div className={styles.window}>
      <MenuBar>
        <MenuButton label="Game">
          <MenuItem onClick={g.newGame} shortcut="F2">
            New Game
          </MenuItem>
          <MenuItem onClick={g.dealAgain}>Deal Again</MenuItem>
          <MenuItem onClick={g.undo} shortcut="Ctrl+Z" disabled={!g.canUndo}>
            Undo
          </MenuItem>
          <hr />
          <MenuItem onClick={() => g.setSettings({ cardBack: 'blue' })} checked={settings.cardBack === 'blue'}>
            Blue card back
          </MenuItem>
          <MenuItem onClick={() => g.setSettings({ cardBack: 'red' })} checked={settings.cardBack === 'red'}>
            Red card back
          </MenuItem>
          <MenuItem onClick={() => g.setSettings({ autoComplete: !settings.autoComplete })} checked={settings.autoComplete}>
            Auto-complete
          </MenuItem>
          <hr />
          <MenuItem onClick={() => setModal('stats')}>Statistics…</MenuItem>
          <MenuItem onClick={() => setModal('board')}>Today&apos;s Leaderboard…</MenuItem>
          <hr />
          <MenuItem onClick={close}>Exit</MenuItem>
        </MenuButton>
        <MenuButton label="Help">
          <MenuItem onClick={() => setModal('help')}>How to Play</MenuItem>
          <MenuItem onClick={() => setModal('about')}>About Solitaire</MenuItem>
        </MenuButton>
      </MenuBar>

      <SolitaireBoard
        state={state}
        back={settings.cardBack}
        onDraw={g.draw}
        onMove={g.move}
        onFoundation={g.toFoundation}
        celebrated={celebrated}
        onCelebrated={setCelebrated}
      />

      <div className={styles.status}>
        <span>Time: {clock(seconds)}</span>
        <span>Moves: {state.moves}</span>
        <span>Score: {score.toLocaleString('en-US')}</span>
      </div>
      <RankedBar
        game="solitaire"
        level="klondike"
        unranked={g.unranked}
        notRankable=""
        signedIn={signedIn}
        ranked={g.ranked}
        onSignIn={signIn}
        signingIn={signingIn}
        onOpenBoard={() => setModal('board')}
      />

      {modal === 'board' && (
        <LeaderboardDialog
          game="solitaire"
          levels={BOARD}
          initial="klondike"
          clocked="Times are clocked by the server from the deal to the win."
          onClose={() => setModal(null)}
        />
      )}

      {g.resumable && (
        <MessageBox
          title="Solitaire"
          kind="question"
          onClose={g.declineResume}
          buttons={
            <>
              <Button onClick={g.resume} data-autofocus>
                Resume
              </Button>
              <Button onClick={g.declineResume}>New Game</Button>
            </>
          }
        >
          You have an unfinished game ({g.resumable.moves} moves). Resume it?
        </MessageBox>
      )}

      {state.status === 'won' && celebrated && !winSeen && (
        <MessageBox
          title="Solitaire"
          kind="info"
          onClose={setWinSeen}
          buttons={
            <>
              <Button onClick={g.newGame} data-autofocus>
                New Game
              </Button>
              <Button
                onClick={() => {
                  setWinSeen();
                  setModal('stats');
                }}
              >
                Statistics
              </Button>
            </>
          }
        >
          <p>
            <b>You won!</b>
          </p>
          <p>
            Time {clock(seconds)} · {state.moves} moves · Score {score.toLocaleString('en-US')}
          </p>
        </MessageBox>
      )}

      {modal === 'stats' && (
        <Dialog title="Statistics" onClose={() => setModal(null)} width={300} footer={<Button onClick={() => setModal(null)}>OK</Button>}>
          <table className={styles.statsTable}>
            <tbody>
              <tr>
                <th>Games played</th>
                <td>{stats.gamesPlayed}</td>
              </tr>
              <tr>
                <th>Games won</th>
                <td>
                  {stats.wins} ({stats.gamesPlayed ? Math.round((stats.wins / stats.gamesPlayed) * 100) : 0}%)
                </td>
              </tr>
              <tr>
                <th>Current streak</th>
                <td>{stats.currentStreak}</td>
              </tr>
              <tr>
                <th>Best time</th>
                <td>{stats.bestTime == null ? '—' : clock(stats.bestTime)}</td>
              </tr>
              <tr>
                <th>Fewest moves</th>
                <td>{stats.bestMoves ?? '—'}</td>
              </tr>
              <tr>
                <th>Best score</th>
                <td>{stats.bestScore?.toLocaleString('en-US') ?? '—'}</td>
              </tr>
            </tbody>
          </table>
          <p className={styles.note}>Kept in this browser only.</p>
        </Dialog>
      )}

      {modal === 'help' && (
        <Dialog title="How to Play" onClose={() => setModal(null)} width={380} footer={<Button onClick={() => setModal(null)}>OK</Button>}>
          <ul className={styles.helpList}>
            <li>Move every card to the four piles at the top right, by suit, from Ace up to King.</li>
            <li>In the seven columns, build down in alternating colours: a red 6 on a black 7.</li>
            <li>Drag a card, or a face-up run, onto another column. Only a King (or a run starting with one) fills an empty column.</li>
            <li>Click the deck to turn over one card. When it runs out, click it again to turn the pile back over (−15 points).</li>
            <li>Double-click (double-tap on a phone) or right-click a card to send it to its pile.</li>
            <li>F2 starts a new game, Ctrl+Z undoes a move.</li>
            <li>Scoring: +10 to a column from the turned-up pile, +5 from it to the top piles, +10 from a column to the top piles, +5 for turning over a column card, −15 for taking a card back down, −2 every 10 seconds, and a time bonus when you win.</li>
          </ul>
        </Dialog>
      )}

      {modal === 'about' && (
        <MessageBox title="About Solitaire" onClose={() => setModal(null)}>
          <div className={styles.about}>
            <SolitaireIcon size={40} />
            <div>
              <p>
                <b>Solitaire</b> for Dockhood
              </p>
              <p>Klondike, turn one. Your games and statistics stay in this browser.</p>
              <p className={styles.note}>An original recreation; not affiliated with Microsoft.</p>
            </div>
          </div>
        </MessageBox>
      )}
    </div>
  );
}
