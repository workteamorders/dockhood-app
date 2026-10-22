#!/usr/bin/env node
/**
 * Runs an indexer command natively on Linux/macOS, and inside the compose `indexer` container on Windows,
 * where envio has no build (its CLI and test runtime are native binaries).
 *
 *   node scripts/envio.mjs codegen        envio codegen (types for config.yaml + schema.graphql)
 *   node scripts/envio.mjs test           vitest run: the main indexer's handlers, then the verification indexer's
 *                                         (config.verification.yaml, its own schema and handlers)
 *   node scripts/envio.mjs ensure-types   codegen only if .envio/types.d.ts is missing (before tsc)
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const commands = { codegen: ['npx', 'envio', 'codegen'] };

/** Runs a command; `config` overrides ENVIO_CONFIG. Returns its exit status. */
function run(args, config) {
  const native = process.platform !== 'win32';
  const [cmd, ...rest] = native
    ? args
    : ['docker', 'compose', '--profile', 'indexer', 'run', '--rm', '--no-deps', '--build', ...(config ? ['-e', `ENVIO_CONFIG=${config}`] : []), 'indexer', ...args];
  const result = spawnSync(cmd, rest, {
    cwd: native ? here : join(here, '..', '..'),
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: native && config ? { ...process.env, ENVIO_CONFIG: config } : process.env,
  });
  if (result.error) {
    console.error(native ? result.error.message : `Docker is needed to run envio on Windows: ${result.error.message}`);
    process.exit(1);
  }
  return result.status ?? 1;
}

const task = process.argv[2];
if (task === 'ensure-types') {
  if (existsSync(join(here, '.envio', 'types.d.ts'))) process.exit(0);
  process.exit(run(commands.codegen));
} else if (task === 'test') {
  const testnet = run(['node', '--test', 'scripts/render-testnet.test.mjs']);
  const main = run(['npx', 'vitest', 'run', 'src/handlers']);
  const verification = run(['npx', 'vitest', 'run', 'src/verification'], 'config.verification.yaml');
  process.exit(testnet || main || verification);
} else if (task in commands) {
  process.exit(run(commands[task]));
} else {
  console.error(`Unknown task "${task}". Use codegen, test or ensure-types.`);
  process.exit(1);
}
