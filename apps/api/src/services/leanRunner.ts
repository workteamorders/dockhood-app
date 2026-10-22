import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CheckVerdict } from '@hood/shared';

/** The outcome of checking one proof. */
export type LeanResult = {
  status: 'passed' | 'failed';
  verdict: CheckVerdict | null;
  /** For the submitter when it failed: the compiler's errors (first 50 lines) or the checker's reason. */
  errorSummary: string | null;
  compileMs: number;
};

export interface LeanRunner {
  verify(source: string): Promise<LeanResult>;
}

export type SandboxConfig = {
  image: string;
  timeoutSec: number;
  checkTimeoutSec: number;
  memoryMb: number;
  /** Swap the container may add on top of memoryMb (0: none). Lets a smaller machine check big Mathlib proofs, slowly. */
  swapMb?: number;
  cpus: number;
  pidsLimit: number;
  tmpfsMb: number;
  /** Existing Docker-shared parent for private per-proof directories; defaults to the OS temp directory. */
  workDir?: string;
};

/** Thrown when the sandbox itself failed (Docker down, image missing): the proof is retried, not failed. */
export class RunnerError extends Error {}

const MAX_SUMMARY_LINES = 50;

/**
 * The docker run flags for one step (brief §4.5): no network, read-only root, a small writable /tmp, hard memory
 * (no swap), CPU and process limits, every capability dropped, no privilege escalation, an unprivileged user.
 */
export function sandboxArgs(cfg: SandboxConfig, name: string, mounts: string[], env: Record<string, string> = {}): string[] {
  return [
    'run',
    '--rm',
    '--name', name,
    '--network', 'none',
    '--read-only',
    '--tmpfs', `/tmp:rw,size=${cfg.tmpfsMb}m,mode=1777`,
    '--memory', `${cfg.memoryMb}m`,
    '--memory-swap', `${cfg.memoryMb + (cfg.swapMb ?? 0)}m`,
    '--cpus', String(cfg.cpus),
    '--pids-limit', String(cfg.pidsLimit),
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', '10001:10001',
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    ...mounts.flatMap((m) => ['-v', m]),
    cfg.image,
  ];
}

/** The compiler's error lines, for the submitter. */
export function summarizeCompileLog(log: string): string {
  const lines = log.split('\n');
  const errors = lines.filter((l) => /\berror\b/i.test(l));
  return (errors.length ? errors : lines).slice(0, MAX_SUMMARY_LINES).join('\n').trim() || 'The proof did not compile.';
}

/** Why the checker refused a compiled proof, in a sentence. */
export function summarizeVerdict(v: CheckVerdict): string {
  if (v.error) return v.error;
  const bad = v.theorems.filter((t) => !t.ok);
  return bad.length
    ? bad.map((t) => `${t.name} relies on ${t.axioms.filter((a) => !['propext', 'Classical.choice', 'Quot.sound'].includes(a)).join(', ') || 'disallowed axioms'}`).join('; ')
    : 'The checker refused the proof.';
}

type Run = { code: number | null; stdout: string; stderr: string };

function docker(args: string[], timeoutMs: number, name: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout = (stdout + d).slice(-1_000_000)));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-100_000)));
    // Belt and braces: the container has its own timeout; this one kills it from outside if that fails.
    const timer = setTimeout(() => spawn('docker', ['kill', name], { stdio: 'ignore' }), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new RunnerError(`docker: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Runs a proof through the verifier image in two containers: an untrusted compile (the proof's code runs there),
 * then, once that container and every process in it are gone, the trusted check against the compiled file
 * mounted read-only. Only the check's own output decides the verdict.
 */
export function dockerLeanRunner(cfg: SandboxConfig): LeanRunner {
  return {
    async verify(source) {
      const root = await mkdtemp(join(resolve(cfg.workDir ?? tmpdir()), 'hood-verify-'));
      const work = join(root, 'work');
      const out = join(root, 'out');
      const id = randomUUID().slice(0, 12);
      try {
        await mkdir(work);
        await mkdir(out);
        await writeFile(join(work, 'proof.lean'), source, { mode: 0o444 });
        await chmod(out, 0o777); // the container's unprivileged user writes the compiled proof here

        const started = Date.now();
        const compile = await docker(
          [...sandboxArgs(cfg, `hood-verify-${id}-compile`, [`${work}:/work:ro`, `${out}:/out:rw`], { VERIFY_TIMEOUT_SEC: String(cfg.timeoutSec) }), 'compile'],
          (cfg.timeoutSec + 120) * 1000,
          `hood-verify-${id}-compile`,
        );
        const compileMs = Date.now() - started;
        const log = await readFile(join(out, 'compile.log'), 'utf8').catch(() => '');
        if (compile.code === 124) return { status: 'failed', verdict: null, errorSummary: `Timed out after ${cfg.timeoutSec} s.`, compileMs };
        if (compile.code !== 0) {
          // 125–127: Docker couldn't start the container at all; that's ours to fix, not the proof's fault.
          if (compile.code === null || compile.code >= 125) throw new RunnerError(`compile container failed (${compile.code}): ${compile.stderr.slice(-500)}`);
          return { status: 'failed', verdict: null, errorSummary: summarizeCompileLog(log), compileMs };
        }

        const check = await docker([...sandboxArgs(cfg, `hood-verify-${id}-check`, [`${out}:/out:ro`]), 'check'], cfg.checkTimeoutSec * 1000, `hood-verify-${id}-check`);
        const line = check.stdout.trim().split('\n').at(-1) ?? '';
        let verdict: CheckVerdict;
        try {
          verdict = JSON.parse(line) as CheckVerdict;
        } catch {
          throw new RunnerError(`checker gave no verdict (${check.code}): ${check.stderr.slice(-500)}`);
        }
        return verdict.ok && check.code === 0
          ? { status: 'passed', verdict, errorSummary: null, compileMs: Date.now() - started }
          : { status: 'failed', verdict, errorSummary: summarizeVerdict(verdict), compileMs: Date.now() - started };
      } finally {
        await rm(root, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
