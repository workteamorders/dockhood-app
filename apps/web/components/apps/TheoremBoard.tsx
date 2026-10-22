'use client';

import { Button } from '@/components/xp/Button';
import { TheoremIcon } from '@/components/xp/Icons';
import { RigorBadge } from '@/components/xp/RigorBadge';
import { useWindows, type WindowState } from '@/store/windows';
import styles from './apps.module.css';

export function TheoremBoard({ win }: { win: WindowState }) {
  return (
    <>
      <div className={styles.pane}>
        <div className={styles.hero}>
          <TheoremIcon size={32} />
          <b style={{ fontSize: 18 }}>Every Dockhood coin carries a theorem.</b>
        </div>
        <ol className={styles.steps}>
          <li>Write a mathematical statement in LaTeX when you launch.</li>
          <li>An AI grades its rigor from 0 to 100 — an estimate, not a proof check.</li>
          <li>The statement and score go into the coin&apos;s on-chain description; the proof sketch lives on IPFS.</li>
          <li>The coin trades on its Pons bonding curve and graduates to Uniswap V4 when the curve fills.</li>
        </ol>
        <div className={styles.example}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <b>$FERMAT</b>
            <RigorBadge score={94} />
          </div>
          <div className={styles.theorem}>
            xⁿ + yⁿ = zⁿ has no solutions in positive integers for n &gt; 2.
          </div>
        </div>
      </div>
      <div className={styles.footerRow}>
        <Button onClick={() => useWindows.getState().close(win.id)}>OK</Button>
      </div>
    </>
  );
}
