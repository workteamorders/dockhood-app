'use client';

import type { VerificationRow } from '@/lib/api';
import { displayTicker } from '@/lib/hoodToken';
import { statusText } from './format';
import styles from './verification.module.css';

/** One tab of the queue: each row opens the submission's detail. */
export function QueueList({ rows, empty, onOpen }: { rows: VerificationRow[]; empty: string; onOpen: (id: string) => void }) {
  if (!rows.length) return <p className={styles.empty}>{empty}</p>;
  return (
    <ul className={styles.list}>
      {rows.map((r) => (
        <li key={r.id} className={styles.row} role="button" tabIndex={0} onClick={() => onOpen(r.id)} onKeyDown={(e) => e.key === 'Enter' && onOpen(r.id)}>
          <span>
            <span className={styles.ticker}>${displayTicker(r.token, r.ticker) ?? '?'}</span> <span className={styles.coinName}>{r.name}</span>
          </span>
          <span className={`${styles.status} ${styles[r.status]}`}>{statusText(r)}</span>
          <span className={styles.meta}>
            {new Date(r.submittedAt).toLocaleString()} · {r.submitter.slice(0, 6)}…{r.submitter.slice(-4)}
          </span>
        </li>
      ))}
    </ul>
  );
}
