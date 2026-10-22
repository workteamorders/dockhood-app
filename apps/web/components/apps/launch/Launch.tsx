'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Hash } from 'viem';
import { formatAmount, normalizeStatement, type RigorScore } from '@hood/shared';
import { addressUrl, findPair } from '@/lib/network';
import { Button } from '@/components/xp/Button';
import { ProgressBar } from '@/components/xp/Controls';
import { Dialog, MessageBox } from '@/components/xp/Dialog';
import { LaunchIcon } from '@/components/xp/Icons';
import { latexErrors } from '@/components/xp/Latex';
import { TxLink } from '@/components/xp/TxLink';
import { failureReason, track } from '@/lib/analytics';
import { ApiError, scoreTheorem } from '@/lib/api';
import { useIdentity } from '@/lib/identity';
import { openApp } from '@/lib/openApp';
import { txErrorMessage, useCanLaunch, useLaunchTerms } from '@/lib/pons/launch';
import { useWindows, type WindowState } from '@/store/windows';
import { deployLaunch, type DeployResult, type DeployStep } from './deploy';
import {
  EMPTY_DRAFT,
  PAGES,
  creatorTaxBps,
  currentRigor,
  devBuyAmount,
  hasErrors,
  validateEconomics,
  validateIdentity,
  validateTheorem,
  type Draft,
  type Errors,
  type Page,
} from './draft';
import { EconomicsPage } from './EconomicsPage';
import { IdentityPage } from './IdentityPage';
import { withRiskAccepted } from '@/lib/risk';
import { ReviewPage } from './ReviewPage';
import { TheoremPage } from './TheoremPage';
import styles from './Launch.module.css';

const HEADERS: Record<Page, [string, string]> = {
  identity: ['Name your coin', 'Pick a name, ticker and logo. They can never be changed after launch.'],
  theorem: ['State your theorem', 'Every Dockhood coin carries a mathematical statement and an AI rigor score.'],
  economics: ['Set the economics', 'Choose what the coin trades against, your creator fees and an optional dev buy.'],
  review: ['Review and launch', 'Check everything. Pons launch settings are permanent.'],
};

const STEP_LABELS: [DeployStep, string][] = [
  ['signin', 'Signing in with your wallet'],
  ['pin', 'Uploading logo and theorem to IPFS'],
  ['approve', 'Approving the dev buy in your wallet'],
  ['sign', 'Waiting for your signature'],
  ['confirm', 'Confirming on Robinhood Chain'],
  ['record', 'Recording the launch on Dockhood'],
];

type Deploy =
  | { state: 'idle' }
  | { state: 'confirm' }
  | { state: 'running'; step: DeployStep; done: DeployStep[]; hash?: Hash }
  | { state: 'done'; result: DeployResult }
  | { state: 'error'; message: string };

const FAILED_SCORE: RigorScore = { score: null, parts: null, statusLabel: null, reasoning: '', model: null, cached: false };

export function Launch({ win }: { win: WindowState }) {
  const { address, connected } = useIdentity();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [pageIndex, setPageIndex] = useState(0);
  const [attempted, setAttempted] = useState<Partial<Record<Page, boolean>>>({});
  const [scoring, setScoring] = useState(false);
  const [scoreError, setScoreError] = useState<string>();
  const [deploy, setDeploy] = useState<Deploy>({ state: 'idle' });
  const [inviteDismissed, setInviteDismissed] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const page = PAGES[pageIndex];
  const { terms, error: termsError } = useLaunchTerms(draft.pair);
  const canLaunch = useCanLaunch(address);

  const set = useCallback((patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch })), []);

  // Blob URLs outlive the component unless revoked.
  const logoUrl = draft.logo?.url;
  useEffect(() => () => void (logoUrl && URL.revokeObjectURL(logoUrl)), [logoUrl]);

  useEffect(() => {
    bodyRef.current?.scrollTo(0, 0);
    bodyRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, [page]);

  const errorsFor = (p: Page, d: Draft): Errors => {
    if (p === 'identity') return validateIdentity(d);
    if (p === 'theorem') return validateTheorem(d, latexErrors(d.statement));
    if (p === 'economics') return validateEconomics(d, { maxCreatorTaxBps: terms?.maxCreatorTaxBps, decimals: terms?.decimals, pairApproved: terms?.pairApproved });
    return {};
  };
  const errors = attempted[page] ? errorsFor(page, draft) : {};

  const score = async (d: Draft) => {
    const statement = normalizeStatement(d.statement);
    setScoring(true);
    setScoreError(undefined);
    try {
      const result = await scoreTheorem(d.name.trim(), statement);
      setDraft((cur) => ({ ...cur, rigor: { statement, result } }));
      track('theorem_scored', { score: result.score, cached: result.cached });
    } catch (e) {
      setDraft((cur) => ({ ...cur, rigor: { statement, result: FAILED_SCORE } }));
      setScoreError(e instanceof ApiError ? e.message : 'Scoring failed.');
    } finally {
      setScoring(false);
    }
  };

  const next = () => {
    setAttempted((a) => ({ ...a, [page]: true }));
    if (hasErrors(errorsFor(page, draft))) return;
    if (page === 'theorem' && currentRigor(draft) == null && !scoring) void score(draft);
    setPageIndex((i) => Math.min(i + 1, PAGES.length - 1));
  };

  const back = () => setPageIndex((i) => Math.max(0, i - 1));
  useEffect(() => track('launch_step_viewed', { step: page }), [page]);
  const close = () => useWindows.getState().close(win.id);

  const quoteIn = terms ? devBuyAmount(draft, terms.decimals) : null;
  const launchBlocked =
    !connected || !terms || !terms.configEnabled || !terms.pairApproved || canLaunch === false || scoring || quoteIn == null || creatorTaxBps(draft) == null;

  const runDeploy = async () => {
    if (!terms) return;
    const props = { pair: findPair(draft.pair)?.symbol ?? 'other', dev_buy: quoteIn != null && quoteIn > 0n };
    track('launch_submitted', props);
    setDeploy({ state: 'running', step: 'signin', done: [] });
    try {
      const result = await deployLaunch(draft, terms, (step, hash) =>
        setDeploy((cur) => {
          const prev = cur.state === 'running' ? cur : { step, done: [] as DeployStep[], hash: undefined };
          const done = prev.step === step ? prev.done : [...prev.done, prev.step];
          // A new step without a hash drops the previous one, so the approval's hash is never shown as the launch's.
          return { state: 'running', step, done, hash: hash ?? (prev.step === step ? prev.hash : undefined) };
        }),
      );
      setDeploy({ state: 'done', result });
      track('launch_confirmed', props);
    } catch (e) {
      const message = e instanceof ApiError ? e.message : txErrorMessage(e);
      setDeploy({ state: 'error', message });
      track('launch_failed', { ...props, reason: failureReason(message) });
    }
  };

  const finish = () => {
    setDraft(EMPTY_DRAFT);
    setAttempted({});
    setPageIndex(0);
    setDeploy({ state: 'idle' });
  };

  const [title, subtitle] = HEADERS[page];

  return (
    <div className={styles.wizard}>
      <div className={styles.header}>
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
        <LaunchIcon size={32} />
      </div>

      <div className={styles.body} ref={bodyRef}>
        {page === 'identity' && <IdentityPage draft={draft} set={set} errors={errors} />}
        {page === 'theorem' && <TheoremPage draft={draft} set={set} errors={errors} scoring={scoring} scoreError={scoreError} onScore={() => void score(draft)} />}
        {page === 'economics' && <EconomicsPage draft={draft} set={set} errors={errors} terms={terms} account={address} />}
        {page === 'review' && <ReviewPage draft={draft} terms={terms} account={address} canLaunch={canLaunch} />}
        {termsError && <p className={styles.error}>Could not read Pons launch terms from Robinhood Chain. Check your connection.</p>}
      </div>

      <div className={styles.footer}>
        <span className={styles.stepLabel}>
          Step {pageIndex + 1} of {PAGES.length}
        </span>
        <Button onClick={back} disabled={pageIndex === 0}>
          &lt; Back
        </Button>
        {page === 'review' ? (
          <Button variant="primary" onClick={() => withRiskAccepted(() => setDeploy({ state: 'confirm' }))} disabled={launchBlocked}>
            Launch
          </Button>
        ) : (
          <Button onClick={next}>Next &gt;</Button>
        )}
        <Button onClick={close}>Cancel</Button>
      </div>

      {canLaunch === false && !inviteDismissed && (
        <MessageBox
          title="Launch"
          kind="info"
          onClose={() => setInviteDismissed(true)}
          buttons={
            <>
              <Button onClick={() => {
                  close();
                  openApp('explore');
                }} data-autofocus>
                Explore
              </Button>
              <Button onClick={() => setInviteDismissed(true)}>OK</Button>
            </>
          }
        >
          Pons launches are invite-only right now. You can still browse and trade coins in Explore.
        </MessageBox>
      )}

      {deploy.state === 'confirm' && (
        <MessageBox
          title="Launch"
          kind="question"
          onClose={() => setDeploy({ state: 'idle' })}
          buttons={
            <>
              <Button onClick={() => void runDeploy()} data-autofocus>
                Yes
              </Button>
              <Button onClick={() => setDeploy({ state: 'idle' })}>No</Button>
            </>
          }
        >
          Launch settings can never be changed. Continue?
        </MessageBox>
      )}

      {deploy.state === 'running' && <DeployProgress step={deploy.step} done={deploy.done} hash={deploy.hash} hasApproval={deploy.done.includes('approve') || deploy.step === 'approve'} />}

      {deploy.state === 'error' && (
        <MessageBox title="Launch failed" kind="error" onClose={() => setDeploy({ state: 'idle' })}>
          {deploy.message}
        </MessageBox>
      )}

      {deploy.state === 'done' && (
        <MessageBox
          title="Launch complete"
          kind="info"
          width={380}
          onClose={finish}
          buttons={
            <>
              <Button onClick={() => window.open(addressUrl(deploy.result.token), '_blank', 'noopener')}>View token</Button>
              <Button onClick={finish} data-autofocus>
                OK
              </Button>
            </>
          }
        >
          <p style={{ margin: '0 0 6px' }}>
            <b>${draft.ticker}</b> is live on Pons.
          </p>
          {deploy.result.tokensOut != null && <p style={{ margin: '0 0 6px' }}>Your dev buy filled {formatAmount(deploy.result.tokensOut, 18, { compact: true })} ${draft.ticker}.</p>}
          <p style={{ margin: 0 }}>
            <TxLink hash={deploy.result.txHash} label="Transaction" />
          </p>
          {!deploy.result.recorded && <p className={styles.hint}>Dockhood will pick the launch up from the chain shortly.</p>}
        </MessageBox>
      )}
    </div>
  );
}

function DeployProgress({ step, done, hash, hasApproval }: { step: DeployStep; done: DeployStep[]; hash?: Hash; hasApproval: boolean }) {
  const steps = STEP_LABELS.filter(([s]) => s !== 'approve' || hasApproval);
  const index = steps.findIndex(([s]) => s === step);
  return (
    <Dialog title="Launching…" onClose={() => {}} width={360}>
      <ul className={styles.steps}>
        {steps.map(([s, label]) => {
          const state = done.includes(s) ? 'done' : s === step ? 'active' : '';
          return (
            <li key={s} className={state ? styles[state] : undefined}>
              <span className={styles.mark}>{state === 'done' ? '✓' : state === 'active' ? '▸' : ''}</span>
              {label}
            </li>
          );
        })}
      </ul>
      <ProgressBar value={((index + 0.5) / steps.length) * 100} label="Launch progress" />
      {hash && (
        <p className={styles.hint}>
          <TxLink hash={hash} label={step === 'approve' ? 'Approval' : 'Transaction'} />
        </p>
      )}
    </Dialog>
  );
}
