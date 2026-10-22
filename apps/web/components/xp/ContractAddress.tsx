'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { shortAddress } from '@hood/shared';
import { addressUrl } from '@/lib/network';
import { HOOD_TOKEN } from '@/lib/hoodToken';
import { openToken } from '@/lib/openApp';
import { Button } from './Button';
import styles from './ContractAddress.module.css';

const COPIED_MS = 2_000;

/** Copies text to the clipboard, falling back to a prompt where the clipboard is blocked. */
function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      window.prompt('Copy the contract address:', text);
    }
  };
  return { copied, copy };
}

/** Welcome: hood.exe's official contract, labelled so it can't be mistaken for a coin launched here. */
export function OfficialContract() {
  if (!HOOD_TOKEN) return null;
  return <OfficialContractBox address={HOOD_TOKEN.address} ticker={HOOD_TOKEN.ticker} />;
}

function OfficialContractBox({ address, ticker }: { address: string; ticker: string }) {
  const { copied, copy } = useCopy(address);
  return (
    <div className={styles.box}>
      <div className={styles.label}>
        Official <b>${ticker}</b> contract
      </div>
      <div className={styles.row}>
        <code className={styles.address} title={address}>
          {address}
        </code>
        <Button onClick={() => void copy()}>{copied ? 'Copied ✓' : 'Copy'}</Button>
        <Button onClick={() => openToken(address, ticker)}>Chart</Button>
        <a className={styles.link} href={addressUrl(address)} target="_blank" rel="noopener noreferrer">
          Blockscout
        </a>
      </div>
    </div>
  );
}

/** Taskbar tray: one click copies the contract, from any window. */
export function ContractTrayButton() {
  if (!HOOD_TOKEN) return null;
  return <TrayButton address={HOOD_TOKEN.address} ticker={HOOD_TOKEN.ticker} />;
}

function TrayButton({ address, ticker }: { address: string; ticker: string }) {
  const { copied, copy } = useCopy(address);
  return (
    <span className={styles.trayWrap}>
      <button
        type="button"
        className={styles.trayBtn}
        title={`Copy the official $${ticker} contract address`}
        aria-label={`Copy the official $${ticker} contract address`}
        onClick={() => void copy()}
      >
        CA
      </button>
      {copied && (
        <span className={styles.bubble} role="status">
          ${ticker} contract copied
        </span>
      )}
    </span>
  );
}

/** About: the contract as a row value, linked to Blockscout. Null while there's no token. */
export function contractRow(): [string, ReactNode] | null {
  if (!HOOD_TOKEN) return null;
  return [
    'Contract',
    <a key="ca" href={addressUrl(HOOD_TOKEN.address)} target="_blank" rel="noopener noreferrer" title={HOOD_TOKEN.address} className={styles.mono}>
      ${HOOD_TOKEN.ticker} {shortAddress(HOOD_TOKEN.address)}
    </a>,
  ];
}
