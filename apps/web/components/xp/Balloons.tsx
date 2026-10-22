'use client';

import { useEffect, useRef } from 'react';
import { shortAddress } from '@hood/shared';
import { formatQuote, timeAgo } from '@/components/apps/explore/format';
import { fetchRecentActivity, type Activity, type Callout } from '@/lib/api';
import { playBalloonSound, unlockBalloonSound } from '@/lib/balloonSound';
import { displayTicker } from '@/lib/hoodToken';
import { onLive, startLive } from '@/lib/live';
import { openApp, openToken } from '@/lib/openApp';
import { tradeBalloonFeed, type TradeBalloon } from '@/lib/tradeBalloons';
import { useStartup } from '@/store/startup';
import { useTray } from '@/store/tray';
import { useWindows } from '@/store/windows';
import { CtrlGlyph } from './Window';
import styles from './Balloons.module.css';

const FADE_MS = 6_000;
const GONE_MS = 8_000;
/** The first visit's balloon (the newest notable trade of the last 15 minutes) waits for the desktop to settle. */
const WELCOME_TRADE_MS = 3_000;
const LINES = 3;

const calloutsVisible = () => useWindows.getState().windows.some((w) => w.appId === 'callouts' && !w.minimized);

/** That coin's Token Detail is the window in front: its trade list is already updating there. */
const tokenInFront = (a: Activity) => {
  const { windows, activeId } = useWindows.getState();
  const win = windows.find((w) => w.id === `token:${a.token.toLowerCase()}`);
  return !!win && !win.minimized && activeId === win.id;
};

/**
 * Tray balloons (docs/BRIEF.md §5.6). Keeps the page's live link open, and when a callout arrives while
 * Callouts.exe is closed or minimized, raises a balloon from the tray and lights the unread dot. Notable $HEXE and
 * hood-coin trades raise their own balloons, paced by lib/tradeBalloons.ts; a first visit opens with the newest.
 */
export function Balloons() {
  const balloons = useTray((s) => s.balloons);
  const trade = useTray((s) => s.trade);
  const windows = useWindows((s) => s.windows);
  const desktopShown = useStartup((s) => s.done);
  const sound = useTray((s) => s.soundEnabled);

  // Browsers allow audio only after a click or key press; the first one unlocks the chime.
  useEffect(() => {
    const unlock = () => {
      unlockBalloonSound();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return unlock;
  }, []);

  // Chime when a balloon pops up, not when one is dismissed or the setting changes: only for ids not seen before.
  const heard = useRef(new Set<string>());
  useEffect(() => {
    const ids = [...balloons.map((b) => b.id), ...(trade ? [trade.id] : [])];
    const fresh = ids.some((id) => !heard.current.has(id));
    if (heard.current.size > 200) heard.current.clear();
    ids.forEach((id) => heard.current.add(id));
    if (fresh && sound) playBalloonSound();
  }, [balloons, trade, sound]);

  useEffect(() => {
    const stop = startLive();
    const off = onLive((e) => {
      if (e.type === 'callout' && !calloutsVisible()) useTray.getState().push(e.callout);
    });
    return () => {
      off();
      stop();
    };
  }, []);

  // Trades wait for the desktop to be in view: a balloon under the boot screen would be wasted.
  useEffect(() => {
    if (!desktopShown) return;
    const feed = tradeBalloonFeed({ show: (b) => useTray.getState().showTrade(b), skip: tokenInFront, openedAt: Date.now() });
    const off = onLive((e) => {
      if (e.type === 'activity') feed.add(e.activity);
    });
    const welcome = setTimeout(() => {
      void fetchRecentActivity()
        .then((items) => {
          const newest = items.at(-1);
          feed.seen(items.slice(0, -1));
          if (newest) feed.add(newest, { fromBefore: true });
        })
        .catch(() => {});
    }, WELCOME_TRADE_MS);
    return () => {
      clearTimeout(welcome);
      feed.stop();
      off();
    };
  }, [desktopShown]);

  // Opening (or restoring) Callouts reads everything and clears the balloons.
  const open = windows.some((w) => w.appId === 'callouts' && !w.minimized);
  useEffect(() => {
    if (open) {
      useTray.getState().markRead();
      useTray.getState().clearAll();
    }
  }, [open]);

  if (!balloons.length && !trade) return null;
  return (
    <div className={styles.stack} aria-live="polite">
      {balloons.map((b) => (
        <Balloon key={b.id} callout={b} />
      ))}
      {trade && <TradeBalloonView key={trade.id} balloon={trade} />}
    </div>
  );
}

const bought = (a: Activity) => `${a.side === 'buy' ? 'bought' : 'sold'} ${formatQuote(Number(a.eth), 'ETH')}`;
const sideIcon = (a: Activity) => (a.side === 'buy' ? '🟢' : '🔴');

/** "🟢 Buy · $HEXE: 0x12ab…9f0c bought 0.05 ETH", or several trades in one. Click: that coin's Token Detail. */
function TradeBalloonView({ balloon }: { balloon: TradeBalloon }) {
  useEffect(() => {
    const t = setTimeout(() => useTray.getState().dismissTrade(balloon.id), GONE_MS);
    return () => clearTimeout(t);
  }, [balloon.id]);

  const items = balloon.items;
  const latest = items[items.length - 1];
  const tickers = new Set(items.map((a) => displayTicker(a.token, a.ticker)));
  const ticker = displayTicker(latest.token, latest.ticker);
  const one = items.length === 1;
  const open = () => {
    openToken(latest.token, ticker || undefined);
    useTray.getState().dismissTrade(balloon.id);
  };
  // The first visit's balloon can be minutes old; say so.
  const ago = balloon.shownAt - latest.time * 1000 > 60_000 ? timeAgo(new Date(latest.time * 1000).toISOString(), balloon.shownAt) : null;

  return (
    <div
      role="button"
      tabIndex={0}
      className={styles.balloon}
      style={{ animationDelay: `${FADE_MS}ms`, animationDuration: `${GONE_MS - FADE_MS}ms` }}
      onClick={open}
      onKeyDown={(e) => e.key === 'Enter' && open()}
    >
      <div className={styles.head}>
        <b>
          {one ? `${sideIcon(latest)} ${latest.side === 'buy' ? 'Buy' : 'Sell'}` : `📈 ${items.length} trades`}
          {tickers.size === 1 && ticker ? <span className={styles.ticker}> · ${ticker}</span> : null}
        </b>
        <button
          type="button"
          className={styles.close}
          aria-label="Dismiss"
          onClick={(e) => {
            e.stopPropagation();
            useTray.getState().dismissTrade(balloon.id);
          }}
        >
          <CtrlGlyph kind="close" />
        </button>
      </div>
      {one ? (
        <p className={styles.text}>
          <b>{shortAddress(latest.trader)}</b> {bought(latest)}
          {ago && <span className={styles.ago}> · {ago}</span>}
        </p>
      ) : (
        <ul className={styles.lines}>
          {items.slice(-LINES).reverse().map((a) => (
            <li key={a.id}>
              {sideIcon(a)} <b>{shortAddress(a.trader)}</b> {bought(a)}
              {tickers.size > 1 && a.ticker ? <span className={styles.ticker}> ${displayTicker(a.token, a.ticker)}</span> : null}
            </li>
          ))}
          {items.length > LINES && <li className={styles.ago}>and {items.length - LINES} more</li>}
        </ul>
      )}
    </div>
  );
}

function Balloon({ callout: c }: { callout: Callout }) {
  useEffect(() => {
    const t = setTimeout(() => useTray.getState().dismiss(c.id), GONE_MS);
    return () => clearTimeout(t);
  }, [c.id]);

  const who = c.kind === 'system' ? 'Dockhood' : (c.nickname ?? shortAddress(c.wallet));
  return (
    <div
      role="button"
      tabIndex={0}
      className={styles.balloon}
      style={{ animationDelay: `${FADE_MS}ms`, animationDuration: `${GONE_MS - FADE_MS}ms` }}
      onClick={() => openApp('callouts')}
      onKeyDown={(e) => e.key === 'Enter' && openApp('callouts')}
    >
      <div className={styles.head}>
        <b>📣 New Callout</b>
        <button
          type="button"
          className={styles.close}
          aria-label="Dismiss"
          onClick={(e) => {
            e.stopPropagation();
            useTray.getState().dismiss(c.id);
          }}
        >
          <CtrlGlyph kind="close" />
        </button>
      </div>
      <p className={styles.text}>
        <b>{who}</b>
        {c.ticker ? <span className={styles.ticker}> ${displayTicker(c.tokenAddress, c.ticker)}</span> : null}: {c.text.length > 120 ? `${c.text.slice(0, 119)}…` : c.text}
      </p>
    </div>
  );
}
