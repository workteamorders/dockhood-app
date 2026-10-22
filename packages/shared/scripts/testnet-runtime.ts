/** Public deployment only: pnpm --filter @hood/shared exec tsx scripts/testnet-runtime.ts */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, type Hex } from 'viem';
import { CHAIN_ID, RPC, TestnetError, digest, json, secureDirectory, type Plan } from './testnet-lib';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const RUNTIME_RPC = 'https://robinhood-testnet.drpc.org';
export const PUBLICNODE_RPC = 'https://robinhood-sepolia-rpc.publicnode.com';
type Entry = { name: string; hash: Hex; raw: Hex; status: string; blockNumber: string; blockHash: Hex; address?: string; codeHash?: Hex };
type Journal = { version: number; chainId: number; planHash: string; entries: Entry[]; complete: boolean };
const check = (ok: unknown, message: string): void => { if (!ok) throw new TestnetError(message); };
const address = (value: unknown) => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);
const hash = (value: unknown) => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);

function publicRpc(value: string) {
  let url;
  try { url = new URL(value); }
  catch { throw new TestnetError('TESTNET_RPC_URL must be an approved public HTTPS endpoint.'); }
  check(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
    !url.port && url.pathname === '/' && [RUNTIME_RPC, PUBLICNODE_RPC, RPC].includes(url.origin),
  'TESTNET_RPC_URL must be an approved public HTTPS endpoint, not a local fork or credentialed URL.');
  return url.origin;
}

// Never follow links or read an app .env (or the dedicated wallet secrets).
function readPrivate(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    check(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600 && stat.uid === process.getuid?.(),
      'Unsafe runtime input: require an owned regular file, mode 0600 and one link.');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

function createPrivate(path: string, content: string) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); }
  finally { closeSync(fd); }
}

export async function renderRuntime(root = ROOT) {
  const rpc = publicRpc(process.env.TESTNET_RPC_URL ?? RUNTIME_RPC);
  const witnessRpc = rpc === RUNTIME_RPC ? PUBLICNODE_RPC : RUNTIME_RPC;
  check(readFileSync(join(root, '.gitignore'), 'utf8').split('\n').some(line => line.trim() === '.testnet/'),
    'Root .gitignore must ignore .testnet/.');
  const dir = join(root, '.testnet');
  secureDirectory(dir);
  const lock = join(dir, 'runtime.lock');
  const fd = openSync(lock, 'wx', 0o600);
  try {
    const planText = readPrivate(join(dir, 'plan.json'));
    const journalText = readPrivate(join(dir, 'journal.json'));
    const plan: Plan = JSON.parse(planText);
    const journal: Journal = JSON.parse(journalText);
    check(Object.keys(plan).every(key => ['version', 'chainId', 'deployer', 'addresses', 'artifacts', 'steps'].includes(key)) &&
      Object.keys(journal).every(key => ['version', 'chainId', 'planHash', 'entries', 'complete'].includes(key)),
    'Only public plan/journal manifests are accepted; simulation evidence is not deployment evidence.');
    check(plan.version === 1 && plan.chainId === CHAIN_ID && address(plan.deployer) &&
      journal.version === 1 && journal.chainId === CHAIN_ID && journal.complete === true &&
      journal.planHash === digest(json(plan)) && Array.isArray(plan.steps) && plan.steps.length > 0 &&
      Array.isArray(journal.entries) && journal.entries.length === plan.steps.length,
    'A complete public chain 46630 journal matching the immutable plan is required.');
    check(plan.addresses && Object.values(plan.addresses).every(address) &&
      ['factory', 'router', 'registry', 'pool', 'splitter'].every(key => address(plan.addresses[key])), 'Invalid deployment addresses.');
    for (const [i, entry] of journal.entries.entries()) {
      const step = plan.steps[i];
      check(entry.name === step.name && step.nonce === i && entry.status === 'success' && hash(entry.hash) &&
        hash(entry.blockHash) && /^0x(?:[0-9a-f]{2})+$/i.test(entry.raw) && /^[1-9][0-9]*$/.test(entry.blockNumber) &&
        (!step.creates || (entry.address?.toLowerCase() === step.creates.toLowerCase() && hash(entry.codeHash))),
      'Every public deployment step must have successful receipt/runtime evidence in plan order.');
    }
    const factory = journal.entries.find((entry, i) => entry.name === 'deploy:factory' &&
      plan.steps[i].creates?.toLowerCase() === plan.addresses.factory.toLowerCase());
    check(factory && Number.isSafeInteger(Number(factory.blockNumber)), 'Missing factory deployment block.');

    // Only approved public endpoints can reach validation; chain ID alone cannot distinguish a fork.
    // A clean environment also prevents NODE_OPTIONS/.env or signing credentials reaching validation.
    const result = spawnSync('pnpm', ['exec', 'tsx', 'scripts/testnet.ts', 'deploy'], {
      cwd: join(root, 'packages', 'shared'), shell: false, encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, TESTNET_RPC_URL: rpc },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000, maxBuffer: 4 * 1024 * 1024,
    });
    check(!result.error && result.status === 0 && !result.signal, 'Public deploy revalidation failed; no runtime files generated.');
    // deploy prints prepare's JSON followed by the final JSON. Neither output is forwarded to the terminal.
    const output = result.stdout.trim();
    let report;
    try { report = JSON.parse(output.slice(output.lastIndexOf('\n{') + 1)); }
    catch { throw new TestnetError('Public deploy revalidation returned no completion attestation.'); }
    check(report.state === 'deployed-wiring-verified' && report.chainId === CHAIN_ID && report.broadcast === false &&
      json(report.addresses) === json(plan.addresses), 'Public deploy revalidation did not attest this complete deployment.');

    const clients = [rpc, witnessRpc].map(url => createPublicClient({
      transport: http(url, { retryCount: 0, timeout: 20_000, fetchOptions: { redirect: 'error' } }),
    }));
    for (const client of clients) {
      check(await client.getChainId() === CHAIN_ID, 'Both public RPCs must report chain 46630.');
      const receipt = await client.getTransactionReceipt({ hash: factory!.hash });
      check(receipt.status === 'success' && receipt.transactionHash === factory!.hash && receipt.blockHash === factory!.blockHash &&
        receipt.blockNumber.toString() === factory!.blockNumber && receipt.contractAddress?.toLowerCase() === plan.addresses.factory.toLowerCase(),
      'Factory receipt/block does not match independent public deployment evidence.');
    }
    // Envio discovers curve events with wildcard logs. An address-filtered probe would miss provider restrictions.
    const head = await clients[0].getBlockNumber();
    check(head >= BigInt(factory!.blockNumber), 'Public RPC head predates the factory deployment.');
    const logs = await clients[0].getLogs({ fromBlock: head > 3n ? head - 3n : 0n, toBlock: head });
    check(Array.isArray(logs), 'Public RPC must support wildcard eth_getLogs for the indexer.');
    check(readPrivate(join(dir, 'plan.json')) === planText && readPrivate(join(dir, 'journal.json')) === journalText,
      'Deployment state changed during validation; retry after reviewing it.');

    const runtime = join(dir, 'runtime');
    secureDirectory(runtime);
    const credentialsPath = join(runtime, 'credentials.json');
    const existingCredentials = existsSync(credentialsPath);
    const credentials = existingCredentials ? JSON.parse(readPrivate(credentialsPath)) : {
      session: randomBytes(32).toString('hex'), proxy: randomBytes(32).toString('hex'), hasura: randomBytes(32).toString('hex'),
    };
    check(Object.keys(credentials).sort().join(',') === 'hasura,proxy,session' &&
      Object.values(credentials).every(value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)), 'Invalid saved service credentials.');
    const a = plan.addresses;
    const common = {
      NODE_ENV: 'development', CHAIN_ID: String(CHAIN_ID), RPC_URL_SERVER: rpc,
      DATABASE_URL: 'postgres://hood:hood@127.0.0.1:54321/hood', REDIS_URL: 'redis://127.0.0.1:63791',
      ENVIO_GRAPHQL_URL: 'http://127.0.0.1:8081/v1/graphql', INDEXER_DATABASE_URL: 'postgres://hood:hood@127.0.0.1:54321/envio',
      PONS_LAUNCH_FACTORY: a.factory, PONS_LAUNCH_AND_BUY: a.router, PAIR_TOKENS_JSON: '[]',
      RIGOR_REGISTRY_ADDRESS: a.registry, VERIFICATION_POOL_ADDRESS: a.pool, FEE_SPLITTER_ADDRESS: a.splitter,
      VERIFICATION_SUBMISSIONS_ENABLED: 'false', VERIFICATION_SUBMISSION_FEE_WEI: '10000000000000',
      ADMIN_WALLETS: plan.deployer, TOKEN_INDEX: 'off', STAND_INS: 'allow',
    };
    const files: Record<string, Record<string, string>> = {
      'api.env': { ...common, HOST: '127.0.0.1', PORT: '8787', TOKEN_INDEX: 'on',
        CORS_ORIGINS: 'http://localhost:3101,http://127.0.0.1:3101', SESSION_SECRET: credentials.session, PROXY_SECRET: credentials.proxy },
      'web.env': { PORT: '3101', NEXT_PUBLIC_CHAIN_ID: String(CHAIN_ID), NEXT_PUBLIC_RPC_URL: rpc,
        NEXT_PUBLIC_PONS_LAUNCH_FACTORY: a.factory, NEXT_PUBLIC_PONS_LAUNCH_AND_BUY: a.router, NEXT_PUBLIC_PAIR_TOKENS_JSON: '[]',
        NEXT_PUBLIC_API_URL: '/api', API_PROXY_TARGET: 'http://127.0.0.1:8787', PROXY_SECRET: credentials.proxy,
        NEXT_PUBLIC_WS_URL: 'ws://127.0.0.1:8787/ws', NEXT_PUBLIC_SITE_URL: 'http://localhost:3101' },
      'indexer.env': { TESTNET_FACTORY_ADDRESS: a.factory, TESTNET_START_BLOCK: factory!.blockNumber,
        TESTNET_RPC_URL: rpc, TESTNET_HASURA_ADMIN_SECRET: credentials.hasura },
      'worker.env': common,
    };
    const pending: [string, string][] = [];
    for (const [name, values] of Object.entries(files)) {
      const content = '# Public chain 46630 only. Generated after receipt/runtime/wiring revalidation.\n' +
        Object.entries(values).map(([key, value]) => {
          check(!/[\r\n\0$#'"`\\]/.test(value), 'Unsafe env value; refusing to render.');
          return `${key}=${value}\n`;
        }).join('');
      const path = join(runtime, name);
      if (existsSync(path)) check(readPrivate(path) === content, 'Existing runtime env differs; refusing to overwrite.');
      else pending.push([path, content]);
    }
    if (!existingCredentials) createPrivate(credentialsPath, json(credentials));
    for (const [path, content] of pending) createPrivate(path, content);
    const dirFd = openSync(runtime, 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    return { state: 'runtime-rendered', chainId: CHAIN_ID, broadcast: false, walletSecretsRead: false,
      files: Object.keys(files).map(name => `.testnet/runtime/${name}`),
      limitations: ['No services started. No verifier key loaded or written; verifier launcher is not implemented.',
        'Wildcard logs were probed over at most four recent blocks, not the full indexer backfill.',
        'Proof submissions remain disabled. Deployment wiring is not launch/trading/graduation/payout E2E evidence.'] };
  } finally { closeSync(fd); unlinkSync(lock); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    console.error('Usage: testnet-runtime.ts (no flags; TESTNET_RPC_URL may select an approved public chain 46630 HTTPS RPC)');
    process.exitCode = 1;
  } else {
    renderRuntime().then(report => console.log(json(report))).catch(() => {
      console.error('Runtime rendering blocked. Require a complete public journal and successful public receipt/runtime/wiring revalidation. No completion claimed; raw errors suppressed.');
      process.exitCode = 1;
    });
  }
}
