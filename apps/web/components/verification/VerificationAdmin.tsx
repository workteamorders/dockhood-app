'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatEther, type Address } from 'viem';
import { useReadContract } from 'wagmi';
import { getAccount, switchChain, waitForTransactionReceipt, writeContract } from 'wagmi/actions';
import { TIERS, feeSplitterAbi, type Tier } from '@hood/shared';
import { Button } from '@/components/xp/Button';
import { Latex } from '@/components/xp/Latex';
import { fetchVerificationAdmin, fetchVerificationConfig, reviewVerification, setVerificationPaused, type VerificationAdmin as Overview } from '@/lib/api';
import { useIdentity } from '@/lib/identity';
import { displayTicker } from '@/lib/hoodToken';
import { ensureSession } from '@/lib/siwe';
import { chain, ensureRpcNetwork, wagmiConfig } from '@/lib/wagmi';
import { duration } from './format';
import { ProofViewer } from './ProofViewer';
import styles from './verification.module.css';

const message = (e: unknown) => (e instanceof Error ? e.message.split('\n')[0] : 'Something went wrong.');
const ethOf = (wei: string | null) => (wei == null ? '—' : `${Number(formatEther(BigInt(wei))).toLocaleString('en-US', { maximumFractionDigits: 4 })} ETH`);

/** Owner-only pool switches (brief §15 rollback), sent from the admin's own wallet: the contract checks ownership. */
const poolOwnerAbi = [
  { type: 'function', name: 'pausePayouts', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'resumePayouts', inputs: [], outputs: [], stateMutability: 'nonpayable' },
] as const;

/** Brief §11 "Modify split %": the FeeSplitter's pool share, set from the owner wallet (the contract checks ownership
 * and caps it at 50%). */
function FeeSplitControl({ address }: { address: Address }) {
  const bps = useReadContract({ address, abi: feeSplitterAbi, functionName: 'poolBps', chainId: chain.id });
  const [percent, setPercent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = bps.data != null ? Number(bps.data) / 100 : null;
  const set = async () => {
    const value = Math.round(Number(percent) * 100);
    if (!Number.isFinite(value) || value < 0 || value > 5_000) return setError('Enter a share from 0 to 50%.');
    setBusy(true);
    setError(null);
    try {
      await ensureRpcNetwork();
      if (getAccount(wagmiConfig).chainId !== chain.id) await switchChain(wagmiConfig, { chainId: chain.id });
      const hash = await writeContract(wagmiConfig, { chainId: chain.id, address, abi: feeSplitterAbi, functionName: 'setPoolBps', args: [value] });
      await waitForTransactionReceipt(wagmiConfig, { chainId: chain.id, hash });
      setPercent('');
      await bps.refetch();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.actions}>
      <span>
        Fee split to the pool: <b>{current == null ? '—' : `${current}%`}</b> (operator {current == null ? '—' : `${100 - current}%`}, max 50%)
      </span>
      <input type="number" min={0} max={50} step={0.5} placeholder="%" value={percent} onChange={(e) => setPercent(e.target.value)} style={{ width: 64 }} />
      <Button disabled={busy || percent === ''} onClick={() => void set()}>
        Set split (owner wallet)
      </Button>
      {error && <span className={styles.error}>{error}</span>}
    </div>
  );
}

function ReviewCard({ item, onDone }: { item: Overview['review'][number]; onDone: () => void }) {
  const [tier, setTier] = useState<Tier>(item.suggestedTier ?? 'TRIVIAL');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(true);
    setError(null);
    try {
      await reviewVerification({ id: item.id, decision, tier: decision === 'approve' ? tier : undefined, note: note.trim() || undefined });
      onDone();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.reviewCard}>
      <div>
        <b>${displayTicker(item.token, item.ticker) ?? '?'}</b> · submitted by {item.submitter.slice(0, 6)}…{item.submitter.slice(-4)} · passed the checker{' '}
        {item.checkedAt ? new Date(item.checkedAt).toLocaleString() : ''}
      </div>
      <div className={styles.compare}>
        <div>
          <h4>The coin&apos;s theorem</h4>
          <div className={styles.statement}>{item.coinStatement ? <Latex source={item.coinStatement} /> : '—'}</div>
        </div>
        <div>
          <h4>What the proof proves (kernel-checked)</h4>
          <ul className={styles.theorems}>
            {item.theorems.map((t) => (
              <li key={t.name}>
                <b>{t.name}</b>
                <br />
                <code>{t.statement}</code>
                <div className={styles.axioms}>axioms: {t.axioms.join(', ') || 'none'}</div>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p className={styles.warn}>
        Approve only if a theorem above states <b>this coin&apos;s theorem</b>: a correct proof of something else must be rejected. Suggested tier:{' '}
        <b>{item.suggestedTier ?? '—'}</b>
        {item.suggestion.length ? ` (${item.suggestion.join('; ')})` : ''}. The heuristic is easy to game; the tier you pick is what gets paid.
      </p>
      <ProofViewer source={item.proof} />
      <div className={styles.actions}>
        <label>
          Tier{' '}
          <select value={tier} onChange={(e) => setTier(e.target.value as Tier)}>
            {TIERS.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <input placeholder="Note (shown to the submitter if rejected)" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
        <Button variant="primary" disabled={busy} onClick={() => void decide('approve')}>
          Approve as {tier}
        </Button>
        <Button disabled={busy} onClick={() => void decide('reject')}>
          Reject
        </Button>
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}

/** /admin/verification (brief §11): pool and queue health, the review list, pause switches. Admin wallets only. */
export function VerificationAdmin() {
  const { address, connected } = useIdentity();
  const queryClient = useQueryClient();
  const config = useQuery({ queryKey: ['verification-config'], queryFn: fetchVerificationConfig });
  const overview = useQuery({ queryKey: ['verification-admin'], queryFn: fetchVerificationAdmin, enabled: !!config.data?.admin, refetchInterval: 20_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['verification-admin'] });
  const run = async (label: string, work: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await work();
      refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };
  const ownerCall = (fn: 'pausePayouts' | 'resumePayouts') =>
    run(fn, async () => {
      const pool = overview.data?.pool.address as Address | undefined;
      if (!pool) throw new Error('No pool is configured.');
      await ensureRpcNetwork();
      if (getAccount(wagmiConfig).chainId !== chain.id) await switchChain(wagmiConfig, { chainId: chain.id });
      const hash = await writeContract(wagmiConfig, { chainId: chain.id, address: pool, abi: poolOwnerAbi, functionName: fn });
      await waitForTransactionReceipt(wagmiConfig, { chainId: chain.id, hash });
    });

  if (!connected) return <p className={styles.empty}>Connect an admin wallet.</p>;
  if (config.data && !config.data.admin)
    return (
      <div className={styles.empty}>
        <p>This page is for Dockhood admins. Sign in with an admin wallet.</p>
        <Button onClick={() => void run('signin', async () => (await ensureSession(address as Address), queryClient.invalidateQueries({ queryKey: ['verification-config'] })))}>
          Sign in
        </Button>
        {error && <p className={styles.error}>{error}</p>}
      </div>
    );
  const o = overview.data;
  if (!o) return <p className={styles.empty}>{overview.isError ? message(overview.error) : 'Loading…'}</p>;

  return (
    <div className={styles.window}>
      <div className={styles.scroll}>
        <div className={styles.stats}>
          <div className={styles.stat}>
            Pool balance<b>{ethOf(o.pool.balanceWei)}</b>
            <span className={styles.note}>available {ethOf(o.pool.availableWei)}</span>
          </div>
          <div className={styles.stat}>
            Queue<b>{o.queueLength}</b>
            <span className={styles.note}>{o.oldestQueuedAt ? `oldest ${new Date(o.oldestQueuedAt).toLocaleString()}` : 'empty'}</span>
          </div>
          <div className={styles.stat}>
            This week<b>{o.submissionsThisWeek}</b>
            <span className={styles.note}>success {o.successRate == null ? '—' : `${Math.round(o.successRate * 100)}%`}</span>
          </div>
          <div className={styles.stat}>
            Paid out<b>{ethOf(o.paidOutWei)}</b>
            <span className={styles.note}>avg check {duration(o.averageCheckSec)}</span>
          </div>
        </div>
        <div className={styles.actions}>
          <span>
            Submissions: <b>{!o.enabledByEnv ? 'off (VERIFICATION_SUBMISSIONS_ENABLED)' : o.paused ? 'paused' : 'open'}</b>
          </span>
          <Button disabled={!!busy || !o.enabledByEnv} onClick={() => void run('pause', () => setVerificationPaused(!o.paused))}>
            {o.paused ? 'Resume submissions' : 'Pause submissions'}
          </Button>
          <span>· Pool payouts (owner wallet):</span>
          <Button disabled={!!busy} onClick={() => void ownerCall('pausePayouts')}>
            Pause payouts
          </Button>
          <Button disabled={!!busy} onClick={() => void ownerCall('resumePayouts')}>
            Resume payouts
          </Button>
        </div>
        {o.feeSplitterAddress && <FeeSplitControl address={o.feeSplitterAddress as Address} />}
        {busy && <p className={styles.note}>Working…</p>}
        {error && <p className={styles.error}>{error}</p>}
        <h3 style={{ margin: '4px 0 0' }}>Awaiting review ({o.review.length})</h3>
        {o.review.length ? o.review.map((item) => <ReviewCard key={item.id} item={item} onDone={refresh} />) : <p className={styles.empty}>Nothing to review.</p>}
      </div>
    </div>
  );
}
