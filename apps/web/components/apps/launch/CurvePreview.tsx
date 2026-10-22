'use client';

import { useEffect, useRef } from 'react';
import { curvePreview } from '@hood/shared';
import styles from './Launch.module.css';

type Props = {
  phantomQuote: number;
  supply: number;
  graduationThreshold: number;
  symbol: string;
  /** Pair-token amount the dev buy adds to the curve, if any. */
  devBuyNet?: number;
};

const HEIGHT = 128;
const PAD = { l: 8, r: 8, t: 10, b: 18 };

/** Read-only Pons curve (docs/BRIEF.md §5.2): price against pair raised, ending at graduation. */
export function CurvePreview({ phantomQuote, supply, graduationThreshold, symbol, devBuyNet }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const width = canvas.clientWidth;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(HEIGHT * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, HEIGHT);

      const pts = curvePreview(phantomQuote, supply, graduationThreshold);
      const maxPrice = pts[pts.length - 1].price;
      const w = width - PAD.l - PAD.r;
      const h = HEIGHT - PAD.t - PAD.b;
      const x = (progress: number) => PAD.l + progress * w;
      const y = (price: number) => PAD.t + h - (price / maxPrice) * h;

      ctx.strokeStyle = 'rgba(0, 0, 0, 0.08)';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const gy = Math.round(PAD.t + (h * i) / 4) + 0.5;
        ctx.beginPath();
        ctx.moveTo(PAD.l, gy);
        ctx.lineTo(PAD.l + w, gy);
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.moveTo(x(0), y(0));
      for (const p of pts) ctx.lineTo(x(p.progress), y(p.price));
      ctx.lineTo(x(1), y(0));
      ctx.closePath();
      ctx.fillStyle = 'rgba(50, 145, 255, 0.16)';
      ctx.fill();

      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(x(p.progress), y(p.price)) : ctx.moveTo(x(p.progress), y(p.price))));
      ctx.strokeStyle = '#0a84ff';
      ctx.lineWidth = 2;
      ctx.stroke();

      const gx = Math.round(x(1)) - 0.5;
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = '#ff6b00';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(gx, PAD.t);
      ctx.lineTo(gx, PAD.t + h);
      ctx.stroke();
      ctx.setLineDash([]);

      if (devBuyNet && devBuyNet > 0) {
        const progress = Math.min(1, devBuyNet / graduationThreshold);
        const quote = phantomQuote + progress * graduationThreshold;
        const px = x(progress);
        const py = y((quote * quote) / (phantomQuote * supply));
        ctx.fillStyle = '#ff6b00';
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      ctx.fillStyle = '#6a6a70';
      ctx.font = '12px Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      ctx.textBaseline = 'bottom';
      ctx.textAlign = 'left';
      ctx.fillText('0', PAD.l, HEIGHT - 3);
      ctx.textAlign = 'right';
      ctx.fillText(`${fmt(graduationThreshold)} ${symbol} → Uniswap V4`, PAD.l + w, HEIGHT - 3);
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [phantomQuote, supply, graduationThreshold, symbol, devBuyNet]);

  return (
    <canvas
      ref={ref}
      className={styles.curve}
      style={{ height: HEIGHT }}
      role="img"
      aria-label={`Bonding curve: price rises until ${fmt(graduationThreshold)} ${symbol} is raised, then the coin graduates to Uniswap V4.`}
    />
  );
}

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 4 : 2 });
