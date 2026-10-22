import { Redis } from 'ioredis';
import { connectPostgres } from './db';
import { loadEnv } from './env';
import { envioClient } from './services/envio';
import { redisPubSub } from './services/pubsub';
import { activityTick } from './activity';
import { systemCalloutsTick } from './systemCallouts';
import { pruneIndexer } from './services/indexerPrune';
import { assertRpcChain } from './services/network';

/**
 * The always-on worker (docs/BRIEF.md §9): every 10 s, system callouts for hood.exe coins and the live trade
 * balloons ($HEXE and hood coins). Runs from the
 * API's image as a second Railway service (`pnpm --filter @hood/api worker`). Needs Redis: its callouts
 * reach the API's WebSockets through pub/sub.
 */
const env = loadEnv();
if (!env.REDIS_URL) throw new Error('The worker needs REDIS_URL to reach the API.');
await assertRpcChain(env.network);
const envio = env.ENVIO_GRAPHQL_URL ? envioClient(env.ENVIO_GRAPHQL_URL, env.network, 1_000, { background: 20 }) : undefined;
const { db, close } = await connectPostgres(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, family: 0 });
const pubsub = redisPubSub(redis);
// Its share of Envio's per-minute query limit; the API takes 60 (src/index.ts).
if (!envio) console.warn('No ENVIO_GRAPHQL_URL: big-buy callouts and trade balloons are off; launches and graduations still post.');

const log = (msg: string) => console.log(`[worker] ${new Date().toISOString()} ${msg}`);
let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    await systemCalloutsTick({ db, pubsub, envio, now: () => new Date(), log });
  } catch (e) {
    log(`tick failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
  // Separate, so a failure in one doesn't hold up the other.
  try {
    if (envio) await activityTick({ db, pubsub, envio, network: env.network, now: () => new Date(), log });
  } catch (e) {
    log(`activity tick failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  } finally {
    running = false;
  }
}

await tick();
const timer = setInterval(tick, 10_000);
log('running every 10 s');

// Hourly: keep the self-hosted indexer's database inside its volume (services/indexerPrune.ts).
let pruneTimer: ReturnType<typeof setInterval> | undefined;
let closeIndexerDb = async () => {};
if (env.INDEXER_DATABASE_URL) {
  const { default: postgres } = await import('postgres');
  const indexerSql = postgres(env.INDEXER_DATABASE_URL, { max: 2, onnotice: () => {} });
  closeIndexerDb = () => indexerSql.end({ timeout: 5 });
  let pruning = false;
  const prune = async () => {
    if (pruning) return;
    pruning = true;
    try {
      const started = Date.now();
      const res = await pruneIndexer(async (text, params) => (await indexerSql.unsafe(text, params as never[])).count, Math.floor(Date.now() / 1_000));
      log(`pruned indexer: ${res.trades} trades, ${res.candles} candles in ${Math.round((Date.now() - started) / 1_000)} s`);
    } catch (e) {
      log(`indexer prune failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    } finally {
      pruning = false;
    }
  };
  setTimeout(() => void prune(), 60_000);
  pruneTimer = setInterval(() => void prune(), 3_600_000);
  log('pruning the indexer database hourly');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    clearInterval(timer);
    if (pruneTimer) clearInterval(pruneTimer);
    await Promise.all([pubsub.close(), close(), closeIndexerDb()]);
    await redis.quit();
    process.exit(0);
  });
}
