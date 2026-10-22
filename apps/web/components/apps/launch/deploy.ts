import { erc20Abi, parseEventLogs, type Address, type Hash } from 'viem';
import { getAccount, readContract, simulateContract, switchChain, waitForTransactionReceipt, writeContract } from 'wagmi/actions';
import {
  buildDescription,
  buildTokenParams,
  freshCurveState,
  planLaunch,
  ponsCurveAbi,
  ponsFactoryAbi,
  quoteBuy,
  randomSalt,
  withSlippage,
  type TheoremMetadata,
} from '@hood/shared';
import { pinLaunch, recordLaunch } from '@/lib/api';
import { network } from '@/lib/network';
import { ensureSession } from '@/lib/siwe';
import { LAUNCH_CONFIG_ID, type LaunchTerms } from '@/lib/pons/launch';
import { chain, wagmiConfig } from '@/lib/wagmi';
import { creatorTaxBps, currentRigor, devBuyAmount, type Draft } from './draft';

export type DeployStep = 'signin' | 'pin' | 'approve' | 'sign' | 'confirm' | 'record';

export type DeployResult = {
  token: Address;
  curve: Address;
  txHash: Hash;
  /** Filled dev buy from the CurveBuy log; null without a dev buy. */
  tokensOut: bigint | null;
  recorded: boolean;
};

/**
 * The dev buy executes in the launch transaction against a curve nobody else can have traded yet, so the
 * quote is exact; the 1% bound only absorbs a launch config changing underneath (which the economics pin
 * already reverts on).
 */
const DEV_BUY_SLIPPAGE_BPS = 100n;

export function devBuyQuote(draft: Draft, terms: LaunchTerms) {
  const quoteIn = devBuyAmount(draft, terms.decimals) ?? 0n;
  const tax = creatorTaxBps(draft) ?? 0;
  if (quoteIn === 0n) return null;
  const state = freshCurveState(terms.supply, terms.phantomQuote, terms.graduationThreshold, terms.curveFeeBps, BigInt(tax));
  return quoteBuy(state, quoteIn);
}

export function theoremMetadata(draft: Draft): TheoremMetadata {
  const rigor = currentRigor(draft);
  return {
    schema: 'hood.exe/theorem@1',
    name: draft.name.trim(),
    ticker: draft.ticker.trim().toUpperCase(),
    statement: draft.statement.trim(),
    proof: draft.proof.trim(),
    rigor:
      rigor?.score != null && rigor.parts && rigor.statusLabel
        ? {
            score: rigor.score,
            ...rigor.parts,
            statusLabel: rigor.statusLabel,
            reasoning: rigor.reasoning,
            model: rigor.model ?? 'unknown',
          }
        : null,
    createdAt: new Date().toISOString(),
  };
}

export async function deployLaunch(draft: Draft, terms: LaunchTerms, onStep: (step: DeployStep, hash?: Hash) => void): Promise<DeployResult> {
  const { address: account, chainId } = getAccount(wagmiConfig);
  if (!account) throw new Error('Connect a wallet first.');
  if (!draft.logo) throw new Error('Choose a logo image.');
  if (chainId !== chain.id) await switchChain(wagmiConfig, { chainId: chain.id });

  const quoteIn = devBuyAmount(draft, terms.decimals) ?? 0n;
  const tax = creatorTaxBps(draft) ?? 0;
  const quote = devBuyQuote(draft, terms);

  onStep('signin');
  await ensureSession(account);

  onStep('pin');
  const metadata = theoremMetadata(draft);
  const { logoCid, metadataCid, rigorScore } = await pinLaunch(draft.logo.blob, metadata);

  const params = buildTokenParams({
    name: metadata.name,
    symbol: metadata.ticker,
    logo: `ipfs://${logoCid}`,
    // The server pins its own score for the statement; the description must agree with it.
    description: buildDescription(metadata.statement, rigorScore, metadataCid),
    socials: draft.socials,
    creatorFeeRecipient: (draft.creator.trim() || account) as Address,
    creatorTaxBps: tax,
    buybackEnabled: draft.buyback,
    expectedEconomics: terms.economics,
    salt: randomSalt(),
  });
  const plan = planLaunch({
    params,
    launchConfigId: LAUNCH_CONFIG_ID,
    pairToken: draft.pair,
    launchFee: terms.launchFee,
    quoteIn,
    minTokensOut: quote ? withSlippage(quote.tokensOut, DEV_BUY_SLIPPAGE_BPS) : 0n,
    recipient: account,
  }, network.pons);

  if (plan.approval) {
    const { token, spender, amount } = plan.approval;
    const allowance = await readContract(wagmiConfig, { address: token, abi: erc20Abi, functionName: 'allowance', args: [account, spender] });
    if (allowance < amount) {
      onStep('approve');
      const hash = await writeContract(wagmiConfig, { address: token, abi: erc20Abi, functionName: 'approve', args: [spender, amount] });
      onStep('approve', hash);
      const r = await waitForTransactionReceipt(wagmiConfig, { hash });
      if (r.status !== 'success') throw new Error('The approval transaction failed.');
    }
  }

  onStep('sign');
  const hash =
    plan.kind === 'launchToken'
      ? await writeContract(wagmiConfig, (await simulateContract(wagmiConfig, { ...plan.request, account })).request)
      : await writeContract(wagmiConfig, (await simulateContract(wagmiConfig, { ...plan.request, account })).request);

  onStep('confirm', hash);
  const receipt = await waitForTransactionReceipt(wagmiConfig, { hash });
  if (receipt.status !== 'success') throw new Error('The launch transaction reverted on-chain.');
  const [launched] = parseEventLogs({ abi: ponsFactoryAbi, eventName: 'TokenLaunched', logs: receipt.logs });
  if (!launched) throw new Error('The transaction confirmed but no launch was found in it.');
  const { token, curve } = launched.args;
  const buys = parseEventLogs({ abi: ponsCurveAbi, eventName: 'CurveBuy', logs: receipt.logs }).filter(
    (l) => l.address.toLowerCase() === curve.toLowerCase(),
  );
  const tokensOut = buys.length ? buys.reduce((sum, l) => sum + l.args.tokensOut, 0n) : null;

  onStep('record', hash);
  const recorded = await recordLaunch(hash).then(
    () => true,
    () => false,
  );

  return { token, curve, txHash: hash, tokensOut, recorded };
}
