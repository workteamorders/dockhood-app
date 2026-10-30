'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RIGOR_DISCLAIMER, shortAddress } from '@hood/shared';
import { addressUrl } from '@/lib/network';
import { ProgressBar, Tabs } from '@/components/xp/Controls';

import { Latex } from '@/components/xp/Latex';
import { RigorBadge } from '@/components/xp/RigorBadge';
import { ApiError, CHART_INTERVALS, fetchCandles, fetchToken, type ChartInterval, type TokenDetail as Token } from '@/lib/api';
import { ipfsUrl } from '@/lib/ipfs';
import { displayTicker } from '@/lib/hoodToken';
import { FormalProofTab } from '@/components/verification/FormalProofTab';
import { VerificationBadge } from '@/components/verification/VerificationBadge';
import { Button } from '@/components/xp/Button';
import { VERIFICATION_LIVE } from '@/lib/features';
import { openVerification } from '@/lib/openApp';
import { useWindows, type WindowState } from '@/store/windows';
import { PHASE_LABEL, formatPercent, formatQuote, timeAgo } from '../explore/format';
import { TokenLogo } from '../explore/TokenLogo';
import { PriceChart } from './PriceChart';
import { CalloutFeed } from '../callouts/CalloutFeed';
import { TradePanel } from './TradePanel';
import { TradesTab } from './TradesTab';
import styles from './TokenDetail.module.css';

/** Token Detail (docs/BRIEF.md §5.4): header, chart + graduation bar, tabs, and the buy/sell panel. */
export function TokenDetail({ win }: { win: WindowState }) {
  const address = win.props?.address ?? '';
  const paused = win.minimized;
  const q = useQuery({ queryKey: ['token', address.toLowerCase()], queryFn: () => fetchToken(address), enabled: !!address, refetchInterval: paused ? false : 15_000 });

  const symbol = displayTicker(q.data?.token, q.data?.symbol);
  useEffect(() => {
    if (symbol) useWindows.getState().rename(win.id, `$${symbol} — Token Detail`);
  }, [symbol, win.id]);

  if (q.isPending) return <p className={styles.muted}>Loading…</p>;
  if (q.isError) {
    return (
      <div className={styles.muted}>
        <p>{q.error instanceof ApiError ? q.error.message : 'Could not load this token.'}</p>
        <a href={addressUrl(address)} target="_blank" rel="noopener noreferrer">
          View on Blockscout
        </a>
      </div>
    );
  }

  const t = q.data;
  return (
    <div className={styles.layout}>
      <div className={styles.main}>
        <Header token={t} />
        <ChartBox token={t} paused={paused} />
        <div className={styles.tabs}>
          <Tabs
            tabs={[
              { id: 'trades', label: 'Trades', content: <TradesTab address={t.token} symbol={displayTicker(t.token, t.symbol)} pairSymbol={t.pair.symbol} paused={paused} /> },
              { id: 'callouts', label: 'Callouts', content: <CalloutFeed token={t.token} ticker={t.symbol} /> },
              { id: 'theorem', label: 'Theorem', content: <TheoremTab token={t} /> },
              ...(t.formal ? [{ id: 'formal', label: 'Formal ✓', content: <FormalProofTab address={t.token} /> }] : []),
            ]}
          />
        </div>
      </div>
      <aside className={styles.side}>
        <TradePanel token={t} paused={paused} />
      </aside>
    </div>
  );
}

function Header({ token: t }: { token: Token }) {
  const symbol = displayTicker(t.token, t.symbol);
  return (
    <div className={styles.header}>
      <TokenLogo logo={t.logo} symbol={symbol} size={40} />
      <div className={styles.titles}>
        <div>
          <b>${symbol}</b> <span className={styles.name}>{t.name}</span>
        </div>
        <div className={styles.snippet}>{t.hood && t.statement ? <Latex source={t.statement} /> : <span className={styles.plain}>{t.blurb}</span>}</div>
      </div>
      {t.hood && <RigorBadge score={t.rigorScore} />}
      {t.formal && <VerificationBadge />}
      <dl className={styles.stats}>
        <div>
          <dt>Price</dt>
          <dd>{formatQuote(t.price, t.pair.symbol)}</dd>
        </div>
        <div>
          <dt>MCap</dt>
          <dd>{formatQuote(t.marketCap, t.pair.symbol)}</dd>
        </div>
        <div>
          <dt>24h vol</dt>
          <dd>{formatQuote(t.volume24h, t.pair.symbol)}</dd>
        </div>
      </dl>
      <Share token={t} />
    </div>
  );
}

/** Copy the /t/0x… link (its preview shows this coin's card) or post it on X. */
function Share({ token: t }: { token: Token }) {
  const [copied, setCopied] = useState(false);
  const link = typeof window === 'undefined' ? '' : `${window.location.origin}/t/${t.token}`;
  const symbol = displayTicker(t.token, t.symbol);
  const text = t.hood && t.rigorScore != null ? `${symbol}: a theorem coin on Dockhood, rigor ${t.rigorScore}/100` : `${symbol} on Dockhood`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      window.prompt('Copy this link:', link);
    }
  };
  return (
    <div className={styles.share}>
      <button type="button" className={styles.shareBtn} onClick={() => void copy()}>
        {copied ? 'Copied ✓' : 'Copy link'}
      </button>
      <a className={styles.shareBtn} href={`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(link)}`} target="_blank" rel="noopener noreferrer">
        Post on X
      </a>
    </div>
  );
}

function ChartBox({ token: t, paused }: { token: Token; paused: boolean }) {
  const [interval, setInterval] = useState<ChartInterval>('5m');
  const q = useQuery({
    queryKey: ['candles', t.token.toLowerCase(), interval],
    queryFn: () => fetchCandles(t.token, interval),
    refetchInterval: paused ? false : 15_000,
  });

  return (
    <div className={styles.chartBox}>
      <div className={styles.chartBar}>
        <span>Price ({t.pair.symbol})</span>
        <div role="radiogroup" aria-label="Chart interval" className={styles.intervals}>
          {CHART_INTERVALS.map((i) => (
            <button key={i} type="button" role="radio" aria-checked={interval === i} className={interval === i ? styles.intervalOn : styles.interval} onClick={() => setInterval(i)}>
              {i}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.chart}>
        {q.isError ? (
          <p className={styles.muted}>{q.error instanceof ApiError ? q.error.message : 'Could not load the chart.'}</p>
        ) : q.data && q.data.candles.length === 0 ? (
          <p className={styles.muted}>No trades in this range yet.</p>
        ) : (
          <PriceChart key={interval} data={q.data?.candles ?? []} />
        )}
      </div>
      <div className={styles.curveLabel}>
        <span>{t.phase === 0 ? `Curve ${formatPercent(t.progress)} → Uniswap V4` : PHASE_LABEL[t.phase]}</span>
        <span className={styles.muted}>
          launched {timeAgo(t.launchedAt)} by <span className={styles.mono}>{shortAddress(t.deployer)}</span>
        </span>
      </div>
      <ProgressBar value={(t.progress ?? 0) * 100} label="Graduation progress" />
    </div>
  );
}

function TheoremTab({ token: t }: { token: Token }) {
  const metadata = t.metadataCid ? ipfsUrl(t.metadataCid) : null;
  if (!t.hood || !t.statement) {
    return (
      <div>
        <p className={styles.muted} style={{ marginTop: 0 }}>
          This coin wasn&apos;t launched on Dockhood, so it carries no theorem. Its description:
        </p>
        <p className={styles.description}>{t.description || 'No description.'}</p>
      </div>
    );
  }
  return (
    <div>
      <div className={styles.theorem}>
        <Latex source={t.statement} />
      </div>
      {t.formal ? (
        <p className={styles.muted}>
          Rigor <RigorBadge score={t.rigorScore} /> <VerificationBadge small /> — formally verified: a Lean 4 proof was checked by the kernel and reviewed (see the Formal ✓
          tab).
        </p>
      ) : (
        <>
          <p className={styles.muted}>
            Rigor <RigorBadge score={t.rigorScore} /> — {RIGOR_DISCLAIMER}.
          </p>
          {VERIFICATION_LIVE && (
            <p>
              <Button onClick={() => openVerification(t.token)}>⚡ Submit for Formal Verification</Button>{' '}
              <span className={styles.muted}>A Lean proof that passes earns Σ 100, FORMAL ✓ and a reward.</span>
            </p>
          )}
        </>
      )}
      <p>
        <a href={addressUrl(t.token)} target="_blank" rel="noopener noreferrer">
          Token on Blockscout
        </a>
        {metadata && (
          <>
            {' · '}
            <a href={metadata} target="_blank" rel="noopener noreferrer">
              Theorem and proof sketch on IPFS
            </a>
          </>
        )}
      </p>
    </div>
  );
}
