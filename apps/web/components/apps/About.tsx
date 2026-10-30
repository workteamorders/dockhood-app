'use client';

import type { ReactNode } from 'react';
import { network } from '@/lib/network';
import { Button } from '@/components/xp/Button';
import { GroupBox } from '@/components/xp/Controls';
import { HoodLogo } from '@/components/xp/Icons';
import { openApp } from '@/lib/openApp';
import { X_HANDLE, X_URL } from '@/lib/social';
import { useWindows, type WindowState } from '@/store/windows';
import styles from './apps.module.css';

const ROWS: [string, ReactNode][] = [
  ['Chain', `${network.chain.name} (${network.chainId})`],
  ['Launch routing', 'Pons V2 bonding curve → Uniswap V4'],
  ['Rigor engine', 'DeepSeek — AI estimate, not a proof check'],
  ['Callouts', 'Live feed, Sign-In with Ethereum'],
  ['Theme', 'Light glass desktop. Original assets.'],
  [
    'X',
    <a key="x" href={X_URL} target="_blank" rel="noopener noreferrer">
      @{X_HANDLE}
    </a>,
  ],
];

export function About({ win }: { win: WindowState }) {
  return (
    <>
      <div className={styles.pane}>
        <div className={styles.hero}>
          <HoodLogo size={48} />
          <div>
            <div className={styles.wordmark}>Dockhood</div>
            <div style={{ marginTop: 4 }}>Version 1.0</div>
          </div>
        </div>
        <GroupBox label="System">
          <table className={styles.infoTable}>
            <tbody>
              {ROWS.map(([k, v]) => (
                <tr key={k}>
                  <th scope="row">{k}:</th>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </GroupBox>
        <p className={styles.fineprint}>
          Pons V2 contracts are unaudited. Memecoins can go to zero.
        </p>
        <p className={styles.legalLinks}>
          <button type="button" onClick={() => openApp('terms')}>
            Terms of Use
          </button>
          <button type="button" onClick={() => openApp('risk')}>
            Risk disclosure
          </button>
          <button type="button" onClick={() => openApp('privacy')}>
            Privacy notice
          </button>
        </p>
      </div>
      <div className={styles.footerRow}>
        <Button onClick={() => useWindows.getState().close(win.id)}>OK</Button>
      </div>
    </>
  );
}
