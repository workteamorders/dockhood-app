import { readFileSync } from 'node:fs';
import { Redis } from 'ioredis';
import { connectPostgres } from './db';
import { loadEnv } from './env';
import { dockerLeanRunner, type SandboxConfig } from './services/leanRunner';
import { rpcPool, rpcPoolWriter } from './services/poolChain';
import { memoryPubSub, redisPubSub } from './services/pubsub';
import { requeueStale, verifierTick } from './verification/worker';
import { assertRpcChain } from './services/network';

/**
 * The formal verification worker (hood-exe-formal-verification-brief.md §4): runs on the verifier VPS, next to
 * Docker, with the bot key. Every 10 s it picks up new submissions, compiles and checks queued proofs in the
 * sandbox (apps/verifier), and posts results on-chain: failures right away, verifications only once the admin has
 * approved them in /admin/verification.
 *
 *   pnpm --filter @hood/api verifier
 *
 * Needs DATABASE_URL, RPC_URL_SERVER, VERIFICATION_POOL_ADDRESS, VERIFIER_BOT_PRIVATE_KEY and Docker with the
 * verifier image (VERIFIER_IMAGE). REDIS_URL, when set, pushes the FORMAL ✓ callout live.
 */
const env = loadEnv();
for (const key of ['RPC_URL_SERVER', 'VERIFICATION_POOL_ADDRESS', 'VERIFIER_BOT_PRIVATE_KEY'] as const) {
  if (!env[key]) throw new Error(`The verifier worker needs ${key}.`);
}
await assertRpcChain(env.network);
const limits = JSON.parse(readFileSync(new URL('../../verifier/sandbox-config.json', import.meta.url), 'utf8')) as SandboxConfig;
const { db, close } = await connectPostgres(env.DATABASE_URL);
const redis = env.REDIS_URL ? new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, family: 0 }) : null;
const pubsub = redis ? redisPubSub(redis) : memoryPubSub();
const pool = rpcPool(env.network, env.VERIFICATION_POOL_ADDRESS as `0x${string}`);
const writer = rpcPoolWriter(env.network, pool.address, env.VERIFIER_BOT_PRIVATE_KEY as `0x${string}`);
const runner = dockerLeanRunner({
  ...limits,
  image: env.VERIFIER_IMAGE,
  timeoutSec: env.VERIFICATION_TIMEOUT_SEC,
  memoryMb: env.VERIFICATION_MEMORY_MB ?? limits.memoryMb,
  swapMb: env.VERIFICATION_SWAP_MB ?? limits.swapMb ?? 0,
});

const log = (msg: string) => console.log(`[verifier] ${new Date().toISOString()} ${msg}`);
const stale = await requeueStale(db);
if (stale) log(`requeued ${stale} proof(s) left mid-check`);
log(`bot ${writer.bot}, pool ${pool.address}, ${env.VERIFICATION_MAX_CONCURRENT} at a time`);

let running = false;
const tick = async () => {
  if (running) return;
  running = true;
  try {
    await verifierTick({ db, pool, writer, runner, pubsub, concurrency: env.VERIFICATION_MAX_CONCURRENT, now: () => new Date(), log });
  } catch (e) {
    log(`tick failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  } finally {
    running = false;
  }
};
await tick();
const timer = setInterval(tick, 10_000);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    clearInterval(timer);
    await Promise.all([pubsub.close(), close()]);
    await redis?.quit();
    process.exit(0);
  });
}
