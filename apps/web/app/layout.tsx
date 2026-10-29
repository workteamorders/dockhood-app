import type { ReactNode } from 'react';
import type { Metadata, Viewport } from 'next';
import { X_HANDLE } from '@/lib/social';
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono';
import './globals.css';

// Absolute URLs for link previews: NEXT_PUBLIC_SITE_URL, else the production domain.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.dockhood.com';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'Dockhood — The launchpad that boots clean.',
  description: 'Dockhood. The Mathematical Superintelligence launchpad. Theorem-backed coins on Robinhood Chain.',
  applicationName: 'Dockhood',
  openGraph: {
    title: 'Dockhood',
    description: 'The Mathematical Superintelligence launchpad.',
    siteName: 'Dockhood',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Dockhood',
    description: 'The Mathematical Superintelligence launchpad.',
    site: `@${X_HANDLE}`,
  },
};

export const viewport: Viewport = {
  themeColor: '#3a2d6b',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
