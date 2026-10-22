'use client';

import { useEffect, useRef, useState } from 'react';
import { useAccountModal, useConnectModal } from '@rainbow-me/rainbowkit';
import { addressUrl, network } from '@/lib/network';
import { APPS, GAME_APPS, START_APPS, type AppId } from '@/components/apps/meta';
import { openApp } from '@/lib/openApp';
import { X_URL } from '@/lib/social';
import { useIdentity } from '@/lib/identity';
import {
  ExploreIcon,
  HelpIcon,
  HoodLogo,
  InfoIcon,
  KeyIcon,
  PortfolioIcon,
  RecycleBinIcon,
  TurnOffIcon,
  WalletIcon,
  XIcon,
} from './Icons';
import styles from './StartMenu.module.css';

type StartMenuProps = {
  onClose: () => void;
  onLogOff: () => void;
  onShutDown: () => void;
};

export function StartMenu({ onClose, onLogOff, onShutDown }: StartMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { connected, label, role, address } = useIdentity();
  const { openConnectModal } = useConnectModal();
  const { openAccountModal } = useAccountModal();
  const [gamesOpen, setGamesOpen] = useState(false);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t) || t.closest('[data-start-button]')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const launch = (id: AppId) => {
    openApp(id);
    onClose();
  };

  return (
    <div ref={ref} className={styles.menu} role="menu" aria-label="Dockhood menu">
      <div className={styles.header}>
        <span className={styles.avatar}>
          <HoodLogo size={40} />
        </span>
        <span className={styles.who}>
          <span className={styles.name}>{label}</span>
          <span className={styles.role}>{role}</span>
        </span>
      </div>

      <div className={styles.body}>
        <div className={styles.left}>
          {START_APPS.map((id) => {
            const app = APPS[id];
            return (
              <button key={id} type="button" role="menuitem" className={styles.item} onClick={() => launch(id)}>
                <app.Icon size={32} />
                <span className={styles.itemText}>
                  <span className={styles.itemName}>{app.label}</span>
                  <span className={styles.desc}>{app.description}</span>
                </span>
              </button>
            );
          })}
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={gamesOpen}
            className={styles.item}
            onClick={() => setGamesOpen((o) => !o)}
          >
            <APPS.games.Icon size={32} />
            <span className={styles.itemText}>
              <span className={styles.itemName}>Games</span>
              <span className={styles.desc}>{APPS.games.description}</span>
            </span>
            <span className={styles.arrow}>{gamesOpen ? '▾' : '▸'}</span>
          </button>
          {gamesOpen && (
            <div role="menu" className={styles.submenu}>
              {GAME_APPS.map((id) => {
                const app = APPS[id];
                return (
                  <button key={id} type="button" role="menuitem" className={styles.item} onClick={() => launch(id)}>
                    <span className={styles.subIcon}>
                      <app.Icon size={24} />
                    </span>
                    <span className={styles.itemName}>{app.label}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div className={styles.sep} />
          <button type="button" role="menuitem" className={styles.item} onClick={() => launch('welcome')}>
            <HelpIcon size={32} />
            <span className={styles.itemText}>
              <span className={styles.itemName}>Welcome to Dockhood</span>
              <span className={styles.desc}>{APPS.welcome.description}</span>
            </span>
          </button>
        </div>

        <div className={styles.right}>
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            onClick={() => {
              onClose();
              if (connected) openAccountModal?.();
              else openConnectModal?.();
            }}
          >
            <WalletIcon size={24} />
            <span className={styles.itemName}>{connected ? 'My Wallet' : 'Connect Wallet'}</span>
          </button>
          <button type="button" role="menuitem" className={styles.item} onClick={() => launch('portfolio')}>
            <PortfolioIcon size={24} />
            <span className={styles.itemName}>My Coins</span>
          </button>
          <button type="button" role="menuitem" className={styles.item} onClick={() => launch('explore')}>
            <ExploreIcon size={24} />
            <span className={styles.itemName}>All Pons Coins</span>
          </button>
          <div className={styles.sep} />
          <a
            role="menuitem"
            className={styles.item}
            href={address ? addressUrl(address) : network.explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onClose}
          >
            <InfoIcon size={24} />
            <span className={styles.itemName}>Chain Explorer</span>
          </a>
          <a role="menuitem" className={styles.item} href={X_URL} target="_blank" rel="noopener noreferrer" onClick={onClose}>
            <XIcon size={24} />
            <span className={styles.itemName}>Dockhood on X</span>
          </a>
          <button type="button" role="menuitem" className={styles.item} onClick={() => launch('about')}>
            <InfoIcon size={24} />
            <span className={styles.itemName}>About Dockhood</span>
          </button>
          <button type="button" role="menuitem" className={styles.item} onClick={() => launch('recycle')}>
            <RecycleBinIcon size={24} />
            <span className={styles.itemName}>Trash</span>
          </button>
        </div>
      </div>

      <div className={styles.footer}>
        <button type="button" className={styles.footerBtn} onClick={onLogOff}>
          <KeyIcon size={22} /> Log Out
        </button>
        <button type="button" className={styles.footerBtn} onClick={onShutDown}>
          <TurnOffIcon size={22} /> Shut Down
        </button>
      </div>
    </div>
  );
}
