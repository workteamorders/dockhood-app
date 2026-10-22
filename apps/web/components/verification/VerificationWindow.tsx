'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { txUrl } from '@/lib/network';
import { Button } from '@/components/xp/Button';
import { Tabs } from '@/components/xp/Controls';
import { Dialog, MessageBox } from '@/components/xp/Dialog';
import { Latex } from '@/components/xp/Latex';
import { track } from '@/lib/analytics';
import { fetchVerificationConfig, fetchVerificationQueue, fetchVerificationSubmission, type VerificationRow, type VerificationTab } from '@/lib/api';
import { useIdentity } from '@/lib/identity';
import { displayTicker } from '@/lib/hoodToken';
import type { WindowState } from '@/store/windows';
import { eth, statusText } from './format';
import { ProofViewer } from './ProofViewer';
import { QueueList } from './QueueList';
import { SubmitProofForm } from './SubmitProofForm';
import styles from './verification.module.css';

const REFRESH_MS = 15_000;

function Tab({ tab, onOpen, enabled = true }: { tab: VerificationTab; onOpen: (id: string) => void; enabled?: boolean }) {
  const q = useQuery({ queryKey: ['verification', tab], queryFn: () => fetchVerificationQueue(tab), enabled, refetchInterval: REFRESH_MS });
  if (!enabled) return <p className={styles.empty}>Connect your wallet and sign in to see your submissions.</p>;
  if (q.isPending) return <p className={styles.empty}>Loading…</p>;
  if (q.isError) return <p className={styles.empty}>Couldn&apos;t load the queue. Try again in a moment.</p>;
  const empty = { mine: "You haven't submitted a proof yet.", public: 'The queue is empty.', verified: 'No coin is formally verified yet. Be the first.' }[tab];
  return <QueueList rows={q.data.items} empty={empty} onOpen={onOpen} />;
}

/** A submission: its status, the coin's theorem beside what the checker says was proved, errors, and the proof. */
function DetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['verification-submission', id], queryFn: () => fetchVerificationSubmission(id), refetchInterval: REFRESH_MS });
  const d = q.data;
  return (
    <Dialog title={d ? `$${displayTicker(d.submission.token, d.submission.ticker) ?? '?'} — proof` : 'Proof'} onClose={onClose} width={620} footer={<Button onClick={onClose}>Close</Button>}>
      {!d ? (
        <p className={styles.note}>{q.isError ? "Couldn't load this submission." : 'Loading…'}</p>
      ) : (
        <div className={styles.detail}>
          <div>
            Status: <b className={styles[d.submission.status]}>{statusText(d.submission)}</b>
            {d.submission.txHashResult && d.submission.txHashResult.startsWith('0x') && (
              <>
                {' '}
                ·{' '}
                <a href={txUrl(d.submission.txHashResult)} target="_blank" rel="noopener noreferrer">
                  result on Blockscout
                </a>
              </>
            )}
          </div>
          <div className={styles.field}>
            <span className={styles.label}>The coin&apos;s theorem:</span>
            <div className={styles.statement}>{d.coinStatement ? <Latex source={d.coinStatement} /> : '—'}</div>
          </div>
          {d.theorems.length > 0 && (
            <div className={styles.field}>
              <span className={styles.label}>Proved in Lean (checked by the kernel):</span>
              <ul className={styles.theorems}>
                {d.theorems.map((t) => (
                  <li key={t.name}>
                    <b>{t.name}</b> {t.ok ? '✓' : '✗'}
                    <br />
                    <code>{t.statement}</code>
                    <div className={styles.axioms}>axioms: {t.axioms.length ? t.axioms.join(', ') : 'none'}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {d.submission.errorSummary && <pre className={styles.errorLog}>{d.submission.errorSummary}</pre>}
          {d.proof && <ProofViewer source={d.proof} ipfsCid={d.submission.ipfsCid} />}
        </div>
      )}
    </Dialog>
  );
}

/** The brief's result modals (§1.3), for the viewer's own submissions as they finish. */
function ResultBox({ row, onClose, onResubmit }: { row: VerificationRow; onClose: () => void; onResubmit: () => void }) {
  const [copied, setCopied] = useState(false);
  const link = typeof window === 'undefined' ? '' : `${window.location.origin}/t/${row.token}`;
  const ticker = displayTicker(row.token, row.ticker);
  if (row.status === 'verified') {
    const text = `$${ticker} is now formally verified on Dockhood: a Lean proof of its theorem, Σ 100 FORMAL ✓`;
    return (
      <MessageBox
        title="✓ Formal Verification Passed"
        kind="info"
        onClose={onClose}
        width={420}
        buttons={
          <>
            <a
              className={styles.linkBtn}
              href={`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(link)}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => track('verification_shared', { shareDestination: 'x' })}
            >
              Post on X
            </a>
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(link).then(() => setCopied(true));
                track('verification_shared', { shareDestination: 'copy' });
              }}
            >
              {copied ? 'Copied ✓' : 'Copy link'}
            </Button>
            <Button onClick={onClose} data-autofocus>
              OK
            </Button>
          </>
        }
      >
        <p>
          Your coin <b>${ticker}</b> is now <b>Σ 100</b> with the FORMAL ✓ badge.
        </p>
        {row.rewardWei && (
          <p>
            Reward: <b>{eth(row.rewardWei)}</b> sent to your wallet.
          </p>
        )}
        {row.txHashResult?.startsWith('0x') && (
          <p>
            <a href={txUrl(row.txHashResult)} target="_blank" rel="noopener noreferrer">
              Confirmation transaction on Blockscout
            </a>
          </p>
        )}
      </MessageBox>
    );
  }
  return (
    <MessageBox
      title="⚠ Verification Failed"
      kind="warning"
      onClose={onClose}
      width={520}
      buttons={
        <>
          <Button onClick={onResubmit}>Edit &amp; Resubmit</Button>
          <Button onClick={onClose} data-autofocus>
            Close
          </Button>
        </>
      }
    >
      <p>
        Your proof for <b>${ticker}</b> {row.status === 'rejected' ? 'was rejected at review' : 'did not pass'}. Its rigor score is unchanged, and the
        submission fee is not refunded (it prevents spam).
      </p>
      {row.errorSummary && <pre className={styles.errorLog}>{row.errorSummary}</pre>}
    </MessageBox>
  );
}

/** Verification Queue.exe (brief §7.1): my submissions, the public queue, and the hall of verified coins. */
export function VerificationWindow({ win }: { win: WindowState }) {
  const { connected } = useIdentity();
  const queryClient = useQueryClient();
  const config = useQuery({ queryKey: ['verification-config'], queryFn: fetchVerificationConfig, refetchInterval: 60_000 });
  const [submitFor, setSubmitFor] = useState<{ token?: string } | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [result, setResult] = useState<VerificationRow | null>(null);

  // Opened from Token Detail: straight to submitting for that coin (each request carries a fresh `at`).
  const requested = win.props?.token ? `${win.props.token}:${win.props.at}` : null;
  const [handled, setHandled] = useState<string | null>(null);
  if (requested && requested !== handled) {
    setHandled(requested);
    setSubmitFor({ token: win.props!.token });
  }

  // Pop the result up when one of my submissions finishes while this window is open.
  const mine = useQuery({ queryKey: ['verification', 'mine'], queryFn: () => fetchVerificationQueue('mine'), enabled: connected, refetchInterval: REFRESH_MS });
  const last = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    if (!mine.data) return;
    const before = last.current;
    last.current = new Map(mine.data.items.map((r) => [r.id, r.status]));
    if (!before) return;
    const finished = mine.data.items.find((r) => ['verified', 'failed', 'rejected'].includes(r.status) && before.get(r.id) && before.get(r.id) !== r.status);
    if (finished) {
      track(finished.status === 'verified' ? 'verification_passed' : 'verification_failed', { tier: finished.tier, errorType: finished.status });
      setResult(finished);
    }
  }, [mine.data]);

  const enabled = config.data?.enabled ?? false;
  return (
    <div className={styles.window}>
      <div className={styles.body}>
        <div className={styles.tabs}>
          <Tabs
            initial={connected ? 'mine' : 'public'}
            tabs={[
              { id: 'mine', label: 'My submissions', content: <Tab tab="mine" onOpen={setDetail} enabled={connected} /> },
              { id: 'public', label: 'Public queue', content: <Tab tab="public" onOpen={setDetail} /> },
              { id: 'verified', label: 'Verified ✓', content: <Tab tab="verified" onOpen={setDetail} /> },
            ]}
          />
        </div>
        <div className={styles.footer}>
          <Button onClick={() => setSubmitFor({})} disabled={!enabled}>
            + Submit new proof
          </Button>
          {!enabled && config.data && <span className={styles.closed}>Proof submissions open soon. Verified coins and the queue are shown here.</span>}
        </div>
      </div>

      {submitFor && config.data && (
        <SubmitProofForm
          config={config.data}
          token={submitFor.token}
          onClose={() => setSubmitFor(null)}
          onSubmitted={(id) => {
            setSubmitFor(null);
            void queryClient.invalidateQueries({ queryKey: ['verification'] });
            setDetail(id);
          }}
        />
      )}
      {detail && <DetailDialog id={detail} onClose={() => setDetail(null)} />}
      {result && (
        <ResultBox
          row={result}
          onClose={() => setResult(null)}
          onResubmit={() => {
            setResult(null);
            setSubmitFor({ token: result.token });
          }}
        />
      )}
    </div>
  );
}
