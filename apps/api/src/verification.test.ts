import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { decodeFunctionData, type Hash, type Hex } from 'viem';
import { NATIVE_PAIR, verificationPoolAbi, type Tier } from '@hood/shared';
import { schema } from './db';
import type { LeanResult, LeanRunner } from './services/leanRunner';
import { PoolRevert, type PoolReader, type PoolStatus, type PoolSubmission, type PoolWriter } from './services/poolChain';
import { CALLOUTS_CHANNEL } from './services/pubsub';
import { alice, bob, multipart, setup, signIn } from './test/helpers';
import { postResults, processQueue, requeueStale, scanChain } from './verification/worker';

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;
let chain: ReturnType<typeof fakeChain>;

const POOL = '0x00000000000000000000000000000000000000aa';
const COIN = '0x00000000000000000000000000000000000000c1';
const PLAIN = '0x00000000000000000000000000000000000000c2';
const PROOF = 'import Mathlib\n\ntheorem two_add_two : (2 : ℕ) + 2 = 4 := by norm_num\n';

/** A VerificationPool stand-in: submissions land as Submitted events in "mined" transactions. */
function fakeChain() {
  const txs = new Map<Hash, PoolSubmission[]>();
  const status = new Map<string, PoolStatus>();
  const calls: { fn: 'markVerified' | 'markFailed'; id: Hex; arg: string }[] = [];
  let block = 1_000n;
  let depleted = false;
  const reader: PoolReader = {
    address: POOL,
    submissionsFromTx: async (hash) => txs.get(hash) ?? 'pending',
    submissionsBetween: async (from, to) => [...txs.values()].flat().filter((s) => s.blockNumber >= from && s.blockNumber <= to),
    head: async () => block,
    status: async (id) => status.get(id) ?? 'None',
    rewardWei: async (tier: Tier) => ({ TRIVIAL: 10n ** 16n, SIMPLE: 5n * 10n ** 16n, MEDIUM: 25n * 10n ** 16n, HARD: 10n ** 18n, OPEN: 10n ** 19n })[tier],
    submissionFee: async () => 10n ** 16n,
    balances: async () => ({ balance: 3n * 10n ** 18n, available: 2n * 10n ** 18n }),
  };
  const writer: PoolWriter = {
    bot: '0x00000000000000000000000000000000000000b0',
    async markVerified(id, tier) {
      if (status.get(id) !== 'Pending') throw new PoolRevert('NotPending');
      if (depleted) throw new PoolRevert('PoolDepleted');
      calls.push({ fn: 'markVerified', id, arg: tier });
      status.set(id, 'Verified');
      return `0x${'ee'.repeat(32)}`;
    },
    async markFailed(id, reason) {
      if (status.get(id) !== 'Pending') throw new PoolRevert('NotPending');
      calls.push({ fn: 'markFailed', id, arg: reason });
      status.set(id, 'Failed');
      return `0x${'ff'.repeat(32)}`;
    },
  };
  return {
    reader,
    writer,
    calls,
    setDepleted: (d: boolean) => void (depleted = d),
    setStatus: (id: Hex, s: PoolStatus) => void status.set(id, s),
    /** The wallet sends the prepared transaction; returns its hash once "mined". */
    submit(from: string, txData: { data: Hex }, n: number): Hash {
      const { args } = decodeFunctionData({ abi: verificationPoolAbi, data: txData.data });
      const [token, proofHash, ipfsCid] = args as [Hex, Hex, string];
      const id = `0x${n.toString(16).padStart(64, '0')}` as Hex;
      const hash = `0x${(n + 1000).toString(16).padStart(64, '0')}` as Hash;
      block += 1n;
      txs.set(hash, [{ id, submitter: from as Hex, token, proofHash, ipfsCid, submittedAt: ctx.now(), txHash: hash, blockNumber: block }]);
      status.set(id, 'Pending');
      return hash;
    },
  };
}

function runnerReturning(result: Partial<LeanResult> & Pick<LeanResult, 'status'>): LeanRunner & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    async verify(source) {
      seen.push(source);
      return { verdict: null, errorSummary: null, compileMs: 90_000, ...result };
    },
  };
}
const PASS = runnerReturning({
  status: 'passed',
  verdict: { ok: true, theorems: [{ name: 'two_add_two', statement: '2 + 2 = 4', axioms: ['propext'], ok: true }] },
});

async function coin(address: string, symbol: string, hood = true) {
  await ctx.db.insert(schema.tokens).values({
    tokenAddress: address,
    curveAddress: `0x${'d'.repeat(38)}${symbol.length}${symbol.length}`,
    deployer: alice.address,
    pairToken: NATIVE_PAIR,
    blockNumber: 1,
    launchedAt: ctx.now(),
    name: symbol,
    symbol,
    logo: '',
    description: '',
    hood,
    statement: hood ? 'For every natural number, 2 + 2 = 4.' : null,
    graduationThreshold: '4200000000000000000',
  });
}

const ENV = { VERIFICATION_SUBMISSIONS_ENABLED: 'true', ADMIN_WALLETS: bob.address };

beforeEach(async () => {
  PASS.seen.length = 0;
  chain = fakeChain();
  ctx = await setup({ pool: chain.reader, env: ENV });
  await coin(COIN, 'TWOS');
  await coin(PLAIN, 'MEME', false);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await ctx.close();
});

async function prepare(cookie: string, source = PROOF, token = COIN) {
  const { payload, headers } = await multipart({ tokenAddress: token, proof: new Blob([source], { type: 'text/plain' }) });
  return ctx.app.inject({ method: 'POST', url: '/verification/prepare', headers: { ...headers, cookie }, payload });
}

/** Prepare, "send" the transaction, confirm it: the web app's whole submit flow. */
async function submitProof(cookie: string, from: string, n: number, source = PROOF) {
  const res = await prepare(cookie, source);
  expect(res.statusCode).toBe(200);
  const hash = chain.submit(from, res.json().txData, n);
  const confirm = await ctx.app.inject({ method: 'POST', url: '/verification/confirm', payload: { txHash: hash } });
  expect(confirm.statusCode).toBe(200);
  return confirm.json().submissions[0].id as Hex;
}

const worker = (runner: LeanRunner = PASS) => ({ db: ctx.db, pool: chain.reader, writer: chain.writer, runner, pubsub: ctx.pubsub, concurrency: 2, now: ctx.now });
const row = async (id: string) => (await ctx.db.select().from(schema.verificationSubmissions).where(eq(schema.verificationSubmissions.id, id)))[0];

describe('formal verification: submit', () => {
  it('pins the proof and returns the submit transaction for the wallet', async () => {
    const a = await signIn(ctx, alice);
    const res = await prepare(a);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ submissionFee: '10000000000000000', txData: { to: POOL, value: '10000000000000000' } });
    expect(body.proofHash).toMatch(/^0x[0-9a-f]{64}$/);
    const { functionName, args } = decodeFunctionData({ abi: verificationPoolAbi, data: body.txData.data });
    expect(functionName).toBe('submit');
    expect(args).toEqual([expect.stringMatching(/^0x0+c1$/i), body.proofHash, body.ipfsCid]);
  });

  it('turns away a closed queue, other coins, unsafe proofs and repeats', async () => {
    const a = await signIn(ctx, alice);
    expect((await prepare(a, PROOF, PLAIN)).statusCode).toBe(400);
    const sorry = await prepare(a, 'theorem t : 1 = 2 := by sorry');
    expect(sorry.statusCode).toBe(422);
    expect(sorry.json().error).toMatch(/line 1 leaves the proof unfinished/);
    expect((await prepare(a, '#eval IO.println "hi"\ntheorem t : True := trivial')).json().error).toMatch(/runs code while compiling/);

    await submitProof(a, alice.address, 1);
    expect((await prepare(a)).statusCode).toBe(409); // the same proof for the same coin

    await ctx.close();
    ctx = await setup({ pool: chain.reader }); // VERIFICATION_SUBMISSIONS_ENABLED unset: closed
    await coin(COIN, 'TWOS');
    expect((await prepare(await signIn(ctx, alice))).statusCode).toBe(503);
  });

  it('confirms a submission once, and waits for a transaction still pending', async () => {
    const a = await signIn(ctx, alice);
    const id = await submitProof(a, alice.address, 1);
    expect((await row(id)).status).toBe('queued');
    const pending = await ctx.app.inject({ method: 'POST', url: '/verification/confirm', payload: { txHash: `0x${'12'.repeat(32)}` } });
    expect(pending.statusCode).toBe(202);
    // The worker's chain scan finds the same submission and doesn't add it again.
    expect(await scanChain({ db: ctx.db, pool: chain.reader })).toBe(1);
    expect(await ctx.db.select().from(schema.verificationSubmissions)).toHaveLength(1);
  });

  it('rejects invalid UTF-8 as a client error without pinning or storing it', async () => {
    const a = await signIn(ctx, alice);
    const { payload, headers } = await multipart({ tokenAddress: COIN, proof: new Blob([new Uint8Array([0xc3, 0x28])]) });
    const res = await ctx.app.inject({ method: 'POST', url: '/verification/prepare', headers: { ...headers, cookie: a }, payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/UTF-8/);
    expect(ctx.pinner.files.size).toBe(0);
    expect(await ctx.db.select().from(schema.verificationProofs)).toEqual([]);
  });

  it('refuses production proof uploads without Pinata, even when submissions are enabled', async () => {
    const a = await signIn(ctx, alice);
    ctx.app.deps.env.NODE_ENV = 'production';
    ctx.app.deps.env.STAND_INS = 'allow';
    expect((await prepare(a)).statusCode).toBe(503);
    expect(ctx.pinner.files.size).toBe(0);
    expect(await ctx.db.select().from(schema.verificationProofs)).toEqual([]);
  });

  it('allows production proof uploads with configured storage', async () => {
    const a = await signIn(ctx, alice);
    ctx.app.deps.env.NODE_ENV = 'production';
    ctx.app.deps.env.PINATA_JWT = 'test-storage-configuration';
    expect((await prepare(a)).statusCode).toBe(200);
    expect(ctx.pinner.files.size).toBe(1);
    expect(await ctx.db.select().from(schema.verificationProofs)).toHaveLength(1);
  });

  it('keeps to the weekly limit before anyone pays a fee', async () => {
    const a = await signIn(ctx, alice);
    for (let i = 1; i <= 3; i++) await submitProof(a, alice.address, i, `${PROOF}-- ${i}\n`);
    const res = await prepare(a, `${PROOF}-- 4\n`);
    expect(res.statusCode).toBe(429);
  });
});

describe('formal verification: the worker and the review', () => {
  it('passes a proof, and only pays once the admin approves its tier', async () => {
    const a = await signIn(ctx, alice);
    const id = await submitProof(a, alice.address, 1);
    expect(await processQueue(worker())).toBe(1);
    expect(PASS.seen).toEqual([PROOF]);
    expect(await row(id)).toMatchObject({ status: 'passed', suggestedTier: 'SIMPLE', compileMs: 90_000 });

    // Nothing goes on-chain for a pass on its own.
    expect(await postResults(worker())).toBe(0);
    expect(chain.calls).toEqual([]);

    // Only an admin may review.
    expect((await ctx.app.inject({ method: 'POST', url: '/verification/admin/review', headers: { cookie: a }, payload: { id, decision: 'approve', tier: 'OPEN' } })).statusCode).toBe(403);
    const b = await signIn(ctx, bob);
    const overview = (await ctx.app.inject({ method: 'GET', url: '/verification/admin/overview', headers: { cookie: b } })).json();
    expect(overview.review).toHaveLength(1);
    expect(overview.review[0]).toMatchObject({ id, ticker: 'TWOS', coinStatement: 'For every natural number, 2 + 2 = 4.', theorems: [{ name: 'two_add_two' }], proof: PROOF });
    const approve = await ctx.app.inject({ method: 'POST', url: '/verification/admin/review', headers: { cookie: b }, payload: { id, decision: 'approve', tier: 'MEDIUM' } });
    expect(approve.json()).toEqual({ status: 'approved', tier: 'MEDIUM' });

    const seen: { type: string; callout: { text: string } }[] = [];
    await ctx.pubsub.subscribe(CALLOUTS_CHANNEL, (m) => seen.push(m as (typeof seen)[number]));
    expect(await postResults(worker())).toBe(1);
    expect(chain.calls).toEqual([{ fn: 'markVerified', id, arg: 'MEDIUM' }]);
    expect(await row(id)).toMatchObject({ status: 'verified', tier: 'MEDIUM', rewardWei: '250000000000000000', adminTierOverride: true, reviewedBy: bob.address });
    const [token] = await ctx.db.select().from(schema.tokens).where(eq(schema.tokens.tokenAddress, COIN));
    expect(token.formal).toBe(true);
    expect(seen.map((m) => m.callout.text)).toEqual(['🧮 $TWOS just got FORMAL ✓ — Σ 100 (+0.25 ETH)']);

    // The coin's Formal Proof tab and the hall of fame.
    const tab = (await ctx.app.inject({ method: 'GET', url: `/verification/token/${COIN}` })).json();
    expect(tab.verified).toMatchObject({ id, tier: 'MEDIUM', proof: PROOF, theorems: [{ name: 'two_add_two' }] });
    const fame = (await ctx.app.inject({ method: 'GET', url: '/verification/queue?tab=verified' })).json();
    expect(fame.items.map((i: { ticker: string }) => i.ticker)).toEqual(['TWOS']);
    // A verified coin takes no more proofs.
    expect((await prepare(a, `${PROOF}-- again\n`)).statusCode).toBe(409);
  });

  it('approves one proof per coin: a copy with a comment changed is not paid again', async () => {
    const a = await signIn(ctx, alice);
    const b = await signIn(ctx, bob);
    const first = await submitProof(a, alice.address, 1);
    const copy = await submitProof(b, bob.address, 2, `${PROOF}-- mine now\n`);
    expect(await processQueue(worker())).toBe(2);
    const review = (id: string) => ctx.app.inject({ method: 'POST', url: '/verification/admin/review', headers: { cookie: b }, payload: { id, decision: 'approve', tier: 'SIMPLE' } });
    expect((await review(first)).statusCode).toBe(200);
    expect((await review(copy)).statusCode).toBe(409);
    const reject = await ctx.app.inject({ method: 'POST', url: '/verification/admin/review', headers: { cookie: b }, payload: { id: copy, decision: 'reject', note: 'copy' } });
    expect(reject.json()).toMatchObject({ status: 'rejected' });
  });

  it('serializes concurrent approvals for the same coin regardless of address casing', async () => {
    const a = await signIn(ctx, alice);
    const b = await signIn(ctx, bob);
    const first = await submitProof(a, alice.address, 1);
    const copy = await submitProof(b, bob.address, 2, `${PROOF}-- copy\n`);
    await processQueue(worker());
    await ctx.db.update(schema.verificationSubmissions).set({ tokenAddress: `0x${COIN.slice(2).toUpperCase()}` }).where(eq(schema.verificationSubmissions.id, copy));
    const results = await Promise.all([first, copy].map((id) => ctx.app.inject({ method: 'POST', url: '/verification/admin/review', headers: { cookie: b }, payload: { id, decision: 'approve', tier: 'SIMPLE' } })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const rows = await ctx.db.select().from(schema.verificationSubmissions);
    expect(rows.filter((r) => r.status === 'approved')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'passed')).toHaveLength(1);
    expect(await postResults(worker())).toBe(1);
    expect(chain.calls).toHaveLength(1);
  });

  it('records a failed proof on-chain with its reason, and shows it to the submitter only', async () => {
    const a = await signIn(ctx, alice);
    const id = await submitProof(a, alice.address, 1);
    await processQueue(worker(runnerReturning({ status: 'failed', errorSummary: "error: unknown identifier 'foo'" })));
    expect(await row(id)).toMatchObject({ status: 'failed', errorSummary: "error: unknown identifier 'foo'" });
    expect(await postResults(worker())).toBe(1);
    expect(chain.calls).toEqual([{ fn: 'markFailed', id, arg: "error: unknown identifier 'foo'" }]);
    expect(await postResults(worker())).toBe(0); // once
    const mine = (await ctx.app.inject({ method: 'GET', url: '/verification/queue?tab=mine', headers: { cookie: a } })).json();
    expect(mine.items[0]).toMatchObject({ status: 'failed', errorSummary: "error: unknown identifier 'foo'" });
    expect((await ctx.app.inject({ method: 'GET', url: '/verification/queue?tab=mine' })).statusCode).toBe(401);
  });

  it('marks a rejected proof failed on-chain with the reviewer\'s reason', async () => {
    const a = await signIn(ctx, alice);
    const b = await signIn(ctx, bob);
    const id = await submitProof(a, alice.address, 1);
    await processQueue(worker());
    await ctx.app.inject({ method: 'POST', url: '/verification/admin/review', headers: { cookie: b }, payload: { id, decision: 'reject', note: 'proves 2 + 2 = 4, not the coin\'s theorem' } });
    await postResults(worker());
    expect(chain.calls).toEqual([{ fn: 'markFailed', id, arg: "Review: proves 2 + 2 = 4, not the coin's theorem" }]);
    expect((await row(id)).status).toBe('rejected');
  });

  it('keeps an approval waiting while the pool is short, then pays when it is topped up', async () => {
    const a = await signIn(ctx, alice);
    const b = await signIn(ctx, bob);
    const id = await submitProof(a, alice.address, 1);
    await processQueue(worker());
    await ctx.app.inject({ method: 'POST', url: '/verification/admin/review', headers: { cookie: b }, payload: { id, decision: 'approve', tier: 'HARD' } });
    chain.setDepleted(true);
    await postResults(worker());
    expect(await row(id)).toMatchObject({ status: 'approved', lastError: 'Waiting for the reward pool to be topped up.', attempts: 1 });
    chain.setDepleted(false);
    await postResults(worker());
    expect((await row(id)).status).toBe('verified');
  });

  it('reconciles an on-chain success whose receipt was lost without reposting or inventing a payout', async () => {
    const a = await signIn(ctx, alice);
    const id = await submitProof(a, alice.address, 1);
    await processQueue(worker());
    await ctx.db.update(schema.verificationSubmissions).set({ status: 'approved', tier: 'SIMPLE' }).where(eq(schema.verificationSubmissions.id, id));
    const markVerified = chain.writer.markVerified.bind(chain.writer);
    vi.spyOn(chain.writer, 'markVerified').mockImplementationOnce(async (id, tier) => {
      await markVerified(id, tier);
      throw new Error('Worker lost the receipt after the transaction mined.');
    });
    expect(await postResults(worker())).toBe(0);
    expect(await chain.reader.status(id)).toBe('Verified');
    const reward = vi.spyOn(chain.reader, 'rewardWei');
    ctx.advance(60_000);
    expect(await postResults(worker())).toBe(0);
    expect(await postResults(worker())).toBe(0);
    expect(reward).not.toHaveBeenCalled();
    expect(chain.calls).toEqual([{ fn: 'markVerified', id, arg: 'SIMPLE' }]);
    expect(await row(id)).toMatchObject({ status: 'verified', rewardWei: null, verifiedAt: ctx.now(), txHashResult: null, attempts: 2, lastError: expect.stringMatching(/Reconciled Verified.*manual reconciliation/) });
    expect((await ctx.db.select().from(schema.tokens).where(eq(schema.tokens.tokenAddress, COIN)))[0]).toMatchObject({ formal: true, formalAt: ctx.now() });
    expect(await ctx.db.select().from(schema.callouts)).toEqual([]);
    const tab = (await ctx.app.inject({ method: 'GET', url: `/verification/token/${COIN}` })).json();
    expect(tab).toMatchObject({ pending: 0, verified: { id, rewardWei: null, txHashResult: null } });
    expect((await prepare(a, `${PROOF}-- another\n`)).statusCode).toBe(409);
  });

  it('rolls back all DB settlement changes if the settlement transaction fails', async () => {
    const a = await signIn(ctx, alice);
    const id = await submitProof(a, alice.address, 1);
    await processQueue(worker());
    await ctx.db.update(schema.verificationSubmissions).set({ status: 'approved', tier: 'SIMPLE' }).where(eq(schema.verificationSubmissions.id, id));
    const transaction = ctx.db.transaction.bind(ctx.db);
    vi.spyOn(ctx.db, 'transaction').mockImplementationOnce((fn) => transaction(async (tx) => {
      await fn(tx);
      throw new Error('Connection lost before commit.');
    }));
    expect(await postResults(worker())).toBe(0);
    expect(await row(id)).toMatchObject({ status: 'approved', rewardWei: null, txHashResult: null, verifiedAt: null });
    expect((await ctx.db.select().from(schema.tokens).where(eq(schema.tokens.tokenAddress, COIN)))[0].formal).toBe(false);
    expect(await ctx.db.select().from(schema.callouts)).toEqual([]);
    expect(await postResults(worker())).toBe(0);
    expect(await row(id)).toMatchObject({ status: 'verified', rewardWei: null, txHashResult: null, lastError: expect.stringMatching(/manual reconciliation/) });
    expect((await ctx.db.select().from(schema.tokens).where(eq(schema.tokens.tokenAddress, COIN)))[0].formal).toBe(true);
    expect(await ctx.db.select().from(schema.callouts)).toEqual([]);
    expect(chain.calls).toHaveLength(1);
  });

  it('retries an atomic reconciliation after a DB rollback without paying again', async () => {
    const a = await signIn(ctx, alice);
    const id = await submitProof(a, alice.address, 1);
    await processQueue(worker());
    await ctx.db.update(schema.verificationSubmissions).set({ status: 'approved', tier: 'SIMPLE' }).where(eq(schema.verificationSubmissions.id, id));
    chain.setStatus(id, 'Verified');
    const transaction = ctx.db.transaction.bind(ctx.db);
    vi.spyOn(ctx.db, 'transaction').mockImplementationOnce((fn) => transaction(async (tx) => {
      await fn(tx);
      throw new Error('Connection lost before reconciliation commit.');
    }));
    expect(await postResults(worker())).toBe(0);
    expect(await row(id)).toMatchObject({ status: 'approved', verifiedAt: null, rewardWei: null, txHashResult: null });
    expect((await ctx.db.select().from(schema.tokens).where(eq(schema.tokens.tokenAddress, COIN)))[0].formal).toBe(false);
    expect(await postResults(worker())).toBe(0);
    expect(await row(id)).toMatchObject({ status: 'verified', verifiedAt: ctx.now(), rewardWei: null, txHashResult: null });
    expect((await ctx.db.select().from(schema.tokens).where(eq(schema.tokens.tokenAddress, COIN)))[0].formal).toBe(true);
    expect(await ctx.db.select().from(schema.callouts)).toEqual([]);
    expect(chain.calls).toEqual([]);
  });

  it.each(['Failed', 'Refunded'] as const)('settles an approved proof already %s on-chain without claiming a reward', async (status) => {
    const a = await signIn(ctx, alice);
    const id = await submitProof(a, alice.address, 1);
    await ctx.db.update(schema.verificationSubmissions).set({ status: 'approved', tier: 'SIMPLE' }).where(eq(schema.verificationSubmissions.id, id));
    chain.setStatus(id, status);
    expect(await postResults(worker())).toBe(0);
    expect(await row(id)).toMatchObject({ status: 'failed', txHashResult: 'none', rewardWei: null, verifiedAt: null, lastError: null, errorSummary: expect.stringContaining(status.toLowerCase()) });
    expect(await postResults(worker())).toBe(0);
    expect(chain.calls).toEqual([]);
  });

  it.each(['failed', 'rejected', 'approved'] as const)('does not treat a missing on-chain submission as a settled %s result', async (status) => {
    const a = await signIn(ctx, alice);
    const id = await submitProof(a, alice.address, 1);
    await ctx.db.update(schema.verificationSubmissions).set({ status, tier: status === 'approved' ? 'SIMPLE' : null }).where(eq(schema.verificationSubmissions.id, id));
    chain.setStatus(id, 'None');
    expect(await postResults(worker())).toBe(0);
    expect(await row(id)).toMatchObject({ status, txHashResult: null, rewardWei: null, verifiedAt: null, lastError: expect.stringContaining('found None') });
    expect(chain.calls).toEqual([]);
  });

  it.each(['failed', 'rejected'] as const)('flags an unexpected Verified result for a %s proof instead of accepting it', async (status) => {
    const a = await signIn(ctx, alice);
    const id = await submitProof(a, alice.address, 1);
    await ctx.db.update(schema.verificationSubmissions).set({ status }).where(eq(schema.verificationSubmissions.id, id));
    chain.setStatus(id, 'Verified');
    expect(await postResults(worker())).toBe(0);
    expect(await row(id)).toMatchObject({ status, txHashResult: null, rewardWei: null, verifiedAt: null, lastError: expect.stringContaining('found Verified') });
    expect(chain.calls).toEqual([]);
  });

  it('recognizes an already-failed on-chain result without posting it twice', async () => {
    const a = await signIn(ctx, alice);
    const id = await submitProof(a, alice.address, 1);
    await processQueue(worker(runnerReturning({ status: 'failed', errorSummary: 'nope' })));
    chain.setStatus(id, 'Failed');
    expect(await postResults(worker())).toBe(0);
    expect(await row(id)).toMatchObject({ status: 'failed', txHashResult: 'none', lastError: null });
    expect(chain.calls).toEqual([]);
  });

  it('puts a proof back in the queue when the sandbox itself fails, and after a crash', async () => {
    const a = await signIn(ctx, alice);
    const id = await submitProof(a, alice.address, 1);
    const broken: LeanRunner = { verify: async () => Promise.reject(new (await import('./services/leanRunner')).RunnerError('docker: not running')) };
    await processQueue(worker(broken));
    expect(await row(id)).toMatchObject({ status: 'queued', lastError: 'docker: not running' });
    await ctx.db.update(schema.verificationSubmissions).set({ status: 'compiling' }).where(eq(schema.verificationSubmissions.id, id));
    expect(await requeueStale(ctx.db)).toBe(1);
  });

  it('skips posting for a submission the owner already refunded', async () => {
    const a = await signIn(ctx, alice);
    const id = await submitProof(a, alice.address, 1);
    await processQueue(worker(runnerReturning({ status: 'failed', errorSummary: 'nope' })));
    // Refunded on-chain by the owner before the worker posted the failure.
    chain.setStatus(id, 'Refunded');
    await postResults(worker());
    expect(chain.calls).toEqual([]);
    expect((await row(id)).txHashResult).toBe('none');
  });

  it('shows the public queue with positions and wait estimates', async () => {
    const a = await signIn(ctx, alice);
    await submitProof(a, alice.address, 1, `${PROOF}-- a\n`);
    await submitProof(a, alice.address, 2, `${PROOF}-- b\n`);
    await submitProof(a, alice.address, 3, `${PROOF}-- c\n`);
    const q = (await ctx.app.inject({ method: 'GET', url: '/verification/queue?tab=public' })).json();
    expect(q.items.map((i: { position: number; estimatedWaitSec: number }) => [i.position, i.estimatedWaitSec])).toEqual([
      [1, 900],
      [2, 900],
      [3, 1800],
    ]);
    expect(q.items[0].errorSummary).toBeNull();
  });

  it('lets an admin pause submissions', async () => {
    const a = await signIn(ctx, alice);
    const b = await signIn(ctx, bob);
    expect((await ctx.app.inject({ method: 'POST', url: '/verification/admin/pause', headers: { cookie: a }, payload: { paused: true } })).statusCode).toBe(403);
    await ctx.app.inject({ method: 'POST', url: '/verification/admin/pause', headers: { cookie: b }, payload: { paused: true } });
    expect((await prepare(a)).statusCode).toBe(503);
    expect((await ctx.app.inject({ method: 'GET', url: '/verification/config' })).json().enabled).toBe(false);
  });
});
