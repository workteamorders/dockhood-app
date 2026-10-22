'use client';

import { APPS, type AppId } from '@/components/apps/meta';
import { openApp } from '@/lib/openApp';
import { X_URL } from '@/lib/social';
import { useWindows } from '@/store/windows';
import { XIcon } from './AppIcon';
import styles from './Shell.module.css';

const PINNED: AppId[] = ['finder', 'launch', 'explore', 'verification', 'callouts', 'portfolio', 'games'];

export function Dock({ unread = false }: { unread?: boolean }) {
  const windows = useWindows((s) => s.windows);
  const activeId = useWindows((s) => s.activeId);
  const toggle = useWindows((s) => s.toggleFromTaskbar);
  return <nav className={styles.dock} aria-label="Application Dock">
    {PINNED.map((id) => {
      const app = APPS[id];
      const running = windows.filter((w) => w.appId === id).sort((a,b) => b.z-a.z)[0];
      return <button key={id} type="button" className={styles.dockItem} aria-label={app.label} aria-pressed={!!running && running.id === activeId && !running.minimized} onClick={() => running ? toggle(running.id) : openApp(id)}>
        <span className={styles.tooltip}>{app.label}</span><app.Icon size={56}/>
        {running && <span className={styles.running}/>}
        {id === 'callouts' && unread && <span className={styles.unread}/>}
      </button>;
    })}
    {windows.filter((w) => !PINNED.includes(w.appId)).slice(-4).map((w) => {
      const app = APPS[w.appId];
      return <button type="button" key={w.id} className={`${styles.dockItem} ${styles.dynamicItem}`} aria-label={w.title} aria-pressed={w.id === activeId && !w.minimized} onClick={() => toggle(w.id)}><span className={styles.tooltip}>{w.title}</span><app.Icon size={56}/><span className={styles.running}/></button>;
    })}
    <span className={styles.dockSeparator}/>
    <a className={`${styles.dockItem} ${styles.externalItem}`} href={X_URL} target="_blank" rel="noopener noreferrer" aria-label="@dockhood on X"><span className={styles.tooltip}>@dockhood on X</span><XIcon size={56}/></a>
  </nav>;
}
