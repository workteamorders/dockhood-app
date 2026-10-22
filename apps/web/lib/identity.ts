'use client';

import { useAccount } from 'wagmi';
import { shortAddress } from '@hood/shared';

/** Wallet is the identity (docs/BRIEF.md §15 note). Nicknames arrive with the API in week 3. */
export function useIdentity() {
  const { address, isConnected } = useAccount();
  return {
    address,
    connected: isConnected && !!address,
    label: isConnected && address ? shortAddress(address) : 'Guest',
    role: isConnected ? 'Dockhood user' : 'not signed in',
  };
}
