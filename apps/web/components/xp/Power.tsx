'use client';

import { useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button';
import { useModalFocus } from './Dialog';
import { HoodLogo, KeyIcon, RestartIcon, StandByIcon, TurnOffIcon } from './Icons';
import styles from './Power.module.css';

function Panel({ title, onCancel, children }: { title: string; onCancel: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, onCancel);

  return createPortal(
    <div className={styles.overlay}>
      <div ref={ref} data-dockhood-dialog tabIndex={-1} className={styles.panel} role="alertdialog" aria-modal="true" aria-label={title}>
        <div className={styles.head}>
          <span className={styles.trafficLights} aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span>{title}</span>
          <HoodLogo size={28} />
        </div>
        <div className={styles.body}>{children}</div>
        <div className={styles.foot}>
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

type ShutDownProps = {
  onCancel: () => void;
  onStandBy: () => void;
  onTurnOff: () => void;
  onRestart: () => void;
};

export function ShutDownDialog({ onCancel, onStandBy, onTurnOff, onRestart }: ShutDownProps) {
  return (
    <Panel title="Shut Down Dockhood" onCancel={onCancel}>
      <button type="button" className={styles.choice} onClick={onStandBy}>
        <StandByIcon size={36} />
        Sleep
      </button>
      <button type="button" className={styles.choice} onClick={onTurnOff}>
        <TurnOffIcon size={36} />
        Shut Down
      </button>
      <button type="button" className={styles.choice} onClick={onRestart}>
        <RestartIcon size={36} />
        Restart
      </button>
    </Panel>
  );
}

export function LogOffDialog({ onCancel, onLogOff }: { onCancel: () => void; onLogOff: () => void }) {
  return (
    <Panel title="Log Out of Dockhood" onCancel={onCancel}>
      <button type="button" className={styles.choice} onClick={onLogOff}>
        <KeyIcon size={36} />
        Log Out
      </button>
    </Panel>
  );
}

export function OffScreen({ onPowerOn }: { onPowerOn: () => void }) {
  return createPortal(
    <div className={styles.off} role="alert">
      <div className={styles.offText}>Dockhood is shut down.</div>
      <button type="button" className={styles.powerBtn} onClick={onPowerOn} autoFocus>
        <TurnOffIcon size={20} /> Start Dockhood
      </button>
    </div>,
    document.body,
  );
}
