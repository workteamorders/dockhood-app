'use client';

import { useEffect, useRef, useSyncExternalStore, type SyntheticEvent } from 'react';
import { useConnectModal, useAccountModal } from '@rainbow-me/rainbowkit';
import { APPS } from '@/components/apps/meta';
import { useIdentity } from '@/lib/identity';
import { network } from '@/lib/network';
import { openApp } from '@/lib/openApp';
import { useWindows } from '@/store/windows';
import { finderCommands, useFinderUi, type FinderActions } from '@/store/finderUi';
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

function FinderMenus({ windowId }: { windowId: string }) {
  const flags = useFinderUi((s) => s.flags);
  const fire = (action: Exclude<keyof FinderActions, 'setView'>) => finderCommands.current?.[action]();
  return <>
    <details name="desktop-menu" className={`${styles.menu} ${styles.finderMenu}`}>
      <summary>File</summary>
      <div className={styles.dropdown} onClick={closeMenu}>
        <button disabled={!flags.canCreate} onClick={() => fire('newFolder')}>New Folder</button>
        <button disabled={!flags.canImport} onClick={() => fire('importFiles')}>Import Files…</button>
        <button disabled={!flags.canTrash} onClick={() => fire('trash')}>Move to Trash</button>
        {flags.trashView && <><hr/><button disabled={!flags.canEmptyTrash} onClick={() => fire('emptyTrash')}>Empty Trash…</button></>}
        <hr/><button onClick={() => useWindows.getState().close(windowId)}>Close Window</button>
      </div>
    </details>
    <details name="desktop-menu" className={`${styles.menu} ${styles.finderMenu}`}>
      <summary>Edit</summary>
      <div className={styles.dropdown} onClick={closeMenu}>
        <button disabled={!flags.canRename} onClick={() => fire('rename')}>Rename</button>
        <button disabled={!flags.canCopy} onClick={() => fire('copy')}>Copy</button>
        <button disabled={!flags.canPaste} onClick={() => fire('paste')}>Paste</button>
        <hr/><button disabled={!flags.canSelectAll} onClick={() => fire('selectAll')}>Select All</button>
        {flags.trashView && <><hr/><button disabled={!flags.canRestore} onClick={() => fire('restore')}>Put Back</button><button disabled={!flags.canDelete} onClick={() => fire('deleteForever')}>Delete Immediately…</button></>}
      </div>
    </details>
    <details name="desktop-menu" className={`${styles.menu} ${styles.finderMenu}`}>
      <summary>View</summary>
      <div className={styles.dropdown} onClick={closeMenu}>
        <button onClick={() => finderCommands.current?.setView('grid')}>{flags.view === 'grid' ? '✓ ' : '   '}as Icons</button>
        <button onClick={() => finderCommands.current?.setView('list')}>{flags.view === 'list' ? '✓ ' : '   '}as List</button>
        <hr/><button onClick={() => fire('search')}>Search This Folder</button>
      </div>
    </details>
  </>;
}

export function MenuBar({ onLogOff, onShutDown, onWidgets }: { onLogOff: () => void; onShutDown: () => void; onWidgets: () => void }) {
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
      {active?.appId === 'finder' && !active.minimized
        ? <FinderMenus windowId={active.id}/>
        : <><span className={styles.displayMenu} aria-hidden="true">File</span><span className={styles.displayMenu} aria-hidden="true">Edit</span><span className={styles.displayMenu} aria-hidden="true">View</span></>}
      <details name="desktop-menu" className={`${styles.menu} ${styles.windowMenu}`}>
        <summary>Window</summary><div className={styles.dropdown} onClick={closeMenu}>{windows.length ? windows.map((w) => <button key={w.id} onClick={() => useWindows.getState().focus(w.id)}>{w.id === activeId ? '\u2713 ' : ''}{w.title}{w.minimized ? ' (minimized)' : ''}</button>) : <span>No open windows</span>}</div>
      </details>
      <button className={styles.help} onClick={() => openApp('welcome')}>Help</button>
    </div>
    <div className={styles.menuRight}>
      <button className={styles.widgetsButton} onClick={onWidgets} aria-label="Open desktop widgets" aria-haspopup="dialog" title="Desktop widgets"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="1.5" y="1.5" width="5" height="5" rx="1.5" stroke="currentColor"/><rect x="9.5" y="1.5" width="5" height="5" rx="1.5" stroke="currentColor"/><rect x="1.5" y="9.5" width="5" height="5" rx="1.5" stroke="currentColor"/><rect x="9.5" y="9.5" width="5" height="5" rx="1.5" fill="currentColor"/></svg><span>Widgets</span></button>
      {network.chain.testnet && <span className={styles.testnet} title={`${network.chain.name} (${network.chainId}). Use an injected wallet with test ETH.`}>Testnet</span>}
      <span className={styles.ticker}><PriceTicker/></span>
      <button className={styles.wallet} onClick={() => connected ? openAccountModal?.() : openConnectModal?.()}><span className={connected ? styles.connected : styles.walletDot}/>{connected ? label : 'Connect Wallet'}</button>
      <span className={styles.date}>{today}</span><time className={styles.clock} suppressHydrationWarning>{clock}</time>
    </div>
  </header>;
}
