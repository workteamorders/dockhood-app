import { shortHash } from '@hood/shared';
import { txUrl } from '@/lib/network';

/** A transaction's short hash linking to Blockscout, with the full hash on hover. */
export function TxLink({ hash, label, className }: { hash: string; label?: string; className?: string }) {
  return (
    <a href={txUrl(hash)} target="_blank" rel="noopener noreferrer" className={className} title={`${hash} on Blockscout`}>
      {label && `${label} `}
      <span style={{ fontFamily: 'var(--font-mono)' }}>{shortHash(hash)}</span>
    </a>
  );
}
