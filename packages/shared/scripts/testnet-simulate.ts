/** Local fork ONLY. Run: pnpm --filter @hood/shared exec tsx scripts/testnet-simulate.ts */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, createWalletClient, decodeErrorResult, defineChain,
  encodeFunctionData, erc20Abi, hashTypedData, http, keccak256, parseAbi, parseEther,
  parseEventLogs, toHex, type Abi, type Address, type Hex, type TransactionReceipt,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ponsCurveAbi, ponsFactoryAbi, ponsTokenAbi } from '../src/abi';
import { buildTokenParams, planLaunch, randomSalt } from '../src/launchTx';
import { NATIVE_PAIR } from '../src/pons';
import { rigorRegistryAbi, verificationPoolAbi } from '../src/verificationAbi';
import {
  CHAIN_ID, INFRA, PONS, PROXY_CODE, ROLES, VERIFIED_NAMES, buildPlan, digest, json,
  save, secureDirectory, verifiedArtifact, type Artifacts, type Role,
} from './testnet-lib';

export const LOCAL_RPC = 'http://127.0.0.1:18545';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const UPSTREAMS = ['https://robinhood-sepolia-rpc.publicnode.com', 'https://robinhood-testnet.drpc.org'];
const chain = defineChain({ id: CHAIN_ID, name: 'SIMULATION ONLY Robinhood testnet fork', testnet: true,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [LOCAL_RPC] } } });
const equal = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new RehearsalError(message); }
class RehearsalError extends Error {}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function safeFailure(error: unknown, abi: Abi = []) {
  const result: { errorTypes: string[]; errorName?: string; revertSelector?: Hex; rpcCodes?: number[]; categories?: string[] } = { errorTypes: [] };
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 10 || seen.has(value)) return;
    seen.add(value);
    const node = value as Record<string, unknown>;
    if (typeof node.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(node.name)) result.errorTypes.push(node.name);
    if (typeof node.errorName === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(node.errorName)) result.errorName = node.errorName;
    if (typeof node.code === 'number' && Number.isSafeInteger(node.code)) (result.rpcCodes ??= []).push(node.code);
    for (const field of ['message', 'details']) {
      if (typeof node[field] !== 'string') continue;
      const text = node[field] as string;
      for (const [category, pattern] of [
        ['fork-state-read', /failed to (?:get|fetch|read) (?:storage|account|code)|missing trie|state.*unavailable/i],
        ['upstream-transport', /error sending request|connection|transport error|failed to send|dns|certificate/i],
        ['rate-limit', /rate.?limit|too many requests|429/], ['timeout', /timed? ?out|timeout/i],
        ['gas-limit', /out of gas|gas.*(?:limit|allowance)|exceeds.*gas/i],
        ['execution-revert', /execution reverted|revert(?:ed)? with/i], ['invalid-opcode', /invalid opcode|not activated|notactivated/i],
        ['historical-state-unavailable', /state (?:not found|is not available)|historical state|no state available|header not found|unknown block|block not found/i],
        ['account-not-found', /account (?:not found|does not exist)|nonexistent account/i],
      ] as const) if (pattern.test(text) && !result.categories?.includes(category)) (result.categories ??= []).push(category);
    }
    if (typeof node.data === 'string' && /^0x[0-9a-f]{8}(?:[0-9a-f]{64})*$/i.test(node.data)) {
      result.revertSelector = node.data.slice(0, 10) as Hex;
      try { result.errorName = decodeErrorResult({ abi, data: node.data as Hex }).errorName; } catch { /* Selector only. */ }
    }
    // Do not walk request parameters, signed payloads, error messages or arbitrary provider fields.
    for (const key of ['cause', 'error', 'data', 'originalError']) visit(node[key], depth + 1);
  };
  visit(error, 0);
  result.errorTypes = [...new Set(result.errorTypes)];
  if (result.rpcCodes) result.rpcCodes = [...new Set(result.rpcCodes)];
  return result;
}

export function assertLocalRpc(url: string) {
  check(url === LOCAL_RPC, 'Only the fixed exact loopback rehearsal RPC is permitted.');
}

export function assertForkIdentity(chainId: number, version: unknown, info: unknown, upstream: string, forkBlock: bigint) {
  check(chainId === CHAIN_ID, 'Local node has wrong chain ID.');
  check(typeof version === 'string' && /^anvil\//i.test(version), 'Local node is not Anvil.');
  const node = info as { environment?: { chainId?: number }; forkConfig?: { forkBlockNumber?: number; forkUrl?: string } } | null;
  check(Number(node?.environment?.chainId) === CHAIN_ID &&
    Number.isSafeInteger(node?.forkConfig?.forkBlockNumber) && BigInt(node!.forkConfig!.forkBlockNumber!) === forkBlock &&
    node?.forkConfig?.forkUrl === upstream, 'Anvil fork identity does not match the pinned upstream/block.');
}

export function loadSimulationArtifacts(): Artifacts {
  const result: Artifacts = {};
  for (const [address, name] of Object.values(PONS)) {
    const path = join(ROOT, '.testnet', 'artifacts', `${name}.json`);
    check(existsSync(path), `Missing cached verified artifact: ${name}. Run public prepare first, without broadcast.`);
    result[name] = verifiedArtifact(JSON.parse(readFileSync(path, 'utf8')), address, VERIFIED_NAMES[name] ?? name,
      `https://sourcify.dev/server/v2/contract/4663/${address}?fields=all`);
  }
  for (const name of ['RigorRegistry', 'VerificationPool', 'FeeSplitter']) {
    const contractsDir = join(ROOT, 'apps', 'contracts');
    const path = join(contractsDir, 'out', `${name}.sol`, `${name}.json`);
    check(existsSync(path), `Missing ${name} build artifact. Wait for apps/contracts forge build, then rerun.`);
    const raw = readFileSync(path, 'utf8');
    const compiled = JSON.parse(raw);
    check(/^0x[0-9a-f]+$/i.test(compiled.bytecode?.object ?? '') &&
      !Object.keys(compiled.bytecode?.linkReferences ?? {}).length && Array.isArray(compiled.abi), `Invalid artifact: ${name}.`);
    const metadata = compiled.metadata ?? JSON.parse(compiled.rawMetadata ?? '{}');
    check(metadata.compiler?.version?.startsWith('0.8.28+') && Object.keys(metadata.sources ?? {}).length, `Rebuild ${name} with Solidity 0.8.28.`);
    for (const [source, data] of Object.entries(metadata.sources) as [string, { keccak256: Hex }][]) {
      const sourcePath = resolve(contractsDir, source);
      check(sourcePath.startsWith(contractsDir + sep) && existsSync(sourcePath) &&
        keccak256(toHex(readFileSync(sourcePath))) === data.keccak256, `Stale source in ${name}; rebuild contracts.`);
    }
    result[name] = { abi: compiled.abi, bytecode: compiled.bytecode.object, provenance: path, sha256: digest(raw) };
  }
  return result;
}

type Receipt = { name: string; hash: Hex; status: string; blockNumber: string; blockHash: Hex; gasUsed: string; gasPrice: string; gasCostWei: string; expectedRevert?: string };
type Report = {
  version: number; mode: 'local-fork'; chainId: number; publicBroadcast: false; publicSecretsRead: false;
  keysPersisted: false; startedAt: string; state: string; stage: string; forkBlock?: string; forkBlockHash?: Hex;
  upstream?: string; addresses?: Record<string, Address>; wallets?: Record<Role, Address>; planSteps?: number;
  receipts: Receipt[]; tests: string[]; observations: string[]; reason?: string; anvilStopped?: boolean; operation?: string;
  failure?: ReturnType<typeof safeFailure>; getters?: Record<string, unknown>;
  outcomes?: Record<string, unknown>;
  pendingTransaction?: { name: string; hash: Hex; nonce: number; expectedStatus: string };
};

export async function main() {
  check(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--help'), 'Usage: testnet-simulate.ts [--help]. No public broadcast or RPC override flags exist.');
  if (process.argv[2] === '--help') {
    console.log('SIMULATION ONLY: fresh memory-only wallets, pinned chain 46630 fork, http://127.0.0.1:18545. No public deployment. Anvil stops after report persistence.');
    return;
  }
  check(readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n').some(line => line.trim() === '.testnet/'), '.testnet/ must be gitignored.');
  secureDirectory(join(ROOT, '.testnet'));
  const simulationDir = join(ROOT, '.testnet', 'simulation');
  secureDirectory(simulationDir);
  const runDir = mkdtempSync(join(simulationDir, 'run-'));
  const report: Report = { version: 1, mode: 'local-fork', chainId: CHAIN_ID, publicBroadcast: false,
    publicSecretsRead: false, keysPersisted: false, startedAt: new Date().toISOString(), state: 'running', stage: 'artifacts',
    receipts: [], tests: [], observations: ['Contract protocol rehearsal only. No Lean compilation, proof validity, API or public deployment is attested.'] };
  const persist = () => save(join(runDir, 'report.json'), report);
  let ownedAnvil: ChildProcess | undefined;
  let interrupted = false;
  const stopSignal = () => { interrupted = true; ownedAnvil?.kill('SIGTERM'); };
  process.on('SIGINT', stopSignal);
  process.on('SIGTERM', stopSignal);
  const stage = (name: string) => { report.stage = name; persist(); console.log(`[local-fork] ${name}`); };
  try {
    persist();
    const artifacts = loadSimulationArtifacts();
    stage('pin-upstream');
    let upstream: string | undefined;
    let forkBlock: bigint | undefined;
    for (const url of UPSTREAMS) {
      // This client is read-only and never receives an account or a signed transaction.
      const remote = createPublicClient({ transport: http(url, { retryCount: 0, timeout: 20_000, fetchOptions: { redirect: 'error' } }) });
      try {
        check(await remote.getChainId() === CHAIN_ID, 'Upstream must be chain 46630.');
        const block = await remote.getBlock({ blockTag: 'latest' });
        check(block.number !== null && block.hash, 'Missing fork block.');
        check(await remote.getCode({ address: INFRA.proxy, blockNumber: block.number }) === PROXY_CODE, 'Upstream canonical proxy missing.');
        await remote.getLogs({ address: INFRA.poolManager, fromBlock: block.number, toBlock: block.number });
        upstream = url; forkBlock = block.number;
        report.upstream = new URL(url).hostname; report.forkBlock = block.number.toString(); report.forkBlockHash = block.hash;
        break;
      } catch { /* Try the next fixed read-only provider. Never print RPC errors. */ }
    }
    check(upstream && forkBlock !== undefined, 'No approved upstream serves chain 46630 state and address-filtered logs.');
    stage('start-owned-anvil');
    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', () => reject(new RehearsalError('Port 18545 is occupied; refusing to attach to or stop another node.')));
      probe.listen(18545, '127.0.0.1', () => probe.close(error => error ? reject(new RehearsalError('Port reservation failed.')) : resolve()));
    });
    ownedAnvil = spawn(join(ROOT, '.testnet', 'tools', 'bin', 'anvil'), [
      '--host', '127.0.0.1', '--port', '18545', '--chain-id', String(CHAIN_ID), '--accounts', '0',
      '--fork-url', upstream, '--fork-block-number', forkBlock.toString(), '--no-storage-caching',
      '--compute-units-per-second', '50', '--fork-retry-backoff', '1000',
      '--disable-default-create2-deployer', '--no-cors', '--quiet',
    ], { stdio: 'ignore' });
    let spawnFailed = false;
    ownedAnvil.on('error', () => { spawnFailed = true; });
    assertLocalRpc(LOCAL_RPC);
    const transport = () => http(LOCAL_RPC, { retryCount: 0, timeout: 120_000, fetchOptions: { redirect: 'error' } });
    const client = createPublicClient({ chain, transport: transport(), pollingInterval: 50, cacheTime: 0 });
    const rpc = (method: string, params: unknown[] = []) => client.request({ method, params } as never) as Promise<unknown>;
    const assertNode = async () => {
      assertLocalRpc(LOCAL_RPC);
      check(!interrupted && ownedAnvil?.pid && ownedAnvil.exitCode === null && ownedAnvil.signalCode === null && !spawnFailed, 'Owned Anvil is not running.');
      assertForkIdentity(await client.getChainId(), await rpc('web3_clientVersion'), await rpc('anvil_nodeInfo'), upstream, forkBlock);
    };
    let ready = false;
    for (let i = 0; i < 120; i++) {
      if (spawnFailed || ownedAnvil.exitCode !== null || interrupted) break;
      try { await assertNode(); ready = true; break; } catch { await delay(250); }
    }
    check(ready, 'Owned Anvil failed identity/startup checks; no wallets funded or transactions sent.');
    const pinned = await client.getBlock({ blockNumber: forkBlock });
    check(pinned.hash === report.forkBlockHash, 'Fork block hash mismatch.');
    // Warm the signature precompile's fork account before later verification transactions need it.
    const ecrecover = '0x0000000000000000000000000000000000000001';
    await client.getCode({ address: ecrecover });
    await client.getBalance({ address: ecrecover });
    await client.getTransactionCount({ address: ecrecover });
    report.tests.push('Exact loopback, owned Anvil client/nodeInfo, chain ID and pinned block hash verified');
    stage('fund-fresh-simulation-wallets');
    const accounts = Object.fromEntries(ROLES.map(role => [role, privateKeyToAccount(generatePrivateKey())])) as Record<Role, ReturnType<typeof privateKeyToAccount>>;
    const wallets = { addresses: Object.fromEntries(ROLES.map(role => [role, accounts[role].address])) as Record<Role, Address> };
    report.wallets = wallets.addresses;
    save(join(runDir, 'wallets.json'), { purpose: 'SIMULATION-ONLY-NEVER-FUND-PUBLICLY', chainId: CHAIN_ID, ...wallets }, true);
    for (const role of ROLES) {
      const address = accounts[role].address;
      check(await client.getTransactionCount({ address }) === 0 && !(await client.getCode({ address })), 'Generated wallet not fresh.');
      await assertNode();
      await rpc('anvil_setBalance', [address, toHex(parseEther('100'))]);
      check(await client.getBalance({ address }) === parseEther('100'), 'Local wallet funding failed.');
    }
    const plan = buildPlan(wallets, artifacts);
    check(plan.steps.length === 29, 'Expected the unchanged 29-step public deployment plan.');
    report.addresses = plan.addresses; report.planSteps = plan.steps.length;
    save(join(runDir, 'plan.json'), { mode: 'local-fork', ...plan }, true);
    const a = plan.addresses;
    const read = (address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) => client.readContract({ address, abi, functionName, args });
    const get = (key: string, artifact: string, fn: string, args: readonly unknown[] = []) => read(a[key], artifacts[artifact].abi, fn, args);
    // Anvil's suggested legacy price reflects previous tips. Repeatedly doubling it compounds fees.
    const initialGasPrice = await client.getGasPrice();
    const send = async (name: string, role: Role, request: { to?: Address; data?: Hex; value?: bigint; nonce?: number }, expectedRevert?: string) => {
      report.operation = name;
      persist();
      await assertNode();
      const wallet = createWalletClient({ account: accounts[role], chain, transport: transport() });
      // Explicit gas only for intentional negative transactions; positives must estimate successfully.
      let estimatedGas = 2_400_000n;
      for (let attempt = 0; ; attempt++) {
        try {
          if (expectedRevert) {
            let matched = false;
            try { await client.call({ account: accounts[role], ...request }); }
            catch (error) {
              if (safeFailure(error).revertSelector !== keccak256(toHex(`${expectedRevert}()`)).slice(0, 10)) throw error;
              matched = true;
            }
            check(matched, `Negative preflight did not return expected ${expectedRevert}.`);
          } else estimatedGas = await client.estimateGas({ account: accounts[role], ...request });
          break;
        }
        catch (error) {
          const diagnostic = safeFailure(error, Object.values(artifacts).flatMap(a => a.abi));
          if (attempt < 3 && diagnostic.categories?.includes('fork-state-read') && !diagnostic.revertSelector) {
            report.observations.push(`Retrying read-only gas estimation after upstream fork-state failure: ${name} (attempt ${attempt + 1}).`);
            persist();
            await delay(3000 * (attempt + 1));
            await assertNode();
            continue;
          }
          try { await client.call({ account: accounts[role], ...request }); }
          catch (callError) { report.observations.push(`Independent eth_call diagnostics: ${JSON.stringify(safeFailure(callError, Object.values(artifacts).flatMap(a => a.abi)))}`); }
          throw error;
        }
      }
      const gas = estimatedGas * 125n / 100n;
      const baseFee = (await client.getBlock()).baseFeePerGas ?? 0n;
      const gasPrice = (initialGasPrice > baseFee ? initialGasPrice : baseFee) * 2n;
      check(await client.getBalance({ address: accounts[role].address }) >= gas * gasPrice + (request.value ?? 0n), `Simulation wallet cannot cover gas/value: ${name}.`);
      const nonce = request.nonce ?? await client.getTransactionCount({ address: accounts[role].address, blockTag: 'pending' });
      await assertNode();
      const hash = await wallet.sendTransaction({ ...request, nonce, gas, type: 'legacy', gasPrice });
      report.pendingTransaction = { name, hash, nonce, expectedStatus: expectedRevert ? 'reverted' : 'success' };
      persist();
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
      delete report.pendingTransaction;
      report.receipts.push({ name, hash, status: receipt.status, blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash, gasUsed: receipt.gasUsed.toString(), gasPrice: receipt.effectiveGasPrice.toString(),
        gasCostWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(), ...(expectedRevert ? { expectedRevert } : {}) });
      persist();
      check(receipt.transactionHash === hash && receipt.status === (expectedRevert ? 'reverted' : 'success'), `Unexpected receipt status: ${name}.`);
      if (expectedRevert) {
        let found = false;
        try { await client.call({ account: accounts[role].address, ...request, blockNumber: receipt.blockNumber }); }
        catch (error) {
          // Only ABI-decoded custom error names are public. Never persist raw RPC/viem errors.
          found = safeFailure(error).revertSelector === keccak256(toHex(`${expectedRevert}()`)).slice(0, 10);
        }
        check(found, `Negative transaction did not return expected ${expectedRevert}.`);
      }
      return receipt;
    };
    const write = (name: string, role: Role, address: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], value = 0n, expectedRevert?: string) =>
      send(name, role, { to: address, data: encodeFunctionData({ abi, functionName, args }), value }, expectedRevert);
    const call = (key: string, artifact: string, fn: string, args: readonly unknown[] = [], role: Role = 'deployer') =>
      write(`${key}:${fn}`, role, a[key], artifacts[artifact].abi, fn, args);
    const event = (receipt: TransactionReceipt, address: Address, abi: Abi, eventName: string) => {
      const logs = parseEventLogs({ abi, eventName, logs: receipt.logs.filter(log => equal(log.address, address)), strict: true });
      check(logs.length === 1, `Expected one ${eventName} event.`);
      return logs[0].args as Record<string, unknown>;
    };
    stage('infrastructure-and-29-plan-steps');
    for (const [name, address] of Object.entries(INFRA)) {
      const code = await client.getCode({ address });
      check(code && code !== '0x', `Missing fork infrastructure: ${name}.`);
      if (name === 'proxy') check(code === PROXY_CODE, 'Canonical CREATE2 proxy runtime differs.');
    }
    const infraAbi = parseAbi(['function poolManager() view returns (address)', 'function permit2() view returns (address)', 'function ownerOf(uint256) view returns (address)', 'function getPositionLiquidity(uint256) view returns (uint128)']);
    check(equal(await read(INFRA.positionManager, infraAbi, 'poolManager'), INFRA.poolManager), 'PositionManager PoolManager mismatch.');
    check(equal(await read(INFRA.positionManager, infraAbi, 'permit2'), INFRA.permit2), 'PositionManager Permit2 mismatch.');
    for (const step of plan.steps) {
      check(await client.getTransactionCount({ address: accounts.deployer.address }) === step.nonce, 'Deployment nonce drift.');
      if (step.name === 'locker:setFactory') {
        report.getters = {
          'locker.owner': await get('locker', 'PonsV2LaunchLocker', 'owner'),
          'locker.factory': await get('locker', 'PonsV2LaunchLocker', 'factory'),
          'locker.positionManager': await get('locker', 'PonsV2LaunchLocker', 'positionManager'),
        };
        persist();
        check(equal(report.getters['locker.owner'], accounts.deployer.address), 'Locker constructor owner differs from deployer.');
        check(equal(report.getters['locker.factory'], NATIVE_PAIR), 'Locker factory was already initialized.');
        check(equal(report.getters['locker.positionManager'], INFRA.positionManager), 'Locker constructor PositionManager differs.');
      }
      const receipt = await send(step.name, 'deployer', { to: step.to, data: step.data, value: BigInt(step.value), nonce: step.nonce });
      if (step.creates) {
        if (!step.to) check(equal(receipt.contractAddress, step.creates), `CREATE address mismatch: ${step.name}.`);
        const code = await client.getCode({ address: step.creates });
        check(code && code !== '0x', `Missing deployed code: ${step.name}.`);
      }
    }
    const wiring: [string, string, string, unknown][] = [
      ['registry', 'RigorRegistry', 'verificationPool', a.pool], ['pool', 'VerificationPool', 'rigorRegistry', a.registry],
      ['pool', 'VerificationPool', 'verifierBot', accounts.verifier.address], ['splitter', 'FeeSplitter', 'verificationPool', a.pool],
      ['splitter', 'FeeSplitter', 'operatorWallet', accounts.deployer.address], ['splitter', 'FeeSplitter', 'poolBps', 3000],
      ['factory', 'PonsV2LaunchFactory', 'poolManager', INFRA.poolManager], ['factory', 'PonsV2LaunchFactory', 'positionManager', INFRA.positionManager],
      ['factory', 'PonsV2LaunchFactory', 'permit2', INFRA.permit2], ['factory', 'PonsV2LaunchFactory', 'locker', a.locker],
      ['factory', 'PonsV2LaunchFactory', 'memeHook', a.hook], ['factory', 'PonsV2LaunchFactory', 'feeEscrow', a.escrow],
      ['factory', 'PonsV2LaunchFactory', 'buybackVault', a.vault], ['factory', 'PonsV2LaunchFactory', 'graduationGuard', a.guard],
      ['factory', 'PonsV2LaunchFactory', 'graduationExecutor', a.executor], ['factory', 'PonsV2LaunchFactory', 'launchDeployer', a.launchDeployer],
      ['factory', 'PonsV2LaunchFactory', 'launchForwarder', a.router], ['factory', 'PonsV2LaunchFactory', 'launchEnabled', true],
      ['hook', 'PonsV2MemeHook', 'factory', a.factory], ['hook', 'PonsV2MemeHook', 'protocolFeeRecipient', a.splitter],
      ['hook', 'PonsV2MemeHook', 'buybackVault', a.vault], ['vault', 'PonsV2BuybackVault', 'factory', a.factory],
      ['locker', 'PonsV2LaunchLocker', 'factory', a.factory], ['router', 'PonsV2LaunchAndBuy', 'factory', a.factory],
    ];
    for (const [key, artifact, fn, wanted] of wiring) {
      report.operation = `getter:${key}.${fn}`;
      const actual = await get(key, artifact, fn);
      (report.getters ??= {})[`${key}.${fn}`] = actual;
      check(equal(actual, wanted), `Wiring mismatch: ${key}.${fn}.`);
    }
    for (const [key, artifact] of [['registry', 'RigorRegistry'], ['pool', 'VerificationPool'], ['splitter', 'FeeSplitter'],
      ['locker', 'PonsV2LaunchLocker'], ['hook', 'PonsV2MemeHook'], ['vault', 'PonsV2BuybackVault'],
      ['factory', 'PonsV2LaunchFactory'], ['router', 'PonsV2LaunchAndBuy']]) {
      report.operation = `getter:${key}.owner`;
      const owner = await get(key, artifact, 'owner');
      (report.getters ??= {})[`${key}.owner`] = owner;
      check(equal(owner, accounts.deployer.address), `Owner mismatch: ${key}.`);
    }
    for (let tier = 0; tier < 5; tier++) check(await get('pool', 'VerificationPool', 'rewardAmount', [tier]) === parseEther('0.00001') * BigInt(tier + 1), 'Reward configuration mismatch.');
    report.tests.push('All 29 original buildPlan steps: successful receipts, CREATE/CREATE2 code and basic wiring/getters');
    stage('launch-without-buy-and-atomic-dev-buy');
    const launchFee = await get('factory', 'PonsV2LaunchFactory', 'launchFee') as bigint;
    const launch = async (label: string, quoteIn: bigint) => {
      const params = buildTokenParams({ name: `SIMULATION ${label}`, symbol: 'SIMONLY', logo: '',
        description: 'LOCAL FORK REHEARSAL ONLY. Not a verified theorem or public token.', socials: { twitter: '', telegram: '', website: '' },
        creatorFeeRecipient: a.splitter, creatorTaxBps: 150, buybackEnabled: false,
        expectedEconomics: await get('factory', 'PonsV2LaunchFactory', 'previewLaunchEconomics', [0n, NATIVE_PAIR]) as Hex, salt: randomSalt() });
      const launchPlan = planLaunch({ params, launchConfigId: 0n, pairToken: NATIVE_PAIR, launchFee, quoteIn, minTokensOut: 1n,
        recipient: accounts.deployer.address }, { launchFactory: a.factory, launchAndBuy: a.router });
      const r = launchPlan.request;
      const receipt = await write(`launch:${label}`, 'deployer', r.address, r.abi, r.functionName, r.args, r.value);
      const launched = event(receipt, a.factory, ponsFactoryAbi, 'TokenLaunched');
      const token = launched.token as Address; const curve = launched.curve as Address;
      const state = await read(a.factory, ponsFactoryAbi, 'getLaunchedToken', [token]) as { exists: boolean; curve: Address; deployer: Address; phase: number };
      check(state.exists && equal(state.curve, curve) && equal(state.deployer, accounts.deployer.address) && state.phase === 0, 'Launch registration mismatch.');
      check(equal(await read(token, ponsTokenAbi, 'curve'), curve), 'Token curve mismatch.');
      const balance = await read(token, erc20Abi, 'balanceOf', [accounts.deployer.address]) as bigint;
      check(quoteIn === 0n ? balance === 0n : balance > 0n, 'Dev buy balance mismatch.');
      return { token, curve, balance };
    };
    const bare = await launch('no-buy', 0n);
    report.tests.push('Real launchToken without dev buy, registry/token getters and zero creator balance');
    const dev = await launch('atomic-buy', parseEther('0.001'));
    report.tests.push('Real atomic launchAndBuy with native dev buy and positive creator token balance');
    stage('curve-buy-sell');
    await write('curve:buy', 'trader', bare.curve, ponsCurveAbi, 'buy', [parseEther('0.001'), 1n, accounts.trader.address], parseEther('0.001'));
    const bought = await read(bare.token, erc20Abi, 'balanceOf', [accounts.trader.address]) as bigint;
    check(bought > 0n, 'Buy yielded no tokens.');
    const sellAmount = bought / 2n;
    await write('token:approve-sell', 'trader', bare.token, erc20Abi, 'approve', [bare.curve, sellAmount]);
    const beforeSell = await client.getBalance({ address: accounts.trader.address });
    const sellReceipt = await write('curve:sell', 'trader', bare.curve, ponsCurveAbi, 'sell', [sellAmount, 1n, accounts.trader.address]);
    const sellEvent = event(sellReceipt, bare.curve, ponsCurveAbi, 'CurveSell');
    check(BigInt(sellEvent.quoteOut as bigint) > 0n && await read(bare.token, erc20Abi, 'balanceOf', [accounts.trader.address]) === bought - sellAmount, 'Sell accounting mismatch.');
    check(await client.getBalance({ address: accounts.trader.address }) === beforeSell + BigInt(sellEvent.quoteOut as bigint) - sellReceipt.gasUsed * sellReceipt.effectiveGasPrice, 'Sell native payout mismatch.');
    report.tests.push('Real curve buy, ERC20 approval and sell; token and native payout accounting');
    stage('graduation-and-lp-custody');
    const beforeCompletion = await client.getBalance({ address: accounts.deployer.address });
    const graduateBuy = await write('curve:complete-with-refund', 'deployer', dev.curve, ponsCurveAbi, 'buy', [parseEther('0.1'), 1n, accounts.deployer.address], parseEther('0.1'));
    const refunded = event(graduateBuy, dev.curve, ponsCurveAbi, 'CurveBuyRefunded');
    check(BigInt(refunded.refund as bigint) > 0n, 'Oversized curve buy did not refund excess.');
    check(await client.getBalance({ address: accounts.deployer.address }) === beforeCompletion - parseEther('0.1') + BigInt(refunded.refund as bigint) -
      graduateBuy.gasUsed * graduateBuy.effectiveGasPrice, 'Oversized buy native refund accounting mismatch.');
    // The real curve auto-sweeps to phase 1; seeding the V4 pool is a separate permissionless transaction.
    let sweptState = await read(a.factory, ponsFactoryAbi, 'getLaunchedToken', [dev.token]) as { phase: number; sweptQuote: bigint; sweptTokens: bigint };
    if (sweptState.phase === 0) {
      check(await read(dev.curve, ponsCurveAbi, 'readyToGraduate') === true, 'Curve did not become ready to graduate.');
      await call('factory', 'PonsV2LaunchFactory', 'graduate', [dev.token], 'trader');
      sweptState = await read(a.factory, ponsFactoryAbi, 'getLaunchedToken', [dev.token]) as typeof sweptState;
    }
    check(sweptState.phase === 1 && sweptState.sweptQuote > 0n && sweptState.sweptTokens > 0n &&
      await read(dev.curve, ponsCurveAbi, 'graduated') === true, 'Curve sweep did not reach funded Swept phase.');
    const graduationReceipt = await call('factory', 'PonsV2LaunchFactory', 'createGraduatedPool', [dev.token], 'trader');
    const graduation = event(graduationReceipt, a.factory, ponsFactoryAbi, 'PoolGraduated');
    const positionId = graduation.positionId as bigint;
    check(positionId > 0n && await read(INFRA.positionManager, infraAbi, 'getPositionLiquidity', [positionId]) as bigint > 0n, 'Graduated LP has no liquidity.');
    check(equal(await read(INFRA.positionManager, infraAbi, 'ownerOf', [positionId]), a.locker), 'LP NFT is not in locker custody.');
    check(await get('locker', 'PonsV2LaunchLocker', 'lockedPositions', [dev.token]) === positionId && await get('locker', 'PonsV2LaunchLocker', 'isLocked', [dev.token]) === true, 'LP locker record mismatch.');
    const graduatedState = await read(a.factory, ponsFactoryAbi, 'getLaunchedToken', [dev.token]) as { phase: number };
    check(graduatedState.phase === 2, 'Factory did not reach Pool phase.');
    const lockedSupply = await get('locker', 'PonsV2LaunchLocker', 'lockedTokenSupply', [dev.token]) as bigint;
    const dustEvents = parseEventLogs({ abi: artifacts.PonsV2GraduationExecutor.abi, eventName: 'GraduationDustSwept',
      logs: graduationReceipt.logs.filter(log => equal(log.address, a.executor)), strict: true });
    const tokenDust = dustEvents.reduce((sum, log) => {
      const args = log.args as Record<string, unknown>;
      return equal(args.launchToken, dev.token) && equal(args.currency, dev.token) ? sum + BigInt(args.amount as bigint) : sum;
    }, 0n);
    check(lockedSupply > 0n && lockedSupply === sweptState.sweptTokens - BigInt(graduation.tokenAmount as bigint) &&
      await read(dev.token, erc20Abi, 'balanceOf', [a.locker]) === lockedSupply + tokenDust, 'Virtual reserve remainder/dust locker custody mismatch.');
    report.outcomes = { noBuyToken: bare.token, devBuyToken: dev.token, oversizeBuyRefundWei: refunded.refund,
      sweptQuoteWei: sweptState.sweptQuote, sweptTokens: sweptState.sweptTokens, lpPositionId: positionId, lpOwner: a.locker,
      lockedTokenSupply: lockedSupply, lockedMintDust: tokenDust };
    report.tests.push('Oversized buy refunded; real graduation into fork Uniswap V4, nonzero LP liquidity and locker NFT custody');
    stage('native-fee-escrow-splitter-pool');
    const credit = await get('escrow', 'PonsV2FeeEscrow', 'balanceOf', [a.splitter]) as bigint;
    check(credit > 0n, 'Real trades did not accrue splitter escrow credit.');
    const splitterBefore = await client.getBalance({ address: a.splitter });
    await call('splitter', 'FeeSplitter', 'claimEscrow', [a.escrow, NATIVE_PAIR]);
    check(await get('escrow', 'PonsV2FeeEscrow', 'balanceOf', [a.splitter]) === 0n && await client.getBalance({ address: a.splitter }) === splitterBefore + credit, 'Escrow claim accounting mismatch.');
    const total = await client.getBalance({ address: a.splitter });
    const poolBefore = await client.getBalance({ address: a.pool });
    const operatorBefore = await client.getBalance({ address: accounts.deployer.address });
    const distribution = await call('splitter', 'FeeSplitter', 'distributeFee', [], 'trader');
    const distributed = event(distribution, a.splitter, artifacts.FeeSplitter.abi, 'FeeDistributed');
    check(distributed.poolAmount === total * 3000n / 10000n && distributed.operatorAmount === total - total * 3000n / 10000n, 'Fee split differs from 30/70 policy.');
    check(await client.getBalance({ address: a.pool }) === poolBefore + total * 3000n / 10000n && await client.getBalance({ address: a.splitter }) === 0n, 'Pool did not receive distributed native fees.');
    check(await client.getBalance({ address: accounts.deployer.address }) === operatorBefore + total - total * 3000n / 10000n, 'Operator did not receive native fees.');
    Object.assign(report.outcomes, { nativeEscrowCreditWei: credit, poolFeeIncomeWei: distributed.poolAmount, operatorFeeIncomeWei: distributed.operatorAmount });
    report.tests.push('Real trade-generated native escrow credit claimed by splitter and distributed 30/70 to pool/operator');
    stage('verification-signatures-refund-failure');
    const fee = await get('pool', 'VerificationPool', 'submissionFee') as bigint;
    const submit = async (label: string) => {
      const proofHash = keccak256(toHex(`SIMULATION-NOT-A-LEAN-PROOF:${label}`));
      const receipt = await write(`verification:submit:${label}`, 'trader', a.pool, verificationPoolAbi, 'submit', [bare.token, proofHash, 'simulation-only-not-pinned'], fee);
      return event(receipt, a.pool, verificationPoolAbi, 'Submitted').id as Hex;
    };
    const id = await submit('signature');
    const deadline = (await client.getBlock()).timestamp + 3600n;
    const typed = { domain: { name: 'hood.exe VerificationPool', version: '1', chainId: CHAIN_ID, verifyingContract: a.pool },
      types: { Verify: [{ name: 'id', type: 'bytes32' }, { name: 'tier', type: 'uint8' }, { name: 'deadline', type: 'uint256' }] },
      primaryType: 'Verify', message: { id, tier: 1, deadline } } as const;
    check(await get('pool', 'VerificationPool', 'verifyDigest', [id, 1, deadline]) === hashTypedData(typed), 'EIP712 digest mismatch.');
    const invalid = await accounts.trader.signTypedData(typed);
    await write('verification:invalid-signature', 'deployer', a.pool, verificationPoolAbi, 'markVerified', [id, 1, deadline, invalid], 0n, 'BadSignature');
    const wrongDomain = await accounts.verifier.signTypedData({ ...typed, domain: { ...typed.domain, chainId: 4663 } });
    await write('verification:wrong-domain', 'deployer', a.pool, verificationPoolAbi, 'markVerified', [id, 1, deadline, wrongDomain], 0n, 'BadSignature');
    const signature = await accounts.verifier.signTypedData(typed);
    const expired = await accounts.verifier.signTypedData({ ...typed, message: { ...typed.message, deadline: 0n } });
    await write('verification:expired-signature', 'deployer', a.pool, verificationPoolAbi, 'markVerified', [id, 1, 0n, expired], 0n, 'Expired');
    const traderBefore = await client.getBalance({ address: accounts.trader.address });
    const reward = await get('pool', 'VerificationPool', 'rewardAmount', [1]) as bigint;
    await write('verification:valid-signature', 'deployer', a.pool, verificationPoolAbi, 'markVerified', [id, 1, deadline, signature]);
    const verified = await read(a.pool, verificationPoolAbi, 'getSubmission', [id]) as { status: number; reward: bigint };
    check(verified.status === 2 && verified.reward === reward && await client.getBalance({ address: accounts.trader.address }) === traderBefore + reward, 'Verification reward/status mismatch.');
    check(await read(a.registry, rigorRegistryAbi, 'isFormallyVerified', [bare.token]) === true && await read(a.registry, rigorRegistryAbi, 'rigorScore', [bare.token]) === 100, 'Local registry upgrade missing.');
    await write('verification:replay', 'deployer', a.pool, verificationPoolAbi, 'markVerified', [id, 1, deadline, signature], 0n, 'NotPending');
    const refundId = await submit('refund');
    const refundBefore = await client.getBalance({ address: accounts.trader.address });
    await call('pool', 'VerificationPool', 'refund', [refundId]);
    const refundedSubmission = await read(a.pool, verificationPoolAbi, 'getSubmission', [refundId]) as { status: number };
    check(refundedSubmission.status === 4 && await client.getBalance({ address: accounts.trader.address }) === refundBefore + fee, 'Refund status/payment mismatch.');
    const failedId = await submit('fail');
    await write('verification:unauthorized-fail', 'deployer', a.pool, artifacts.VerificationPool.abi, 'markFailed', [failedId, 'SIMULATION ONLY'], 0n, 'NotBot');
    await call('pool', 'VerificationPool', 'markFailed', [failedId, 'Synthetic failure; no Lean execution'], 'verifier');
    const failed = await read(a.pool, verificationPoolAbi, 'getSubmission', [failedId]) as { status: number };
    check(failed.status === 3 && await get('pool', 'VerificationPool', 'pendingFees') === 0n, 'Failed submission/pending fee accounting mismatch.');
    Object.assign(report.outcomes, { syntheticVerificationRewardWei: reward, refundedSubmissionFeeWei: fee, finalPendingFees: 0n });
    report.tests.push('Synthetic submission, matching EIP712 digest, invalid signer/wrong-chain/expired/replay reverts, valid signed reward and local registry upgrade',
      'Owner refund returns exact fee; unauthorized markFailed reverts; verifier failure releases pending fee liability');
    report.state = 'passed';
    stage('complete');
  } catch (error) {
    report.state = 'blocked';
    report.reason = error instanceof RehearsalError ? error.message : 'Stage failed; raw RPC, signing and process errors suppressed. No completion claimed.';
    let abi: Abi = [];
    try { abi = Object.values(loadSimulationArtifacts()).flatMap(a => a.abi); } catch { /* Artifact stage may have failed. */ }
    report.failure = safeFailure(error, abi);
    process.exitCode = 1;
  } finally {
    // Persist shareable results BEFORE stopping only the child we spawned. No private keys or raw transactions.
    try { persist(); }
    finally {
      if (ownedAnvil && ownedAnvil.exitCode === null && ownedAnvil.signalCode === null) {
        ownedAnvil.kill('SIGTERM');
        await Promise.race([new Promise(resolve => ownedAnvil!.once('exit', resolve)), delay(3000)]);
        if (ownedAnvil.exitCode === null && ownedAnvil.signalCode === null) {
          ownedAnvil.kill('SIGKILL');
          await Promise.race([new Promise(resolve => ownedAnvil!.once('exit', resolve)), delay(3000)]);
        }
      }
    }
    report.anvilStopped = !ownedAnvil || ownedAnvil.exitCode !== null || ownedAnvil.signalCode !== null;
    persist();
    process.off('SIGINT', stopSignal); process.off('SIGTERM', stopSignal);
    console.log(json({ mode: report.mode, state: report.state, chainId: CHAIN_ID, forkBlock: report.forkBlock,
      publicBroadcast: false, stage: report.stage, operation: report.operation, reason: report.reason, failure: report.failure, getters: report.getters, observations: report.observations, completedTests: report.tests,
      transactions: report.receipts.length, anvilStopped: report.anvilStopped, report: join(runDir, 'report.json') }));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Local rehearsal refused before startup. No public broadcast; raw errors suppressed.'); process.exitCode = 1; });
}
