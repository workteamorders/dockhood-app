'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/xp/Button';
import { Dialog, MessageBox } from '@/components/xp/Dialog';
import { MinesweeperIcon } from '@/components/xp/Icons';
import { track } from '@/lib/analytics';
import { finishRankedGame, startRankedGame, type RankedLevel, type RankedResult } from '@/lib/api';
import { useWindows, type WindowState } from '@/store/windows';
import { MenuBar, MenuButton, MenuItem } from '../GameMenu';
import { LeaderboardDialog, RankedBar, leaderboardKey } from '../Leaderboard';
import { useRankedSession } from '../useRankedSession';
import { BOARD_BORDER, CELL_MAX, Minesweeper } from './Minesweeper';
import { CUSTOM_LIMITS, PRESETS, validateCustom } from './minesweeper.logic';
import type { DifficultyConfig, PresetDifficulty } from './minesweeper.types';
import { useMinesweeper, type MinesweeperHost } from './useMinesweeper';
import styles from './minesweeper.module.css';

type Modal = 'custom' | 'best' | 'board' | 'help' | 'about' | null;

const LEVELS: [PresetDifficulty, string][] = [
  ['beginner', 'Beginner'],
  ['intermediate', 'Intermediate'],
  ['expert', 'Expert'],
];
const LEVEL_NAME = Object.fromEntries(LEVELS) as Record<PresetDifficulty, string>;
const MOBILE_QUERY = '(max-width: 640px)';
const MIN_WINDOW = { w: 240, cell: 16 } as const;
/**
 * Spare pixels around the board. Sizes are measured in whole pixels but laid out in fractions (browser zoom,
 * Retina scaling), so a window fitted exactly can leave the board a hair too big: scrollbars then crop it
 * (invisible ones on macOS) or fight the cell size.
 */
const FIT_SLACK = 2;

/** Minesweeper.exe (hood-exe-minesweeper-brief.md): menu bar, game, dialogs. Lazy-loaded on first open. */
export default function MinesweeperWindow({ win }: { win: WindowState }) {
  // Ranked play (the daily leaderboard) while the connected wallet is signed in.
  const { signedIn, signIn, signingIn } = useRankedSession();
  const queryClient = useQueryClient();
  const host = useMemo<MinesweeperHost<RankedResult> | null>(
    () =>
      signedIn
        ? {
            start: (level) => startRankedGame('minesweeper', level),
            finish: async (id, game) => {
              const result = await finishRankedGame('minesweeper', id, game);
              void queryClient.invalidateQueries({ queryKey: leaderboardKey('minesweeper', result.level as RankedLevel) });
              return result;
            },
          }
        : null,
    [signedIn, queryClient],
  );

  // The win hook (§10) is where a future whitelist/airdrop mechanic plugs in; nothing listens yet.
  const g = useMinesweeper<RankedResult>({ ranked: host });
  const { state, settings, stats } = g;
  const rankedLevel = settings.difficulty === 'custom' ? null : settings.difficulty;
  const active = useWindows((s) => s.activeId === win.id);
  const [modal, setModal] = useState<Modal>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const close = () => useWindows.getState().close(win.id);

  useEffect(() => {
    track('game_opened', { game: 'minesweeper' });
  }, []);

  // Fit the window to the board whenever its size or the browser window changes: the largest cell (up to
  // CELL_MAX) that keeps the window on screen. Phones skip this; there every window fills the screen and the
  // board scrolls instead.
  const { rows, cols } = state;
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const winEl = scroller?.closest<HTMLElement>('[data-window]');
    if (!scroller || !winEl) return;
    const fit = () => {
      if (window.matchMedia(MOBILE_QUERY).matches) return;
      const chromeW = winEl.offsetWidth - scroller.offsetWidth + BOARD_BORDER + FIT_SLACK;
      const chromeH = winEl.offsetHeight - scroller.offsetHeight + BOARD_BORDER + FIT_SLACK;
      const vw = window.innerWidth - 8;
      const vh = window.innerHeight - 30 - 8;
      const cell = Math.max(MIN_WINDOW.cell, Math.min(CELL_MAX, Math.floor(Math.min((vw - chromeW) / cols, (vh - chromeH) / rows))));
      useWindows.getState().resize(win.id, Math.max(MIN_WINDOW.w, chromeW + cols * cell), chromeH + rows * cell);
    };
    fit();
    // Resizing the browser, zooming it, or a late font changing the menu height all call for a refit.
    let frame = 0;
    const refit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    };
    window.addEventListener('resize', refit);
    let live = true;
    document.fonts?.ready.then(() => live && refit());
    return () => {
      live = false;
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', refit);
    };
  }, [win.id, rows, cols]);

  // F2 starts a new game while this window is the focused one (Esc closes dialogs, in Dialog itself).
  const { newGame } = g;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F2') return;
      e.preventDefault();
      newGame();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, newGame]);

  return (
    <div className={styles.window}>
      <MenuBar>
        <MenuButton label="Game">
          <MenuItem onClick={g.newGame} shortcut="F2">
            New
          </MenuItem>
          <hr />
          {LEVELS.map(([id, name]) => (
            <MenuItem key={id} onClick={() => g.setDifficulty(id)} checked={settings.difficulty === id}>
              {name}
            </MenuItem>
          ))}
          <MenuItem onClick={() => setModal('custom')} checked={settings.difficulty === 'custom'}>
            Custom…
          </MenuItem>
          <hr />
          <MenuItem onClick={g.toggleMarks} checked={settings.marksEnabled}>
            Marks (?)
          </MenuItem>
          <hr />
          <MenuItem onClick={() => setModal('best')}>Best Times…</MenuItem>
          <MenuItem onClick={() => setModal('board')}>Today&apos;s Leaderboard…</MenuItem>
          <hr />
          <MenuItem onClick={close}>Exit</MenuItem>
        </MenuButton>
        <MenuButton label="Help">
          <MenuItem onClick={() => setModal('help')}>Contents</MenuItem>
          <MenuItem onClick={() => setModal('about')}>About Minesweeper</MenuItem>
        </MenuButton>
      </MenuBar>

      <Minesweeper game={g} active={active && modal == null} scrollerRef={scrollerRef} />
      <RankedBar
        game="minesweeper"
        level={rankedLevel}
        notRankable="Custom boards aren't ranked."
        signedIn={signedIn}
        ranked={g.ranked}
        onSignIn={signIn}
        signingIn={signingIn}
        onOpenBoard={() => setModal('board')}
      />

      {modal === 'board' && (
        <LeaderboardDialog
          game="minesweeper"
          levels={LEVELS}
          initial={rankedLevel ?? 'beginner'}
          clocked="Times are clocked by the server from your first click to the win."
          onClose={() => setModal(null)}
        />
      )}

      {g.record && (
        <MessageBox title="Minesweeper" kind="info" onClose={g.dismissRecord}>
          <p>
            You have the fastest time for {LEVEL_NAME[g.record.difficulty].toLowerCase()} level: <b>{g.record.time} {g.record.time === 1 ? 'second' : 'seconds'}</b>.
          </p>
        </MessageBox>
      )}

      {modal === 'custom' && (
        <CustomDialog
          initial={settings.custom}
          onCancel={() => setModal(null)}
          onOk={(cfg) => {
            setModal(null);
            g.setDifficulty('custom', cfg);
          }}
        />
      )}

      {modal === 'best' && (
        <Dialog
          title="Fastest Mine Sweepers"
          onClose={() => setModal(null)}
          width={320}
          footer={
            <>
              <Button onClick={g.resetStats}>Reset Scores</Button>
              <Button onClick={() => setModal(null)} data-autofocus>
                OK
              </Button>
            </>
          }
        >
          <table className={styles.statsTable}>
            <thead>
              <tr>
                <th />
                <th>Best time</th>
                <th>Won</th>
              </tr>
            </thead>
            <tbody>
              {LEVELS.map(([id, name]) => (
                <tr key={id}>
                  <th scope="row">{name}</th>
                  <td>{stats[id].bestTime == null ? '—' : `${stats[id].bestTime} s`}</td>
                  <td>
                    {stats[id].wins} / {stats[id].gamesPlayed}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className={styles.note}>Kept in this browser only. Custom games aren’t timed for records.</p>
        </Dialog>
      )}

      {modal === 'help' && (
        <Dialog title="Minesweeper Help" onClose={() => setModal(null)} width={390} footer={<Button onClick={() => setModal(null)}>OK</Button>}>
          <ul className={styles.helpList}>
            <li>Find every square without a mine. Uncover one and it shows how many mines touch it (up to 8).</li>
            <li>Left-click a square to uncover it. Your first click is always safe and opens an area.</li>
            <li>Right-click to flag a mine. Right-click again for a ? (turn this off in Game → Marks), and again to clear it.</li>
            <li>When a number has that many flags around it, click it with both buttons (or the middle button) to uncover the rest of its neighbours.</li>
            <li>On a phone: tap to uncover, long-press to flag, or switch the toolbar to Flag. Pinch to zoom on big boards.</li>
            <li>Uncover every safe square to win. The counter on the left shows mines minus flags; the right one is the clock.</li>
            <li>F2 or the face starts a new game. Space flags the square under the mouse.</li>
          </ul>
        </Dialog>
      )}

      {modal === 'about' && (
        <MessageBox title="About Minesweeper" onClose={() => setModal(null)}>
          <div className={styles.about}>
            <MinesweeperIcon size={40} />
            <div>
              <p>
                <b>Minesweeper</b> for Dockhood
              </p>
              <p>Beginner, Intermediate, Expert and Custom. Your best times stay in this browser.</p>
              <p className={styles.note}>An original recreation; not affiliated with Microsoft.</p>
            </div>
          </div>
        </MessageBox>
      )}
    </div>
  );
}

function CustomDialog({ initial, onOk, onCancel }: { initial: DifficultyConfig; onOk: (cfg: DifficultyConfig) => void; onCancel: () => void }) {
  const [form, setForm] = useState({ rows: String(initial.rows), cols: String(initial.cols), mines: String(initial.mines) });
  const [error, setError] = useState<string | null>(null);
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const cfg = { rows: Number(form.rows), cols: Number(form.cols), mines: Number(form.mines) };
    const err = Object.values(form).some((v) => v.trim() === '') ? 'Fill in height, width and mines.' : validateCustom(cfg);
    if (err) setError(err);
    else onOk(cfg);
  };
  const field = (key: keyof typeof form, label: string, max: number) => (
    <label className={styles.field}>
      <span>{label}:</span>
      <input
        type="number"
        inputMode="numeric"
        min={key === 'mines' ? 0 : key === 'rows' ? CUSTOM_LIMITS.minRows : CUSTOM_LIMITS.minCols}
        max={max}
        value={form[key]}
        onChange={(e) => {
          setForm((f) => ({ ...f, [key]: e.target.value }));
          setError(null);
        }}
        data-autofocus={key === 'rows' ? true : undefined}
      />
    </label>
  );
  const rows = Number(form.rows) || 0;
  const cols = Number(form.cols) || 0;

  return (
    <Dialog
      title="Custom Field"
      onClose={onCancel}
      width={300}
      footer={
        <>
          <Button onClick={() => submit()}>OK</Button>
          <Button onClick={onCancel}>Cancel</Button>
        </>
      }
    >
      <form className={styles.customForm} onSubmit={submit} noValidate>
        {field('rows', 'Height', CUSTOM_LIMITS.maxRows)}
        {field('cols', 'Width', CUSTOM_LIMITS.maxCols)}
        {field('mines', 'Mines', Math.max(0, rows * cols - CUSTOM_LIMITS.safeCells))}
        <button type="submit" hidden />
      </form>
      <p className={styles.note}>
        Height {CUSTOM_LIMITS.minRows}–{CUSTOM_LIMITS.maxRows}, width {CUSTOM_LIMITS.minCols}–{CUSTOM_LIMITS.maxCols}. Leave at least {CUSTOM_LIMITS.safeCells} squares free of mines. Expert is {PRESETS.expert.cols} × {PRESETS.expert.rows} with {PRESETS.expert.mines}.
      </p>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
