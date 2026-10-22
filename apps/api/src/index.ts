import { Redis } from 'ioredis';
import { buildApp } from './app';
import { connectPostgres } from './db';
import { loadEnv } from './env';
import { memoryKv, redisKv } from './kv';
import { rpcChainReader } from './services/chain';
import { rpcPool } from './services/poolChain';
import { devPinner, pinataPinner } from './services/pinner';
import { allowAllModerator, deepseekModerator } from './services/moderation';
import { memoryPubSub, redisPubSub } from './services/pubsub';
import { deepseekScorer, offlineScorer } from './services/scorer';
import { envioClient, envioLaunchSource } from './services/envio';
import { rpcLaunchSource, tokenIndex } from './services/tokenIndex';
import { assertRpcChain } from './services/network';

const env = loadEnv();
const { network } = env;
await assertRpcChain(network);
// Unscoped token/trade queries require a single-chain indexer matching this deployment.
// Envio's 100 queries/minute: 40 for this index, 20 for visitors, 20 for the worker.
const envio = env.ENVIO_GRAPHQL_URL ? envioClient(env.ENVIO_GRAPHQL_URL, network, 1_000, { background: 40, interactive: 20 }) : undefined;
if (envio) await envio.latestBlock();
const rpcSource = rpcLaunchSource(network);
const { db, close: closeDb } = await connectPostgres(env.DATABASE_URL);
// family 0: Railway private hostnames may resolve to IPv6 only.
const redis = env.REDIS_URL ? new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, family: 0 }) : null;
const kv = redis ? redisKv(redis) : memoryKv();
const pubsub = redis ? redisPubSub(redis) : memoryPubSub();
const deepseek = env.DEEPSEEK_API_KEY ? { apiKey: env.DEEPSEEK_API_KEY, baseURL: env.DEEPSEEK_BASE_URL, model: env.DEEPSEEK_MODEL, log: (m: string) => console.warn(m) } : null;

const app = await buildApp({
  env,
  db,
  envio,
  market: rpcSource,
  kv,
  chain: rpcChainReader(network),
  scorer: deepseek ? deepseekScorer(deepseek) : offlineScorer,
  moderator: deepseek ? deepseekModerator(deepseek) : allowAllModerator,
  pubsub,
  pinner: env.PINATA_JWT ? pinataPinner(env.PINATA_JWT) : devPinner(),
  // Formal verification: the pool, when deployed. The API only reads it; the verifier worker (VPS) posts results.
  pool: env.VERIFICATION_POOL_ADDRESS ? rpcPool(network, env.VERIFICATION_POOL_ADDRESS as `0x${string}`) : undefined,
});

const standIns = [!env.REDIS_URL && 'in-memory KV', !env.DEEPSEEK_API_KEY && 'offline scorer and allow-all callout moderation', !env.PINATA_JWT && 'dev pinner (nothing published)'].filter(Boolean);
if (standIns.length) app.log.warn(`Running with stand-ins: ${standIns.join(', ')}`);

const index =
  env.TOKEN_INDEX === 'on'
    ? tokenIndex(db, envio ? envioLaunchSource(envio, rpcSource) : rpcSource, {
        backfillBlocks: env.TOKEN_INDEX_BACKFILL_BLOCKS,
        // Envio pages internally; raw log scans are capped by the RPC's response limit.
        chunkBlocks: env.ENVIO_GRAPHQL_URL ? 5_000_000 : 500_000,
        refreshRecent: 300,
        log: (m) => app.log.warn(m),
      })
    : null;
if (index && !env.ENVIO_GRAPHQL_URL) app.log.warn('Token index is scanning RPC logs; set ENVIO_GRAPHQL_URL to use the indexer');
index?.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    index?.stop();
    await app.close();
    await Promise.all([closeDb(), pubsub.close(), kv.close()]);
    process.exit(0);
  });
}

await app.listen({ host: env.HOST, port: env.PORT });
