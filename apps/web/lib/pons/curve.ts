'use client';

import { erc20Abi, zeroAddress, type Address } from 'viem';
import { useBalance, useReadContracts } from 'wagmi';
import { NATIVE_PAIR, ponsCurveAbi, type CurveState } from '@hood/shared';
import { network } from '../network';

export type LiveCurve = {
  state: CurveState;
  /** currentSnipeTaxBps for the connected wallet (or nobody): >0 only in the first seconds after launch. */
  snipeTaxBps: bigint;
  /** Sells are closed and the next buy finishes the curve. */
  readyToGraduate: boolean;
  graduated: boolean;
};

/**
 * Everything a trade quote needs, read straight from the curve (docs/BRIEF.md §5.4): reserves, the
 * sellable allocation, fee and creator tax, the snipe tax for this buyer, and graduation flags.
 * Refreshed every 4 s while `live`.
 */
export function useLiveCurve(curve: Address, account: Address | undefined, live: boolean) {
  const c = { address: curve, abi: ponsCurveAbi, chainId: network.chainId } as const;
  const q = useReadContracts({
    allowFailure: false,
    contracts: [
      { ...c, functionName: 'getReserves' },
      { ...c, functionName: 'sellableTokens' },
      { ...c, functionName: 'feeBps' },
      { ...c, functionName: 'creatorTaxBps' },
      { ...c, functionName: 'currentSnipeTaxBps', args: [account ?? zeroAddress] },
      { ...c, functionName: 'readyToGraduate' },
      { ...c, functionName: 'graduated' },
    ],
    query: { refetchInterval: live ? 4_000 : false },
  });

  let data: LiveCurve | undefined;
  if (q.data) {
    const [[quoteReserve, tokenReserve], sellable, feeBps, creatorTaxBps, snipeTaxBps, readyToGraduate, graduated] = q.data;
    data = { state: { quoteReserve, tokenReserve, sellable, feeBps, creatorTaxBps }, snipeTaxBps, readyToGraduate, graduated };
  }
  return { data, error: q.error, refetch: q.refetch };
}

/**
 * The wallet's pair-asset and token balances, and what the curve may pull from each (ERC-20 pairs are
 * pulled on buys, the token on sells).
 */
export function useTradeBalances(token: Address, pair: Address, curve: Address, account: Address | undefined) {
  const native = pair === NATIVE_PAIR;
  const enabled = !!account;
  const eth = useBalance({ address: account, chainId: network.chainId, query: { enabled: enabled && native, refetchInterval: 8_000 } });
  const owner = account ?? zeroAddress;
  const erc20 = { abi: erc20Abi, chainId: network.chainId } as const;
  const q = useReadContracts({
    allowFailure: false,
    contracts: [
      { ...erc20, address: token, functionName: 'balanceOf', args: [owner] },
      { ...erc20, address: token, functionName: 'allowance', args: [owner, curve] },
      { ...erc20, address: native ? token : pair, functionName: 'balanceOf', args: [owner] },
      { ...erc20, address: native ? token : pair, functionName: 'allowance', args: [owner, curve] },
    ],
    query: { enabled, refetchInterval: 8_000 },
  });
  const [tokenBalance, tokenAllowance, pairBalance, pairAllowance] = q.data ?? [];
  return {
    tokenBalance,
    tokenAllowance,
    pairBalance: native ? eth.data?.value : pairBalance,
    /** Infinite for ETH: nothing to approve. */
    pairAllowance: native ? 2n ** 256n - 1n : pairAllowance,
    refetch: () => Promise.all([eth.refetch(), q.refetch()]),
  };
}
