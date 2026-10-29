import type { ReactNode } from 'react';
import { rigorTier } from '@hood/shared';
import { logoUrl } from './ipfs';

/** Link-preview images (next/og): a glass window on original sunset dunes. Inline styles only (Satori). */
export const OG_SIZE = { width: 1200, height: 630 };

const TIER_COLOR = { good: '#2e9a2e', warn: '#c98a00', bad: '#c0392b', none: '#8a8a8a' } as const;

export function XpFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        position: 'relative',
        overflow: 'hidden',
        padding: 44,
        background: 'linear-gradient(135deg, #ff9a56 0%, #f45b7a 48%, #3a2d6b 100%)',
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ position: 'absolute', left: -160, bottom: -410, width: 1500, height: 700, borderRadius: '50%', transform: 'rotate(-16deg)', background: 'linear-gradient(180deg, #ffc18a 0%, #ed6b82 36%, #6c407d 100%)' }} />
      <div style={{ position: 'absolute', right: -360, bottom: -450, width: 1200, height: 800, borderRadius: '50%', transform: 'rotate(-28deg)', background: 'linear-gradient(160deg, #f49d97 0%, #854e91 42%, #3a2d6b 100%)' }} />
      <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRadius: 12, border: '1px solid rgba(255,255,255,0.5)', background: 'rgba(255,255,255,0.82)', boxShadow: '0 10px 40px rgba(0,0,0,0.25)' }}>
        <div
          style={{
            height: 58,
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 120px',
            background: 'rgba(255,255,255,0.42)',
            borderBottom: '1px solid rgba(28,28,32,0.08)',
            color: '#45414f',
            fontSize: 24,
            fontWeight: 600,
          }}
        >
          <div style={{ position: 'absolute', left: 24, display: 'flex', gap: 10 }}>
            {['#ff5f57', '#febc2e', '#28c840'].map((color) => (
              <div key={color} style={{ width: 16, height: 16, borderRadius: '50%', background: color, border: '1px solid rgba(0,0,0,0.08)' }} />
            ))}
          </div>
          <span>{title}</span>
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '34px 40px 26px' }}>{children}</div>
      </div>
    </div>
  );
}

export function Footer() {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'auto', paddingTop: 20, fontSize: 22, color: '#45414f' }}>
      <span>Dockhood · Robinhood Chain · Pons</span>
      <span style={{ fontWeight: 700, color: '#3a2d6b' }}>dockhood.com</span>
    </div>
  );
}

export function RigorPill({ score }: { score: number | null }) {
  return (
    <div style={{ display: 'flex', padding: '6px 18px', borderRadius: 999, background: TIER_COLOR[rigorTier(score)], color: '#fff', fontSize: 34, fontWeight: 700 }}>
      Σ {score ?? '—'}
    </div>
  );
}

/** The logo as a data URL Satori can draw (PNG/JPEG only), or null to fall back to the ticker's letter. */
export async function logoDataUrl(logo: string): Promise<string | null> {
  const url = logoUrl(logo);
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    const type = res.headers.get('content-type')?.split(';')[0] ?? '';
    if (!res.ok || !['image/png', 'image/jpeg'].includes(type)) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > 1_000_000) return null;
    return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
  } catch {
    return null;
  }
}
