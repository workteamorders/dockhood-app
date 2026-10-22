'use client';

import { useRef, type PointerEvent, type ReactNode } from 'react';
import { useWindows, type WindowState } from '@/store/windows';
import styles from './Window.module.css';

const MOBILE_QUERY = '(max-width: 640px)';

export function CtrlGlyph({ kind }: { kind: 'min' | 'max' | 'restore' | 'close' }) {
  return <svg width="8" height="8" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
    {kind === 'close' ? <path d="m2 2 8 8m0-8-8 8"/> : kind === 'min' ? <path d="M1 6h10"/> : <path d="M2 5V2h3m2 8h3V7M2 2l8 8"/>}
  </svg>;
}

type WindowProps = {
  win: WindowState;
  active: boolean;
  icon: ReactNode;
  children: ReactNode;
  maximizable?: boolean;
};

export function Window({ win, active, icon, children, maximizable = true }: WindowProps) {
  const { focus, close, minimize, toggleMaximize, move } = useWindows.getState();
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ dx: number; dy: number; x: number; y: number; pointer: number } | null>(null);

  const onTitlePointerDown = (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || win.maximized) return;
    if ((e.target as HTMLElement).closest('button')) return;
    if (window.matchMedia(MOBILE_QUERY).matches) return;
    const el = ref.current;
    if (!el) return;
    drag.current = { dx: e.clientX - win.x, dy: e.clientY - win.y, x: win.x, y: win.y, pointer: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onTitlePointerMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    const el = ref.current;
    if (!d || !el || d.pointer !== e.pointerId) return;
    const vw = window.innerWidth;
    const vh = ref.current?.parentElement?.clientHeight ?? window.innerHeight;
    // Keep at least part of the title bar reachable.
    d.x = Math.min(vw - 60, Math.max(60 - win.w, e.clientX - d.dx));
    d.y = Math.min(vh - 30, Math.max(0, e.clientY - d.dy));
    el.style.left = `${d.x}px`;
    el.style.top = `${d.y}px`;
  };

  const endDrag = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    if (d.x !== win.x || d.y !== win.y) move(win.id, d.x, d.y);
  };

  const cls = [styles.window, !active && styles.inactive, win.maximized && styles.maximized].filter(Boolean).join(' ');

  return (
    <section
      ref={ref}
      className={cls}
      role="dialog"
      aria-label={win.title}
      data-window={win.id}
      style={{
        left: win.x,
        top: win.y,
        width: win.w,
        height: win.h,
        zIndex: win.z,
        display: win.minimized ? 'none' : undefined,
      }}
      onPointerDownCapture={() => focus(win.id)}
      onFocusCapture={() => focus(win.id)}
    >
      <header
        role="presentation"
        className={styles.titlebar}
        onPointerDown={onTitlePointerDown}
        onPointerMove={onTitlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(e) => {
          if (maximizable && !(e.target as HTMLElement).closest('button')) toggleMaximize(win.id);
        }}
      >
        <span className={styles.controls}>
          <button type="button" className={`${styles.ctrl} ${styles.close}`} aria-label="Close" onClick={() => close(win.id)}>
            <CtrlGlyph kind="close" />
          </button>
          <button type="button" className={`${styles.ctrl} ${styles.minimize}`} aria-label="Minimize" onClick={() => minimize(win.id)}>
            <CtrlGlyph kind="min" />
          </button>
            <button
              type="button"
              className={`${styles.ctrl} ${styles.maximizeCtrl}`}
              aria-label={win.maximized ? 'Restore' : 'Maximize'}
              disabled={!maximizable}
              onClick={() => toggleMaximize(win.id)}
            >
              <CtrlGlyph kind={win.maximized ? 'restore' : 'max'} />
            </button>
        </span>
        <span className={styles.title}><span className={styles.titleIcon}>{icon}</span>{win.title}</span>
      </header>
      <div className={styles.body}>{children}</div>
    </section>
  );
}
