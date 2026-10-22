'use client';

import { shortAddress } from '@hood/shared';
import { HoodLogo } from '@/components/xp/Icons';
import { TxLink } from '@/components/xp/TxLink';
import { REACTION_KINDS, type Callout, type ReactionKind } from '@/lib/api';
import { displayTicker } from '@/lib/hoodToken';
import { openToken } from '@/lib/openApp';
import { timeAgo } from '../explore/format';
import styles from './Callouts.module.css';

export const REACTION_EMOJI: Record<ReactionKind, string> = { rocket: '🚀', eyes: '👀', skull: '💀' };

/** A small square in a colour derived from the wallet, with its first two hex digits. */
function Avatar({ c }: { c: Callout }) {
  if (c.kind === 'system') return <HoodLogo size={28} />;
  const hex = c.wallet.slice(2, 8);
  const hue = parseInt(hex || '0', 16) % 360;
  return (
    <span className={styles.avatar} style={{ background: `hsl(${hue} 55% 42%)` }} aria-hidden>
      {(c.nickname?.[0] ?? c.wallet.slice(2, 4)).toUpperCase()}
    </span>
  );
}

type Props = {
  callout: Callout;
  flash: boolean;
  onReact: (kind: ReactionKind) => void;
};

/** One callout (docs/BRIEF.md §5.5). All user text renders as text, never HTML (§4.5). */
export function CalloutItem({ callout: c, flash, onReact }: Props) {
  const who = c.kind === 'system' ? 'Dockhood' : (c.nickname ?? shortAddress(c.wallet));
  const ticker = displayTicker(c.tokenAddress, c.ticker);
  return (
    <li className={`${styles.item} ${c.official ? styles.official : ''} ${flash ? styles.flash : ''}`}>
      <Avatar c={c} />
      <div className={styles.body}>
        <div className={styles.meta}>
          <b className={styles.who} title={c.kind === 'user' ? c.wallet : undefined}>
            {who}
          </b>
          {c.verified && (
            <span className={styles.verified} title="Verified: launched a Dockhood coin that graduated">
              ✔
            </span>
          )}
          {ticker &&
            (c.tokenAddress ? (
              <button type="button" className={styles.ticker} onClick={() => openToken(c.tokenAddress!, ticker)}>
                ${ticker}
              </button>
            ) : (
              <span className={styles.ticker}>${ticker}</span>
            ))}
          <time className={styles.time} dateTime={c.createdAt} title={new Date(c.createdAt).toLocaleString()}>
            {timeAgo(c.createdAt)}
          </time>
          {c.txHash && <TxLink hash={c.txHash} label={c.txSide && (c.txSide === 'buy' ? 'Buy' : 'Sell')} className={styles.tx} />}
        </div>
        <p className={styles.text}>{c.text}</p>
        <div className={styles.reactions}>
          {REACTION_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className={`${styles.reaction} ${c.mine?.includes(k) ? styles.reacted : ''}`}
              aria-pressed={c.mine?.includes(k) ?? false}
              aria-label={`${k} (${c.reactions[k]})`}
              onClick={() => onReact(k)}
            >
              {REACTION_EMOJI[k]} {c.reactions[k] || ''}
            </button>
          ))}
        </div>
      </div>
    </li>
  );
}
