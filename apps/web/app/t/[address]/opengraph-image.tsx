import { ImageResponse } from 'next/og';
import { formatQuote } from '@/components/apps/explore/format';
import { Footer, OG_SIZE, RigorPill, XpFrame, logoDataUrl } from '@/lib/ogCard';
import { getShareToken, plainStatement } from '@/lib/shareToken';
import { displayTicker } from '@/lib/hoodToken';

export const alt = 'A coin on Dockhood';
export const size = OG_SIZE;
export const contentType = 'image/png';

/** The /t/0x… link preview: the coin's card in a Dockhood glass window. */
export default async function Image({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const t = await getShareToken(address);
  if (!t) {
    return new ImageResponse(
      (
        <XpFrame title="Token Detail">
          <div style={{ display: 'flex', fontSize: 56, fontWeight: 700, color: '#1c1c20' }}>A coin on Dockhood</div>
          <div style={{ display: 'flex', marginTop: 16, fontSize: 32, color: '#45414f' }}>Theorem-backed coins on Robinhood Chain.</div>
          <Footer />
        </XpFrame>
      ),
      size,
    );
  }

  const logo = await logoDataUrl(t.logo);
  const symbol = displayTicker(address, t.symbol);
  const line = t.hood && t.statement ? plainStatement(t.statement, 120) : (t.blurb ?? '').slice(0, 120);
  const progress = t.phase > 0 ? 1 : (t.progress ?? 0);

  return new ImageResponse(
    (
      <XpFrame title={`$${symbol} — Token Detail`}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 30 }}>
          {logo ? (
            <img src={logo} width={150} height={150} alt="" style={{ borderRadius: 24, border: '1px solid rgba(28,28,32,0.1)' }} />
          ) : (
            <div style={{ width: 150, height: 150, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 24, background: 'linear-gradient(135deg, #0a84ff, #6d4acb)', color: '#fff', fontSize: 84, fontWeight: 700 }}>
              {(symbol.trim()[0] ?? '?').toUpperCase()}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
              <span style={{ fontSize: 78, fontWeight: 700, color: '#1c1c20' }}>${symbol.slice(0, 12)}</span>
              {t.hood && <RigorPill score={t.rigorScore} />}
            </div>
            <span style={{ fontSize: 34, color: '#45414f' }}>{t.name.slice(0, 48)}</span>
          </div>
        </div>

        {line && (
          <div style={{ display: 'flex', marginTop: 26, padding: '16px 22px', background: 'rgba(255,255,255,0.6)', border: '1px solid rgba(28,28,32,0.1)', borderRadius: 12, fontSize: 34, color: '#1c1c20' }}>
            {line}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 34, marginTop: 26, fontSize: 30, color: '#222' }}>
          {t.marketCap != null && <span>MCap {formatQuote(t.marketCap, t.pairSymbol)}</span>}
          <div style={{ display: 'flex', flex: 1, height: 16, overflow: 'hidden', borderRadius: 999, background: 'rgba(28,28,32,0.1)' }}>
            <div style={{ display: 'flex', width: `${Math.max(2, Math.round(progress * 100))}%`, borderRadius: 999, background: '#30d158' }} />
          </div>
          <span>{t.phase > 0 ? 'Graduated' : `${Math.floor(progress * 100)}% to graduation`}</span>
        </div>

        <Footer />
      </XpFrame>
    ),
    size,
  );
}
