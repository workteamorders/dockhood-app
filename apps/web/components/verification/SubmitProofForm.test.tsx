import { Children, isValidElement, type ChangeEvent, type ReactElement, type ReactNode, type SetStateAction } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareProof, type PreparedProof, type VerificationConfig } from '@/lib/api';
import { ensureSession } from '@/lib/siwe';
import { sendTransaction } from 'wagmi/actions';
import { SubmitProofForm } from './SubmitProofForm';

const hooks = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0 }));

// Follow the wallet component tests, retaining state across explicit re-renders.
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: <T,>(initial: T) => {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [hooks.states[index], (next: SetStateAction<T>) => {
      hooks.states[index] = typeof next === 'function' ? (next as (previous: T) => T)(hooks.states[index] as T) : next;
    }];
  },
}));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({}) }));
vi.mock('@/components/xp/Dialog', () => ({ Dialog: () => null }));
vi.mock('@/lib/identity', () => ({ useIdentity: () => ({ address: '0x1111111111111111111111111111111111111111', connected: true }) }));
vi.mock('@/lib/siwe', () => ({ ensureSession: vi.fn() }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('@/lib/wagmi', () => ({ chain: { id: 46630 }, wagmiConfig: {}, ensureRpcNetwork: vi.fn() }));
vi.mock('wagmi/actions', () => ({
  getAccount: vi.fn(), switchChain: vi.fn(), sendTransaction: vi.fn(), waitForTransactionReceipt: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  fetchToken: vi.fn(), fetchTokens: vi.fn(), prepareProof: vi.fn(), confirmProofSubmission: vi.fn(),
}));

const first = { token: '0x1111111111111111111111111111111111111111', symbol: 'FIRST', statement: null, formal: false };
const second = { ...first, token: '0x2222222222222222222222222222222222222222', symbol: 'SECOND' };
const config: VerificationConfig = {
  enabled: true, admin: false, poolAddress: first.token, submissionFeeWei: '1', maxPerWeek: 10, maxProofBytes: 1024 * 1024,
  rewardsEth: { TRIVIAL: '0', SIMPLE: '0', MEDIUM: '0', HARD: '0', OPEN: '0' },
};
const prepared: PreparedProof = {
  ipfsCid: 'proof', proofHash: 'hash', submissionFee: '2', estimatedTier: 'TRIVIAL',
  txData: { to: first.token, data: '0x', value: '2' },
};
type Props = {
  children?: ReactNode; footer?: ReactNode; type?: string; disabled?: boolean;
  onClick?: () => void; onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
  onPick?: (coin: typeof first) => void;
};
function elements(node: ReactNode): ReactElement<Props>[] {
  return Children.toArray(node).flatMap((child) => isValidElement<Props>(child)
    ? [child, ...elements(child.props.children), ...elements(child.props.footer)] : []);
}
function render() {
  hooks.cursor = 0;
  return SubmitProofForm({ config, onClose: vi.fn(), onSubmitted: vi.fn() });
}
function button(label: string) {
  const found = elements(render()).find((node) => node.props.onClick &&
    renderToStaticMarkup(<>{node.props.children}</>).includes(label));
  if (!found) throw new Error(`Button not found: ${label}`);
  return found.props;
}
function upload() {
  return elements(render()).find((node) => node.type === 'input' && node.props.type === 'file')!.props;
}
function pick(coin: typeof first) {
  elements(render()).find((node) => node.props.onPick)!.props.onPick!(coin);
}
async function choose(file: File | null) {
  await upload().onChange!({ target: { files: file ? [file] : [] } } as unknown as ChangeEvent<HTMLInputElement>);
  // The input handler deliberately does not return choose()'s promise.
  await Promise.resolve();
}
async function ready() {
  pick(first);
  const file = new File(['theorem proof : True := by trivial'], 'proof.lean');
  await choose(file);
  expect(button('Check &amp; prepare').disabled).toBe(false);
  button('Check &amp; prepare').onClick!();
  await vi.waitFor(() => expect(button('Submit (').disabled).toBe(false));
  return file;
}

beforeEach(() => {
  hooks.states = [];
  hooks.cursor = 0;
  vi.clearAllMocks();
  vi.mocked(prepareProof).mockResolvedValue(prepared);
});

describe('proof input invalidation', () => {
  it('clears prepared data immediately on coin change and prepares the newly picked coin', async () => {
    const file = await ready();
    button('change').onClick!();
    expect(button('Check &amp; prepare').disabled).toBe(true);
    expect(renderToStaticMarkup(<>{elements(render())[0].props.footer}</>)).not.toContain('Submit (');
    pick(second);
    expect(renderToStaticMarkup(render().props.children)).toContain('$SECOND');
    expect(button('Check &amp; prepare').disabled).toBe(false);
    button('Check &amp; prepare').onClick!();
    await vi.waitFor(() => expect(prepareProof).toHaveBeenLastCalledWith(second.token, file));
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it.each(['replacement', 'cleared', 'oversized'])('invalidates a prepared transaction when the file is %s', async (kind) => {
    await ready();
    const next = kind === 'cleared' ? null : new File([
      kind === 'oversized' ? 'x'.repeat(config.maxProofBytes + 1) : 'theorem replacement : True := by trivial',
    ], 'replacement.lean');
    await choose(next);
    expect(button('Check &amp; prepare').disabled).toBe(kind !== 'replacement');
    expect(renderToStaticMarkup(<>{elements(render())[0].props.footer}</>)).not.toContain('Submit (');
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('blocks oversized files until a valid file is selected, including in the prepare handler', async () => {
    pick(first);
    await choose(new File(['x'.repeat(config.maxProofBytes + 1)], 'large.lean'));
    expect(renderToStaticMarkup(render().props.children)).toContain('The proof file must be 1 MB or less.');
    expect(button('Check &amp; prepare').disabled).toBe(true);
    button('Check &amp; prepare').onClick!();
    await Promise.resolve();
    expect(ensureSession).not.toHaveBeenCalled();
    expect(prepareProof).not.toHaveBeenCalled();
    await choose(new File(['theorem proof : True := by trivial'.padEnd(config.maxProofBytes)], 'valid.lean'));
    await vi.waitFor(() => expect(button('Check &amp; prepare').disabled).toBe(false));
    expect(renderToStaticMarkup(render().props.children)).not.toContain('The proof file must be');
  });

  it('locks coin and file inputs while preparation is in flight', async () => {
    let finish!: (value: PreparedProof) => void;
    vi.mocked(prepareProof).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    pick(first);
    await choose(new File(['theorem proof : True := by trivial'], 'proof.lean'));
    button('Check &amp; prepare').onClick!();
    await vi.waitFor(() => expect(prepareProof).toHaveBeenCalledOnce());
    expect(button('change').disabled).toBe(true);
    expect(upload().disabled).toBe(true);
    finish(prepared);
    await vi.waitFor(() => expect(button('Submit (').disabled).toBe(false));
    expect(button('change').disabled).toBe(false);
    expect(upload().disabled).toBe(false);
  });
});
