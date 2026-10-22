'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/xp/Button';
import { ConnectWallet } from '@/components/xp/ConnectWallet';
import { Tabs } from '@/components/xp/Controls';
import { PortfolioIcon } from '@/components/xp/Icons';
import { VerificationBadge } from '@/components/verification/VerificationBadge';
import { RigorBadge } from '@/components/xp/RigorBadge';
import { ApiError, fetchPortfolio, type Holding, type TokenItem } from '@/lib/api';
import { useIdentity } from '@/lib/identity';
import { displayTicker } from '@/lib/hoodToken';
import { openApp, openToken } from '@/lib/openApp';
import type { WindowState } from '@/store/windows';
import { PHASE_LABEL, formatPercent, formatQuote, timeAgo } from '../explore/format';
import { TokenLogo } from '../explore/TokenLogo';
import { holdingsCsv, sortHoldings, totalsByPair, type HoldingSort } from './holdings';
import shared from '../apps.module.css';
import styles from './Portfolio.module.css';

const SORTS: { id: HoldingSort; label: string }[] = [
  { id: 'rigor', label: 'Rigor' },
  { id: 'value', label: 'Value' },
  { id: 'pnl', label: 'P&L %' },
];

const compact = (n: number) => n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const signed = (n: number | null, symbol: string) => (n == null ? '—' : `${n > 0 ? '+' : ''}${formatQuote(n, symbol)}`);
const pct = (n: number | null) => (n == null ? '' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`);
const tone = (n: number | null) => (n == null || n === 0 ? undefined : n > 0 ? styles.up : styles.down);

/** Portfolio.exe (docs/BRIEF.md §5.7): the connected wallet's holdings with unrealized P&L, and its launches. */
export function Portfolio({ win }: { win: WindowState }) {
  const { connected, address, label } = useIdentity();
  const q = useQuery({
    queryKey: ['portfolio', address?.toLowerCase()],
    queryFn: () => fetchPortfolio(address!),
    enabled: connected,
    refetchInterval: win.minimized ? false : 30_000,
  });

  if (!connected) {
    return (
      <div className={`${shared.pane} ${shared.center}`} style={{ justifyContent: 'center' }}>
        <PortfolioIcon size={48} />
        <p style={{ margin: 0 }}>Connect a wallet to see your launches and holdings.</p>
        <ConnectWallet large />
      </div>
    );
  }
  if (q.isPending) return <p className={`${shared.pane} ${styles.muted}`}>Loading your coins…</p>;
  if (q.isError) {
    return (
      <div className={`${shared.pane} ${shared.center}`} style={{ justifyContent: 'center' }}>
        <p style={{ margin: 0 }}>{q.error instanceof ApiError ? q.error.message : 'Could not load your portfolio.'}</p>
        <Button onClick={() => q.refetch()}>Try again</Button>
      </div>
    );
  }

  const { holdings, launches, tradeHistory } = q.data;
  if (holdings.length === 0 && launches.length === 0) {
    return (
      <div className={`${shared.pane} ${shared.center}`} style={{ justifyContent: 'center' }}>
        <PortfolioIcon size={48} />
        <p style={{ margin: 0 }}>You don&apos;t have any coins yet.</p>
        <Button variant="primary" onClick={() => openApp('launch')}>
          ▶ Launch a Coin
        </Button>
        {!tradeHistory && <p className={shared.fineprint}>Trade history is offline, so only coins you launched are listed.</p>}
      </div>
    );
  }

  const totals = totalsByPair(holdings);
  return (
    <div className={styles.window}>
      <div className={styles.summary}>
        <span className={styles.who} title={address}>
          {label}
        </span>
        <span>
          Value: <b>{totals.length ? totals.map((t) => formatQuote(t.value, t.symbol)).join(' + ') : '—'}</b>
        </span>
        <span>
          P&amp;L:{' '}
          {totals.some((t) => t.cost > 0) ? (
            totals
              .filter((t) => t.cost > 0)
              .map((t) => (
                <b key={t.symbol} className={tone(t.pnl)}>
                  {signed(t.pnl, t.symbol)} {pct((t.pnl / t.cost) * 100)}
                </b>
              ))
          ) : (
            <b>—</b>
          )}
        </span>
      </div>
      <div className={styles.body}>
        <Tabs
          tabs={[
            { id: 'holdings', label: `Holdings (${holdings.length})`, content: <HoldingsTab holdings={holdings} wallet={q.data.wallet} tradeHistory={tradeHistory} /> },
            { id: 'launches', label: `My launches (${launches.length})`, content: <LaunchesTab launches={launches} /> },
          ]}
        />
      </div>
    </div>
  );
}

function HoldingsTab({ holdings, wallet, tradeHistory }: { holdings: Holding[]; wallet: string; tradeHistory: boolean }) {
  const [sort, setSort] = useState<HoldingSort>('rigor');
  const rows = sortHoldings(holdings, sort);

  function exportCsv() {
    const url = URL.createObjectURL(new Blob([holdingsCsv(rows)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `hood-portfolio-${wallet.slice(0, 8).toLowerCase()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  return (
    <>
      <div className={styles.toolbar}>
        <label>
          Sort:{' '}
          <select value={sort} onChange={(e) => setSort(e.target.value as HoldingSort)}>
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <Button onClick={exportCsv} disabled={rows.length === 0}>
          Export CSV
        </Button>
      </div>
      {!tradeHistory && <p className={styles.note}>Trade history is offline: only coins you launched are listed, without cost basis.</p>}
      {rows.length === 0 ? (
        <p className={styles.muted}>You don&apos;t hold any coins right now.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Coin</th>
              <th scope="col" className={styles.num}>
                Balance
              </th>
              <th scope="col" className={styles.num}>
                Value
              </th>
              <th scope="col" className={styles.num}>
                P&amp;L
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((h) => (
              <tr key={h.token} tabIndex={0} onClick={() => openToken(h.token, displayTicker(h.token, h.symbol))} onKeyDown={(e) => e.key === 'Enter' && openToken(h.token, displayTicker(h.token, h.symbol))} title={h.name}>
                <td>
                  <span className={styles.coin}>
                    <TokenLogo logo={h.logo} symbol={displayTicker(h.token, h.symbol)} size={18} />
                    <b>${displayTicker(h.token, h.symbol)}</b>
                    {h.hood && <RigorBadge score={h.rigorScore} />}
                    {h.formal && <VerificationBadge small />}
                    {h.launchedByMe && <span className={styles.tag}>yours</span>}
                  </span>
                </td>
                <td className={styles.num}>{compact(h.balance)}</td>
                <td className={styles.num}>{h.phase === 0 ? formatQuote(h.value, h.pair.symbol) : <span className={styles.muted}>{PHASE_LABEL[h.phase] ?? '—'}</span>}</td>
                <td className={`${styles.num} ${tone(h.pnl) ?? ''}`} title={h.costBasis != null ? `Cost basis ${formatQuote(h.costBasis, h.pair.symbol)}` : 'Cost basis unknown'}>
                  {h.pnl == null ? (
                    '—'
                  ) : (
                    <>
                      {signed(h.pnl, h.pair.symbol)} <span className={styles.pct}>{pct(h.pnlPct)}</span>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function LaunchesTab({ launches }: { launches: TokenItem[] }) {
  if (launches.length === 0) {
    return (
      <div className={shared.center}>
        <p className={styles.muted}>You haven&apos;t launched a coin yet.</p>
        <Button variant="primary" onClick={() => openApp('launch')}>
          ▶ Launch a Coin
        </Button>
      </div>
    );
  }
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th scope="col">Coin</th>
          <th scope="col">Status</th>
          <th scope="col" className={styles.num}>
            MCap
          </th>
          <th scope="col" className={styles.num}>
            Launched
          </th>
        </tr>
      </thead>
      <tbody>
        {launches.map((t) => (
          <tr key={t.token} tabIndex={0} onClick={() => openToken(t.token, displayTicker(t.token, t.symbol))} onKeyDown={(e) => e.key === 'Enter' && openToken(t.token, displayTicker(t.token, t.symbol))} title={t.name}>
            <td>
              <span className={styles.coin}>
                <TokenLogo logo={t.logo} symbol={displayTicker(t.token, t.symbol)} size={18} />
                <b>${displayTicker(t.token, t.symbol)}</b>
                {t.hood && <RigorBadge score={t.rigorScore} />}
                {t.formal && <VerificationBadge small />}
              </span>
            </td>
            <td>{t.phase === 0 ? `${formatPercent(t.progress)} to graduate` : (PHASE_LABEL[t.phase] ?? '—')}</td>
            <td className={styles.num}>{formatQuote(t.marketCap, t.pair.symbol)}</td>
            <td className={styles.num}>{timeAgo(t.launchedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
