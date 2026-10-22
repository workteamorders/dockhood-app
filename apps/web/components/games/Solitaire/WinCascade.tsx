'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { RANK_LABEL, SUIT_SYMBOL, isRed } from './solitaire.logic';
import { SUITS, type Card, type Suit } from './solitaire.types';
import styles from './solitaire.module.css';

type Props = {
  board: RefObject<HTMLDivElement | null>;
  foundations: Record<Suit, Card[]>;
  onDone: () => void;
};

function drawCard(ctx: CanvasRenderingContext2D, card: Card, x: number, y: number, w: number, h: number) {
  const r = Math.max(2, w * 0.06);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = isRed(card.suit) ? '#c91f00' : '#000';
  ctx.textBaseline = 'top';
  ctx.font = `bold ${Math.round(w * 0.22)}px Inter, system-ui, sans-serif`;
  ctx.fillText(RANK_LABEL[card.rank], x + w * 0.08, y + h * 0.05);
  ctx.fillText(SUIT_SYMBOL[card.suit], x + w * 0.08, y + h * 0.05 + w * 0.24);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${Math.round(w * 0.5)}px Inter, system-ui, sans-serif`;
  ctx.fillText(card.rank > 10 ? RANK_LABEL[card.rank] : SUIT_SYMBOL[card.suit], x + w / 2, y + h / 2);
  ctx.textAlign = 'start';
}

/**
 * The classic win (hood-exe-games-brief.md §2.6): Kings first, the cards leave the foundations one at a time and
 * bounce across the felt, leaving trails. Click to skip; skipped for reduced motion.
 */
export function WinCascade({ board, foundations, onDone }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });

  useEffect(() => {
    const host = board.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!host || !canvas || !ctx || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      done.current();
      return;
    }
    const W = host.scrollWidth;
    const H = host.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.scale(dpr, dpr);

    const hostRect = host.getBoundingClientRect();
    const slot = (suit: Suit) => host.querySelector<HTMLElement>(`[data-foundation="${suit}"]`)?.getBoundingClientRect();
    const first = slot('hearts');
    const w = first?.width ?? 60;
    const h = first?.height ?? 84;
    const g = h * 0.012;

    // King of each suit, then Queens, … then Aces: the order they come off the piles.
    const queue = [] as { card: Card; x: number; y: number }[];
    for (let rank = 13; rank >= 1; rank--) {
      for (const suit of SUITS) {
        const card = foundations[suit][rank - 1];
        const r = slot(suit);
        if (card && r) queue.push({ card, x: r.left - hostRect.left + host.scrollLeft, y: r.top - hostRect.top + host.scrollTop });
      }
    }

    let flying: { card: Card; x: number; y: number; vx: number; vy: number } | null = null;
    let raf = 0;
    let last = 0;
    /** One 60 Hz physics tick, drawn (the trail is every tick's card left on the canvas). Returns false when done. */
    const tickOnce = (): boolean => {
      if (!flying) {
        const next = queue.shift();
        if (!next) return false;
        const speed = w * (0.05 + Math.random() * 0.08);
        flying = { ...next, vx: Math.random() < 0.5 ? -speed : speed, vy: -Math.random() * h * 0.12 };
      }
      flying.vy += g;
      flying.x += flying.vx;
      flying.y += flying.vy;
      if (flying.y + h > H) {
        flying.y = H - h;
        flying.vy = -flying.vy * 0.75;
      }
      drawCard(ctx, flying.card, flying.x, flying.y, w, h);
      if (flying.x + w < 0 || flying.x > W) flying = null;
      return true;
    };
    // Time-based: if frames arrive late (a slow phone), run the missed ticks so speed and trails look the same.
    const frame = (now: number) => {
      const ticks = last ? Math.min(8, Math.max(1, Math.round((now - last) / (1_000 / 60)))) : 1;
      last = now;
      for (let i = 0; i < ticks; i++) {
        if (!tickOnce()) {
          done.current();
          return;
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [board, foundations]);

  return <canvas ref={canvasRef} className={styles.cascade} onClick={() => done.current()} aria-label="You won! Click to continue." />;
}
