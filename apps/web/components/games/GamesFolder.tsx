'use client';

import { useRef } from 'react';
import { APPS, GAME_APPS, type AppId } from '@/components/apps/meta';
import { openApp } from '@/lib/openApp';
import styles from './games.module.css';

const DOUBLE_TAP_MS = 400;

/** Double-click (or double-tap) a game to open it. */
export function GamesFolder() {
  const lastTap = useRef<{ id: AppId; t: number } | null>(null);
  const tap = (id: AppId, t: number) => {
    if (lastTap.current?.id === id && t - lastTap.current.t < DOUBLE_TAP_MS) {
      lastTap.current = null;
      openApp(id);
    } else {
      lastTap.current = { id, t };
    }
  };

  return (
    <div className={styles.folder}>
      <header className={styles.folderHeader}>
        <span className={styles.folderEyebrow}>Dockhood Arcade</span>
        <h1>Time for a little downtime.</h1>
        <p>Two classics. One clean desktop.</p>
      </header>
      <ul className={styles.folderIcons} aria-label="Games">
        {GAME_APPS.map((id) => {
          const app = APPS[id];
          return (
            <li key={id}>
              <button
                type="button"
                className={styles.folderIcon}
                onClick={(e) => tap(id, e.timeStamp)}
                onKeyDown={(e) => e.key === 'Enter' && openApp(id)}
                aria-label={`${app.label} - double-click to open`}
              >
                <span className={styles.folderImg}>
                  <app.Icon size={48} />
                </span>
                <span className={styles.folderLabel}>{app.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className={styles.folderFooter}>
        <span>{GAME_APPS.length} games</span>
        <span>Double-click or double-tap to play. Press Enter when focused.</span>
      </div>
    </div>
  );
}
