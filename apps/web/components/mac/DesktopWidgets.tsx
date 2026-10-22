'use client';

import { useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { TokenLogo } from '@/components/apps/explore/TokenLogo';
import { formatQuote, PHASE_LABEL } from '@/components/apps/explore/format';
import { useModalFocus } from '@/components/xp/Dialog';
import { fetchTokens } from '@/lib/api';
import { displayTicker } from '@/lib/hoodToken';
import { openApp, openToken } from '@/lib/openApp';
import { ExploreIcon } from './AppIcon';
import styles from './DesktopWidgets.module.css';

const WIDE = '(min-width: 1100px) and (min-height: 740px)';
const subscribeLayout = (notify: () => void) => {
  const media = window.matchMedia(WIDE);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
};
const wideSnapshot = () => window.matchMedia(WIDE).matches;
const serverLayout = () => false;
const subscribeClock = (notify: () => void) => {
  const timer = window.setInterval(notify, 1000);
  return () => window.clearInterval(timer);
};
const clockSnapshot = () => Math.floor(Date.now() / 60_000) * 60_000;
const serverClock = () => 0;

function ClockWidget() {
  const timestamp = useSyncExternalStore(subscribeClock, clockSnapshot, serverClock);
  const now = timestamp ? new Date(timestamp) : null;
  const hour = now?.getHours() ?? 12;
  const greeting = hour < 5 ? 'Enjoy the quiet hours.' : hour < 12 ? 'A fresh start awaits.' : hour < 18 ? 'Make room for something new.' : 'Let the day wind down.';
  return <section className={`${styles.card} ${styles.clockCard}`} aria-label="Local time and date">
    <div className={styles.clockTop}><span className={styles.eyebrow}>YOUR LOCAL TIME</span><span className={styles.sun} aria-hidden="true" /></div>
    <time className={styles.time} dateTime={now?.toISOString()}>{now ? now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }) : '--:--'}</time>
    <p className={styles.date}>{now ? now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) : 'A moment of calm.'}</p>
    <p className={styles.greeting}>{greeting}</p>
  </section>;
}

function MarketWidget({ onNavigate }: { onNavigate?: () => void }) {
  const query = useQuery({
    // Keep a plain page separate from Explore's infinite-query cache.
    queryKey: ['desktop-market', 'all', 'latest', 3],
    queryFn: () => fetchTokens({ tab: 'all', sort: 'latest', limit: 3, offset: 0 }),
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    retry: 1,
  });
  const items = query.data?.items;
  return <section className={`${styles.card} ${styles.marketCard}`} aria-labelledby="desktop-market-title" aria-busy={query.isFetching}>
    <header className={styles.marketHeader}>
      <ExploreIcon size={34} />
      <div><h2 id="desktop-market-title">Market watch</h2><p>Fresh launches. New possibilities.</p></div>
    </header>
    <div className={styles.marketLabel}><span>LATEST ON PONS</span><span>PRICE / PAIR</span></div>
    {items?.length ? <ul className={styles.tokens}>{items.slice(0, 3).map((token) => {
      const ticker = displayTicker(token.token, token.symbol);
      return <li key={token.token}><button className={styles.token} onClick={() => { onNavigate?.(); openToken(token.token, ticker); }} aria-label={`Open ${ticker || token.name}`}>
        <TokenLogo logo={token.logo} symbol={ticker} size={34} />
        <span className={styles.tokenName}><strong>{ticker || token.name}</strong><span>{token.name}</span></span>
        <span className={styles.tokenPrice}><strong>{token.price == null ? 'Unavailable' : formatQuote(token.price, token.pair.symbol)}</strong><span>{PHASE_LABEL[token.phase] ?? 'Unknown phase'}</span></span>
      </button></li>;
    })}</ul> : query.isPending ? <div className={styles.skeleton} role="status" aria-label="Loading latest tokens"><span /><span /><span /></div> : <div className={styles.empty} role="status">
      <strong>{query.isError ? 'Taking a little breather.' : 'The next launch starts here.'}</strong>
      <p>{query.isError ? 'Market data is unavailable right now.' : 'No tokens indexed yet. Explore what comes next.'}</p>
      {query.isError && <button className={styles.retry} onClick={() => void query.refetch()} disabled={query.isFetching}>Try again</button>}
    </div>}
    <div className={styles.marketStatus} role="status">{query.isError && query.data ? 'Refresh unavailable. Showing last update.' : query.dataUpdatedAt ? `Updated ${new Date(query.dataUpdatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} / 30s refresh` : 'Prices are quoted in each pair asset.'}</div>
    <button className={styles.explore} onClick={() => { onNavigate?.(); openApp('explore'); }}>Explore the market <span aria-hidden="true">&#8599;</span></button>
  </section>;
}

function WidgetSheet({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, onClose);
  return createPortal(<div className={styles.backdrop} onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={ref} data-dockhood-dialog role="dialog" aria-modal="true" aria-label="Desktop widgets" tabIndex={-1} className={styles.sheet}>
      <header className={styles.sheetHeader}><div><span className={styles.eyebrow}>YOUR DESKTOP, AT A GLANCE</span><h2>A little space. A little signal.</h2></div><button onClick={onClose} aria-label="Close widgets">&#215;</button></header>
      <div className={styles.cards}><ClockWidget /><MarketWidget onNavigate={onClose} /></div>
      <p className={styles.signature}>DOCKHOOD <span /> LIQUID SUNSET</p>
    </div>
  </div>, document.body);
}

export function DesktopWidgets({ open, onClose, covered = false }: { open: boolean; onClose: () => void; covered?: boolean }) {
  const wide = useSyncExternalStore(subscribeLayout, wideSnapshot, serverLayout);
  if (open) return <WidgetSheet onClose={onClose} />;
  if (!wide || covered) return null;
  return <aside className={styles.rail} aria-label="Desktop widgets">
    <div className={styles.railHeader}><span className={styles.eyebrow}>A LITTLE SPACE. A LITTLE SIGNAL.</span><svg className={styles.gridGlyph} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="m8 0 2 6 6 2-6 2-2 6-2-6-6-2 6-2Z" fill="currentColor" /></svg></div>
    <div className={styles.cards}><ClockWidget /><MarketWidget /></div>
    <p className={styles.signature}>DOCKHOOD <span /> LIQUID SUNSET</p>
  </aside>;
}
