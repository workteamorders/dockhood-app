'use client';

import { useSyncExternalStore } from 'react';
import { useConnectModal, useAccountModal } from '@rainbow-me/rainbowkit';
import { APPS } from '@/components/apps/meta';
import { openApp } from '@/lib/openApp';
import { useIdentity } from '@/lib/identity';
import { useWindows } from '@/store/windows';
import { PriceTicker } from './PriceTicker';
import { CalloutsIcon, HoodLogo, WalletIcon } from './Icons';
import styles from './Taskbar.module.css';

// The clock is an external store ticking every 10 s; the server snapshot is empty so hydration matches.
const subscribeClock = (onTick: () => void) => {
  const t = setInterval(onTick, 10_000);
  return () => clearInterval(t);
};
const clockSnapshot = () => new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const dateSnapshot = () => new Date().toLocaleDateString('en-US', { dateStyle: 'full' });
const emptySnapshot = () => '';

function Clock() {
  const time = useSyncExternalStore(subscribeClock, clockSnapshot, emptySnapshot);
  const date = useSyncExternalStore(subscribeClock, dateSnapshot, emptySnapshot);
  return (
    <span className={styles.clock} title={date}>
      {time}
    </span>
  );
}

type TaskbarProps = {
  startOpen: boolean;
  onStartToggle: () => void;
  unreadCallouts?: boolean;
};

export function Taskbar({ startOpen, onStartToggle, unreadCallouts = false }: TaskbarProps) {
  const windows = useWindows((s) => s.windows);
  const activeId = useWindows((s) => s.activeId);
  const toggleFromTaskbar = useWindows((s) => s.toggleFromTaskbar);
  const { connected, label } = useIdentity();
  const { openConnectModal } = useConnectModal();
  const { openAccountModal } = useAccountModal();

  return (
    <nav className={styles.taskbar} aria-label="Taskbar">
      <button
        type="button"
        data-start-button
        className={`${styles.start} ${startOpen ? styles.startOpen : ''}`}
        onClick={onStartToggle}
        aria-expanded={startOpen}
        aria-haspopup="menu"
      >
        <span className={styles.orb}>
          <HoodLogo size={22} />
        </span>
        start
      </button>

      <div className={styles.tabs}>
        {windows.map((w) => {
          const { Icon } = APPS[w.appId];
          const active = w.id === activeId && !w.minimized;
          return (
            <button
              key={w.id}
              type="button"
              className={`${styles.tab} ${active ? styles.tabActive : ''}`}
              onClick={() => toggleFromTaskbar(w.id)}
              title={w.title}
              aria-pressed={active}
            >
              <Icon size={16} />
              <span className={styles.tabTitle}>{w.title}</span>
            </button>
          );
        })}
      </div>

      <div className={styles.tray}>
        <PriceTicker />
        <button
          type="button"
          className={styles.trayBtn}
          title={unreadCallouts ? 'New callouts' : 'Callouts'}
          aria-label="Open Callouts"
          onClick={() => openApp('callouts')}
        >
          <CalloutsIcon size={16} />
          {unreadCallouts && <span className={styles.unread} />}
        </button>
        <button
          type="button"
          className={`${styles.trayBtn} ${connected ? styles.connected : ''}`}
          title={connected ? `Wallet: ${label}` : 'Connect wallet'}
          aria-label={connected ? `Wallet ${label}` : 'Connect wallet'}
          onClick={() => (connected ? openAccountModal?.() : openConnectModal?.())}
        >
          <WalletIcon size={16} />
        </button>
        <Clock />
      </div>
    </nav>
  );
}
