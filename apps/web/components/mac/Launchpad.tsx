'use client';

import { useEffect, useRef } from 'react';
import { APPS, GAME_APPS } from '@/components/apps/meta';
import { openApp } from '@/lib/openApp';
import styles from './Shell.module.css';

export function Launchpad({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        const buttons = ref.current?.querySelectorAll<HTMLButtonElement>('button');
        if (!buttons?.length) return;
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (!ref.current?.contains(document.activeElement)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
        else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    ref.current?.querySelector('button')?.focus();
    window.addEventListener('keydown', key);
    document.addEventListener('pointerdown', outside);
    return () => { window.removeEventListener('keydown', key); document.removeEventListener('pointerdown', outside); before?.focus(); };
  }, [onClose]);
  return <div ref={ref} className={styles.launchpad} role="dialog" aria-label="Games Launchpad" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <button className={styles.launchpadClose} onClick={onClose} aria-label="Close Games Launchpad">Close</button>
    <span className={styles.eyebrow}>TAKE A BREAK</span><h1>Games</h1><p>No wallet. Just play.</p>
    <div className={styles.gameGrid}>{GAME_APPS.map((id) => { const app = APPS[id]; return <button key={id} onClick={() => { onClose(); openApp(id); }}><app.Icon size={96}/><strong>{app.label}</strong><span>{app.description}</span></button>; })}</div>
    <small>Escape to return to the desktop.</small>
  </div>;
}
