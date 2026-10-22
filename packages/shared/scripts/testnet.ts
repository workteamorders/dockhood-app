/** Run from the repository: pnpm --filter @hood/shared exec tsx scripts/testnet.ts <command> */
import { existsSync, openSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, createWalletClient, defineChain, http, keccak256, parseAbi, parseEther, toHex,
  type Address, type Hex,
} from 'viem';
import {
  CHAIN_ID, INFRA, PONS, PROXY_CODE, ROLES, RPC, TestnetError, VERIFIED_NAMES, assertIntent, buildPlan, digest, initWallets, json,
  loadDeployer, save, secureDirectory, verifiedArtifact, type Artifacts, type Plan, type Wallets,
} from './testnet-lib';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DIR = join(ROOT, '.testnet');
const [command, ...flags] = process.argv.slice(2);
if (!['init', 'status', 'prepare', 'deploy'].includes(command) || flags.some(f => f !== '--broadcast') ||
    (flags.length > 0 && (command !== 'deploy' || flags.length !== 1))) {
  console.error('Usage: testnet.ts init|status|prepare|deploy [--broadcast (deploy only)]');
  process.exit(1);
}
const broadcast = flags.includes('--broadcast');
/** Minimum ETH the deployer must keep after each tx. Full plan costs ~0.0016 ETH (gas ~0.0006 + 0.001 value). */
const GAS_RESERVE = parseEther('0.005');
const rpc = process.env.TESTNET_RPC_URL ?? RPC;
const chain = defineChain({ id: CHAIN_ID, name: 'Robinhood Testnet', testnet: true,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const client = createPublicClient({ chain, transport: http(rpc, { retryCount: 1, timeout: 20_000 }) });
const read = <T>(name: string): T => JSON.parse(readFileSync(join(DIR, name), 'utf8'));
const getterAbi = parseAbi([
  'function poolManager() view returns (address)', 'function permit2() view returns (address)',
  'function owner() view returns (address)', 'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function allowance(address,address,address) view returns (uint160,uint48,uint48)',
  'function extsload(bytes32) view returns (bytes32)', 'function nextTokenId() view returns (uint256)',
]);
const equal = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
const publicError = (stage: string) => `${stage} failed; no completion claimed. Check network, cached source data and local tooling. Raw errors are suppressed to avoid leaking RPC credentials or signing data.`;

async function assertChain() {
  if (await client.getChainId() !== CHAIN_ID) throw new TestnetError('Wrong chain: only 46630 is permitted.');
}

async function infrastructure() {
  await assertChain();
  const checks: Record<string, unknown> = {};
  const blockers: string[] = [];
  for (const [name, address] of Object.entries(INFRA)) {
    const code = await client.getCode({ address });
    checks[`${name}CodeHash`] = code && code !== '0x' ? keccak256(code) : null;
    if (!code || code === '0x') blockers.push(`No testnet code at ${name} ${address}`);
    if (name === 'proxy' && code?.toLowerCase() !== PROXY_CODE) blockers.push('CREATE2 proxy does not match the canonical deterministic-deployment-proxy runtime.');
  }
  const expect = async (address: Address, name: 'poolManager' | 'permit2', wanted: Address) => {
    try {
      const value = await client.readContract({ address, abi: getterAbi, functionName: name });
      checks[`positionManager.${name}`] = value;
      if (!equal(value, wanted)) blockers.push(`PositionManager.${name} is ${value}, expected ${wanted}`);
    } catch { blockers.push(`PositionManager.${name} getter unavailable or incompatible`); }
  };
  await expect(INFRA.positionManager, 'poolManager', INFRA.poolManager);
  await expect(INFRA.positionManager, 'permit2', INFRA.permit2);
  try {
    checks.poolManagerSlot0 = await client.readContract({ address: INFRA.poolManager, abi: getterAbi,
      functionName: 'extsload', args: [toBytes32(0n)] });
    checks.poolManagerOwner = await client.readContract({ address: INFRA.poolManager, abi: getterAbi, functionName: 'owner' });
  } catch { blockers.push('PoolManager owner/extsload getters unavailable or incompatible'); }
  try {
    checks.positionManagerNextTokenId = await client.readContract({ address: INFRA.positionManager, abi: getterAbi, functionName: 'nextTokenId' });
  } catch { blockers.push('PositionManager.nextTokenId unavailable or incompatible'); }
  try {
    const domain = await client.readContract({ address: INFRA.permit2, abi: getterAbi, functionName: 'DOMAIN_SEPARATOR' });
    if (BigInt(domain) === 0n) throw new Error('Empty domain');
    checks.permit2Domain = domain;
    checks.permit2Allowance = await client.readContract({ address: INFRA.permit2, abi: getterAbi,
      functionName: 'allowance', args: [INFRA.proxy, INFRA.poolManager, INFRA.positionManager] });
  } catch { blockers.push('Permit2 domain/allowance getters unavailable or incompatible'); }
  return { checks, blockers };
}

function toBytes32(value: bigint): Hex { return `0x${value.toString(16).padStart(64, '0')}`; }

async function artifacts() {
  const result: Artifacts = {};
  secureDirectory(join(DIR, 'artifacts'));
  for (const [address, name] of Object.values(PONS)) {
    const verifiedName = VERIFIED_NAMES[name] ?? name;
    const url = `https://sourcify.dev/server/v2/contract/4663/${address}?fields=all`;
    const path = join(DIR, 'artifacts', `${name}.json`);
    let raw;
    if (existsSync(path)) raw = JSON.parse(readFileSync(path, 'utf8'));
    else {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`Sourcify HTTP ${response.status} for ${name}`);
      raw = await response.json();
      verifiedArtifact(raw, address, verifiedName, url);
      save(path, raw, true);
    }
    result[name] = verifiedArtifact(raw, address, verifiedName, url);
  }
  save(join(DIR, 'provenance.json'), Object.fromEntries(Object.entries(result).map(([name, a]) => [name, {
    verifiedName: VERIFIED_NAMES[name] ?? name, sourcify: a.provenance, sha256: a.sha256,
  }])));
  for (const name of ['RigorRegistry', 'VerificationPool', 'FeeSplitter']) {
    const path = join(ROOT, 'apps', 'contracts', 'out', `${name}.sol`, `${name}.json`);
    if (!existsSync(path)) throw new Error(`Build apps/contracts first: missing ${name} artifact (forge build).`);
    const raw = readFileSync(path, 'utf8');
    const compiled = JSON.parse(raw);
    if (!/^0x[0-9a-f]+$/i.test(compiled.bytecode?.object ?? '') || Object.keys(compiled.bytecode?.linkReferences ?? {}).length) {
      throw new Error(`Invalid or linked local artifact: ${name}`);
    }
    const metadata = compiled.metadata ?? JSON.parse(compiled.rawMetadata ?? '{}');
    if (!metadata.compiler?.version?.startsWith('0.8.28+') || !Object.keys(metadata.sources ?? {}).length) {
      throw new Error(`Missing Solidity 0.8.28 source metadata: ${name}; rebuild apps/contracts.`);
    }
    const contractsDir = join(ROOT, 'apps', 'contracts');
    for (const [source, data] of Object.entries(metadata.sources) as [string, { keccak256: string }][]) {
      const sourcePath = resolve(contractsDir, source);
      if (!sourcePath.startsWith(contractsDir + sep) || !existsSync(sourcePath) ||
          keccak256(toHex(readFileSync(sourcePath))) !== data.keccak256) {
        throw new Error(`Stale or unavailable source in ${name}; rebuild apps/contracts.`);
      }
    }
    result[name] = { abi: compiled.abi, bytecode: compiled.bytecode.object, provenance: path, sha256: digest(raw) };
  }
  return result;
}

type Entry = {
  name: string; hash: Hex; raw: Hex; status: 'signed' | 'success' | 'reverted';
  blockNumber?: string; blockHash?: Hex; address?: Address; codeHash?: Hex;
};
type Journal = { version: 1; chainId: 46630; planHash: string; entries: Entry[]; complete: boolean };

async function status(wallets: Wallets) {
  const result: Record<string, unknown> = { command, chainId: CHAIN_ID, addresses: wallets.addresses,
    secretsRead: false, broadcast: false, deployment: 'not-started', blockers: [] };
  const blockers: string[] = [];
  try {
    const infra = await infrastructure();
    result.infrastructure = infra.checks;
    blockers.push(...infra.blockers);
    const balances: Record<string, string> = {};
    for (const role of ROLES) balances[role] = (await client.getBalance({ address: wallets.addresses[role] })).toString();
    result.balancesWei = balances;
    if (BigInt(balances.deployer) < GAS_RESERVE) blockers.push('Deployer needs testnet ETH; minimum broadcast reserve is 0.005 ETH (not a total deployment quote).');
  } catch { blockers.push('Testnet RPC unavailable or chain ID is not 46630.'); }
  if (existsSync(join(DIR, 'journal.json'))) {
    const journal = read<Journal>('journal.json');
    result.deployment = journal.complete ? 'journal-complete-unchecked' : 'incomplete';
    result.transactions = journal.entries.map(({ name, hash, status, address }) => ({ name, hash, status, address }));
    result.completionNote = 'Use deploy without --broadcast to recheck receipts, runtime hashes and wiring; status alone does not attest completion.';
  }
  result.blockers = blockers;
  console.log(json(result));
}

async function prepare(wallets: Wallets) {
  const blockers: string[] = [];
  let infra: Awaited<ReturnType<typeof infrastructure>> | undefined;
  try { infra = await infrastructure(); blockers.push(...infra.blockers); }
  catch { blockers.push('Testnet RPC unavailable or chain ID is not 46630.'); }
  let prepared: { plan: Plan; artifacts: Artifacts } | undefined;
  try {
    const loaded = await artifacts();
    const plan = buildPlan(wallets, loaded);
    const path = join(DIR, 'plan.json');
    if (existsSync(path)) {
      if (json(read<Plan>('plan.json')) !== json(plan)) throw new Error('Existing plan differs; refusing to overwrite deployment state.');
    } else save(path, plan, true);
    prepared = { plan, artifacts: loaded };
  } catch (error) {
    // These errors precede secret access and cannot contain keys or signed transactions.
    blockers.push(error instanceof Error ? error.message : 'Artifact preparation failed');
  }
  const report = { command, chainId: CHAIN_ID, state: blockers.length ? 'blocked' : 'prepared-not-simulated',
    broadcast: false, secretsRead: false, infrastructure: infra?.checks, blockers,
    predictedAddresses: prepared?.plan.addresses, transactionCount: prepared?.plan.steps.length,
    limitations: ['Getter checks are necessary, not a full Uniswap compatibility proof.',
      'Dependent transactions require sequential execution; prepare does not simulate launch, trading or graduation.',
      'No app environment files are modified. ERC20 quote pairs are not configured; native ETH only.'] };
  save(join(DIR, 'status.json'), report);
  console.log(json(report));
  return blockers.length ? undefined : prepared;
}

async function validateWiring(plan: Plan, loaded: Artifacts, launchesOpen = true) {
  const a = plan.addresses;
  const expected: [string, string, string, unknown, (readonly unknown[])?][] = [
    ['registry', 'RigorRegistry', 'verificationPool', a.pool],
    ['pool', 'VerificationPool', 'rigorRegistry', a.registry], ['pool', 'VerificationPool', 'verifierBot', read<Wallets>('wallets.json').addresses.verifier],
    ['pool', 'VerificationPool', 'submissionFee', parseEther('0.00001')], ['pool', 'VerificationPool', 'minPoolBalance', parseEther('0.0001')],
    ['splitter', 'FeeSplitter', 'verificationPool', a.pool], ['splitter', 'FeeSplitter', 'operatorWallet', plan.deployer],
    ['splitter', 'FeeSplitter', 'poolBps', 3000],
    ['factory', 'PonsV2LaunchFactory', 'poolManager', INFRA.poolManager], ['factory', 'PonsV2LaunchFactory', 'positionManager', INFRA.positionManager],
    ['factory', 'PonsV2LaunchFactory', 'permit2', INFRA.permit2], ['factory', 'PonsV2LaunchFactory', 'locker', a.locker],
    ['factory', 'PonsV2LaunchFactory', 'memeHook', a.hook], ['factory', 'PonsV2LaunchFactory', 'feeEscrow', a.escrow],
    ['factory', 'PonsV2LaunchFactory', 'buybackVault', a.vault], ['factory', 'PonsV2LaunchFactory', 'graduationGuard', a.guard],
    ['factory', 'PonsV2LaunchFactory', 'graduationExecutor', a.executor], ['factory', 'PonsV2LaunchFactory', 'launchDeployer', a.launchDeployer],
    ['factory', 'PonsV2LaunchFactory', 'launchForwarder', a.router], ['factory', 'PonsV2LaunchFactory', 'launchEnabled', launchesOpen],
    ['factory', 'PonsV2LaunchFactory', 'launchFee', parseEther('0.00001')], ['factory', 'PonsV2LaunchFactory', 'launchConfigCount', 1],
    ['hook', 'PonsV2MemeHook', 'factory', a.factory], ['hook', 'PonsV2MemeHook', 'buybackVault', a.vault],
    ['hook', 'PonsV2MemeHook', 'feeEscrow', a.escrow], ['hook', 'PonsV2MemeHook', 'poolManager', INFRA.poolManager],
    ['hook', 'PonsV2MemeHook', 'protocolFeeRecipient', a.splitter], ['hook', 'PonsV2MemeHook', 'feeSweepOperator', plan.deployer],
    ['hook', 'PonsV2MemeHook', 'hookFeeBps', 100], ['hook', 'PonsV2MemeHook', 'protocolFeeShareBps', 3000],
    ['hook', 'PonsV2MemeHook', 'buybackBurnBps', 5000], ['hook', 'PonsV2MemeHook', 'maxInternalPriceImpactBps', 300],
    ['vault', 'PonsV2BuybackVault', 'factory', a.factory], ['vault', 'PonsV2BuybackVault', 'feePolicy', a.hook], ['vault', 'PonsV2BuybackVault', 'feeEscrow', a.escrow],
    ['locker', 'PonsV2LaunchLocker', 'factory', a.factory], ['locker', 'PonsV2LaunchLocker', 'positionManager', INFRA.positionManager],
    ['executor', 'PonsV2GraduationExecutor', 'factory', a.factory], ['executor', 'PonsV2GraduationExecutor', 'positionManager', INFRA.positionManager],
    ['executor', 'PonsV2GraduationExecutor', 'permit2', INFRA.permit2], ['executor', 'PonsV2GraduationExecutor', 'locker', a.locker],
    ['launchDeployer', 'PonsV2LaunchDeployer', 'factory', a.factory], ['router', 'PonsV2LaunchAndBuy', 'factory', a.factory],
  ];
  for (let tier = 0; tier < 5; tier++) expected.push(['pool', 'VerificationPool', 'rewardAmount', parseEther('0.00001') * BigInt(tier + 1), [tier]]);
  for (const [key, name] of [['registry', 'RigorRegistry'], ['pool', 'VerificationPool'], ['splitter', 'FeeSplitter'],
    ['factory', 'PonsV2LaunchFactory'], ['hook', 'PonsV2MemeHook'], ['locker', 'PonsV2LaunchLocker'], ['vault', 'PonsV2BuybackVault'], ['router', 'PonsV2LaunchAndBuy']]) {
    expected.push([key, name, 'owner', plan.deployer]);
  }
  for (const [key, name, functionName, wanted, args] of expected) {
    const actual = await client.readContract({ address: a[key], abi: loaded[name].abi, functionName, args });
    if (!equal(actual, wanted)) throw new Error(`Wiring mismatch: ${key}.${functionName}`);
  }
  const config = await client.readContract({ address: a.factory, abi: loaded.PonsV2LaunchFactory.abi, functionName: 'getLaunchConfig', args: [0n] }) as Record<string, unknown>;
  for (const [name, wanted] of Object.entries({ supply: parseEther('1000000000'), curveFeeBps: 100, phantomQuote: parseEther('0.01'),
    graduationThreshold: parseEther('0.02'), poolFee: 0, tickSpacing: 200, enabled: true })) {
    if (!equal(config[name], wanted)) throw new Error(`Launch config mismatch: ${name}`);
  }
  const guardCode = await client.getCode({ address: a.guard });
  if (!guardCode || guardCode === '0x') throw new Error('Internal graduation guard missing');
}

async function deploy(wallets: Wallets) {
  const prepared = await prepare(wallets);
  if (!prepared) { process.exitCode = 1; return; }
  const { plan, artifacts: loaded } = prepared;
  const planHash = digest(json(plan));
  const path = join(DIR, 'journal.json');
  const journal: Journal = existsSync(path) ? read<Journal>('journal.json') : { version: 1, chainId: CHAIN_ID, planHash, entries: [], complete: false };
  if (journal.planHash !== planHash || journal.chainId !== CHAIN_ID || journal.entries.length > plan.steps.length) throw new TestnetError('Journal does not match immutable plan.');
  // Recheck confirmed history before resuming, even if a previous run marked completion.
  for (let i = 0; i < journal.entries.length; i++) {
    const entry = journal.entries[i];
    const step = plan.steps[i];
    if (entry.name !== step.name || (entry.status !== 'success' && i !== journal.entries.length - 1)) throw new TestnetError('Invalid journal sequence.');
    await assertIntent(entry.raw, entry.hash, step, plan.deployer);
    if (entry.status === 'reverted') throw new TestnetError('A transaction reverted; manual review required. No automatic redeployment.');
    if (entry.status !== 'success') continue;
    if (step.creates && !equal(entry.address, step.creates)) throw new TestnetError('Journal lacks expected created address.');
    const receipt = await client.getTransactionReceipt({ hash: entry.hash });
    if (receipt.status !== 'success' || receipt.blockHash !== entry.blockHash) throw new TestnetError('Receipt changed or reorganized; manual review required.');
    if (entry.address) {
      const code = await client.getCode({ address: entry.address });
      if (!code || keccak256(code) !== entry.codeHash) throw new TestnetError('Deployed runtime changed or missing.');
    }
  }
  if (journal.entries.length === plan.steps.length && journal.entries.every(e => e.status === 'success')) {
    await validateWiring(plan, loaded);
    journal.complete = true;
    if (broadcast) save(path, journal);
    console.log(json({ state: 'deployed-wiring-verified', chainId: CHAIN_ID, addresses: plan.addresses, broadcast: false,
      limitations: ['Launch/buy/sell/graduation and proof payout E2E have not been tested by this tool.'] }));
    return;
  }
  if (!broadcast) {
    const step = plan.steps[journal.entries.filter(e => e.status === 'success').length];
    const gas = await client.estimateGas({ account: plan.deployer, to: step.to, data: step.data, value: BigInt(step.value) });
    console.log(json({ state: 'partial-simulation-only', broadcast: false, nextStep: step.name, estimatedGas: gas,
      limitations: ['Only the next transaction was estimated against current chain state, not the dependent deployment sequence.'] }));
    return;
  }
  const account = loadDeployer(DIR, wallets);
  const wallet = createWalletClient({ account, chain, transport: http(rpc, { retryCount: 0, timeout: 20_000 }) });
  for (const step of plan.steps) {
    let entry = journal.entries[step.nonce];
    if (entry?.status === 'success') continue;
    await assertChain();
    if (!entry) {
      if (step.name === 'factory:setLaunchEnabled') await validateWiring(plan, loaded, false);
      const nonce = await client.getTransactionCount({ address: account.address, blockTag: 'pending' });
      if (nonce !== step.nonce) throw new TestnetError('Unexpected deployer nonce; refusing replacement or address drift.');
      const gasEstimate = await client.estimateGas({ account, to: step.to, data: step.data, value: BigInt(step.value) });
      const gas = gasEstimate * 125n / 100n;
      const gasPrice = (await client.getGasPrice()) * 2n;
      const balance = await client.getBalance({ address: account.address });
      if (balance < gas * gasPrice + BigInt(step.value) + GAS_RESERVE) throw new TestnetError('Insufficient testnet gas plus 0.005 ETH reserve.');
      const raw = await wallet.signTransaction({ chain, type: 'legacy', nonce, gas, gasPrice, to: step.to, data: step.data, value: BigInt(step.value) });
      entry = { name: step.name, raw, hash: keccak256(raw), status: 'signed' };
      journal.entries.push(entry);
      // Persist the exact signed intent before sending, closing the send/receipt crash window.
      save(path, journal);
    }
    let receipt;
    try { receipt = await client.getTransactionReceipt({ hash: entry.hash }); }
    catch (error) {
      if (!(error instanceof Error) || error.name !== 'TransactionReceiptNotFoundError') throw error;
    }
    if (!receipt) {
      let pending = false;
      try { await client.getTransaction({ hash: entry.hash }); pending = true; }
      catch (error) { if (!(error instanceof Error) || error.name !== 'TransactionNotFoundError') throw error; }
      if (!pending) {
        const nonce = await client.getTransactionCount({ address: account.address, blockTag: 'pending' });
        if (nonce > step.nonce) throw new TestnetError('Signed intent is missing but nonce is consumed; manual review required.');
        const tx = await assertIntent(entry.raw, entry.hash, step, account.address);
        if (await client.getBalance({ address: account.address }) < tx.gas! * tx.gasPrice! + BigInt(step.value) + GAS_RESERVE) {
          throw new TestnetError('Insufficient testnet gas plus 0.005 ETH reserve for persisted intent.');
        }
        await assertChain();
        await client.sendRawTransaction({ serializedTransaction: entry.raw });
      }
    }
    receipt = await client.waitForTransactionReceipt({ hash: entry.hash, confirmations: 2, timeout: 180_000 });
    if (receipt.transactionHash !== entry.hash) throw new TestnetError('Unexpected replacement transaction.');
    entry.blockNumber = receipt.blockNumber.toString();
    entry.blockHash = receipt.blockHash;
    if (receipt.status !== 'success') {
      entry.status = 'reverted';
      save(path, journal);
      throw new TestnetError('Deployment transaction reverted; review journal before continuing.');
    }
    if (step.creates) {
      if (!step.to && !equal(receipt.contractAddress, step.creates)) throw new TestnetError('Unexpected CREATE address.');
      const code = await client.getCode({ address: step.creates });
      if (!code || code === '0x') throw new TestnetError('Receipt succeeded but deployment code missing.');
      entry.address = step.creates;
      entry.codeHash = keccak256(code);
    }
    entry.status = 'success';
    save(path, journal);
    console.log(json({ step: step.name, hash: entry.hash, address: entry.address, status: entry.status }));
  }
  await validateWiring(plan, loaded);
  journal.complete = true;
  save(path, journal);
  console.log(json({ state: 'deployed-wiring-verified', addresses: plan.addresses,
    limitations: ['Launch/trading/graduation and proof payout E2E remain untested. Contracts are unaudited testnet copies.'] }));
}

async function main() {
  // Refuse initialization unless git already protects all generated private state.
  if (!readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n').some(line => line.trim() === '.testnet/')) {
    throw new Error('Root .gitignore must ignore .testnet/ before running this tool.');
  }
  if (command === 'init') {
    console.log(json({ state: 'wallets-created', ...initWallets(DIR), broadcast: false, next: 'Fund only these public addresses with testnet ETH. Then run status and prepare.' }));
    return;
  }
  secureDirectory(DIR);
  const wallets = read<Wallets>('wallets.json');
  if (wallets.chainId !== CHAIN_ID || wallets.purpose !== 'dockhood-dedicated-testnet') throw new Error('Not a dedicated testnet wallet manifest.');
  if (command === 'status') { await status(wallets); return; }
  const lock = join(DIR, 'operation.lock');
  const fd = openSync(lock, 'wx', 0o600);
  try {
    if (command === 'prepare') { if (!await prepare(wallets)) process.exitCode = 1; }
    else await deploy(wallets);
  } finally { closeSync(fd); unlinkSync(lock); }
}

main().catch(error => {
  // Never print viem errors: they can include the account, RPC URL and serialized request.
  console.error(json({ state: 'blocked', command, broadcastRequested: broadcast,
    reason: error instanceof TestnetError ? error.message : publicError(command) }));
  process.exitCode = 1;
});
