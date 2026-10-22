/** Local-only orchestration. No dotenv, public RPC, public wallet, or existing application database inputs. */
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, formatEther, getAddress, http, parseEther, toHex, type Abi, type Address, type Hex, type TransactionReceipt } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { connectPostgres, schema } from '../src/db';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const apiDir = join(root, 'apps/api');
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`;
const output = join(root, '.testnet/local-verification', runId);
const workDir = join(root, '.testnet/sandbox', runId);
const RPC = 'http://127.0.0.1:18546';
const API = 'http://localhost:18787';
const database = `hood_verification_e2e_${Date.now()}_${randomBytes(4).toString('hex')}`;
const databaseUrl = `postgres://hood:hood@127.0.0.1:54321/${database}`;
const image = 'hoodexe/verifier:latest';
const chain = defineChain({ id: 4663, name: 'owned-local-anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 5_000, retryCount: 0 }), cacheTime: 0 });
// Deliberately allowlist OS/Docker plumbing, never application env or NODE_OPTIONS/ENV_FILE secrets.
const osEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'COLIMA_HOME'].flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []));
const secrets: string[] = [];
const sanitize = (text: string) => secrets.reduce((s, secret) => s.replaceAll(secret, '[REDACTED]'), text)
  .replace(/test(?: test){10} junk/g, '[REDACTED LOCAL MNEMONIC]')
  .replace(/(postgres(?:ql)?:\/\/[^:/\s]+:)[^@\s]+@/g, '$1[REDACTED]@');
const json = (value: unknown) => sanitize(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
const report: Record<string, unknown> = { runId, scope: 'LOCAL ONLY: synthetic theorem coin; proof pipeline, not a real Pons launch', rpc: RPC, api: API, chainId: chain.id, database, workDir, publicFundingWei: '0', startedAt: new Date().toISOString() };
const children: { name: string; child: ChildProcess; done: Promise<void>; code?: number | null; signal?: string | null }[] = [];
const receipts: { step: string; receipt: TransactionReceipt }[] = [];
const sandboxes = new Map<string, Record<string, unknown>>();
let anvil: ChildProcess | undefined;
let closing = false;
let aborted: string | undefined;
let monitor: Promise<void> | undefined;
let closeDb: (() => Promise<void>) | undefined;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function local(url: string) {
  const parsed = new URL(url);
  assert.ok(['http:', 'postgres:'].includes(parsed.protocol) && ['127.0.0.1', 'localhost'].includes(parsed.hostname), 'Nonloopback endpoint refused');
  if (parsed.protocol === 'http:') assert.ok(!parsed.username && !parsed.password, 'RPC/API credentials refused');
}

function start(name: string, command: string, args: string[], env = osEnv, quiet = false) {
  const child = spawn(command, args, { cwd: apiDir, env, detached: true, stdio: ['ignore', quiet ? 'ignore' : 'pipe', quiet ? 'ignore' : 'pipe'] });
  const entry = { name, child, done: Promise.resolve(), code: undefined as number | null | undefined, signal: undefined as string | null | undefined };
  entry.done = new Promise<void>((resolve) => {
    child.once('error', () => { aborted = `${name} could not start`; resolve(); });
    child.once('close', (code, signal) => {
      entry.code = code;
      entry.signal = signal;
      if (!closing && name !== 'e2e') {
        aborted = `${name} exited unexpectedly (${code ?? signal})`;
        // A signing child must not outlive its owned local chain.
        for (const other of children) if (other.child !== child && other.child.exitCode === null && other.child.signalCode === null) other.child.kill('SIGTERM');
      }
      resolve();
    });
  });
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on('line', (line) => {
      const clean = sanitize(line);
      appendFileSync(join(output, `${name}.log`), `${clean}\n`, { mode: 0o600 });
      if (name !== 'api') console.log(`[${name}] ${clean}`);
    });
  }
  children.push(entry);
  return entry;
}

async function waitFor(label: string, test: () => Promise<boolean>, timeout = 30_000) {
  const until = Date.now() + timeout;
  do {
    assert.ok(!aborted, aborted);
    if (await test().catch(() => false)) return;
    await sleep(300);
  } while (Date.now() < until);
  throw new Error(`Timed out: ${label}`);
}

async function rpc(method: string) {
  local(RPC);
  const response = await fetch(RPC, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }) });
  const body = await response.json() as { result?: unknown; error?: unknown };
  assert.ok(response.ok && !body.error, `Local RPC method ${method} failed`);
  return body.result;
}

async function guard() {
  local(RPC);
  local(API);
  local(databaseUrl);
  assert.ok(!aborted, aborted);
  assert.ok(anvil?.pid && anvil.exitCode === null && anvil.signalCode === null, 'Owned Anvil child must be alive before any key usage');
  const listeners = await exec('/usr/sbin/lsof', ['-nP', '-iTCP:18546', '-sTCP:LISTEN', '-Fp'], { env: osEnv });
  assert.deepEqual(listeners.stdout.trim().split('\n').filter((s) => s.startsWith('p')), [`p${anvil.pid}`], 'RPC listener must be our child');
  const api = children.find((entry) => entry.name === 'api');
  if (api) {
    const listeners = await exec('/usr/sbin/lsof', ['-nP', '-iTCP:18787', '-sTCP:LISTEN', '-Fp'], { env: osEnv });
    assert.deepEqual(listeners.stdout.trim().split('\n').filter((s) => s.startsWith('p')), [`p${api.child.pid}`], 'API listener must be our child');
  }
  assert.equal(await pub.getChainId(), 4663, 'Wrong local chain');
  assert.match(String(await rpc('web3_clientVersion')), /anvil/i, 'Not Anvil');
}

async function receipt(step: string, hash: Hex) {
  const mined = await pub.waitForTransactionReceipt({ hash, timeout: 30_000 });
  assert.equal(mined.status, 'success', `${step} reverted`);
  receipts.push({ step, receipt: mined });
  await writeFile(join(output, 'receipts.json'), json(receipts), { mode: 0o600 });
  return mined;
}

async function inspectSandboxes() {
  const ids = (await exec('docker', ['ps', '-aq', '--filter', 'name=hood-verify-'], { env: osEnv })).stdout.trim().split('\n').filter(Boolean);
  if (!ids.length) return [];
  // --rm containers can disappear between ps and inspect; Docker still returns the surviving objects as JSON.
  const inspected = await exec('docker', ['inspect', ...ids], { env: osEnv }).catch((error: { stderr?: string; stdout?: string }) => {
    if (/no such object/i.test(error.stderr ?? '') && error.stdout) return { stdout: error.stdout };
    throw error;
  });
  const containers = JSON.parse(inspected.stdout) as { Id: string; Name: string; State: { Running: boolean }; Mounts: { Source: string }[]; Config: { Image: string; User: string }; HostConfig: { Memory: number; MemorySwap: number; NetworkMode: string; ReadonlyRootfs: boolean; CapDrop: string[]; SecurityOpt: string[]; AutoRemove: boolean; PidsLimit: number; NanoCpus: number } }[];
  const owned = containers.filter((c) => c.Mounts.some((m) => m.Source.startsWith(`${workDir}/`)));
  for (const c of owned) {
    const { Memory, MemorySwap, NetworkMode, ReadonlyRootfs, CapDrop, SecurityOpt, AutoRemove, PidsLimit, NanoCpus } = c.HostConfig;
    sandboxes.set(c.Id, { id: c.Id, name: c.Name, image: c.Config.Image, user: c.Config.User, Memory, MemorySwap, NetworkMode, ReadonlyRootfs, CapDrop, SecurityOpt, AutoRemove, PidsLimit, NanoCpus, observedAt: new Date().toISOString() });
  }
  return owned;
}

async function run() {
  assert.equal(process.argv.length, 2, 'No CLI overrides accepted; endpoints and local accounts are fixed');
  for (const port of [18546, 18787]) {
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
  local(databaseUrl);
  const imageInfo = JSON.parse((await exec('docker', ['image', 'inspect', image], { env: osEnv })).stdout)[0];
  report.image = { tag: image, id: imageInfo.Id, architecture: imageInfo.Architecture };
  // Inspect only published ports, not container environment, and never start/modify the shared service.
  const ports = JSON.parse((await exec('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', 'dockhood-testnet-postgres-1'], { env: osEnv })).stdout);
  assert.ok(ports['5432/tcp'].some((p: { HostIp: string; HostPort: string }) => p.HostIp === '127.0.0.1' && p.HostPort === '54321'), 'Dedicated testnet Postgres must be loopback :54321');
  const adminSql = postgres('postgres://hood:hood@127.0.0.1:54321/hood', { max: 1, onnotice: () => {} });
  try {
    await adminSql`CREATE DATABASE ${adminSql(database)}`;
  } finally {
    await adminSql.end({ timeout: 5 });
  }
  report.databaseCreated = true;
  const connected = await connectPostgres(databaseUrl);
  closeDb = connected.close;
  const db = connected.db;
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  anvil = start('anvil', join(root, '.testnet/tools/bin/anvil'), ['--host', '127.0.0.1', '--port', '18546', '--chain-id', '4663', '--silent'], osEnv, true).child;
  await waitFor('owned Anvil', async () => { await guard(); return true; });
  assert.equal(await pub.getBlockNumber(), 0n, 'Must start an unforked fresh chain');
  const nodeInfo = await rpc('anvil_nodeInfo') as { forkConfig?: { forkUrl?: string | null; forkBlockNumber?: number | null } };
  assert.ok(!nodeInfo.forkConfig?.forkUrl && !nodeInfo.forkConfig?.forkBlockNumber, 'Forked Anvil refused');
  report.anvil = { pid: anvil.pid, client: await rpc('web3_clientVersion'), nodeInfo, freshBlock: 0 };
  await guard();
  const mnemonic = 'test test test test test test test test test test test junk';
  const owner = mnemonicToAccount(mnemonic, { addressIndex: 0 });
  const bot = mnemonicToAccount(mnemonic, { addressIndex: 1 });
  const user = mnemonicToAccount(mnemonic, { addressIndex: 3 });
  const botKey = toHex(bot.getHdKey().privateKey!);
  secrets.push(mnemonic, botKey, botKey.slice(2), toHex(owner.getHdKey().privateKey!), toHex(user.getHdKey().privateKey!));
  const accounts = await rpc('eth_accounts') as string[];
  report.accounts = await Promise.all([owner, bot, user].map(async (a, index) => {
    assert.equal(a.address.toLowerCase(), accounts[[0, 1, 3][index]].toLowerCase());
    const balance = await pub.getBalance({ address: a.address });
    assert.ok(balance >= parseEther('100'), 'Default local accounts must have ample funds');
    return { index: [0, 1, 3][index], address: a.address, initialBalanceWei: balance };
  }));
  const wallet = createWalletClient({ account: owner, chain, transport: http(RPC, { retryCount: 0 }) });
  const artifact = async (name: string) => JSON.parse(await readFile(join(root, `apps/contracts/out/${name}.sol/${name}.json`), 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
  const registryArtifact = await artifact('RigorRegistry');
  const poolArtifact = await artifact('VerificationPool');
  const splitterArtifact = await artifact('FeeSplitter');
  async function deploy(name: string, compiled: Awaited<ReturnType<typeof artifact>>, args: Address[]) {
    await guard();
    const mined = await receipt(`deploy ${name}`, await wallet.deployContract({ abi: compiled.abi, bytecode: compiled.bytecode.object, args }));
    assert.ok(mined.contractAddress);
    assert.ok(await pub.getCode({ address: mined.contractAddress }));
    return getAddress(mined.contractAddress);
  }
  const registry = await deploy('RigorRegistry', registryArtifact, [owner.address]);
  const pool = await deploy('VerificationPool', poolArtifact, [owner.address, bot.address, registry]);
  const splitter = await deploy('FeeSplitter', splitterArtifact, [owner.address, owner.address, pool]);
  await guard();
  await receipt('wire registry pool', await wallet.writeContract({ address: registry, abi: registryArtifact.abi, functionName: 'setVerificationPool', args: [pool] }));
  const read = (address: Address, abi: Abi, functionName: string, args: unknown[] = []) => pub.readContract({ address, abi, functionName, args });
  assert.equal(await read(registry, registryArtifact.abi, 'verificationPool'), pool);
  assert.equal(await read(pool, poolArtifact.abi, 'verifierBot'), bot.address);
  assert.equal(await read(pool, poolArtifact.abi, 'rigorRegistry'), registry);
  assert.equal(await read(splitter, splitterArtifact.abi, 'verificationPool'), pool);
  assert.equal(await read(splitter, splitterArtifact.abi, 'operatorWallet'), owner.address);
  report.contracts = { registry, pool, splitter, wiring: 'passed' };

  const sessionSecret = randomBytes(32).toString('hex');
  secrets.push(sessionSecret);
  const common = { ...osEnv, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '18787', API_URL: API, DATABASE_URL: databaseUrl, RPC_URL_SERVER: RPC, CHAIN_ID: '4663', TOKEN_INDEX: 'off', STAND_INS: 'allow', CORS_ORIGINS: 'http://localhost:3000', SESSION_SECRET: sessionSecret, ADMIN_WALLETS: owner.address, VERIFICATION_SUBMISSIONS_ENABLED: 'true', VERIFICATION_POOL_ADDRESS: pool, RIGOR_REGISTRY_ADDRESS: registry, FEE_SPLITTER_ADDRESS: splitter, VERIFIER_IMAGE: image, VERIFICATION_WORK_DIR: workDir, VERIFICATION_MAX_CONCURRENT: '1', VERIFICATION_MEMORY_MB: '4096', VERIFICATION_SWAP_MB: '0', VERIFICATION_TIMEOUT_SEC: '120' };
  report.runtime = { concurrency: 1, memoryMb: 4096, swapMb: 0, compileTimeoutSec: 120, redis: 'not used: in-memory KV/pubsub', botKeyOnApi: false, envFiles: false };
  await guard();
  start('api', process.execPath, ['--import', 'tsx', 'src/index.ts'], common);
  await waitFor('API health', async () => (await fetch(`${API}/health`, { redirect: 'error', signal: AbortSignal.timeout(2_000) })).ok);
  await guard();
  start('worker', process.execPath, ['--import', 'tsx', 'src/verifierWorker.ts'], { ...common, VERIFIER_BOT_PRIVATE_KEY: botKey });
  monitor = (async () => {
    while (!closing) {
      try { await inspectSandboxes(); } catch (e) { if (!closing) aborted = `Docker monitoring failed: ${sanitize(String(e))}`; }
      await sleep(250);
    }
  })();
  await guard();
  const e2e = start('e2e', process.execPath, ['--import', 'tsx', 'scripts/verify-e2e.ts'], common);
  await waitFor('real Docker/API/worker proof flow', async () => e2e.code !== undefined, 900_000);
  assert.equal(e2e.code, 0, 'Existing E2E failed; see sanitized e2e.log');

  const rows = await db.select().from(schema.verificationSubmissions);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.status, 'verified');
  assert.equal(row.tier, 'SIMPLE');
  assert.equal(row.rewardWei, parseEther('0.05').toString());
  assert.equal(row.submitter.toLowerCase(), user.address.toLowerCase());
  assert.equal(row.reviewedBy?.toLowerCase(), owner.address.toLowerCase());
  assert.ok(row.reviewedAt && row.checkedAt && row.verifiedAt && row.compileMs! > 0);
  assert.ok(row.theorems?.length && row.theorems.every((t) => t.ok && t.axioms.every((a) => ['propext', 'Classical.choice', 'Quot.sound'].includes(a))));
  assert.equal(row.lastError, null);
  assert.ok(row.txHashSubmit && row.txHashResult);
  const submitted = await receipt('submit proof', row.txHashSubmit as Hex);
  const paid = await receipt('worker payout', row.txHashResult as Hex);
  const submission = await read(pool, poolArtifact.abi, 'getSubmission', [row.id]) as { status: number; tier: number; reward: bigint; feePaid: bigint; submitter: Address };
  assert.equal(submission.status, 2);
  assert.equal(submission.tier, 1);
  assert.equal(submission.reward, parseEther('0.05'));
  assert.equal(submission.submitter, user.address);
  assert.equal(await read(registry, registryArtifact.abi, 'isFormallyVerified', [row.tokenAddress]), true);
  assert.equal(await read(registry, registryArtifact.abi, 'rigorScore', [row.tokenAddress]), 100);
  assert.equal(await read(pool, poolArtifact.abi, 'pendingFees'), 0n);
  assert.equal(await read(pool, poolArtifact.abi, 'owed', [user.address]), 0n);
  assert.equal(getAddress((await pub.getTransaction({ hash: paid.transactionHash })).from), bot.address);
  const events = paid.logs.filter((log) => log.address.toLowerCase() === pool.toLowerCase()).map((log) => decodeEventLog({ abi: poolArtifact.abi, data: log.data, topics: log.topics }));
  assert.ok(events.some((event) => event.eventName === 'Verified'));
  const before = await pub.getBalance({ address: user.address, blockNumber: submitted.blockNumber - 1n });
  const after = await pub.getBalance({ address: user.address, blockNumber: paid.blockNumber });
  const gas = submitted.gasUsed * submitted.effectiveGasPrice;
  assert.equal(after - before, submission.reward - submission.feePaid - gas, 'Exact gas-adjusted payout');
  const [token] = await db.select().from(schema.tokens);
  assert.ok(token.formal && token.formalAt);
  const callouts = await db.select().from(schema.callouts);
  assert.equal(callouts.filter((c) => c.sourceKey === `formal:${row.id}` && c.txHash === row.txHashResult).length, 1);
  report.evidence = { submissionId: row.id, syntheticToken: row.tokenAddress, db: row, onchain: submission, rigorScore: 100, formal: true, exactPayout: { beforeWei: before, afterWei: after, feeWei: submission.feePaid, rewardWei: submission.reward, submitGasWei: gas, netWei: after - before, netEth: formatEther(after - before) }, calloutCount: 1 };
  for (let block = 1n; block <= await pub.getBlockNumber(); block++) {
    for (const hash of (await pub.getBlock({ blockNumber: block })).transactions) if (!receipts.some((r) => r.receipt.transactionHash === hash)) await receipt('local chain transaction', hash);
  }
  const observed = [...sandboxes.values()];
  assert.ok(observed.some((c) => String(c.name).endsWith('-compile')), 'Real compile container was observed');
  assert.ok(observed.some((c) => String(c.name).endsWith('-check')), 'Real checker container was observed');
  for (const c of observed) {
    assert.equal(c.Memory, 4096 * 1024 * 1024);
    assert.equal(c.MemorySwap, c.Memory);
    assert.equal(c.NetworkMode, 'none');
    assert.equal(c.ReadonlyRootfs, true);
    assert.equal(c.user, '10001:10001');
    assert.deepEqual(c.CapDrop, ['ALL']);
    assert.ok((c.SecurityOpt as string[]).includes('no-new-privileges'));
    assert.equal(c.AutoRemove, true);
  }
  report.result = 'passed';
}

await mkdir(output, { recursive: true, mode: 0o700 });
console.log(`Local-only verification evidence: ${output}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { aborted = `Received ${signal}`; });
try {
  await run();
} catch (error) {
  report.result = 'failed';
  report.error = sanitize(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
} finally {
  closing = true;
  await monitor;
  const cleanupErrors: string[] = [];
  for (const entry of [...children].reverse()) {
    if (entry.child.exitCode === null && entry.child.signalCode === null && entry.child.pid) {
      try { process.kill(-entry.child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
      await Promise.race([entry.done, sleep(8_000)]);
      if (entry.child.exitCode === null && entry.child.signalCode === null) {
        cleanupErrors.push(`${entry.name} required SIGKILL`);
        try { process.kill(-entry.child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
      }
    }
    await entry.done;
  }
  try {
    const remaining = await inspectSandboxes();
    if (remaining.length) await exec('docker', ['rm', '-f', ...remaining.map((c) => c.Id)], { env: osEnv });
    assert.equal((await inspectSandboxes()).length, 0, 'Owned proof containers remain');
  } catch (error) { cleanupErrors.push(sanitize(String(error))); }
  try { await closeDb?.(); } catch (error) { cleanupErrors.push(sanitize(String(error))); }
  await rm(workDir, { recursive: true, force: true }).catch((error) => cleanupErrors.push(sanitize(String(error))));
  report.sandboxes = [...sandboxes.values()];
  report.cleanup = { children: children.map((e) => ({ name: e.name, pid: e.child.pid, exitCode: e.child.exitCode, signal: e.child.signalCode })), ownedContainersRemaining: cleanupErrors.length ? 'see errors' : 0, errors: cleanupErrors, database: 'retained, isolated; no session/proof database dump written' };
  if (cleanupErrors.length) { report.result = 'failed'; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'report.json'), json(report), { mode: 0o600 });
  console.log(json(report));
}
