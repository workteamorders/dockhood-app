import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dockerLeanRunner, type SandboxConfig } from '../src/services/leanRunner';

// No env files, API, database, RPC, or signing keys: exercise only the production Docker runner.
const workDir = fileURLToPath(new URL('../../../.testnet/sandbox/', import.meta.url));
await mkdir(workDir, { recursive: true, mode: 0o700 });
const limits = JSON.parse(await readFile(new URL('../../verifier/sandbox-config.json', import.meta.url), 'utf8')) as SandboxConfig;
const cfg: SandboxConfig = { ...limits, workDir, memoryMb: 4096, swapMb: 0, cpus: 2, timeoutSec: 120, checkTimeoutSec: 120 };
const image = JSON.parse(execFileSync('docker', ['image', 'inspect', cfg.image], { encoding: 'utf8' }))[0];
console.log(JSON.stringify({ image: cfg.image, imageId: image.Id, architecture: image.Architecture, cfg, concurrency: 1 }));

const runner = dockerLeanRunner(cfg);
const cases = [
  { name: 'valid', source: 'theorem smokeValid : (2 : Nat) + 2 = 4 := by norm_num', status: 'passed' },
  { name: 'invalid', source: 'theorem smokeInvalid : (2 : Nat) + 2 = 5 := by norm_num', status: 'failed' },
  { name: 'sorry', source: 'theorem smokeSorry : (2 : Nat) + 2 = 4 := by sorry', status: 'failed', axiom: 'sorryAx' },
  { name: 'axiom', source: 'axiom smokeAssumption : (2 : Nat) + 2 = 4\ntheorem smokeAxiom : (2 : Nat) + 2 = 4 := smokeAssumption', status: 'failed', axiom: 'smokeAssumption' },
] as const;
const started = Date.now();
for (const test of cases) {
  const start = Date.now();
  const result = await runner.verify(`import Mathlib.Tactic.NormNum\n${test.source}\n`);
  console.log(JSON.stringify({ case: test.name, durationMs: Date.now() - start, ...result }));
  assert.equal(result.status, test.status, test.name);
  if (test.name === 'invalid') {
    assert.equal(result.verdict, null, 'invalid proof must fail compilation');
    assert.match(result.errorSummary ?? '', /unsolved goals|error/i);
  } else {
    assert.equal(result.verdict?.ok, test.name === 'valid', test.name);
    assert.equal(result.verdict?.theorems.length, 1, test.name);
    const theorem = result.verdict!.theorems[0];
    assert.equal(theorem.ok, test.name === 'valid', test.name);
    if ('axiom' in test) assert.ok(theorem.axioms.includes(test.axiom), `${test.name}: missing expected axiom`);
    else assert.ok(theorem.axioms.every((a) => ['propext', 'Classical.choice', 'Quot.sound'].includes(a)));
  }
}
console.log(JSON.stringify({ smoke: 'passed', cases: cases.length, durationMs: Date.now() - started }));
