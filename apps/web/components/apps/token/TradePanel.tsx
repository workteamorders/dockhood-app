'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { erc20Abi, parseEventLogs, parseUnits, type Address, type Hash } from 'viem';
import { getAccount, simulateContract, switchChain, waitForTransactionReceipt, writeContract } from 'wagmi/actions';
import { buyPresets, formatAmount, formatBps, ponsCurveAbi, quoteBuy, quoteSell, withSlippage } from '@hood/shared';
import { addressUrl, findPair } from '@/lib/network';
import { Button } from '@/components/xp/Button';
import { ConnectWallet } from '@/components/xp/ConnectWallet';
import { InfoIcon, WarningIcon } from '@/components/xp/Icons';
import { TxLink } from '@/components/xp/TxLink';
import { failureReason, track } from '@/lib/analytics';
import type { TokenDetail } from '@/lib/api';
import { displayTicker } from '@/lib/hoodToken';
import { useIdentity } from '@/lib/identity';
import { useLiveCurve, useTradeBalances } from '@/lib/pons/curve';
import { txErrorMessage } from '@/lib/pons/launch';
import { withRiskAccepted } from '@/lib/risk';
import { chain, wagmiConfig } from '@/lib/wagmi';
import styles from './TradePanel.module.css';

type Side = 'buy' | 'sell';
type Status = { kind: 'idle' } | { kind: 'busy'; label: string; hash?: Hash; approval?: boolean } | { kind: 'done'; text: string; hash: Hash } | { kind: 'error'; text: string };

const SLIPPAGE = { min: 0.5, max: 20, default: '5' };
const SELL_SHARES = [25, 50, 75, 100] as const;

/** Parses a decimal amount; null when empty or invalid, 0n never returned. */
function parseAmount(text: string, decimals: number): bigint | null {
  const v = text.trim().replace(',', '.');
  if (!/^\d*\.?\d*$/.test(v) || v === '' || v === '.') return null;
  try {
    const n = parseUnits(v, decimals);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

/**
 * Buy/Sell on the Pons curve (docs/BRIEF.md §5.4). Quotes come from packages/shared/quote.ts on live
 * reserves (they match the contract to the wei); the transaction is still simulated before signing.
 */
export function TradePanel({ token: t, paused = false }: { token: TokenDetail; paused?: boolean }) {
  const { address: account, connected } = useIdentity();
  const queryClient = useQueryClient();
  const [side, setSide] = useState<Side>('buy');
  const [amount, setAmount] = useState('');
  const [slippage, setSlippage] = useState(SLIPPAGE.default);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const curveAddress = t.curve as Address;
  const tokenAddress = t.token as Address;
  const pairAddress = t.pair.address as Address;
  const pair = findPair(pairAddress);
  const live = useLiveCurve(curveAddress, account, !paused && t.phase === 0);
  const balances = useTradeBalances(tokenAddress, pairAddress, curveAddress, account);
  const symbol = displayTicker(t.token, t.symbol);

  if (t.phase > 0 || live.data?.graduated) {
    return (
      <div className={styles.panel}>
        <div className={styles.info}>
          <InfoIcon size={16} />
          <p>
            {t.phase >= 2
              ? `$${symbol} has graduated and trades on Uniswap V4. Swapping it inside Dockhood arrives in Phase 2.`
              : `$${symbol} has finished its curve; its Uniswap V4 pool is being seeded. Curve trading is closed.`}
          </p>
        </div>
        <a href={addressUrl(t.token)} target="_blank" rel="noopener noreferrer">
          ${symbol} on Blockscout
        </a>
        <Footer />
      </div>
    );
  }

  const decimals = side === 'buy' ? t.pair.decimals : 18;
  const unit = side === 'buy' ? t.pair.symbol : `$${symbol}`;
  const amountIn = parseAmount(amount, decimals);
  const slippagePct = Number(slippage);
  const slippageOk = Number.isFinite(slippagePct) && slippagePct >= SLIPPAGE.min && slippagePct <= SLIPPAGE.max;
  const slippageBps = BigInt(Math.round((slippageOk ? slippagePct : Number(SLIPPAGE.default)) * 100));

  const state = live.data?.state;
  const snipe = live.data?.snipeTaxBps ?? 0n;
  const buyQuote = side === 'buy' && state && amountIn ? quoteBuy(state, amountIn, snipe) : null;
  const sellQuote = side === 'sell' && state && amountIn ? quoteSell(state, amountIn) : null;

  const balance = side === 'buy' ? balances.pairBalance : balances.tokenBalance;
  const allowance = side === 'buy' ? balances.pairAllowance : balances.tokenAllowance;
  const insufficient = balance != null && amountIn != null && amountIn > balance;
  const needsApproval = allowance != null && amountIn != null && allowance < amountIn;
  const busy = status.kind === 'busy';

  let blocked: string | null = null;
  if (live.data?.readyToGraduate) blocked = `$${symbol} is graduating to Uniswap V4; trading on the curve has closed.`;
  else if (snipe > 0n) blocked = `Snipe tax is ${formatBps(snipe)} right after launch. Trading opens in a few seconds.`;

  const execute = async () => {
    if (!account || !amountIn) return;
    const props = { side, pair: t.pair.symbol, hood: t.hood, approval: needsApproval };
    track('trade_submitted', props);
    try {
      if (getAccount(wagmiConfig).chainId !== chain.id) await switchChain(wagmiConfig, { chainId: chain.id });
      if (needsApproval) {
        const approveToken = side === 'buy' ? pairAddress : tokenAddress;
        setStatus({ kind: 'busy', label: `Approve ${unit} in your wallet…` });
        const hash = await writeContract(wagmiConfig, { address: approveToken, abi: erc20Abi, functionName: 'approve', args: [curveAddress, amountIn] });
        setStatus({ kind: 'busy', label: 'Confirming approval…', hash, approval: true });
        const r = await waitForTransactionReceipt(wagmiConfig, { hash });
        if (r.status !== 'success') throw new Error('The approval failed.');
        await balances.refetch();
      }

      setStatus({ kind: 'busy', label: 'Confirm in your wallet…' });
      let hash: Hash;
      if (side === 'buy') {
        const minOut = buyQuote ? withSlippage(buyQuote.tokensOut, slippageBps) : 0n;
        const { request } = await simulateContract(wagmiConfig, {
          address: curveAddress,
          abi: ponsCurveAbi,
          functionName: 'buy',
          args: [amountIn, minOut, account],
          value: pair?.kind === 'native' ? amountIn : 0n,
          account,
        });
        hash = await writeContract(wagmiConfig, request);
      } else {
        const minOut = sellQuote ? withSlippage(sellQuote.quoteOut, slippageBps) : 0n;
        const { request } = await simulateContract(wagmiConfig, {
          address: curveAddress,
          abi: ponsCurveAbi,
          functionName: 'sell',
          args: [amountIn, minOut, account],
          account,
        });
        hash = await writeContract(wagmiConfig, request);
      }

      setStatus({ kind: 'busy', label: 'Confirming on Robinhood Chain…', hash });
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash });
      if (receipt.status !== 'success') throw new Error('The trade reverted on-chain.');
      const logs = receipt.logs.filter((l) => l.address.toLowerCase() === curveAddress.toLowerCase());
      const text =
        side === 'buy'
          ? `Bought ${formatAmount(parseEventLogs({ abi: ponsCurveAbi, eventName: 'CurveBuy', logs })[0]?.args.tokensOut ?? 0n, 18, { compact: true })} $${symbol}.`
          : `Sold for ${formatAmount(parseEventLogs({ abi: ponsCurveAbi, eventName: 'CurveSell', logs })[0]?.args.quoteOut ?? 0n, t.pair.decimals)} ${t.pair.symbol}.`;
      setStatus({ kind: 'done', text, hash });
      track('trade_confirmed', props);
      setAmount('');
      await Promise.all([balances.refetch(), live.refetch()]);
      void queryClient.invalidateQueries({ queryKey: ['token', t.token.toLowerCase()] });
      void queryClient.invalidateQueries({ queryKey: ['trades', t.token.toLowerCase()] });
    } catch (e) {
      const text = txErrorMessage(e);
      setStatus({ kind: 'error', text });
      track('trade_failed', { ...props, reason: failureReason(text) });
    }
  };

  const verb = side === 'buy' ? `Buy $${symbol}` : `Sell $${symbol}`;
  const action = amountIn && insufficient ? `Not enough ${unit}` : amountIn && needsApproval ? `Approve ${unit}, then ${side}` : verb;

  return (
    <div className={styles.panel}>
      <div role="tablist" className={styles.sides}>
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={side === s}
            className={`${styles.side} ${side === s ? (s === 'buy' ? styles.buyOn : styles.sellOn) : ''}`}
            onClick={() => {
              setSide(s);
              setAmount('');
              setStatus({ kind: 'idle' });
            }}
          >
            {s === 'buy' ? 'BUY' : 'SELL'}
          </button>
        ))}
      </div>

      <label className={styles.label} htmlFor="trade-amount">
        <span>Amount</span>
        {balance != null && (
          <span className={styles.muted}>
            Balance {formatAmount(balance, decimals, { compact: side === 'sell' })} {side === 'buy' ? t.pair.symbol : ''}
          </span>
        )}
      </label>
      <div className={styles.inputRow}>
        <input
          id="trade-amount"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0"
          value={amount}
          disabled={busy}
          onChange={(e) => {
            setAmount(e.target.value);
            if (status.kind !== 'busy') setStatus({ kind: 'idle' });
          }}
        />
        <span className={styles.unit}>{unit}</span>
      </div>
      <div className={styles.presets}>
        {side === 'buy'
          ? buyPresets(pair ?? { address: pairAddress, symbol: t.pair.symbol, name: '', decimals: t.pair.decimals, kind: 'other' }).map((v) => (
              <Button key={v} onClick={() => setAmount(v)} disabled={busy}>
                {v}
              </Button>
            ))
          : SELL_SHARES.map((pct) => (
              <Button
                key={pct}
                disabled={busy || !balances.tokenBalance}
                onClick={() => {
                  const v = ((balances.tokenBalance ?? 0n) * BigInt(pct)) / 100n;
                  setAmount(formatAmount(v, 18, { maxFraction: 6 }).replace(/,/g, ''));
                }}
              >
                {pct === 100 ? 'Max' : `${pct}%`}
              </Button>
            ))}
      </div>

      {(buyQuote || sellQuote) && (
        <dl className={styles.quote}>
          <div>
            <dt>You receive</dt>
            <dd>
              ≈ {buyQuote ? `${formatAmount(buyQuote.tokensOut, 18, { compact: true })} $${symbol}` : `${formatAmount(sellQuote!.quoteOut, t.pair.decimals)} ${t.pair.symbol}`}
            </dd>
          </div>
          <div>
            <dt>Minimum</dt>
            <dd>
              {buyQuote
                ? `${formatAmount(withSlippage(buyQuote.tokensOut, slippageBps), 18, { compact: true })} $${symbol}`
                : `${formatAmount(withSlippage(sellQuote!.quoteOut, slippageBps), t.pair.decimals)} ${t.pair.symbol}`}
            </dd>
          </div>
          <div>
            <dt>Price impact</dt>
            <dd className={(buyQuote ?? sellQuote)!.priceImpactBps > 500n ? styles.warn : undefined}>{formatBps((buyQuote ?? sellQuote)!.priceImpactBps)}</dd>
          </div>
          <div>
            <dt>Trade fee ({formatBps(state!.feeBps)})</dt>
            <dd>
              {formatAmount((buyQuote ?? sellQuote)!.fee, t.pair.decimals)} {t.pair.symbol}
            </dd>
          </div>
          {state!.creatorTaxBps > 0n && (
            <div>
              <dt>Creator tax ({formatBps(state!.creatorTaxBps)})</dt>
              <dd>
                {formatAmount((buyQuote ?? sellQuote)!.creatorTax, t.pair.decimals)} {t.pair.symbol}
              </dd>
            </div>
          )}
          {buyQuote && buyQuote.snipeTax > 0n && (
            <div>
              <dt>Snipe tax ({formatBps(snipe)})</dt>
              <dd className={styles.warn}>
                {formatAmount(buyQuote.snipeTax, t.pair.decimals)} {t.pair.symbol}
              </dd>
            </div>
          )}
          {buyQuote?.completesCurve && (
            <p className={styles.note}>
              This buy finishes the curve; {formatAmount(buyQuote.refund, t.pair.decimals)} {t.pair.symbol} comes back.
            </p>
          )}
        </dl>
      )}

      <label className={styles.slippage}>
        Slippage
        <input
          type="number"
          min={SLIPPAGE.min}
          max={SLIPPAGE.max}
          step={0.5}
          value={slippage}
          onChange={(e) => setSlippage(e.target.value)}
          aria-invalid={!slippageOk}
          disabled={busy}
        />
        %
      </label>
      {!slippageOk && <p className={styles.error}>Use {SLIPPAGE.min}–{SLIPPAGE.max}%.</p>}

      {blocked && (
        <div className={styles.info}>
          <WarningIcon size={16} />
          <p>{blocked}</p>
        </div>
      )}

      {!connected ? (
        <div className={styles.connect}>
          <ConnectWallet />
        </div>
      ) : (
        <Button
          variant={side === 'buy' ? 'success' : 'danger'}
          className={styles.action}
          disabled={busy || !!blocked || !amountIn || insufficient || !slippageOk || !live.data}
          onClick={() => withRiskAccepted(() => void execute())}
        >
          {busy ? status.label : action}
        </Button>
      )}

      {status.kind === 'error' && <p className={styles.error}>{status.text}</p>}
      {status.kind === 'done' && <p className={styles.done}>{status.text}</p>}
      {(status.kind === 'done' || (status.kind === 'busy' && status.hash)) && (
        <TxLink hash={status.hash!} label={status.kind === 'busy' && status.approval ? 'Approval' : 'Transaction'} className={styles.muted} />
      )}
      {live.error && <p className={styles.error}>Could not read the curve. Check your connection.</p>}

      <Footer />
    </div>
  );
}

function Footer() {
  return <p className={styles.footer}>Powered by Pons · Pons V2 is unaudited</p>;
}
