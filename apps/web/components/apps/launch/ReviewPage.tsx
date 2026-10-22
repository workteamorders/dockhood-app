'use client';

import type { ReactNode } from 'react';
import { formatUnits, parseEther, zeroHash, type Address } from 'viem';
import { useQuery } from '@tanstack/react-query';
import { getPublicClient } from 'wagmi/actions';
import {
  ETH_PAIR,
  NATIVE_PAIR,
  buildDescription,
  buildTokenParams,
  formatAmount,
  formatBps,
  planLaunch,
  shortAddress,
} from '@hood/shared';
import { ConnectWallet } from '@/components/xp/ConnectWallet';
import { InfoIcon, WarningIcon } from '@/components/xp/Icons';
import { Latex } from '@/components/xp/Latex';
import { RigorBadge } from '@/components/xp/RigorBadge';
import { LAUNCH_CONFIG_ID, type LaunchTerms } from '@/lib/pons/launch';
import { wagmiConfig } from '@/lib/wagmi';
import { findPair, network } from '@/lib/network';
import { CurvePreview } from './CurvePreview';
import { usePairBalance } from './EconomicsPage';
import { devBuyQuote } from './deploy';
import { creatorTaxBps, currentRigor, devBuyAmount, type Draft } from './draft';
import styles from './Launch.module.css';

type Props = { draft: Draft; terms: LaunchTerms | undefined; account: Address | undefined; canLaunch: boolean | undefined };

/** Gas for the real call shape, with placeholder IPFS links of realistic length and the balance topped up. */
function useGasEstimate(draft: Draft, terms: LaunchTerms | undefined, account: Address | undefined) {
  const quoteIn = terms ? (devBuyAmount(draft, terms.decimals) ?? 0n) : 0n;
  const tax = creatorTaxBps(draft) ?? 0;
  return useQuery({
    queryKey: ['launch-gas', account, draft.pair, quoteIn.toString(), tax, draft.buyback, terms?.economics],
    enabled: !!account && !!terms,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const client = getPublicClient(wagmiConfig, { chainId: network.chainId });
      if (!client) throw new Error('The selected network client is unavailable.');
      const cid = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
      const params = buildTokenParams({
        name: draft.name || 'Dockhood',
        symbol: draft.ticker || 'HOOD',
        logo: `ipfs://${cid}`,
        description: buildDescription(draft.statement || '1 + 1 = 2', currentRigor(draft)?.score ?? null, cid),
        socials: draft.socials,
        creatorFeeRecipient: account!,
        creatorTaxBps: tax,
        buybackEnabled: draft.buyback,
        expectedEconomics: terms!.economics,
        salt: zeroHash,
      });
      const base = { params, launchConfigId: LAUNCH_CONFIG_ID, pairToken: draft.pair, launchFee: terms!.launchFee, minTokensOut: 0n, recipient: account! };
      const sim = { account: account!, stateOverride: [{ address: account!, balance: parseEther('1000') }] };
      // An ERC-20 dev buy can't be estimated before the approval exists; the bare launch is the floor.
      const plan = planLaunch({ ...base, quoteIn: draft.pair === NATIVE_PAIR ? quoteIn : 0n }, network.pons);
      const [gas, fees] = await Promise.all([
        plan.kind === 'launchToken'
          ? client.estimateContractGas({ ...plan.request, ...sim })
          : client.estimateContractGas({ ...plan.request, ...sim }),
        client.estimateFeesPerGas(),
      ]);
      return { cost: gas * fees.maxFeePerGas, approx: draft.pair !== NATIVE_PAIR && quoteIn > 0n };
    },
  });
}

export function ReviewPage({ draft, terms, account, canLaunch }: Props) {
  const pair = findPair(draft.pair) ?? ETH_PAIR;
  const rigor = currentRigor(draft);
  const tax = creatorTaxBps(draft) ?? 0;
  const quoteIn = terms ? (devBuyAmount(draft, terms.decimals) ?? 0n) : 0n;
  const quote = terms ? devBuyQuote(draft, terms) : null;
  const gas = useGasEstimate(draft, terms, account);
  const ethBalance = usePairBalance(NATIVE_PAIR, account);
  const pairBalance = usePairBalance(draft.pair, account);

  const native = draft.pair === NATIVE_PAIR;
  // The wallet must send the whole dev buy; a buy that finishes the curve gets the unspent part back.
  const ethNeeded = terms ? terms.launchFee + (gas.data?.cost ?? 0n) + (native ? quoteIn : 0n) : 0n;
  const refund = quote?.refund ?? 0n;
  const ethCost = native ? ethNeeded - refund : ethNeeded;
  const shortEth = ethBalance != null && terms != null && ethBalance < ethNeeded;
  const shortPair = !native && pairBalance != null && pairBalance < quoteIn;
  const toNumber = (v: bigint) => Number(formatUnits(v, terms?.decimals ?? 18));

  return (
    <>
      <div className={styles.reviewHead}>
        {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview */}
        {draft.logo && <img src={draft.logo.url} alt="" />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <b style={{ fontSize: 12 }}>${draft.ticker}</b> — {draft.name}
          <div className={styles.preview} style={{ minHeight: 0, padding: '4px 6px', marginTop: 3 }}>
            <Latex source={draft.statement} />
          </div>
        </div>
        <RigorBadge score={rigor?.score} />
      </div>

      {terms && (
        <CurvePreview
          phantomQuote={toNumber(terms.phantomQuote)}
          supply={Number(formatUnits(terms.supply, 18))}
          graduationThreshold={toNumber(terms.graduationThreshold)}
          symbol={pair.symbol}
          devBuyNet={quote ? toNumber(quote.spent - quote.fee - quote.creatorTax - quote.snipeTax) : undefined}
        />
      )}

      <table className={styles.summary} style={{ marginTop: 8 }}>
        <tbody>
          <tr>
            <th scope="row">Pair asset:</th>
            <td>{pair.symbol}</td>
          </tr>
          <tr>
            <th scope="row">Creator wallet:</th>
            <td className={styles.mono}>{draft.creator ? shortAddress(draft.creator) : account ? `${shortAddress(account)} (you)` : 'connected wallet'}</td>
          </tr>
          <tr>
            <th scope="row">Trading fees:</th>
            <td>
              {terms ? formatBps(terms.curveFeeBps) : '1%'} Pons{tax > 0 && ` + ${formatBps(tax)} creator tax`} per curve trade
              {draft.buyback && ' · buyback & lock on'}
            </td>
          </tr>
          <tr>
            <th scope="row">Pons launch fee:</th>
            <td>{terms ? `${formatAmount(terms.launchFee, 18)} ETH` : '…'}</td>
          </tr>
          {quoteIn > 0n && (
            <tr>
              <th scope="row">Dev buy:</th>
              <td>
                {formatAmount(quote?.spent ?? quoteIn, pair.decimals)} {pair.symbol}
                {quote && ` → ≈ ${formatAmount(quote.tokensOut, 18, { compact: true })} $${draft.ticker}`}
              </td>
            </tr>
          )}
          <tr>
            <th scope="row">Network fee:</th>
            <td>
              {!account ? 'connect a wallet to estimate' : gas.data ? `≈ ${formatAmount(gas.data.cost, 18, { maxFraction: 8 })} ETH${gas.data.approx ? ' + approval' : ''}` : gas.isError ? 'unavailable' : '…'}
            </td>
          </tr>
          <tr className={styles.total}>
            <th scope="row">Total:</th>
            <td>
              {terms ? `≈ ${formatAmount(ethCost, 18, { maxFraction: 8 })} ETH` : '…'}
              {!native && quoteIn > 0n && ` + ${formatAmount(quoteIn - refund, pair.decimals)} ${pair.symbol}`}
              {refund > 0n && (
                <span style={{ fontWeight: 400 }}>
                  {' '}
                  (sends {native ? `${formatAmount(ethNeeded, 18)} ETH` : `${formatAmount(quoteIn, pair.decimals)} ${pair.symbol}`}, {formatAmount(refund, pair.decimals)} back)
                </span>
              )}
            </td>
          </tr>
        </tbody>
      </table>
      <p className={styles.hint} style={{ marginTop: 0 }}>No Dockhood platform fee.</p>

      {quote?.completesCurve && (
        <Notice warn>
          This dev buy fills the whole curve: ${draft.ticker} graduates to Uniswap V4 in the launch transaction and
          about {formatAmount(quote.refund, pair.decimals)} {pair.symbol} is refunded.
        </Notice>
      )}
      {terms && !terms.configEnabled && <Notice warn>Pons has paused new launches. Try again later.</Notice>}
      {canLaunch === false && <Notice warn>Pons launches are invite-only right now, and this wallet is not on the list.</Notice>}
      {shortEth && <Notice warn>This wallet holds {formatAmount(ethBalance!, 18)} ETH, less than the total above.</Notice>}
      {shortPair && <Notice warn>This wallet holds {formatAmount(pairBalance!, pair.decimals)} {pair.symbol}, less than the dev buy.</Notice>}
      {!native && quoteIn > 0n && <Notice>Your wallet asks you to approve {pair.symbol} for the Pons router first, then to sign the launch.</Notice>}

      {account ? (
        <Notice>Launch settings are locked forever once the coin exists. Click Launch when everything above looks right.</Notice>
      ) : (
        <div style={{ textAlign: 'center', marginTop: 8 }}>
          <ConnectWallet />
        </div>
      )}
    </>
  );
}

function Notice({ warn, children }: { warn?: boolean; children: ReactNode }) {
  return (
    <div className={styles.notice}>
      {warn ? <WarningIcon size={16} /> : <InfoIcon size={16} />}
      <p>{children}</p>
    </div>
  );
}
