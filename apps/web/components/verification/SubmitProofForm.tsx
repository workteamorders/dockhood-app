'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatEther, type Address, type Hex } from 'viem';
import { getAccount, sendTransaction, switchChain, waitForTransactionReceipt } from 'wagmi/actions';
import { TIERS, screenProof, type ScreenProblem } from '@hood/shared';
import { Button } from '@/components/xp/Button';
import { Dialog } from '@/components/xp/Dialog';
import { Latex } from '@/components/xp/Latex';
import { track } from '@/lib/analytics';
import { confirmProofSubmission, fetchToken, fetchTokens, prepareProof, type PreparedProof, type VerificationConfig } from '@/lib/api';
import { useIdentity } from '@/lib/identity';
import { displayTicker } from '@/lib/hoodToken';
import { ensureSession } from '@/lib/siwe';
import { chain, ensureRpcNetwork, wagmiConfig } from '@/lib/wagmi';
import styles from './verification.module.css';

type Coin = { token: string; symbol: string; statement: string | null; formal: boolean };

const message = (e: unknown) => (e instanceof Error ? e.message.split('\n')[0] : 'Something went wrong.');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The coin to prove: given (from Token Detail) or searched among hood.exe theorem coins. */
function CoinPicker({ onPick }: { onPick: (c: Coin) => void }) {
  const [q, setQ] = useState('');
  const list = useQuery({
    queryKey: ['verify-pick', q],
    queryFn: () => fetchTokens({ tab: 'hood', sort: 'latest', limit: 8, offset: 0, q: q || undefined }),
  });
  return (
    <div className={styles.picker}>
      <label className={styles.field}>
        <span className={styles.label}>Coin (ticker, name or address):</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="$COLLATZ" data-autofocus />
      </label>
      <ul className={styles.pickList}>
        {(list.data?.items ?? []).map((t) => (
          <li key={t.token}>
            <button type="button" disabled={t.formal} onClick={() => onPick({ token: t.token, symbol: t.symbol, statement: t.statement, formal: t.formal })}>
              <b>${displayTicker(t.token, t.symbol)}</b> {t.name} {t.formal ? '· already FORMAL ✓' : ''}
            </button>
          </li>
        ))}
        {list.data && !list.data.items.length && <li className={styles.note}>No theorem coins match.</li>}
      </ul>
    </div>
  );
}

/**
 * Submit Formal Proof (brief §7.2): choose the coin and its proof.lean, see the fee and the reward table, have the
 * proof checked and pinned (POST /verification/prepare), then pay the fee in one transaction to the pool.
 */
export function SubmitProofForm({ config, token, onClose, onSubmitted }: { config: VerificationConfig; token?: string; onClose: () => void; onSubmitted: (id: string) => void }) {
  const { address, connected } = useIdentity();
  const given = useQuery({ queryKey: ['token', token?.toLowerCase()], queryFn: () => fetchToken(token!), enabled: !!token });
  const [picked, setPicked] = useState<Coin | null>(null);
  const coin: Coin | null = picked ?? (given.data ? { token: given.data.token, symbol: given.data.symbol, statement: given.data.statement, formal: given.data.formal } : null);

  const [file, setFile] = useState<File | null>(null);
  const [problems, setProblems] = useState<ScreenProblem[]>([]);
  const [prepared, setPrepared] = useState<PreparedProof | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fee = BigInt(prepared?.submissionFee ?? config.submissionFeeWei);
  const pick = (c: Coin | null) => {
    setPicked(c);
    setPrepared(null);
    setError(null);
  };
  const choose = async (f: File | null) => {
    setFile(f);
    setPrepared(null);
    setError(null);
    setProblems([]);
    if (!f) return;
    if (f.size > config.maxProofBytes) return setError(`The proof file must be ${Math.round(config.maxProofBytes / 1024 / 1024)} MB or less.`);
    setProblems(screenProof(await f.text()));
  };

  const canPrepare = !!coin && !coin.formal && !!file && file.size <= config.maxProofBytes && !problems.length && !busy && connected;
  const prepare = async () => {
    if (!canPrepare || !coin || !file || !address) return;
    setError(null);
    try {
      setBusy('Signing in…');
      await ensureSession(address as Address);
      setBusy('Checking and pinning your proof…');
      setPrepared(await prepareProof(coin.token, file));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    if (!prepared || !coin) return;
    setError(null);
    try {
      setBusy('Confirm the transaction in your wallet…');
      await ensureRpcNetwork();
      if (getAccount(wagmiConfig).chainId !== chain.id) await switchChain(wagmiConfig, { chainId: chain.id });
      const hash = await sendTransaction(wagmiConfig, { chainId: chain.id, to: prepared.txData.to as Address, data: prepared.txData.data as Hex, value: BigInt(prepared.txData.value) });
      setBusy('Waiting for the transaction…');
      const receipt = await waitForTransactionReceipt(wagmiConfig, { chainId: chain.id, hash });
      if (receipt.status !== 'success') throw new Error('The transaction failed: the fee was not taken.');
      setBusy('Adding it to the queue…');
      for (let i = 0; i < 10; i++) {
        const r = await confirmProofSubmission(hash);
        if (!r.pending && r.submissions[0]) {
          track('verification_submitted', { tokenAddress: coin.token, tier: prepared.estimatedTier });
          return onSubmitted(r.submissions[0].id);
        }
        await sleep(2_000);
      }
      throw new Error('Submitted on-chain; it will appear in the queue shortly.');
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      title="Submit Formal Proof"
      onClose={onClose}
      width={460}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {prepared ? (
            <Button variant="primary" onClick={() => void submit()} disabled={!!busy}>
              ⚡ Submit ({formatEther(fee)} ETH)
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void prepare()} disabled={!canPrepare}>
              Check &amp; prepare
            </Button>
          )}
        </>
      }
    >
      <div className={styles.form}>
        {!coin ? (
          token && given.isPending ? <p className={styles.note}>Loading the coin…</p> : <CoinPicker onPick={pick} />
        ) : (
          <div className={styles.field}>
            <span className={styles.label}>
              Coin: <b>${displayTicker(coin.token, coin.symbol)}</b>{' '}
              {!token && (
                <button type="button" className={styles.linkBtn} disabled={!!busy} onClick={() => pick(null)}>
                  change
                </button>
              )}
            </span>
            <span className={styles.label}>Theorem:</span>
            <div className={styles.statement}>{coin.statement ? <Latex source={coin.statement} /> : '—'}</div>
            {coin.formal && <p className={styles.error}>This coin is already formally verified.</p>}
          </div>
        )}

        <label className={styles.field}>
          <span className={styles.label}>Upload proof.lean (max {Math.round(config.maxProofBytes / 1024 / 1024)} MB):</span>
          <input type="file" accept=".lean,text/plain" disabled={!!busy} onChange={(e) => void choose(e.target.files?.[0] ?? null)} />
        </label>
        {problems.length > 0 && (
          <ul className={styles.problems}>
            {problems.slice(0, 5).map((p, i) => (
              <li key={i}>
                Line {p.line} {p.why}
                {p.text ? `: ${p.text}` : ''}
              </li>
            ))}
          </ul>
        )}

        <p className={styles.warn}>
          ⚠ Submission fee: <b>{formatEther(fee)} ETH</b> (prevents spam, not refundable). ⏱ Estimated wait: 2–6 hours typically.
        </p>
        <p className={styles.note}>
          The proof must prove this coin&apos;s theorem in Lean 4 + Mathlib, with no <code>sorry</code> and no extra axioms. If it passes, a reviewer
          checks the statement and sets the reward tier; then the coin becomes Σ 100 with FORMAL ✓ and the reward is paid to your wallet.
        </p>

        <table className={styles.rewards}>
          <tbody>
            {TIERS.map((t) => (
              <tr key={t} className={prepared?.estimatedTier === t ? styles.on : undefined}>
                <td>{t}</td>
                <td>{config.rewardsEth[t]} ETH</td>
              </tr>
            ))}
          </tbody>
        </table>
        {prepared && (
          <p className={styles.note}>
            Reward tier (estimated): <b>{prepared.estimatedTier}</b> ({config.rewardsEth[prepared.estimatedTier]} ETH). The reviewer sets the final tier.
          </p>
        )}
        {!connected && <p className={styles.note}>Connect your wallet to submit.</p>}
        {busy && <p className={styles.note}>{busy}</p>}
        {error && <p className={styles.error}>{error}</p>}
      </div>
    </Dialog>
  );
}
