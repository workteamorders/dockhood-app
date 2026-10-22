import { Suspense } from 'react';
import type { Metadata } from 'next';
import { connection } from 'next/server';
import { Startup } from '@/components/Startup';
import { getShareToken, plainStatement, shareSummary } from '@/lib/shareToken';
import { X_HANDLE } from '@/lib/social';
import { displayTicker } from '@/lib/hoodToken';

/**
 * /t/0x… (docs/BRIEF.md §4): the desktop with that coin's Token Detail open, and a link preview with the
 * coin's own card. The desktop reads the address from the URL itself, like /?app=token&t=.
 */
export async function generateMetadata({ params }: { params: Promise<{ address: string }> }): Promise<Metadata> {
  const { address } = await params;
  const t = await getShareToken(address);
  if (!t) return { title: 'Dockhood' };
  const title = `$${displayTicker(address, t.symbol)} — ${t.name} | Dockhood`;
  const lead = t.hood && t.statement ? plainStatement(t.statement) : (t.blurb ?? 'A coin on Robinhood Chain. Routed through Pons.');
  const description = [lead, shareSummary(t)].filter(Boolean).join(' — ');
  return {
    title,
    description,
    openGraph: { title, description, type: 'website', siteName: 'Dockhood' },
    twitter: { card: 'summary_large_image', title, description, site: `@${X_HANDLE}` },
  };
}

// The metadata needs the address, which is only known per request; this marks that as intended.
async function RequestTime() {
  await connection();
  return null;
}

export default function TokenPage() {
  return (
    <>
      <Startup />
      <Suspense>
        <RequestTime />
      </Suspense>
    </>
  );
}
