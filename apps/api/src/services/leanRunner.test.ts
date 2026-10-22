import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dockerLeanRunner, RunnerError, sandboxArgs, type SandboxConfig } from './leanRunner';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));

const cfg: SandboxConfig = { image: 'hoodexe/verifier:latest', timeoutSec: 120, checkTimeoutSec: 120, memoryMb: 4096, cpus: 2, pidsLimit: 256, tmpfsMb: 1024 };
const parents: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(parents.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function sharedParent() {
  const parent = await mkdtemp(join(tmpdir(), 'hood-runner-test-'));
  parents.push(parent);
  return parent;
}

function mockDocker(run: (args: string[]) => Promise<{ code: number; stdout?: string; stderr?: string }>) {
  spawn.mockImplementation((_command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    setImmediate(async () => {
      try {
        const result = await run(args);
        child.stdout.emit('data', result.stdout ?? '');
        child.stderr.emit('data', result.stderr ?? '');
        child.emit('close', result.code);
      } catch (error) {
        child.emit('error', error);
      }
    });
    return child;
  });
}

describe('Docker Lean runner', () => {
  it('keeps all sandbox restrictions and disables swap by default', () => {
    expect(sandboxArgs(cfg, 'test', ['/source:/work:ro'])).toEqual([
      'run', '--rm', '--name', 'test', '--network', 'none', '--read-only',
      '--tmpfs', '/tmp:rw,size=1024m,mode=1777', '--memory', '4096m', '--memory-swap', '4096m',
      '--cpus', '2', '--pids-limit', '256', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--user', '10001:10001', '-v', '/source:/work:ro', cfg.image,
    ]);
  });

  it('uses a private shared parent, then a separate read-only checker, and cleans up', async () => {
    const workDir = await sharedParent();
    const source = 'theorem test : True := True.intro';
    const verdict = { ok: true, theorems: [{ name: 'test', statement: 'True', axioms: [], ok: true }], error: null };
    let output = '';
    let compileName = '';
    mockDocker(async (args) => {
      const mounts = args.filter((_arg, i) => args[i - 1] === '-v');
      if (args.at(-1) === 'compile') {
        const work = mounts[0].slice(0, -':/work:ro'.length);
        output = mounts[1].slice(0, -':/out:rw'.length);
        expect(dirname(dirname(work))).toBe(workDir);
        expect((await stat(dirname(work))).mode & 0o777).toBe(0o700);
        expect((await stat(output)).mode & 0o777).toBe(0o777);
        expect((await stat(join(work, 'proof.lean'))).mode & 0o777).toBe(0o444);
        expect(await readFile(join(work, 'proof.lean'), 'utf8')).toBe(source);
        expect(args).toContain('VERIFY_TIMEOUT_SEC=120');
        compileName = args[args.indexOf('--name') + 1];
        return { code: 0 };
      }
      expect(args.at(-1)).toBe('check');
      expect(args[args.indexOf('--name') + 1]).not.toBe(compileName);
      expect(mounts).toEqual([`${output}:/out:ro`]);
      return { code: 0, stdout: JSON.stringify(verdict) };
    });
    expect(await dockerLeanRunner({ ...cfg, workDir }).verify(source)).toMatchObject({ status: 'passed', verdict, errorSummary: null });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(await readdir(workDir)).toEqual([]);
  });

  it('reports compiler errors without launching the checker and cleans up', async () => {
    const workDir = await sharedParent();
    mockDocker(async (args) => {
      const output = args.find((arg) => arg.endsWith(':/out:rw'))!.slice(0, -':/out:rw'.length);
      await writeFile(join(output, 'compile.log'), 'warning: example\nerror: unsolved goals\n');
      return { code: 1 };
    });
    expect(await dockerLeanRunner({ ...cfg, workDir }).verify('broken')).toMatchObject({ status: 'failed', verdict: null, errorSummary: 'error: unsolved goals' });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(await readdir(workDir)).toEqual([]);
  });

  it('treats Docker mount failures as infrastructure errors and cleans up', async () => {
    const workDir = await sharedParent();
    mockDocker(async () => ({ code: 125, stderr: 'mount denied' }));
    await expect(dockerLeanRunner({ ...cfg, workDir }).verify('proof')).rejects.toThrow(RunnerError);
    expect(await readdir(workDir)).toEqual([]);
  });
});
