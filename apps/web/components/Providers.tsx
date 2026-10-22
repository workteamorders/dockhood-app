'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, useAccountEffect } from 'wagmi';
import { RainbowKitProvider, type DisclaimerComponent } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import { startAnalytics, track } from '@/lib/analytics';
import { wagmiConfig } from '@/lib/wagmi';
import { xpRainbowTheme } from '@/lib/rainbowTheme';

const Disclaimer: DisclaimerComponent = ({ Text }) => (
  <Text>Dockhood is non-custodial software. Your keys never leave your wallet.</Text>
);

/** Starts analytics and records fresh wallet connections (which wallet app, never the address). */
function Analytics() {
  useEffect(() => startAnalytics(), []);
  useAccountEffect({
    onConnect: ({ connector, isReconnected }) => {
      if (!isReconnected) track('wallet_connected', { wallet_app: connector.name });
    },
  });
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 10_000 } } }));
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <Analytics />
        <RainbowKitProvider
          theme={xpRainbowTheme}
          modalSize="compact"
          appInfo={{ appName: 'Dockhood', disclaimer: Disclaimer }}
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
