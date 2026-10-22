'use client';

import { erc20Abi, type Address } from 'viem';
import { useBalance, useReadContract } from 'wagmi';
import { NATIVE_PAIR, buyPresets, formatAmount, formatBps, type PairKind } from '@hood/shared';
import { findPair, launchPairs, network } from '@/lib/network';
import { Button } from '@/components/xp/Button';
import { GroupBox } from '@/components/xp/Controls';
import type { LaunchTerms } from '@/lib/pons/launch';
import { devBuyAmount, type Draft, type Errors } from './draft';
import { Field, invalidProps } from './Field';
import styles from './Launch.module.css';

type Props = {
  draft: Draft;
  set: (patch: Partial<Draft>) => void;
  errors: Errors;
  terms: LaunchTerms | undefined;
  account: Address | undefined;
};

const GROUPS: [PairKind, string][] = [
  ['native', 'Native'],
  ['stable', 'Stablecoin'],
  ['crypto', 'Crypto'],
  ['stock', 'Stocks & ETFs'],
];

/** Wallet balance of the pair asset, in its own units. */
export function usePairBalance(pair: Address, account: Address | undefined) {
  const native = pair === NATIVE_PAIR;
  const eth = useBalance({ address: account, chainId: network.chainId, query: { enabled: !!account && native } });
  const erc20 = useReadContract({
    address: pair,
    chainId: network.chainId,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: account ? [account] : undefined,
    query: { enabled: !!account && !native },
  });
  return native ? eth.data?.value : erc20.data;
}

export function EconomicsPage({ draft, set, errors, terms, account }: Props) {
  const pair = findPair(draft.pair) ?? launchPairs[0];
  const balance = usePairBalance(draft.pair, account);
  const amount = devBuyAmount(draft, pair.decimals);
  const short = balance != null && amount != null && amount > balance;
  const maxTaxPct = terms ? terms.maxCreatorTaxBps / 100 : 10;

  return (
    <>
      <GroupBox label="Curve">
        <Field
          label="Pair asset:"
          htmlFor="launch-pair"
          error={errors.pair}
          hint={terms ? `Trades on the curve are priced in ${pair.symbol}. Graduates to Uniswap V4 at ${formatAmount(terms.graduationThreshold, terms.decimals)} ${pair.symbol} raised.` : 'Reading Pons terms…'}
        >
          <select id="launch-pair" value={draft.pair} onChange={(e) => set({ pair: e.target.value as Address, devBuy: '' })}>
            {GROUPS.map(([kind, label]) => {
              const items = launchPairs.filter((p) => p.kind === kind);
              if (!items.length) return null;
              return (
                <optgroup key={kind} label={label}>
                  {items.map((p) => (
                    <option key={p.address} value={p.address}>
                      {p.symbol} — {p.name}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </select>
        </Field>

        <Field
          label="Dev buy (optional):"
          htmlFor="launch-devbuy"
          error={errors.devBuy ?? (short ? `Your wallet holds ${formatAmount(balance!, pair.decimals)} ${pair.symbol}.` : undefined)}
          hint={
            <>
              Bought in the launch transaction, before anyone else can trade.
              {balance != null && ` Balance: ${formatAmount(balance, pair.decimals)} ${pair.symbol}.`}
            </>
          }
        >
          <div className={styles.inline}>
            <input
              id="launch-devbuy"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              value={draft.devBuy}
              onChange={(e) => set({ devBuy: e.target.value.replace(',', '.') })}
              {...invalidProps('launch-devbuy', errors.devBuy)}
            />
            <span className={styles.unit}>{pair.symbol}</span>
          </div>
          {buyPresets(pair).length > 0 && (
            <div className={styles.presets}>
              {buyPresets(pair).map((v) => (
                <Button key={v} onClick={() => set({ devBuy: v })}>
                  {v}
                </Button>
              ))}
            </div>
          )}
        </Field>
      </GroupBox>

      <GroupBox label="Creator fees">
        <Field
          label="Creator wallet:"
          htmlFor="launch-creator"
          error={errors.creator}
          hint="Receives your creator tax and Pons creator fees. Defaults to the connected wallet."
        >
          <input
            id="launch-creator"
            type="text"
            autoComplete="off"
            spellCheck={false}
            className={styles.mono}
            placeholder={account ?? '0x… (connected wallet)'}
            value={draft.creator}
            onChange={(e) => set({ creator: e.target.value.trim() })}
            {...invalidProps('launch-creator', errors.creator)}
          />
        </Field>

        <Field
          label="Creator tax:"
          htmlFor="launch-tax"
          error={errors.creatorTax}
          hint={`Extra fee on every curve trade, paid to you, on top of the ${terms ? formatBps(terms.curveFeeBps) : '1%'} Pons fee. 0–${maxTaxPct}%.`}
        >
          <div className={styles.inline} style={{ maxWidth: 140 }}>
            <input
              id="launch-tax"
              type="number"
              min={0}
              max={maxTaxPct}
              step={0.1}
              value={draft.creatorTaxPct}
              onChange={(e) => set({ creatorTaxPct: e.target.value })}
              {...invalidProps('launch-tax', errors.creatorTax)}
            />
            <span className={styles.unit}>%</span>
          </div>
        </Field>

        <label className={styles.check}>
          <input type="checkbox" checked={draft.buyback} onChange={(e) => set({ buyback: e.target.checked })} />
          <span>
            Buyback &amp; lock: part of your creator fees buys back ${draft.ticker || 'TICKER'} and locks it, vesting back over 5 years
            (split with Pons). Lowers what you take home; you can switch it off later.
          </span>
        </label>
      </GroupBox>

      <GroupBox label="Links">
        <div className={styles.row}>
          <Field label="X:" htmlFor="launch-x" error={errors.twitter}>
            <input id="launch-x" type="text" autoComplete="off" placeholder="@handle" value={draft.socials.twitter} onChange={(e) => set({ socials: { ...draft.socials, twitter: e.target.value } })} {...invalidProps('launch-x', errors.twitter)} />
          </Field>
          <Field label="Telegram:" htmlFor="launch-tg" error={errors.telegram}>
            <input id="launch-tg" type="text" autoComplete="off" placeholder="t.me/group" value={draft.socials.telegram} onChange={(e) => set({ socials: { ...draft.socials, telegram: e.target.value } })} {...invalidProps('launch-tg', errors.telegram)} />
          </Field>
        </div>
        <Field label="Website:" htmlFor="launch-web" error={errors.website}>
          <input id="launch-web" type="text" autoComplete="off" value={draft.socials.website} onChange={(e) => set({ socials: { ...draft.socials, website: e.target.value } })} {...invalidProps('launch-web', errors.website)} />
        </Field>
      </GroupBox>
    </>
  );
}
