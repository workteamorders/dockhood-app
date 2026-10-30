'use client';

import { useRef, type KeyboardEvent } from 'react';
import { APPS, DESKTOP_APPS, type AppId } from '@/components/apps/meta';
import { openApp } from '@/lib/openApp';
import { X_URL } from '@/lib/social';
import styles from './Desktop.module.css';
import { XIcon } from '../mac/AppIcon';

const DOUBLE_TAP_MS = 400;

/** Desktop shortcuts that open a web page in a new tab instead of a window. */
const LINKS = { x: { label: '@Dock_Hood', Icon: XIcon, href: X_URL } };
type LinkId = keyof typeof LINKS;
export type DesktopItemId = AppId | LinkId;

const isLink = (id: DesktopItemId): id is LinkId => id in LINKS;
/** Links sit just before About and the Recycle Bin. */
const ITEMS: DesktopItemId[] = [...DESKTOP_APPS, 'x'];

function open(id: DesktopItemId) {
  if (isLink(id)) window.open(LINKS[id].href, '_blank', 'noopener,noreferrer');
  else openApp(id);
}

export function DesktopIcons({ selected, onSelect }: { selected: DesktopItemId | null; onSelect: (id: DesktopItemId | null) => void }) {
  const lastTap = useRef<{ id: DesktopItemId; t: number } | null>(null);

  // One handler for mouse and touch: a second click/tap on the same icon within 400 ms opens it.
  const onClick = (id: DesktopItemId, now: number) => {
    const prev = lastTap.current;
    if (prev && prev.id === id && now - prev.t < DOUBLE_TAP_MS) {
      lastTap.current = null;
      open(id);
      return;
    }
    lastTap.current = { id, t: now };
    onSelect(id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, id: DesktopItemId) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      open(id);
    }
  };

  return (
    <ul className={styles.icons} aria-label="Desktop">
      {ITEMS.map((id) => {
        const app = isLink(id) ? LINKS[id] : APPS[id];
        return (
          <li key={id}>
            <button
              type="button"
              className={`${styles.icon} ${selected === id ? styles.selected : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                onClick(id, e.timeStamp);
              }}
              onKeyDown={(e) => onKeyDown(e, id)}
              onFocus={() => onSelect(id)}
              aria-label={`${app.label} — double-click to open`}
            >
              <span className={styles.iconImg}>
                <app.Icon size={96} />
              </span>
              <span className={styles.label}>{app.label}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
