import type { Metadata } from 'next';
import { Startup } from '@/components/Startup';

export const metadata: Metadata = {
  title: 'Verification Admin | Dockhood',
  robots: { index: false, follow: false },
};

/** /admin/verification: the desktop boots and opens the admin window; the API only answers admin wallets. */
export default function VerificationAdminPage() {
  return <Startup />;
}
