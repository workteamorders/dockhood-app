import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { zeroHash } from 'viem';
import { NATIVE_PAIR, buyPresets, quoteBuy, quoteSell } from '@hood/shared';
import { readContract, sendTransaction, simulateContract, waitForTransactionReceipt, writeContract } from 'wagmi/actions';
import { TradePanel } from '@/components/apps/token/TradePanel';
import { deployLaunch } from '@/components/apps/launch/deploy';
import { EMPTY_DRAFT } from '@/components/apps/launch/draft';
import { SubmitProofForm } from '@/components/verification/SubmitProofForm';
import { VerificationAdmin } from '@/components/verification/VerificationAdmin';
import { Button } from '@/components/xp/Button';
import { pinLaunch, type TokenDetail, type VerificationConfig } from './api';
import { ensureRpcNetwork } from './wagmi';

const test = vi.hoisted(() => ({
  states: [] as unknown[], cursor: 0, walletChain: 46630, switchAfterApproval: false,
  broadcasts: [] as number[], setState: vi.fn(),
  account: '0x1111111111111111111111111111111111111111' as const,
  pair: '0x3333333333333333333333333333333333333333' as const,
  hash: `0x${'1'.repeat(64)}` as `0x${string}`,
}));

vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => [test.cursor < test.states.length ? test.states[test.cursor++] : initial, test.setState],
}));
vi.mock('@hood/shared', async (original) => {
  const shared = await original<typeof import('@hood/shared')>();
  return { ...shared, buyPresets: vi.fn(shared.buyPresets), quoteBuy: vi.fn(shared.quoteBuy), quoteSell: vi.fn(shared.quoteSell) };
});
vi.mock('./network', () => ({
  network: { chainId: 46630, pons: { launchFactory: test.account, launchAndBuy: test.pair }, officialToken: null },
  findPair: () => undefined, addressUrl: () => 'https://explorer.example.test',
}));
vi.mock('./wagmi', () => ({ chain: { id: 46630 }, wagmiConfig: {}, ensureRpcNetwork: vi.fn(async () => {}) }));
vi.mock('wagmi', () => ({ useReadContract: () => ({ data: 100n, refetch: vi.fn() }) }));
vi.mock('wagmi/actions', () => {
  const broadcast = vi.fn(async (_config: unknown, params: { chainId?: number }) => {
    if (params.chainId !== 46630) throw new Error('Missing selected chain');
    if (test.walletChain !== params.chainId) throw new Error('Wallet chain changed');
    test.broadcasts.push(params.chainId);
    return test.hash;
  });
  return {
    getAccount: () => ({ address: test.account, chainId: test.walletChain }),
    switchChain: vi.fn(async () => { test.walletChain = 46630; }),
    readContract: vi.fn(async () => 0n),
    simulateContract: vi.fn(async (_config: unknown, params: object) => ({ request: params })),
    writeContract: broadcast, sendTransaction: vi.fn(broadcast),
    waitForTransactionReceipt: vi.fn(async () => {
      if (test.switchAfterApproval) test.walletChain = 4663;
      return { status: 'success', logs: [] };
    }),
  };
});
vi.mock('./identity', () => ({ useIdentity: () => ({ address: test.account, connected: true }) }));
vi.mock('./siwe', () => ({ ensureSession: vi.fn() }));
vi.mock('./analytics', () => ({ track: vi.fn(), failureReason: vi.fn() }));
vi.mock('./risk', () => ({ withRiskAccepted: (work: () => void) => work() }));
vi.mock('@/components/xp/Dialog', () => ({ Dialog: () => null }));
vi.mock('@/components/xp/ConnectWallet', () => ({ ConnectWallet: () => null }));
vi.mock('./pons/curve', () => ({
  useLiveCurve: () => ({ data: {
    state: { quoteReserve: 1000000n, tokenReserve: 1000000n, sellable: 100000n, feeBps: 100n, creatorTaxBps: 0n },
    snipeTaxBps: 0n, graduated: false, readyToGraduate: false,
  }, refetch: vi.fn() }),
  useTradeBalances: () => ({ tokenBalance: 1000000n, pairBalance: 1000000n, tokenAllowance: 0n, pairAllowance: 0n, refetch: vi.fn() }),
}));
vi.mock('./api', () => ({
  pinLaunch: vi.fn(async () => ({ logoCid: 'logo', metadataCid: 'metadata', rigorScore: null })),
  recordLaunch: vi.fn(), fetchToken: vi.fn(), fetchTokens: vi.fn(), prepareProof: vi.fn(),
  confirmProofSubmission: vi.fn(async () => ({ pending: false, submissions: [{ id: 'proof' }] })),
  fetchVerificationAdmin: vi.fn(), fetchVerificationConfig: vi.fn(), reviewVerification: vi.fn(), setVerificationPaused: vi.fn(),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({ data: queryKey[0] === 'verification-config' ? { admin: true } :
    queryKey[0] === 'verification-admin' ? {
      pool: { address: test.account, balanceWei: null, availableWei: null }, paidOutWei: '0',
      feeSplitterAddress: test.account, review: [],
    } : { token: test.account, symbol: 'TEST', statement: null, formal: false } }),
}));

type Props = { children?: ReactNode; footer?: ReactNode; onClick?: () => void; disabled?: boolean; address?: `0x${string}` };
function elements(node: ReactNode): ReactElement<Props>[] {
  return Children.toArray(node).flatMap((child) => isValidElement<Props>(child)
    ? [child, ...elements(child.props.children), ...elements(child.props.footer)] : []);
}
function button(tree: ReactNode, label: string) {
  const found = elements(tree).find((node) => (node.type === Button || node.type === 'button') &&
    renderToStaticMarkup(<>{node.props.children}</>).includes(label));
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}
function expectPinned() {
  for (const action of [readContract, writeContract, sendTransaction, simulateContract, waitForTransactionReceipt]) {
    for (const call of vi.mocked(action).mock.calls) expect(call[1]).toMatchObject({ chainId: 46630 });
  }
}

const token: TokenDetail = {
  token: test.account, curve: test.pair, name: 'Test', symbol: 'TEST', logo: '',
  pair: { address: test.pair, symbol: 'PAIR', decimals: 0 }, hood: false, phase: 0, formal: false,
  statement: null, blurb: null, rigorScore: null, price: null, marketCap: null, progress: null,
  volume24h: null, trades24h: null, launchedAt: '', stateUpdatedAt: null, deployer: test.account, description: '', metadataCid: null,
};
const config: VerificationConfig = {
  enabled: true, admin: false, poolAddress: test.account, submissionFeeWei: '1', maxPerWeek: 10, maxProofBytes: 1000,
  rewardsEth: { TRIVIAL: '0', SIMPLE: '0', MEDIUM: '0', HARD: '0', OPEN: '0' },
};
const prepared = { submissionFee: '1', txData: { to: test.account, data: '0x', value: '1' }, estimatedTier: 'TRIVIAL' };
const terms = {
  launchFee: 1n, maxCreatorTaxBps: 100, curveFeeBps: 100n, supply: 1000000n, phantomQuote: 1000000n,
  graduationThreshold: 100000n, decimals: 0, economics: zeroHash, configEnabled: true, pairApproved: true,
};
const draft = { ...EMPTY_DRAFT, name: 'Test', ticker: 'TEST', pair: test.pair, devBuy: '10', logo: { blob: new Blob(), url: '' } };

beforeEach(() => {
  vi.clearAllMocks();
  test.cursor = 0;
  test.states = [];
  test.walletChain = 46630;
  test.switchAfterApproval = false;
  test.broadcasts = [];
});

describe('wallet action chain pinning', () => {
  it.each(['bare', 'native', 'erc20'])('pins the final launch receipt and all %s launch calls', async (kind) => {
    const input = { ...draft, pair: kind === 'erc20' ? test.pair : NATIVE_PAIR, devBuy: kind === 'bare' ? '' : '10' };
    await expect(deployLaunch(input, terms, vi.fn())).rejects.toThrow('no launch was found');
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(kind === 'erc20' ? 2 : 1);
    expect(simulateContract).toHaveBeenCalledOnce();
    expectPinned();
  });

  it('pins launch reads, approvals, simulations and waits even if the wallet switches after approval', async () => {
    test.switchAfterApproval = true;
    await expect(deployLaunch(draft, terms, vi.fn())).rejects.toThrow('Wallet chain changed');
    expect(test.broadcasts).toEqual([46630]);
    expect(simulateContract).toHaveBeenCalledOnce();
    expectPinned();
  });

  it.each(['buy', 'sell'])('pins %s trade actions and refuses the second write after a wallet switch', async (side) => {
    test.states = [side, side === 'buy' ? '10' : '0.00000000000000001', '5', { kind: 'idle' }];
    test.switchAfterApproval = true;
    button(TradePanel({ token }), side === 'buy' ? 'then buy' : 'then sell').props.onClick?.();
    await vi.waitFor(() => expect(test.setState).toHaveBeenCalledWith({ kind: 'error', text: 'Wallet chain changed' }));
    expect(test.broadcasts).toEqual([46630]);
    expect(simulateContract).toHaveBeenCalledOnce();
    expectPinned();
  });

  it.each(['buy', 'sell'])('pins the final receipt for a successful %s trade', async (side) => {
    test.states = [side, side === 'buy' ? '10' : '0.00000000000000001', '5', { kind: 'idle' }];
    button(TradePanel({ token }), side === 'buy' ? 'then buy' : 'then sell').props.onClick?.();
    await vi.waitFor(() => expect(test.setState).toHaveBeenCalledWith(expect.objectContaining({ kind: 'done' })));
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(2);
    expect(test.broadcasts).toEqual([46630, 46630]);
    expectPinned();
  });

  it('pins proof submission and its receipt after the wallet switches', async () => {
    test.states = [null, null, [], prepared, null, null];
    test.switchAfterApproval = true;
    const onSubmitted = vi.fn();
    button(SubmitProofForm({ config, token: test.account, onClose: vi.fn(), onSubmitted }), 'Submit (').props.onClick?.();
    await vi.waitFor(() => expect(onSubmitted).toHaveBeenCalledWith('proof'));
    expect(sendTransaction).toHaveBeenCalledOnce();
    expectPinned();
  });

  it.each(['Pause payouts', 'Resume payouts', 'Set split'])('pins admin %s writes and receipt waits', async (label) => {
    let tree: ReactNode = VerificationAdmin();
    if (label === 'Set split') {
      const control = elements(tree).find((node) => typeof node.type === 'function' && node.props.address === test.account)!;
      test.cursor = 0;
      test.states = ['5', false, null];
      tree = (control.type as (props: Props) => ReactNode)(control.props);
    }
    test.switchAfterApproval = true;
    button(tree, label).props.onClick?.();
    await vi.waitFor(() => expect(waitForTransactionReceipt).toHaveBeenCalledOnce());
    expect(test.broadcasts).toEqual([46630]);
    expectPinned();
  });

  it('blocks launch side effects when the RPC is misconfigured', async () => {
    vi.mocked(ensureRpcNetwork).mockRejectedValueOnce(new Error('RPC network mismatch'));
    await expect(deployLaunch(draft, terms, vi.fn())).rejects.toThrow('RPC network mismatch');
    expect(pinLaunch).not.toHaveBeenCalled();
    expect(writeContract).not.toHaveBeenCalled();
  });

  it.each(['trade', 'proof', 'pool', 'split'])('blocks %s wallet actions when the RPC is misconfigured', async (flow) => {
    vi.mocked(ensureRpcNetwork).mockRejectedValueOnce(new Error('RPC network mismatch'));
    let tree: ReactNode;
    let label: string;
    if (flow === 'trade') {
      test.states = ['buy', '10', '5', { kind: 'idle' }];
      tree = TradePanel({ token });
      label = 'then buy';
    } else if (flow === 'proof') {
      test.states = [null, null, [], prepared, null, null];
      tree = SubmitProofForm({ config, token: test.account, onClose: vi.fn(), onSubmitted: vi.fn() });
      label = 'Submit (';
    } else {
      tree = VerificationAdmin();
      label = 'Pause payouts';
      if (flow === 'split') {
        const control = elements(tree).find((node) => typeof node.type === 'function' && node.props.address === test.account)!;
        test.cursor = 0;
        test.states = ['5', false, null];
        tree = (control.type as (props: Props) => ReactNode)(control.props);
        label = 'Set split';
      }
    }
    button(tree, label).props.onClick?.();
    await vi.waitFor(() => expect(test.setState.mock.calls.flat()).toContainEqual(flow === 'trade'
      ? { kind: 'error', text: 'RPC network mismatch' } : 'RPC network mismatch'));
    expect(writeContract).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(simulateContract).not.toHaveBeenCalled();
    expect(waitForTransactionReceipt).not.toHaveBeenCalled();
  });
});

it.each(['buy', 'sell'])('disables trading, quotes, parsing and presets for unknown pair decimals on %s', (side) => {
  test.states = [side, '10', '5', { kind: 'idle' }];
  const tree = TradePanel({ token: { ...token, pair: { ...token.pair, decimals: null } } });
  const html = renderToStaticMarkup(tree);
  expect(html).toContain('decimals are unknown');
  expect(html).not.toContain('trade-amount');
  expect(button(tree, 'Trading unavailable').props.disabled).toBe(true);
  expect(quoteBuy).not.toHaveBeenCalled();
  expect(quoteSell).not.toHaveBeenCalled();
  expect(buyPresets).not.toHaveBeenCalled();
  expect(writeContract).not.toHaveBeenCalled();
});
