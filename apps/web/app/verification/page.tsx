import type { Metadata } from 'next';
import { Startup } from '@/components/Startup';

export const metadata: Metadata = {
  title: 'Verification Queue | Dockhood',
  description: 'Formally verified theorem coins. Lean 4 proofs checked by the kernel. Σ 100. FORMAL ✓.',
};

/** /verification: the desktop boots and opens Verification Queue (the desktop reads the path). */
export default function VerificationPage() {
  return <Startup />;
}
