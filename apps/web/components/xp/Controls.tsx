'use client';

import { useId, useState, type ReactNode } from 'react';
import styles from './Controls.module.css';

export function GroupBox({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <fieldset className={styles.group}>
      <legend>{label}</legend>
      {children}
    </fieldset>
  );
}

export type TabDef = { id: string; label: ReactNode; content: ReactNode };

export function Tabs({ tabs, initial }: { tabs: TabDef[]; initial?: string }) {
  const [current, setCurrent] = useState(initial ?? tabs[0]?.id);
  const base = useId();
  const active = tabs.find((t) => t.id === current) ?? tabs[0];
  return (
    <div className={styles.tabs}>
      <div role="tablist" className={styles.tabList}>
        {tabs.map((t, index) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${base}-${t.id}`}
            aria-selected={t.id === active?.id}
            aria-controls={`${base}-panel`}
            tabIndex={t.id === active?.id ? 0 : -1}
            className={`${styles.tab} ${t.id === active?.id ? styles.tabActive : ''}`}
            onClick={() => setCurrent(t.id)}
            onKeyDown={(e) => {
              let next: number;
              switch (e.key) {
                case 'ArrowRight': next = (index + 1) % tabs.length; break;
                case 'ArrowLeft': next = (index - 1 + tabs.length) % tabs.length; break;
                case 'Home': next = 0; break;
                case 'End': next = tabs.length - 1; break;
                default: return;
              }
              e.preventDefault();
              setCurrent(tabs[next].id);
              e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div id={`${base}-panel`} role="tabpanel" aria-labelledby={active ? `${base}-${active.id}` : undefined} tabIndex={0} className={styles.tabPanel}>
        {active?.content}
      </div>
    </div>
  );
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className={styles.progress} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className={styles.progressFill} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function StatusBar({ cells }: { cells: ReactNode[] }) {
  return (
    <div className={styles.status}>
      {cells.map((c, i) => (
        <div key={i} className={styles.statusCell}>
          {c}
        </div>
      ))}
    </div>
  );
}
