'use client';

import { useEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { RIGOR_DISCLAIMER } from '@hood/shared';
import { Button } from '@/components/xp/Button';
import { ProgressBar, StatusBar } from '@/components/xp/Controls';
import { Latex } from '@/components/xp/Latex';
import { VerificationBadge } from '@/components/verification/VerificationBadge';
import { RigorBadge } from '@/components/xp/RigorBadge';
import { ApiError, fetchTokens, type TokenItem, type TokenQuery } from '@/lib/api';
import { displayTicker } from '@/lib/hoodToken';
import { openApp, openToken } from '@/lib/openApp';
import type { WindowState } from '@/store/windows';
import { PHASE_LABEL, formatPercent, formatQuote } from './format';
import { TokenLogo } from './TokenLogo';
import styles from './Explore.module.css';

const PAGE = 36;
/** Explore opens on "All Pons" until hood.exe has this many launches (docs/BRIEF.md §5.3). */
const HOOD_TAB_MIN = 12;

const SORTS: { id: TokenQuery['sort']; label: string; needsIndexer?: boolean }[] = [
  { id: 'latest', label: 'Latest' },
  { id: 'volume', label: 'Volume', needsIndexer: true },
  { id: 'rigor', label: 'Rigor' },
  { id: 'mcap', label: 'MCap' },
];

export function Explore({ win }: { win: WindowState }) {
  const [tab, setTab] = useState<TokenQuery['tab'] | null>(null);
  const [sort, setSort] = useState<TokenQuery['sort']>('latest');
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  // Search once typing pauses; 2+ characters, or an empty box to go back to the full list.
  useEffect(() => {
    const next = text.trim();
    const id = window.setTimeout(() => setSearch(next.length >= 2 ? next : ''), 300);
    return () => window.clearTimeout(id);
  }, [text]);

  // The tab is decided by the first answer (hoodCount), so the very first page always loads "all".
  const effectiveTab = tab ?? 'all';
  const q = useInfiniteQuery({
    queryKey: ['tokens', effectiveTab, sort, search],
    queryFn: ({ pageParam }) => fetchTokens({ tab: effectiveTab, sort, limit: PAGE, offset: pageParam, q: search || undefined }),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.offset + last.items.length < last.total ? last.offset + last.items.length : undefined),
    refetchInterval: win.minimized ? false : 15_000,
  });

  const hoodCount = q.data?.pages[0]?.hoodCount ?? 0;
  if (tab == null && q.data && hoodCount >= HOOD_TAB_MIN) setTab('hood');

  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const total = q.data?.pages[0]?.total ?? 0;
  // Volume needs the indexer; until the first answer says whether it's there, leave the option on.
  const hasVolume = q.data?.pages[0]?.volume ?? true;

  return (
    <div className={styles.explore}>
      <div className={styles.toolbar}>
        <div role="tablist" className={styles.tabs}>
          {(
            [
              ['hood', `Dockhood launches (${hoodCount})`],
              ['all', 'All Pons'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={effectiveTab === id} className={effectiveTab === id ? styles.tabActive : styles.tab} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        <input
          type="search"
          className={styles.search}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search ticker, name or 0x…"
          aria-label="Search coins"
          maxLength={64}
          spellCheck={false}
        />
        <label className={styles.sort}>
          Sort by:{' '}
          <select value={sort} onChange={(e) => setSort(e.target.value as TokenQuery['sort'])}>
            {SORTS.map((s) => {
              const off = s.needsIndexer && !hasVolume;
              return (
                <option key={s.id} value={s.id} disabled={off} title={off ? 'Needs the indexer' : undefined}>
                  {s.label}
                  {off ? ' (unavailable)' : ''}
                </option>
              );
            })}
          </select>
        </label>
      </div>

      <div className={styles.view}>
        {q.isPending ? (
          <p className={styles.empty}>Looking for coins…</p>
        ) : q.isError ? (
          <p className={styles.empty}>{q.error instanceof ApiError ? q.error.message : 'Could not load coins.'}</p>
        ) : items.length === 0 && search ? (
          <div className={styles.empty}>
            <p>No coins match “{search}”{effectiveTab === 'hood' ? ' among Dockhood launches' : ''}.</p>
            {effectiveTab === 'hood' && <Button onClick={() => setTab('all')}>Search All Pons</Button>}
          </div>
        ) : items.length === 0 ? (
          <div className={styles.empty}>
            <p>{effectiveTab === 'hood' ? 'No Dockhood launches yet.' : 'No coins indexed yet.'}</p>
            <Button variant="primary" onClick={() => openApp('launch')}>
              ▶ Launch a Coin
            </Button>
          </div>
        ) : (
          <ul className={styles.grid}>
            {items.map((t) => (
              <TokenCard key={t.token} token={t} showVolume={sort === 'volume'} />
            ))}
          </ul>
        )}
        {q.hasNextPage && (
          <div className={styles.more}>
            <Button onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
              {q.isFetchingNextPage ? 'Loading…' : 'Show more'}
            </Button>
          </div>
        )}
      </div>

      <StatusBar cells={[`${total.toLocaleString('en-US')} object${total === 1 ? '' : 's'}`, `AI-scored by rigor · ${RIGOR_DISCLAIMER}`]} />
    </div>
  );
}

function TokenCard({ token: t, showVolume }: { token: TokenItem; showVolume: boolean }) {
  const symbol = displayTicker(t.token, t.symbol);
  const open = () => openToken(t.token, symbol);
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        className={styles.card}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          open();
        }}
        aria-label={`$${symbol} ${t.name}`}
      >
        <div className={styles.cardHead}>
          <TokenLogo logo={t.logo} symbol={symbol} />
          <div className={styles.names}>
            <b>${symbol || '?'}</b>
            <span>{t.name}</span>
          </div>
          {t.hood && <RigorBadge score={t.rigorScore} />}
          {t.formal && <VerificationBadge small />}
        </div>
        <div className={styles.snippet}>{t.hood && t.statement ? <Latex source={t.statement} /> : <span className={styles.plain}>{t.blurb}</span>}</div>
        <div className={styles.stats}>
          <span>{showVolume ? `24h ${formatQuote(t.volume24h, t.pair.symbol)}` : `MC ${formatQuote(t.marketCap, t.pair.symbol)}`}</span>
          <span>{t.phase === 0 ? formatPercent(t.progress) : PHASE_LABEL[t.phase]}</span>
        </div>
        <ProgressBar value={(t.progress ?? 0) * 100} label={`Graduation progress for $${symbol}`} />
      </div>
    </li>
  );
}
