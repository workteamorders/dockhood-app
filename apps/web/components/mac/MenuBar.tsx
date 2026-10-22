'use client';

import { useEffect, useRef, useSyncExternalStore, type SyntheticEvent } from 'react';
import { useConnectModal, useAccountModal } from '@rainbow-me/rainbowkit';
import { APPS } from '@/components/apps/meta';
import { useIdentity } from '@/lib/identity';
import { network } from '@/lib/network';
import { openApp } from '@/lib/openApp';
import { useWindows } from '@/store/windows';
import { ContractTrayButton } from '../xp/ContractAddress';
import { PriceTicker } from '../xp/PriceTicker';
import { DockhoodLogo } from './AppIcon';
import styles from './Shell.module.css';

const subscribe = (tick: () => void) => { const timer = setInterval(tick, 10000); return () => clearInterval(timer); };
const time = () => new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const date = () => new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const empty = () => '';
const closeMenu = (e: SyntheticEvent) => {
  const menu = e.currentTarget.closest('details');
  menu?.removeAttribute('open');
  menu?.querySelector('summary')?.focus();
};

export function MenuBar({ onLogOff, onShutDown }: { onLogOff: () => void; onShutDown: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      for (const menu of ref.current?.querySelectorAll<HTMLDetailsElement>('details[open]') ?? []) {
        if (!menu.contains(event.target as Node)) menu.open = false;
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const menu = ref.current?.querySelector<HTMLDetailsElement>('details[open]');
      if (menu) { menu.open = false; menu.querySelector('summary')?.focus(); }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, []);
  const clock = useSyncExternalStore(subscribe, time, empty);
  const today = useSyncExternalStore(subscribe, date, empty);
  const { connected, label } = useIdentity();
  const { openConnectModal } = useConnectModal();
  const { openAccountModal } = useAccountModal();
  const windows = useWindows((s) => s.windows);
  const activeId = useWindows((s) => s.activeId);
  const active = windows.find((w) => w.id === activeId);
  return <header ref={ref} className={styles.menuBar} data-testnet={network.chain.testnet || undefined}>
    <div className={styles.menuLeft}>
      <details name="desktop-menu" className={styles.menu}>
        <summary aria-label="Dockhood menu"><DockhoodLogo size={20}/><strong>Dockhood</strong></summary>
        <div className={styles.dropdown} onClick={closeMenu}>
          <button onClick={() => openApp('welcome')}>Welcome to Dockhood</button>
          <button onClick={() => openApp('about')}>About Dockhood</button>
          <hr/><button onClick={() => openApp('terms')}>Terms of Use</button><button onClick={() => openApp('risk')}>Risk Disclosure</button><button onClick={() => openApp('privacy')}>Privacy Notice</button>
          <hr/><button onClick={onLogOff}>Log Out...</button><button onClick={onShutDown}>Shut Down...</button>
        </div>
      </details>
      <span className={styles.activeApp}>{active ? APPS[active.appId].label : 'Desktop'}</span>
      <span className={styles.displayMenu} aria-hidden="true">File</span><span className={styles.displayMenu} aria-hidden="true">Edit</span><span className={styles.displayMenu} aria-hidden="true">View</span>
      <details name="desktop-menu" className={`${styles.menu} ${styles.windowMenu}`}>
        <summary>Window</summary><div className={styles.dropdown} onClick={closeMenu}>{windows.length ? windows.map((w) => <button key={w.id} onClick={() => useWindows.getState().focus(w.id)}>{w.id === activeId ? '\u2713 ' : ''}{w.title}{w.minimized ? ' (minimized)' : ''}</button>) : <span>No open windows</span>}</div>
      </details>
      <button className={styles.help} onClick={() => openApp('welcome')}>Help</button>
    </div>
    <div className={styles.menuRight}>
      {network.chain.testnet && <span className={styles.testnet} title={`${network.chain.name} (${network.chainId}). Use an injected wallet with test ETH.`}>Testnet</span>}
      <span className={styles.ticker}><PriceTicker/></span><span className={styles.contract}><ContractTrayButton/></span>
      <button className={styles.wallet} onClick={() => connected ? openAccountModal?.() : openConnectModal?.()}><span className={connected ? styles.connected : styles.walletDot}/>{connected ? label : 'Connect Wallet'}</button>
      <span className={styles.date}>{today}</span><time className={styles.clock} suppressHydrationWarning>{clock}</time>
    </div>
  </header>;
}
