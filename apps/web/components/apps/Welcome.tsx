'use client';

import { Button } from '@/components/xp/Button';
import { HoodLogo, InfoIcon } from '@/components/xp/Icons';
import { VERIFICATION_LIVE } from '@/lib/features';
import { openApp } from '@/lib/openApp';
import styles from './apps.module.css';

export function Welcome() {
  return (
    <div className={`${styles.pane} ${styles.welcome}`}>
      <div className={styles.hero}>
        <span className={styles.brandMark}><HoodLogo size={36} /></span>
        <div>
          <div className={styles.wordmark}>Dockhood</div>
          <div className={styles.eyebrow}>The Mathematical Superintelligence launchpad.</div>
        </div>
      </div>
      <h1 className={styles.display}>The launchpad that boots clean.</h1>
      <p className={styles.lead}>
        {VERIFICATION_LIVE ? 'Theorem-backed coins. Formally verified. Fully on-chain.' : 'Theorem-backed coins. Fully on-chain.'}
      </p>
      <p className={styles.context}>Launch on Robinhood Chain. Route through Pons. Keep control of your wallet.</p>

      <div className={styles.ctaRow}>
        <Button variant="primary" large onClick={() => openApp('launch')}>
          Launch a Coin
        </Button>
        <Button large onClick={() => openApp('explore')}>
          Explore
        </Button>
        <Button large onClick={() => openApp('callouts')}>
          Callouts
        </Button>
        <Button large onClick={() => openApp('about')}>
          About
        </Button>
      </div>

      <div className={styles.tip}>
        <InfoIcon size={16} />
        <p>
          <b>Your desktop. Your Dock.</b> Open an app from the Dock or double-click a desktop icon.
          Drag a title bar to arrange your windows. Return to a running app from the Dock.
        </p>
      </div>

      <p className={styles.fineprint}>
        Dockhood is non-custodial. Trades go straight from your wallet to Pons.
      </p>
    </div>
  );
}
