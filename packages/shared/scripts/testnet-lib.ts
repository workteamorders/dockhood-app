import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  concatHex, encodeDeployData, encodeFunctionData, getContractAddress, keccak256, parseEther, parseTransaction, recoverTransactionAddress, toHex,
  type Abi, type Address, type Hex, type TransactionSerialized,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

export const CHAIN_ID = 46630;
export const RPC = 'https://rpc.testnet.chain.robinhood.com';
export const INFRA = {
  poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  positionManager: '0x58daec3116aae6d93017baaea7749052e8a04fa7',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  proxy: '0x4e59b44847b379578588920cA78FbF26c0B4956C',
} as const;
export const PROXY_CODE: Hex = '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3';
export const PONS = {
  factory: ['0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e', 'PonsV2LaunchFactory'],
  router: ['0xe33E9E479dF8802cb0866d5d05258bEc4cF62948', 'PonsV2LaunchAndBuy'],
  locker: ['0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952', 'PonsV2LaunchLocker'],
  hook: ['0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044', 'PonsV2MemeHook'],
  escrow: ['0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e', 'PonsV2FeeEscrow'],
  vault: ['0x42df2a798f82289E177311362e8f5ccC45c1219c', 'PonsV2BuybackVault'],
  executor: ['0xC7819B64A1dAECD7eC19856d026cb14EfBd89046', 'PonsV2GraduationExecutor'],
  launchDeployer: ['0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42', 'PonsV2LaunchDeployer'],
} as const;
// This exact mainnet locker predates the Pons rename; retain its real verified provenance.
export const VERIFIED_NAMES: Record<string, string> = { PonsV2LaunchLocker: 'RobinFunFiV2LaunchLocker' };
export const ROLES = ['deployer', 'verifier', 'trader'] as const;
export type Role = typeof ROLES[number];
export type Wallets = { version: 1; chainId: 46630; purpose: 'dockhood-dedicated-testnet'; addresses: Record<Role, Address> };
export type Artifact = { abi: Abi; bytecode: Hex; provenance: string; sha256: string };
export type Artifacts = Record<string, Artifact>;
export type Step = { name: string; nonce: number; to?: Address; data: Hex; creates?: Address; value: string };
export type Plan = {
  version: 1; chainId: 46630; deployer: Address; addresses: Record<string, Address>;
  artifacts: Record<string, string>; steps: Step[];
};
export const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n';
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export class TestnetError extends Error {}

export async function assertIntent(raw: Hex, hash: Hex, step: Step, deployer: Address) {
  const tx = parseTransaction(raw);
  if (keccak256(raw) !== hash || tx.chainId !== CHAIN_ID || tx.nonce !== step.nonce ||
      (tx.to ?? '').toLowerCase() !== (step.to ?? '').toLowerCase() || (tx.data ?? '0x') !== step.data ||
      (tx.value ?? 0n) !== BigInt(step.value) || tx.type !== 'legacy' ||
      (await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized })).toLowerCase() !== deployer.toLowerCase()) {
    throw new TestnetError('Signed journal intent does not match the dedicated wallet, chain and deployment step.');
  }
  return tx;
}

export function secureDirectory(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid?.()) {
    throw new TestnetError('Unsafe .testnet directory: require an owned, non-symlink directory with mode 0700.');
  }
}

export function save(path: string, value: unknown, exclusive = false) {
  const target = exclusive ? path : `${path}.tmp`;
  const fd = openSync(target, 'wx', 0o600);
  try {
    writeFileSync(fd, json(value));
    fsyncSync(fd);
  } finally { closeSync(fd); }
  if (!exclusive) renameSync(target, path);
  const dirFd = openSync(dirname(path), 'r');
  try { fsyncSync(dirFd); }
  finally { closeSync(dirFd); }
}

export function initWallets(dir: string): Wallets {
  secureDirectory(dir);
  const secretsPath = join(dir, 'secrets.json');
  if (existsSync(secretsPath) || existsSync(join(dir, 'wallets.json'))) throw new TestnetError('Wallet already exists; refusing to overwrite.');
  const keys = Object.fromEntries(ROLES.map(role => [role, generatePrivateKey()])) as Record<Role, Hex>;
  const wallets: Wallets = {
    version: 1, chainId: CHAIN_ID, purpose: 'dockhood-dedicated-testnet',
    addresses: Object.fromEntries(ROLES.map(role => [role, privateKeyToAccount(keys[role]).address])) as Record<Role, Address>,
  };
  save(secretsPath, { ...wallets, keys }, true);
  save(join(dir, 'wallets.json'), wallets, true);
  return wallets;
}

// This is the only secret reader. init, status and prepare never call it.
export function loadDeployer(dir: string, wallets: Wallets) {
  secureDirectory(dir);
  const path = join(dir, 'secrets.json');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) {
    throw new TestnetError('Unsafe secrets file: require an owned, regular file with mode 0600 and one link.');
  }
  const secret = JSON.parse(readFileSync(path, 'utf8'));
  if (secret.purpose !== wallets.purpose || secret.chainId !== CHAIN_ID || secret.version !== 1) throw new TestnetError('Not a dedicated testnet wallet.');
  for (const role of ROLES) {
    if (privateKeyToAccount(secret.keys[role]).address !== wallets.addresses[role]) throw new TestnetError('Wallet address mismatch.');
  }
  return privateKeyToAccount(secret.keys.deployer);
}

export function verifiedArtifact(raw: any, address: string, name: string, provenance: string): Artifact {
  if (String(raw.chainId) !== '4663' || raw.address?.toLowerCase() !== address.toLowerCase() || raw.compilation?.name !== name ||
      !['match', 'exact_match'].includes(raw.creationMatch) || !['match', 'exact_match'].includes(raw.runtimeMatch)) {
    throw new Error(`Unverified or unexpected Sourcify artifact: ${name}`);
  }
  const bytecode = raw.creationBytecode?.recompiledBytecode;
  if (!/^0x[0-9a-f]+$/i.test(bytecode ?? '') || bytecode.length < 4 || !Array.isArray(raw.abi) ||
      !raw.stdJsonInput?.sources || !raw.compilation?.compilerSettings ||
      Object.keys(raw.creationBytecode.linkReferences ?? {}).length ||
      Object.keys(raw.compilation.compilerSettings.libraries ?? {}).length) {
    throw new Error(`Missing source/compiler data or linked libraries in ${name}`);
  }
  return { abi: raw.abi, bytecode, provenance, sha256: digest(json(raw)) };
}

export function mineHook(initCode: Hex, limit = 1_000_000) {
  const bytecodeHash = keccak256(initCode);
  for (let i = 0; i < limit; i++) {
    const salt = toHex(i, { size: 32 });
    const address = getContractAddress({ opcode: 'CREATE2', from: INFRA.proxy, salt, bytecodeHash });
    if ((BigInt(address) & 0x3fffn) === 0x2044n) return { salt, address };
  }
  throw new Error('Hook salt search exhausted; no deployment plan was produced.');
}

export function buildPlan(wallets: Pick<Wallets, 'addresses'>, artifacts: Artifacts): Plan {
  const owner = wallets.addresses.deployer;
  const addresses: Record<string, Address> = {};
  const steps: Step[] = [];
  const predict = (nonce: number) => getContractAddress({ from: owner, nonce: BigInt(nonce) });
  addresses.registry = predict(0);
  addresses.pool = predict(1);
  addresses.splitter = predict(2);
  addresses.escrow = predict(3);
  addresses.locker = predict(4);
  const creation = (name: string, args: readonly unknown[]) => {
    const a = artifacts[name];
    if (!a) throw new Error(`Missing artifact: ${name}`);
    return encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args });
  };
  const deploy = (key: string, artifact: string, args: readonly unknown[]) => {
    const nonce = steps.length;
    addresses[key] = predict(nonce);
    steps.push({ name: `deploy:${key}`, nonce, data: creation(artifact, args), creates: addresses[key], value: '0' });
  };
  const call = (key: string, artifact: string, functionName: string, args: readonly unknown[]) => {
    steps.push({ name: `${key}:${functionName}`, nonce: steps.length, to: addresses[key],
      data: encodeFunctionData({ abi: artifacts[artifact].abi, functionName, args }), value: '0' });
  };
  deploy('registry', 'RigorRegistry', [owner]);
  deploy('pool', 'VerificationPool', [owner, wallets.addresses.verifier, addresses.registry]);
  deploy('splitter', 'FeeSplitter', [owner, owner, addresses.pool]);
  deploy('escrow', 'PonsV2FeeEscrow', []);
  deploy('locker', 'PonsV2LaunchLocker', [owner, INFRA.positionManager]);
  const hookCode = creation('PonsV2MemeHook', [INFRA.poolManager, addresses.escrow, addresses.splitter, owner]);
  const hook = mineHook(hookCode);
  addresses.hook = hook.address;
  steps.push({ name: 'deploy:hook', nonce: steps.length, to: INFRA.proxy, data: concatHex([hook.salt, hookCode]), creates: hook.address, value: '0' });
  deploy('vault', 'PonsV2BuybackVault', [owner, addresses.hook, addresses.escrow]);
  deploy('factory', 'PonsV2LaunchFactory', [owner, INFRA.poolManager, INFRA.positionManager, INFRA.permit2,
    addresses.locker, addresses.hook, addresses.escrow, addresses.vault, parseEther('0.00001')]);
  // The verified factory constructor performs exactly one CREATE, for this guard.
  addresses.guard = getContractAddress({ from: addresses.factory, nonce: 1n });
  deploy('executor', 'PonsV2GraduationExecutor', [INFRA.positionManager, INFRA.permit2, addresses.locker, addresses.factory]);
  deploy('launchDeployer', 'PonsV2LaunchDeployer', [addresses.factory]);
  deploy('router', 'PonsV2LaunchAndBuy', [addresses.factory, owner]);
  call('registry', 'RigorRegistry', 'setVerificationPool', [addresses.pool]);
  call('pool', 'VerificationPool', 'setSubmissionFee', [parseEther('0.00001')]);
  call('pool', 'VerificationPool', 'setMinPoolBalance', [parseEther('0.0001')]);
  for (let tier = 0; tier < 5; tier++) call('pool', 'VerificationPool', 'setRewardAmount', [tier, parseEther('0.00001') * BigInt(tier + 1)]);
  call('locker', 'PonsV2LaunchLocker', 'setFactory', [addresses.factory]);
  call('hook', 'PonsV2MemeHook', 'setFactory', [addresses.factory]);
  call('hook', 'PonsV2MemeHook', 'setBuybackVault', [addresses.vault]);
  call('vault', 'PonsV2BuybackVault', 'setFactory', [addresses.factory]);
  call('factory', 'PonsV2LaunchFactory', 'setGraduationExecutor', [addresses.executor]);
  call('factory', 'PonsV2LaunchFactory', 'setLaunchDeployer', [addresses.launchDeployer]);
  call('factory', 'PonsV2LaunchFactory', 'setLaunchForwarder', [addresses.router]);
  call('factory', 'PonsV2LaunchFactory', 'addLaunchConfig', [{ supply: parseEther('1000000000'), curveFeeBps: 100n,
    phantomQuote: parseEther('0.01'), graduationThreshold: parseEther('0.02'), poolFee: 0, tickSpacing: 200, enabled: true }]);
  steps.push({ name: 'fund:pool', nonce: steps.length, to: addresses.pool, data: '0x', value: parseEther('0.001').toString() });
  // Open the public gate only after all wiring and economics transactions have confirmed.
  call('factory', 'PonsV2LaunchFactory', 'setLaunchEnabled', [true]);
  return { version: 1, chainId: CHAIN_ID, deployer: owner, addresses,
    artifacts: Object.fromEntries(Object.entries(artifacts).map(([name, a]) => [name, a.sha256])), steps };
}
