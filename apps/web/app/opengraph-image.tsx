import { ImageResponse } from 'next/og';
import { VERIFICATION_LIVE } from '@/lib/features';
import { Footer, OG_SIZE, XpFrame } from '@/lib/ogCard';

export const alt = 'Dockhood. The launchpad that boots clean.';
export const size = OG_SIZE;
export const contentType = 'image/png';

/** The site-wide link preview: the Welcome window. */
export default function Image() {
  return new ImageResponse(
    (
      <XpFrame title="Dockhood">
        <div style={{ display: 'flex', fontSize: 96, fontWeight: 700, letterSpacing: -4, color: '#1c1c20' }}>
          Dockhood
        </div>
        <div style={{ display: 'flex', marginTop: 12, fontSize: 52, fontWeight: 700, letterSpacing: -1, color: '#3a2d6b' }}>The launchpad that boots clean.</div>
        <div style={{ display: 'flex', marginTop: 24, maxWidth: 880, fontSize: 32, lineHeight: 1.5, color: '#45414f' }}>
          {VERIFICATION_LIVE ? 'Theorem-backed coins. Formally verified. Fully on-chain.' : 'Theorem-backed coins. Fully on-chain.'}
        </div>
        <Footer />
      </XpFrame>
    ),
    size,
  );
}
