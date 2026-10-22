/**
 * Local end-to-end run of formal verification: coin → submit proof → worker checks it in Docker → admin approves →
 * worker pays out on-chain. Anvil only (well-known test keys): never point this at a real chain.
 *
 *   see apps/verifier/README.md ("Running it end to end locally") for the setup, then:
 *   npx tsx --env-file=e2e.env scripts/verify-e2e.ts   (or pnpm --filter @hood/api verify:e2e with the env exported)
 *
 * Needs the API (:8787) and the verifier worker running against the same Postgres and anvil, with ADMIN_WALLETS set
 * to anvil account 0 and VERIFICATION_POOL_ADDRESS to the deployed pool.
 */
import { createPublicClient, createWalletClient, defineChain, formatEther, getAddress, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { connectPostgres, schema } from '../src/db';
import { verificationPoolAbi } from '@hood/shared';

const API = process.env.API_URL ?? 'http://127.0.0.1:8787';
const RPC = process.env.RPC_URL_SERVER ?? 'http://127.0.0.1:8545';
const POOL = process.env.VERIFICATION_POOL_ADDRESS as `0x${string}`;
const REGISTRY = process.env.RIGOR_REGISTRY_ADDRESS as `0x${string}`;
const DATABASE_URL = process.env.DATABASE_URL!;
if (!POOL || !REGISTRY || !DATABASE_URL) throw new Error('Set VERIFICATION_POOL_ADDRESS, RIGOR_REGISTRY_ADDRESS and DATABASE_URL.');
for (const [name, value] of [['RPC', RPC], ['API', API]]) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error(`Refusing to run against a non-local ${name}.`);
  }
}

// anvil's default accounts 0 (admin/owner) and 3 (the submitter)
const admin = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const user = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const chain = defineChain({ id: 4663, name: 'anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
if (await pub.getChainId() !== chain.id) throw new Error(`Local Anvil must use chain ID ${chain.id}.`);
const wallet = (account: typeof user) => createWalletClient({ account, chain, transport: http(RPC) });

// A fresh coin and proof every run, so it can be repeated against the same database.
const RUN = Date.now();
const COIN = getAddress(`0x${RUN.toString(16).padStart(40, '0')}`);
const PROOF = `import Mathlib.Tactic.NormNum\n\n-- run ${RUN}\ntheorem two_add_two : (2 : Nat) + 2 = 4 := by norm_num\n`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const step = (msg: string) => console.log(`\n▶ ${msg}`);
const must = (ok: unknown, msg: string) => {
  if (!ok) throw new Error(`FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
};

async function signIn(account: typeof user): Promise<string> {
  const { nonce } = (await (await fetch(`${API}/auth/siwe`)).json()) as { nonce: string };
  const message = createSiweMessage({ domain: 'localhost:3000', address: account.address, statement: 'Sign in to hood.exe', uri: 'http://localhost:3000', version: '1', chainId: 4663, nonce, issuedAt: new Date() });
  const res = await fetch(`${API}/auth/siwe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, signature: await account.signMessage({ message }) }) });
  if (!res.ok) throw new Error(`sign-in failed: ${await res.text()}`);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

async function api<T>(path: string, cookie: string, init: RequestInit = {}): Promise<T> {
  const headers = { cookie, ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}), ...init.headers };
  // Idle keep-alive connections get reset during the minutes the worker spends in Docker: retry reads once.
  const res = await fetch(`${API}${path}`, { ...init, headers }).catch(() => (init.method ? Promise.reject(new Error(`${path}: connection failed`)) : fetch(`${API}${path}`, { ...init, headers })));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function waitFor<T>(what: string, read: () => Promise<T>, done: (v: T) => boolean, seconds = 600): Promise<T> {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(3000);
  }
}

step('Fund the pool and add a theorem coin');
const { db, close } = await connectPostgres(DATABASE_URL);
await pub.waitForTransactionReceipt({ hash: await wallet(admin).sendTransaction({ to: POOL, value: parseEther('5') }) });
await db
  .insert(schema.tokens)
  .values({
    tokenAddress: COIN,
    curveAddress: getAddress(`0x${(RUN + 1).toString(16).padStart(40, '0')}`),
    deployer: user.address,
    pairToken: '0x0000000000000000000000000000000000000000',
    blockNumber: 1,
    launchedAt: new Date(),
    name: 'Two Plus Two',
    symbol: 'TWOS',
    logo: '',
    description: '',
    hood: true,
    statement: 'For every natural number, 2 + 2 = 4.',
    graduationThreshold: '4200000000000000000',
  })
  .onConflictDoNothing();
await close();
console.log(`  pool balance ${formatEther(await pub.getBalance({ address: POOL }))} ETH`);

step('Submit a proof (as the user)');
const userCookie = await signIn(user);
const form = new FormData();
form.append('tokenAddress', COIN);
form.append('proof', new Blob([PROOF], { type: 'text/plain' }), 'proof.lean');
const prep = await api<{ txData: { to: `0x${string}`; data: `0x${string}`; value: string }; estimatedTier: string }>('/verification/prepare', userCookie, { method: 'POST', body: form });
console.log(`  estimated tier ${prep.estimatedTier}`);
const before = await pub.getBalance({ address: user.address });
const txHash = await wallet(user).sendTransaction({ to: prep.txData.to, data: prep.txData.data, value: BigInt(prep.txData.value) });
await pub.waitForTransactionReceipt({ hash: txHash });
const confirmed = await api<{ submissions: { id: `0x${string}` }[] }>('/verification/confirm', userCookie, { method: 'POST', body: JSON.stringify({ txHash }) });
const id = confirmed.submissions[0].id;
must(id, `submission ${id.slice(0, 12)}… recorded`);

step('Worker compiles and checks it in the sandbox');
const status = () => api<{ submission: { status: string; error?: string }; theorems: unknown[] }>(`/verification/submission/${id}`, userCookie);
const passed = await waitFor('the checker', status, (s) => ['passed', 'failed'].includes(s.submission.status));
must(passed.submission.status === 'passed', `checker verdict: ${passed.submission.status}`);
must(passed.theorems.length > 0, 'kernel-checked theorem statements are shown to the reviewer');

step('Admin reviews and approves (as the admin)');
const adminCookie = await signIn(admin);
const overview = await api<{ pending?: unknown[] }>('/verification/admin/overview', adminCookie);
console.log(`  admin overview loaded (${JSON.stringify(overview).length} bytes)`);
await api('/verification/admin/review', adminCookie, { method: 'POST', body: JSON.stringify({ id, decision: 'approve', tier: 'SIMPLE', note: 'e2e' }) });

step('Worker posts the result on-chain');
const verified = await waitFor('the payout', status, (s) => ['verified', 'failed', 'rejected'].includes(s.submission.status), 180);
must(verified.submission.status === 'verified', `status: ${verified.submission.status}`);
const onchain = (await pub.readContract({ address: POOL, abi: verificationPoolAbi, functionName: 'getSubmission', args: [id] })) as unknown;
console.log(`  on-chain submission: ${JSON.stringify(onchain, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
const formal = await pub.readContract({
  address: REGISTRY,
  abi: [{ type: 'function', name: 'isFormallyVerified', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] }],
  functionName: 'isFormallyVerified',
  args: [getAddress(COIN)],
});
must(formal, 'RigorRegistry marks the coin formally verified (Σ 100)');
const after = await pub.getBalance({ address: user.address });
console.log(`  submitter balance change ${formatEther(after - before)} ETH (fee out, reward in, minus gas)`);
must(after > before, 'submitter was paid the SIMPLE reward');
console.log('\nAll good: submit → check → review → payout → registry.');
