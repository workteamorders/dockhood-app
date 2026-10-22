'use client';

import { useQuery } from '@tanstack/react-query';
import { txUrl } from '@/lib/network';
import { fetchTokenProof } from '@/lib/api';
import { eth } from './format';
import { ProofViewer } from './ProofViewer';
import { VerificationBadge } from './VerificationBadge';
import styles from './verification.module.css';

/** Token Detail's Formal ✓ tab (brief §7.4): the verified Lean proof, what it proves, and its on-chain record. */
export function FormalProofTab({ address }: { address: string }) {
  const q = useQuery({ queryKey: ['token-proof', address.toLowerCase()], queryFn: () => fetchTokenProof(address) });
  const v = q.data?.verified;
  if (q.isPending) return <p className={styles.note}>Loading…</p>;
  if (!v) return <p className={styles.note}>{q.isError ? "Couldn't load the proof." : 'No verified proof yet.'}</p>;
  return (
    <div className={styles.detail}>
      <div>
        <VerificationBadge /> Verified {v.verifiedAt ? new Date(v.verifiedAt).toLocaleDateString() : ''}
        {v.tier && ` · tier ${v.tier}`}
        {v.rewardWei && ` · reward ${eth(v.rewardWei)}`}
        {v.txHashResult?.startsWith('0x') && (
          <>
            {' · '}
            <a href={txUrl(v.txHashResult)} target="_blank" rel="noopener noreferrer">
              on-chain record
            </a>
          </>
        )}
      </div>
      <ul className={styles.theorems}>
        {v.theorems.map((t) => (
          <li key={t.name}>
            <b>{t.name}</b>
            <br />
            <code>{t.statement}</code>
            <div className={styles.axioms}>axioms: {t.axioms.join(', ') || 'none'}</div>
          </li>
        ))}
      </ul>
      {v.proof && <ProofViewer source={v.proof} ipfsCid={v.ipfsCid} />}
    </div>
  );
}
