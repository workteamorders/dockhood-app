# Deploying Dockhood on Robinhood Chain Testnet (46630)

Companion to [DEPLOY.md](DEPLOY.md), which describes the mainnet (4663) production setup. Use **separate** Vercel and
Railway projects for testnet: the API database, Redis and indexer must never be shared between networks, and the
existing `hood-exe` Vercel project stays on mainnet.

Contracts below were deployed on 2026-10-23 by `pnpm testnet deploy --broadcast` (29 transactions, wiring verified,
see [apps/contracts/TESTNET.md](../apps/contracts/TESTNET.md)). They are unaudited testnet copies. Launch, trading,
graduation and proof payout have **not** been exercised on the public chain yet.

```
browser ──/api/* + cookie──▶ web (Vercel) ──rewrite──▶ api (Railway) ──▶ Postgres, Redis
   └────────── wss://<api>/ws (live feed, direct) ─────▶     ▲
                                              worker (Railway) ┘
                       api + worker ──GraphQL (private)──▶ hasura ◀── indexer (Railway, own Postgres)
```

## Deployed addresses (public)

| Contract | Address |
| --- | --- |
| Factory (`PONS_LAUNCH_FACTORY`) | `0x9B78f8878fb269CdDAEdfFe9Eb00368d90BF9095` |
| Router (`PONS_LAUNCH_AND_BUY`) | `0x48DD574A31C842b177c3582d2469506964C867ae` |
| RigorRegistry | `0xB97b5A72BD6D508E5376F10D740f67C7C6ab33D0` |
| VerificationPool | `0x3C741cF3BB5b6cee06f30320cdBA489aEfDD7AE2` |
| FeeSplitter | `0x0A7A90e3863D66393B1A97ceAd5700A3f6cEd44c` |
| Deployer / admin wallet | `0xCD8589e80a6e3C99C42A722606052A5F91076dd1` |

Factory deployment block: `140875036`. Chain id `46630`, RPC `https://rpc.testnet.chain.robinhood.com`,
explorer `https://explorer.testnet.chain.robinhood.com`.

`.testnet/` is git-ignored, so none of the rendered `.testnet/runtime/*.env` files are in the repository. Copy the
values below into each platform's dashboard. Generate secrets yourself (`openssl rand -hex 32`) and never commit them.

## 1. Web: Vercel (`apps/web`)

Public values are fixed at build time, so redeploy after changing them.

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_CHAIN_ID` | `46630` |
| `NEXT_PUBLIC_RPC_URL` | A browser-safe RPC that reports chain 46630 (empty falls back to the public RPC) |
| `NEXT_PUBLIC_PONS_LAUNCH_FACTORY` | factory address above |
| `NEXT_PUBLIC_PONS_LAUNCH_AND_BUY` | router address above |
| `NEXT_PUBLIC_PAIR_TOKENS_JSON` | `[]` (native ETH only) |
| `NEXT_PUBLIC_API_URL` | `/api` |
| `API_PROXY_TARGET` | `https://<api-service>.up.railway.app` |
| `NEXT_PUBLIC_WS_URL` | `wss://<api-service>.up.railway.app/ws` |
| `PROXY_SECRET` | random 64 hex, **same value as the API's `PROXY_SECRET`** |
| `NEXT_PUBLIC_SITE_URL` | the site's own URL, e.g. `https://<project>.vercel.app` |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | optional (Reown id) |

Do not set `COOKIE_DOMAIN` anywhere: the `/api` rewrite keeps the session cookie on the web host.

## 2. API and worker: Railway

Same image, two services: `api` (`apps/api/railway.json`, health check `/health`) and `worker`
(`apps/api/railway.worker.json`). Add a Railway Postgres and Redis for them (fresh ones, not mainnet's).

| Variable | Value |
| --- | --- |
| `CHAIN_ID` | `46630` |
| `RPC_URL_SERVER` | RPC reporting chain 46630 (startup refuses a mismatch) |
| `DATABASE_URL`, `REDIS_URL` | the new Railway Postgres and Redis |
| `PONS_LAUNCH_FACTORY` / `PONS_LAUNCH_AND_BUY` | factory / router above (both required on testnet) |
| `PAIR_TOKENS_JSON` | `[]` |
| `RIGOR_REGISTRY_ADDRESS` / `VERIFICATION_POOL_ADDRESS` / `FEE_SPLITTER_ADDRESS` | addresses above |
| `VERIFICATION_SUBMISSIONS_ENABLED` | `false` until the verifier worker is wired to a testnet signer |
| `VERIFICATION_SUBMISSION_FEE_WEI` | `10000000000000` |
| `ADMIN_WALLETS` | deployer address above |
| `ENVIO_GRAPHQL_URL` | `http://hasura.railway.internal:8080/v1/graphql` |
| `INDEXER_DATABASE_URL` | the indexer's Postgres URL (worker pruning) |
| `TOKEN_INDEX` | `on` |
| `STAND_INS` | `allow` (no DeepSeek or Pinata keys on testnet; with `refuse` both keys are required) |
| `SESSION_SECRET` | random 64 hex |
| `PROXY_SECRET` | same value as on Vercel |
| `CORS_ORIGINS` | the web origin(s), e.g. `https://<project>.vercel.app`. Also the hosts sign-in may name and the origins allowed on `/ws` |
| `HOST`, `PORT` | `0.0.0.0` and `8787` (or Railway's `PORT`) |

Preview deployments on Vercel can browse but cannot sign in unless their host is listed in `CORS_ORIGINS`.

## 3. Indexer and Hasura: Railway

Mainnet uses `config.selfhost.yaml` with HyperSync. Testnet has no HyperSync, so the indexer runs from a config
rendered at start by `apps/indexer/scripts/render-testnet.mjs`, which indexes over plain RPC. Services:
`hasura` (image `hasura/graphql-engine:v2.48.5`, no public domain), a dedicated Postgres, and `indexer`.

`indexer` (build `apps/indexer/Dockerfile`):

| Setting | Value |
| --- | --- |
| Start command | `node scripts/render-testnet.mjs && node_modules/.bin/envio start` |
| `ENVIO_CONFIG` | `config.testnet.local.yaml` (written by the renderer) |
| `TESTNET_FACTORY_ADDRESS` | factory address above |
| `TESTNET_START_BLOCK` | `140875036` |
| `TESTNET_RPC_URL` | an RPC with wildcard `eth_getLogs` support for chain 46630 |
| `ENVIO_PG_HOST`, `ENVIO_PG_PORT`, `ENVIO_PG_USER`, `ENVIO_PG_PASSWORD`, `ENVIO_PG_DATABASE` | the indexer's Postgres (database `envio`) |
| `HASURA_GRAPHQL_ENDPOINT` | `http://hasura.railway.internal:8080/v1/metadata` |
| `HASURA_GRAPHQL_ADMIN_SECRET` | random 64 hex, same as hasura's |
| `ENVIO_TUI` | `false` |

`hasura`: `HASURA_GRAPHQL_DATABASE_URL` (the indexer's Postgres, database `envio`), `HASURA_GRAPHQL_ADMIN_SECRET`,
`HASURA_GRAPHQL_UNAUTHORIZED_ROLE=public`, `HASURA_GRAPHQL_STRINGIFY_NUMERIC_TYPES=true`,
`HASURA_GRAPHQL_ENABLE_CONSOLE=false`, `HASURA_GRAPHQL_NO_OF_RETRIES=10`.

Never run `envio start --restart` there: it wipes the index. This hosted layout is derived from the working local
stack (`docker-compose.testnet.yml`, see `apps/indexer/TESTNET.md`) and has not been run on Railway yet.

## Order

1. Railway: Postgres (API), Redis, Postgres (indexer), `hasura`, `indexer`. Wait for the indexer to log sync progress.
2. Railway: `api`, then `worker`. Check `/health`.
3. Vercel: set the variables, deploy, then add the final web origin to the API's `CORS_ORIGINS`.
4. Open the site, connect a wallet on chain 46630 and confirm Explore loads without errors.
