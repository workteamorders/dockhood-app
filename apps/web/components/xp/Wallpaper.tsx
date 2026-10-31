'use client';

import { useEffect, useId, useRef } from 'react';
import styles from './Wallpaper.module.css';

type Motion = { eligible: () => boolean; start: () => void; stop: () => void };
const motions = new Set<Motion>();

// Boot/skeleton copies never register. Overlapping desktops share one RAF owner.
function reconcileMotion() {
  const owner = [...motions].find((motion) => motion.eligible());
  for (const motion of motions) if (motion !== owner) motion.stop();
  owner?.start();
}

/** Liquid Sunset: original, resolution-independent sunset dune artwork. */
export function Wallpaper({ interactive = false }: { interactive?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const paint = (name: string) => `url(#${id}-${name})`;

  useEffect(() => {
    const root = ref.current;
    if (!interactive || !root) return;

    const desktop = root.closest<HTMLElement>('[data-desktop]') ?? root.parentElement;
    if (!desktop) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const coarse = window.matchMedia('(pointer: coarse), (hover: none)');
    let frame: number | null = null;
    let previous: number | null = null;
    let elapsed = 0;
    let targetX = 0, targetY = 0, x = 0, y = 0;
    let hovering = false, glow = 0;
    let bounds = root.getBoundingClientRect();
    const variables = ['--pointer-x', '--pointer-y', '--drift-x', '--drift-y', '--glow-x', '--glow-y', '--glow-opacity'];

    const neutral = () => { targetX = 0; targetY = 0; hovering = false; };
    const stop = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      previous = null;
      elapsed = 0;
      x = 0; y = 0; glow = 0;
      neutral();
      delete root.dataset.moving;
      for (const variable of variables) root.style.removeProperty(variable);
    };
    const tick = (now: number) => {
      const delta = previous === null ? 0 : Math.min(now - previous, 64);
      previous = now;
      elapsed += delta;
      const ease = 1 - Math.exp(-delta / 180);
      x += (targetX - x) * ease;
      y += (targetY - y) * ease;
      glow += ((hovering ? 0.2 : 0) - glow) * ease;
      root.style.setProperty('--pointer-x', `${(x * 18).toFixed(3)}px`);
      root.style.setProperty('--pointer-y', `${(y * 12).toFixed(3)}px`);
      root.style.setProperty('--drift-x', `${(Math.sin(elapsed / 14000) * 10).toFixed(3)}px`);
      root.style.setProperty('--drift-y', `${(Math.sin(elapsed / 19000) * 6).toFixed(3)}px`);
      root.style.setProperty('--glow-x', `${((x + 1) * bounds.width / 2).toFixed(2)}px`);
      root.style.setProperty('--glow-y', `${((y + 1) * bounds.height / 2).toFixed(2)}px`);
      root.style.setProperty('--glow-opacity', glow.toFixed(3));
      frame = window.requestAnimationFrame(tick);
    };
    const motion: Motion = {
      eligible: () => !reduced.matches && !coarse.matches && !document.hidden && root.isConnected &&
        !root.parentElement?.closest('[inert], [hidden], [aria-hidden="true"]'),
      start: () => {
        if (frame !== null) return;
        bounds = root.getBoundingClientRect();
        root.dataset.moving = '';
        frame = window.requestAnimationFrame(tick);
      },
      stop,
    };
    const move = (event: PointerEvent) => {
      if (frame === null || event.pointerType === 'touch') return;
      // Portaled modals and inert descendants must not steer the desktop behind them.
      if (!(event.target instanceof Node) || !desktop.contains(event.target) ||
        (event.target instanceof Element && event.target.closest('[inert], [aria-modal="true"]'))) {
        neutral();
        return;
      }
      if (!bounds.width || !bounds.height) return;
      const px = (event.clientX - bounds.left) / bounds.width;
      const py = (event.clientY - bounds.top) / bounds.height;
      if (px < 0 || px > 1 || py < 0 || py > 1) { neutral(); return; }
      targetX = px * 2 - 1;
      targetY = py * 2 - 1;
      hovering = true;
    };
    const leave = (event: PointerEvent) => {
      if (!(event.relatedTarget instanceof Node) || !desktop.contains(event.relatedTarget)) neutral();
    };
    const resize = () => { bounds = root.getBoundingClientRect(); neutral(); };
    const sync = () => reconcileMotion();

    // Dialogs toggle inert after mounting (including via portals); observe ancestors only,
    // not the CSS-variable mutations made by our own animation frames.
    const observer = new MutationObserver(sync);
    for (let ancestor = root.parentElement; ancestor; ancestor = ancestor.parentElement) {
      observer.observe(ancestor, { attributes: true, attributeFilter: ['inert', 'hidden', 'aria-hidden'] });
    }
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerout', leave, { passive: true });
    window.addEventListener('pointercancel', neutral, { passive: true });
    window.addEventListener('blur', neutral);
    window.addEventListener('resize', resize, { passive: true });
    document.addEventListener('visibilitychange', sync);
    reduced.addEventListener('change', sync);
    coarse.addEventListener('change', sync);
    motions.add(motion);
    reconcileMotion();

    return () => {
      motions.delete(motion);
      stop();
      observer.disconnect();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerout', leave);
      window.removeEventListener('pointercancel', neutral);
      window.removeEventListener('blur', neutral);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', sync);
      reduced.removeEventListener('change', sync);
      coarse.removeEventListener('change', sync);
      reconcileMotion();
    };
  }, [interactive]);

  return (
    <div ref={ref} className={styles.wallpaper} aria-hidden="true">
      <svg className={styles.artwork} viewBox="0 0 2560 1440" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={`${id}-sky`} x1="0" y1="0" x2=".65" y2="1">
            <stop stopColor="#ffe3b5" /><stop offset=".34" stopColor="#f9ad91" /><stop offset=".72" stopColor="#d9749c" /><stop offset="1" stopColor="#8c659e" />
          </linearGradient>
          <radialGradient id={`${id}-sunlight`} cx=".68" cy=".06" r=".72">
            <stop stopColor="#fff3d4" stopOpacity=".8" /><stop offset=".45" stopColor="#ffce9b" stopOpacity=".22" /><stop offset="1" stopColor="#ffcfaa" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`${id}-apricot`} x1=".2" y1="0" x2=".65" y2="1">
            <stop stopColor="#ffd394" /><stop offset=".26" stopColor="#ffb078" /><stop offset=".58" stopColor="#f7827e" /><stop offset="1" stopColor="#bb518b" />
          </linearGradient>
          <linearGradient id={`${id}-rose`} x1=".25" y1="0" x2=".68" y2="1">
            <stop stopColor="#ffbb86" /><stop offset=".24" stopColor="#f38c84" /><stop offset=".55" stopColor="#cd5d88" /><stop offset=".84" stopColor="#944582" /><stop offset="1" stopColor="#643b79" />
          </linearGradient>
          <linearGradient id={`${id}-mulberry`} x1=".3" y1="0" x2=".65" y2="1">
            <stop stopColor="#e997ac" /><stop offset=".28" stopColor="#b76a9c" /><stop offset=".64" stopColor="#7d4c89" /><stop offset="1" stopColor="#403365" />
          </linearGradient>
          <linearGradient id={`${id}-violet`} x1=".4" y1="0" x2=".6" y2="1">
            <stop stopColor="#b488b0" /><stop offset=".26" stopColor="#8d6299" /><stop offset=".63" stopColor="#5b447a" /><stop offset="1" stopColor="#30294f" />
          </linearGradient>
          <linearGradient id={`${id}-rim`} x1="0" y1="0" x2="1" y2=".4">
            <stop stopColor="#ffdcab" stopOpacity="0" /><stop offset=".37" stopColor="#ffedc5" stopOpacity=".75" /><stop offset=".75" stopColor="#ffd3b2" stopOpacity=".3" /><stop offset="1" stopColor="#ffd3b2" stopOpacity="0" />
          </linearGradient>
          <radialGradient id={`${id}-shade`} cx=".52" cy=".3" r=".85">
            <stop offset=".35" stopColor="#30234f" stopOpacity="0" /><stop offset="1" stopColor="#30234f" stopOpacity=".22" />
          </radialGradient>
        </defs>
        <path fill={paint('sky')} d="M0 0h2560v1440H0z" />
        <path fill={paint('sunlight')} d="M0 0h2560v1440H0z" />
        </svg>
        <svg className={`${styles.artwork} ${styles.far}`} viewBox="0 0 2560 1440" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
          <path d="M-200 1000C150 900 500 210 1200 260S2070 690 2750 130L2800 1600H-200Z" fill={paint('apricot')} />
          <path d="M-200 1000C150 900 500 210 1200 260S2070 690 2750 130" fill="none" stroke={paint('rim')} strokeWidth="3" />
          <path d="M100 1000C610 470 760 310 1240 325S2110 760 2700 280" fill="none" stroke="#ffe2b5" strokeOpacity=".09" strokeWidth="38" />
        </svg>
        <svg className={`${styles.artwork} ${styles.middle}`} viewBox="0 0 2560 1440" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
          <path d="M-200 1050C470 1110 700 280 1260 340S2080 980 2760 580L2800 1600H-200Z" fill={paint('rose')} />
          <path d="M-200 1050C470 1110 700 280 1260 340S2080 980 2760 580" fill="none" stroke={paint('rim')} strokeWidth="2.5" />
          <path d="M480 960C790 640 913 398 1260 402S2040 1000 2670 710" fill="none" stroke="#ffc0a4" strokeOpacity=".08" strokeWidth="25" />
        </svg>
        <svg className={`${styles.artwork} ${styles.near}`} viewBox="0 0 2560 1440" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
          <path d="M-200 1360C470 1150 780 650 1250 670S2040 1230 2760 840V1600H-200Z" fill={paint('mulberry')} />
          <path d="M-200 1360C470 1150 780 650 1250 670S2040 1230 2760 840" fill="none" stroke={paint('rim')} strokeOpacity=".65" strokeWidth="2" />
          <path d="M-200 1490C450 1100 1050 1040 1550 1190S2200 1520 2760 1100V1600H-200Z" fill={paint('violet')} />
          <path d="M-200 1490C450 1100 1050 1040 1550 1190S2200 1520 2760 1100" fill="none" stroke="#e3bdd0" strokeOpacity=".25" strokeWidth="2" />
        </svg>
        <svg className={styles.artwork} viewBox="0 0 2560 1440" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
          <path fill={paint('shade')} d="M0 0h2560v1440H0z" />
        </svg>
      <div className={styles.glow} />
    </div>
  );
}
