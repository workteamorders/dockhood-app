import { chmodSync, existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getContractAddress, keccak256, parseAbi, type Abi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { assertIntent, buildPlan, INFRA, initWallets, mineHook, secureDirectory, verifiedArtifact, type Artifacts, type Wallets } from './testnet-lib';

describe('dedicated testnet wallets', () => {
  it('creates private state securely, publishes only distinct addresses and refuses overwrite', () => {
    const parent = mkdtempSync(join(tmpdir(), 'dockhood-testnet-'));
    try {
      const dir = join(parent, '.testnet');
      const result = initWallets(dir);
      expect(lstatSync(dir).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(dir, 'secrets.json')).mode & 0o777).toBe(0o600);
      expect(new Set(Object.values(result.addresses)).size).toBe(3);
      expect(result).not.toHaveProperty('keys');
      expect(result.chainId).toBe(46630);
      expect(() => initWallets(dir)).toThrow('refusing to overwrite');
      expect(existsSync(join(dir, 'wallets.json'))).toBe(true);
      chmodSync(dir, 0o755);
      expect(() => secureDirectory(dir)).toThrow('Unsafe');
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it('rejects symlink state directories', () => {
    const parent = mkdtempSync(join(tmpdir(), 'dockhood-testnet-'));
    try {
      const link = join(parent, 'link');
      symlinkSync(parent, link);
      expect(() => secureDirectory(link)).toThrow('Unsafe');
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });
});

describe('verified artifact guards', () => {
  const address = '0x0000000000000000000000000000000000000001';
  const raw = { chainId: '4663', address, compilation: { name: 'Test', compilerSettings: { libraries: {} } },
    creationMatch: 'exact_match', runtimeMatch: 'match', abi: [], stdJsonInput: { sources: {} },
    creationBytecode: { recompiledBytecode: '0x60006000', linkReferences: {} } };
  it('requires verified source, chain, address and unlinked bytecode', () => {
    expect(verifiedArtifact(raw, address, 'Test', 'sourcify').bytecode).toBe('0x60006000');
    expect(() => verifiedArtifact({ ...raw, chainId: '46630' }, address, 'Test', '')).toThrow('unexpected');
    expect(() => verifiedArtifact({ ...raw, runtimeMatch: null }, address, 'Test', '')).toThrow('Unverified');
    expect(() => verifiedArtifact({ ...raw, stdJsonInput: null }, address, 'Test', '')).toThrow('Missing');
    expect(() => verifiedArtifact({ ...raw, creationBytecode: { ...raw.creationBytecode, linkReferences: { library: [] } } }, address, 'Test', '')).toThrow('linked');
  });
});

describe('deployment plan', () => {
  const wallets: Wallets = { version: 1, chainId: 46630, purpose: 'dockhood-dedicated-testnet', addresses: {
    deployer: '0x0000000000000000000000000000000000000001', verifier: '0x0000000000000000000000000000000000000002', trader: '0x0000000000000000000000000000000000000003',
  } };
  const common = parseAbi(['function setFactory(address)', 'function setBuybackVault(address)', 'function setVerificationPool(address)',
    'function setSubmissionFee(uint256)', 'function setMinPoolBalance(uint256)', 'function setRewardAmount(uint8,uint256)',
    'function setGraduationExecutor(address)', 'function setLaunchDeployer(address)', 'function setLaunchForwarder(address)',
    'function setLaunchEnabled(bool)', 'function addLaunchConfig((uint256 supply,uint256 curveFeeBps,uint256 phantomQuote,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,bool enabled))']);
  const constructors: Record<string, string> = {
    RigorRegistry: 'constructor(address)', VerificationPool: 'constructor(address,address,address)', FeeSplitter: 'constructor(address,address,address)',
    PonsV2FeeEscrow: 'constructor()', PonsV2LaunchLocker: 'constructor(address,address)', PonsV2MemeHook: 'constructor(address,address,address,address)',
    PonsV2BuybackVault: 'constructor(address,address,address)', PonsV2LaunchFactory: 'constructor(address,address,address,address,address,address,address,address,uint256)',
    PonsV2GraduationExecutor: 'constructor(address,address,address,address)', PonsV2LaunchDeployer: 'constructor(address)', PonsV2LaunchAndBuy: 'constructor(address,address)',
  };
  const artifacts: Artifacts = Object.fromEntries(Object.entries(constructors).map(([name, ctor]) => [name, {
    abi: [...parseAbi([ctor]), ...common] as Abi, bytecode: '0x60006000', provenance: 'test', sha256: name,
  }]));
  it('mines real CREATE2 flags and fails closed on exhaustion', () => {
    const hook = mineHook('0x60006000');
    expect(BigInt(hook.address) & 0x3fffn).toBe(0x2044n);
    expect(() => mineHook('0x60006000', 0)).toThrow('exhausted');
  });
  it('uses contiguous nonces, an internal guard, and opens launches last', () => {
    const plan = buildPlan(wallets, artifacts);
    expect(plan.chainId).toBe(46630);
    expect(plan.steps.map(s => s.nonce)).toEqual(plan.steps.map((_, i) => i));
    expect(plan.steps.filter(s => s.name === 'deploy:guard')).toHaveLength(0);
    expect(plan.addresses.guard).toBe(getContractAddress({ from: plan.addresses.factory, nonce: 1n }));
    expect(plan.steps[5].to).toBe(INFRA.proxy);
    expect(plan.steps[5].creates).toBe(plan.addresses.hook);
    expect(plan.steps.at(-1)?.name).toBe('factory:setLaunchEnabled');
    expect(plan.steps.some(s => s.name === 'factory:setLaunchForwarder')).toBe(true);
    expect(buildPlan(wallets, artifacts)).toEqual(plan);
  });
  it('resumes only the exact signed intent, wallet, step and testnet chain', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const step = { name: 'test', nonce: 0, to: INFRA.poolManager, data: '0x' as const, value: '0' };
    const tx = { chainId: 46630, type: 'legacy' as const, nonce: 0, to: step.to, data: step.data, value: 0n, gas: 21000n, gasPrice: 1n };
    const raw = await account.signTransaction(tx);
    await expect(assertIntent(raw, keccak256(raw), step, account.address)).resolves.toHaveProperty('chainId', 46630);
    await expect(assertIntent(raw, keccak256(raw), { ...step, nonce: 1 }, account.address)).rejects.toThrow('does not match');
    await expect(assertIntent(raw, keccak256(raw), step, wallets.addresses.deployer)).rejects.toThrow('does not match');
    const mainnet = await account.signTransaction({ ...tx, chainId: 4663 });
    await expect(assertIntent(mainnet, keccak256(mainnet), step, account.address)).rejects.toThrow('does not match');
  });
});
