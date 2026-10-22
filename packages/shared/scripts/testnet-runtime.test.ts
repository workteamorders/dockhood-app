import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAIN_ID, RPC, digest, json, type Plan } from './testnet-lib';
import { PUBLICNODE_RPC, RUNTIME_RPC, renderRuntime } from './testnet-runtime';

const mocks = vi.hoisted(() => ({ run: vi.fn(), chain: vi.fn(), receipt: vi.fn(), client: vi.fn(), transport: vi.fn(),
  witnessChain: vi.fn(), witnessReceipt: vi.fn(), head: vi.fn(), logs: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: mocks.run }));
vi.mock('viem', async importOriginal => ({ ...await importOriginal<typeof import('viem')>(),
  createPublicClient: mocks.client, http: mocks.transport,
}));

let root: string;
let plan: Plan;
let journal: ReturnType<typeof makeJournal>;
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as const;
const hash = `0x${'ab'.repeat(32)}` as const;
const state = (name: string) => join(root, '.testnet', name);
const runtime = (name = '') => state(join('runtime', name));
function write(path: string, value: unknown) { writeFileSync(path, json(value), { mode: 0o600 }); }
function makeJournal() {
  return { version: 1, chainId: CHAIN_ID, planHash: digest(json(plan)), complete: true,
    entries: plan.steps.map(step => ({ name: step.name, status: 'success', hash, raw: '0x1234',
      blockNumber: '123', blockHash: hash, address: step.creates, codeHash: hash })) };
}
function attestation(overrides = {}) {
  return { state: 'deployed-wiring-verified', chainId: CHAIN_ID, broadcast: false, addresses: plan.addresses, ...overrides };
}
function success(overrides = {}) {
  return { status: 0, signal: null, stdout: json({ state: 'prepared-not-simulated' }) + json(attestation()), stderr: '', ...overrides };
}
function env(name: string) {
  return Object.fromEntries(readFileSync(runtime(`${name}.env`), 'utf8').split('\n')
    .filter(line => line && !line.startsWith('#')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('TESTNET_RPC_URL', RUNTIME_RPC);
  root = mkdtempSync(join(tmpdir(), 'dockhood-runtime-'));
  mkdirSync(state(''), { mode: 0o700 });
  writeFileSync(join(root, '.gitignore'), '.testnet/\n');
  const keys = ['factory', 'router', 'registry', 'pool', 'splitter'];
  plan = { version: 1, chainId: CHAIN_ID, deployer: addr(9), artifacts: {},
    addresses: Object.fromEntries(keys.map((key, i) => [key, addr(i + 1)])),
    steps: keys.map((key, nonce) => ({ name: `deploy:${key}`, nonce, creates: addr(nonce + 1), data: '0x1234', value: '0' })) };
  journal = makeJournal();
  write(state('plan.json'), plan);
  write(state('journal.json'), journal);
  // No wallet secret file or app .env is available. Offline success must not require either.
  mocks.run.mockImplementation(() => success());
  mocks.chain.mockResolvedValue(CHAIN_ID);
  mocks.receipt.mockResolvedValue({ status: 'success', transactionHash: hash, blockHash: hash, blockNumber: 123n, contractAddress: addr(1) });
  mocks.witnessChain.mockResolvedValue(CHAIN_ID);
  mocks.witnessReceipt.mockResolvedValue({ status: 'success', transactionHash: hash, blockHash: hash, blockNumber: 123n, contractAddress: addr(1) });
  mocks.head.mockResolvedValue(130n);
  mocks.logs.mockResolvedValue([]);
  mocks.transport.mockImplementation(url => url);
  mocks.client.mockImplementation(({ transport }) => transport === (process.env.TESTNET_RPC_URL || RUNTIME_RPC).replace(/\/$/, '')
    ? { getChainId: mocks.chain, getTransactionReceipt: mocks.receipt, getBlockNumber: mocks.head, getLogs: mocks.logs }
    : { getChainId: mocks.witnessChain, getTransactionReceipt: mocks.witnessReceipt });
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe('public runtime gate (offline, mocked public validator/RPC)', () => {
  it.each(['incomplete', 'missing-entry', 'signed', 'reverted', 'wrong-plan', 'wrong-chain', 'reordered', 'missing-runtime', 'simulation', 'fork-plan'])
  ('rejects %s evidence before executing validation or generating files', async kind => {
    if (kind === 'incomplete') journal.complete = false;
    if (kind === 'missing-entry') journal.entries.pop();
    if (kind === 'signed' || kind === 'reverted') journal.entries[1].status = kind;
    if (kind === 'wrong-plan') journal.planHash = '0'.repeat(64);
    if (kind === 'wrong-chain') journal.chainId = 4663;
    if (kind === 'reordered') journal.entries.reverse();
    if (kind === 'missing-runtime') journal.entries[0].codeHash = '0x';
    write(state('journal.json'), kind === 'simulation' ? { ...journal, mode: 'local-fork', publicBroadcast: false } : journal);
    if (kind === 'fork-plan') write(state('plan.json'), { ...plan, mode: 'local-fork' });
    await expect(renderRuntime(root)).rejects.toThrow();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(existsSync(runtime())).toBe(false);
    expect(existsSync(state('runtime.lock'))).toBe(false);
  });

  it('does not use a simulation report when the public journal is missing', async () => {
    rmSync(state('journal.json'));
    mkdirSync(state('simulation'), { mode: 0o700 });
    write(state('simulation/report.json'), { state: 'success', chainId: CHAIN_ID, receipts: journal.entries });
    await expect(renderRuntime(root)).rejects.toThrow();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(existsSync(runtime())).toBe(false);
  });

  it.each(['failed', 'timeout', 'partial', 'wrong-chain', 'broadcast', 'wrong-address', 'invalid-output'])
  ('refuses %s deploy revalidation without generating credentials or envs', async kind => {
    let result = success();
    if (kind === 'failed') result = success({ status: 1, stderr: 'sensitive provider error' });
    if (kind === 'timeout') result = success({ error: new Error('sensitive timeout'), signal: 'SIGTERM' });
    if (kind === 'partial') result.stdout = json(attestation({ state: 'partial-simulation-only' }));
    if (kind === 'wrong-chain') result.stdout = json(attestation({ chainId: 4663 }));
    if (kind === 'broadcast') result.stdout = json(attestation({ broadcast: true }));
    if (kind === 'wrong-address') result.stdout = json(attestation({ addresses: { ...plan.addresses, factory: addr(20) } }));
    if (kind === 'invalid-output') result.stdout = 'not JSON';
    mocks.run.mockReturnValue(result);
    await expect(renderRuntime(root)).rejects.toThrow(/Public deploy revalidation/);
    expect(existsSync(runtime())).toBe(false);
  });

  it.each(['chain', 'block', 'hash', 'address', 'reverted', 'state-changed'])
  ('refuses %s after revalidation', async kind => {
    if (kind === 'chain') mocks.chain.mockResolvedValue(4663);
    const receipt = await mocks.receipt();
    if (kind === 'block') receipt.blockNumber = 124n;
    if (kind === 'hash') receipt.blockHash = `0x${'cd'.repeat(32)}`;
    if (kind === 'address') receipt.contractAddress = addr(20);
    if (kind === 'reverted') receipt.status = 'reverted';
    if (kind === 'state-changed') mocks.run.mockImplementation(() => {
      write(state('journal.json'), { ...journal, complete: false });
      return success();
    });
    await expect(renderRuntime(root)).rejects.toThrow();
    expect(existsSync(runtime())).toBe(false);
  });

  it('defaults to dRPC and runs fixed deploy argv without shell/broadcast or inherited secrets', async () => {
    delete process.env.TESTNET_RPC_URL;
    vi.stubEnv('VERIFIER_BOT_PRIVATE_KEY', 'must-not-inherit');
    vi.stubEnv('NODE_OPTIONS', '--require=untrusted');
    const report = await renderRuntime(root);
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith('pnpm', ['exec', 'tsx', 'scripts/testnet.ts', 'deploy'], expect.objectContaining({
      cwd: join(root, 'packages/shared'), shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, TESTNET_RPC_URL: RUNTIME_RPC },
    }));
    expect(mocks.transport).toHaveBeenCalledWith(RUNTIME_RPC, expect.objectContaining({ fetchOptions: { redirect: 'error' } }));
    expect(mocks.transport).toHaveBeenCalledWith(PUBLICNODE_RPC, expect.objectContaining({ fetchOptions: { redirect: 'error' } }));
    expect(report).toMatchObject({ chainId: CHAIN_ID, broadcast: false, walletSecretsRead: false });
    expect(json(report)).not.toContain(env('api').SESSION_SECRET);
    expect(json(report)).not.toContain(env('web').PROXY_SECRET);
  });

  it.each([RUNTIME_RPC, PUBLICNODE_RPC, RPC])('accepts approved override %s with an independent witness and consistent envs', async rpc => {
    vi.stubEnv('TESTNET_RPC_URL', `${rpc}/`);
    await renderRuntime(root);
    const witness = rpc === RUNTIME_RPC ? PUBLICNODE_RPC : RUNTIME_RPC;
    expect(mocks.transport.mock.calls.map(([url]) => url)).toEqual([rpc, witness]);
    expect(mocks.run.mock.calls[0][2].env.TESTNET_RPC_URL).toBe(rpc);
    expect(mocks.chain).toHaveBeenCalledOnce();
    expect(mocks.witnessChain).toHaveBeenCalledOnce();
    expect(mocks.witnessReceipt).toHaveBeenCalledExactlyOnceWith({ hash });
    expect(env('api').RPC_URL_SERVER).toBe(rpc);
    expect(env('web').NEXT_PUBLIC_RPC_URL).toBe(rpc);
    expect(env('worker').RPC_URL_SERVER).toBe(rpc);
    expect(env('indexer').TESTNET_RPC_URL).toBe(rpc);
  });

  it.each(['http://127.0.0.1:18545', 'https://localhost', 'https://127.0.0.1', 'https://[::1]',
    'https://192.168.1.2', 'http://robinhood-testnet.drpc.org', 'https://fork.example',
    'https://robinhood-testnet.drpc.org.evil.example', 'https://robinhood-testnet.drpc.org@localhost',
    `${RUNTIME_RPC}/fork`, `${RUNTIME_RPC}:18545`, `${RUNTIME_RPC}/?key=secret`,
    `${RUNTIME_RPC}/#fragment`, 'https://user:secret@robinhood-testnet.drpc.org', ''])
  ('rejects unsafe/unapproved endpoint %s even if a fork could report chain 46630', async rpc => {
    vi.stubEnv('TESTNET_RPC_URL', rpc);
    await expect(renderRuntime(root)).rejects.toThrow('approved public HTTPS');
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.client).not.toHaveBeenCalled();
    expect(existsSync(runtime())).toBe(false);
  });

  it.each(['wrong-chain', 'different-receipt', 'missing-receipt', 'unavailable'])
  ('blocks %s on the independent witness, even when the primary validator passes', async kind => {
    if (kind === 'wrong-chain') mocks.witnessChain.mockResolvedValue(4663);
    if (kind === 'different-receipt') mocks.witnessReceipt.mockResolvedValue({
      status: 'success', transactionHash: hash, blockHash: `0x${'cd'.repeat(32)}`, blockNumber: 123n, contractAddress: addr(1),
    });
    if (kind === 'missing-receipt') mocks.witnessReceipt.mockRejectedValue(new Error('not found'));
    if (kind === 'unavailable') mocks.witnessChain.mockRejectedValue(new Error('provider unavailable'));
    await expect(renderRuntime(root)).rejects.toThrow();
    expect(existsSync(runtime())).toBe(false);
    expect(mocks.logs).not.toHaveBeenCalled();
  });

  it('probes precisely the last four blocks with no address or topic filter', async () => {
    await renderRuntime(root);
    expect(mocks.logs).toHaveBeenCalledExactlyOnceWith({ fromBlock: 127n, toBlock: 130n });
  });

  it.each(['unsupported', 'invalid-response', 'stale-head'])('refuses %s wildcard log capability before creating runtime state', async kind => {
    vi.stubEnv('TESTNET_RPC_URL', PUBLICNODE_RPC);
    if (kind === 'unsupported') mocks.logs.mockRejectedValue(new Error('wildcard logs not supported'));
    if (kind === 'invalid-response') mocks.logs.mockResolvedValue(null);
    if (kind === 'stale-head') mocks.head.mockResolvedValue(122n);
    await expect(renderRuntime(root)).rejects.toThrow();
    expect(existsSync(runtime())).toBe(false);
  });

  it('renders isolated consistent service envs, secure reusable credentials and no signer keys', async () => {
    await renderRuntime(root);
    const api = env('api'), web = env('web'), indexer = env('indexer'), worker = env('worker');
    expect(api).toMatchObject({ CHAIN_ID: '46630', PORT: '8787', HOST: '127.0.0.1',
      DATABASE_URL: 'postgres://hood:hood@127.0.0.1:54321/hood', REDIS_URL: 'redis://127.0.0.1:63791',
      ENVIO_GRAPHQL_URL: 'http://127.0.0.1:8081/v1/graphql', VERIFICATION_SUBMISSIONS_ENABLED: 'false' });
    expect(api.CORS_ORIGINS.split(',')).toContain(web.NEXT_PUBLIC_SITE_URL);
    expect(web).toMatchObject({ PORT: '3101', NEXT_PUBLIC_CHAIN_ID: '46630', NEXT_PUBLIC_RPC_URL: RUNTIME_RPC,
      NEXT_PUBLIC_API_URL: '/api', API_PROXY_TARGET: `http://127.0.0.1:${api.PORT}`, NEXT_PUBLIC_WS_URL: 'ws://127.0.0.1:8787/ws',
      PROXY_SECRET: api.PROXY_SECRET, NEXT_PUBLIC_PONS_LAUNCH_FACTORY: plan.addresses.factory });
    expect(indexer).toMatchObject({ TESTNET_START_BLOCK: '123', TESTNET_FACTORY_ADDRESS: plan.addresses.factory, TESTNET_RPC_URL: RUNTIME_RPC });
    expect(api.RPC_URL_SERVER).toBe(web.NEXT_PUBLIC_RPC_URL);
    expect(worker.RPC_URL_SERVER).toBe(indexer.TESTNET_RPC_URL);
    expect(worker).toMatchObject({ CHAIN_ID: '46630', TOKEN_INDEX: 'off', VERIFICATION_POOL_ADDRESS: plan.addresses.pool });
    const credentials = JSON.parse(readFileSync(runtime('credentials.json'), 'utf8'));
    expect(new Set(Object.values(credentials)).size).toBe(3);
    expect(api.SESSION_SECRET).toBe(credentials.session);
    expect(indexer.TESTNET_HASURA_ADMIN_SECRET).toBe(credentials.hasura);
    expect(readdirSync(runtime()).sort()).toEqual(['api.env', 'credentials.json', 'indexer.env', 'web.env', 'worker.env']);
    for (const name of readdirSync(runtime())) {
      expect(lstatSync(runtime(name)).mode & 0o777).toBe(0o600);
      expect(readFileSync(runtime(name), 'utf8')).not.toMatch(/PRIVATE_KEY|must-not-inherit/);
    }
    expect(lstatSync(runtime()).mode & 0o777).toBe(0o700);
    const before = readdirSync(runtime()).map(name => [name, readFileSync(runtime(name), 'utf8'), lstatSync(runtime(name)).ino]);
    await renderRuntime(root);
    expect(readdirSync(runtime()).map(name => [name, readFileSync(runtime(name), 'utf8'), lstatSync(runtime(name)).ino])).toEqual(before);
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(existsSync(join(root, 'apps'))).toBe(false);
  });

  it.each(['different-env', 'public-permissions', 'symlink', 'hardlink', 'invalid-credentials'])
  ('refuses %s in existing runtime state without overwriting', async kind => {
    await renderRuntime(root);
    const original = readFileSync(runtime('api.env'), 'utf8');
    if (kind === 'different-env') writeFileSync(runtime('api.env'), 'PORT=9999\n');
    if (kind === 'public-permissions') chmodSync(runtime('api.env'), 0o644);
    if (kind === 'symlink') {
      rmSync(runtime('api.env'));
      symlinkSync(runtime('worker.env'), runtime('api.env'));
    }
    if (kind === 'hardlink') linkSync(runtime('api.env'), state('extra-link'));
    if (kind === 'invalid-credentials') write(runtime('credentials.json'), { session: 'invalid' });
    await expect(renderRuntime(root)).rejects.toThrow();
    if (kind === 'different-env') expect(readFileSync(runtime('api.env'), 'utf8')).toBe('PORT=9999\n');
    if (kind === 'public-permissions' || kind === 'hardlink') expect(readFileSync(runtime('api.env'), 'utf8')).toBe(original);
  });

  it('requires ignore protection and rejects symlink runtime directories and concurrent rendering', async () => {
    writeFileSync(join(root, '.gitignore'), '');
    await expect(renderRuntime(root)).rejects.toThrow('ignore');
    writeFileSync(join(root, '.gitignore'), '.testnet/\n');
    write(state('runtime.lock'), {});
    await expect(renderRuntime(root)).rejects.toThrow();
    expect(mocks.run).not.toHaveBeenCalled();
    rmSync(state('runtime.lock'));
    symlinkSync(root, runtime());
    await expect(renderRuntime(root)).rejects.toThrow('Unsafe');
    expect(existsSync(join(root, 'api.env'))).toBe(false);
  });
});
