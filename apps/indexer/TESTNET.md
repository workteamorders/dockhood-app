# Robinhood Testnet (46630)

This stack is independent of production. Do not merge its Compose file with `docker-compose.yml`.
No deployment or transaction broadcast is performed by these commands.

## Required Inputs

Export the real deployment values in your shell, or put them in an ignored local env file such as
`apps/indexer/.env.testnet.local`:

- `TESTNET_FACTORY_ADDRESS`: deployed Pons V2 factory, a nonzero 20-byte EVM address.
- `TESTNET_START_BLOCK`: factory deployment block, a positive decimal safe integer.
- `TESTNET_RPC_URL`: HTTP(S) RPC that returns chain ID 46630 from `eth_chainId`.
- `TESTNET_HASURA_ADMIN_SECRET`: nonempty local Hasura secret (required by the Compose indexer profile).

There are no factory, block or RPC defaults, and no implicit mainnet `.env` loading. If using a file,
pass `--env-file apps/indexer/.env.testnet.local` to Compose. For the standalone renderer, export
the variables first or use Node's `--env-file` option from `apps/indexer`:

```sh
node --env-file=.env.testnet.local scripts/render-testnet.mjs
```

The renderer makes only an `eth_chainId` request and writes `config.testnet.local.yaml` atomically
after validation. It validates address syntax and block range, not contract bytecode or deployment
provenance: supply the actual factory deployment address and block. Generated config is ignored and
mode 0600 because the RPC URL may contain credentials. Failed validation does not overwrite an
existing config. Always start via the renderer, not directly against an old generated file.

Contract/event declarations are reused from unchanged `config.yaml`. The generated chain uses
Envio 3.13's `rpc: {url, for: sync}` for both historical and real-time indexing, not HyperSync;
no `ENVIO_API_TOKEN` is needed. Mainnet seed CSV loading, including `HOOD_LAUNCH_SEED` overrides,
is restricted to event context chain 4663 and is never used on 46630.

## Local Stack

Run from the repository root (with variables exported, or add `--env-file` as described above):

```sh
docker compose -f docker-compose.testnet.yml up -d postgres redis
docker compose -f docker-compose.testnet.yml --profile indexer up -d --build
docker compose -f docker-compose.testnet.yml logs -f indexer hasura
docker compose -f docker-compose.testnet.yml down
```

The project name is `dockhood-testnet`. All published ports bind only to `127.0.0.1`:

| Service | Host Port | Database |
| --- | --- | --- |
| API Postgres | 54321 | `hood`, user/password `hood` |
| Redis | 63791 | Isolated persistent volume |
| Hasura | 8081 | Separate `envio` database in testnet Postgres |

This file does not run or change the API/web. Point a separately configured testnet API at these
ports. Indexer/Postgres connections inside Compose use container ports, not host ports. A host-only
RPC at `localhost` will not be reachable from the container; use a container-reachable RPC URL.

Postgres, Redis, indexer dependencies and generated Envio types have this project's own named
volumes. No production volume, HyperSync token, seed env override or `.env` is imported. Hasura and
indexer are opt-in via the `indexer` profile and refuse startup when required inputs are empty.
The indexer revalidates the RPC chain ID on every start before invoking Envio. Hasura's entrypoint
checks input presence, while full address/block/RPC validation belongs to the indexer renderer.
Only config declarations, schema, source and scripts are bind-mounted into the indexer; the generated
config stays inside that container. The standalone renderer writes its ignored config on the host.

`down` preserves data. Only use `down -v` when deliberately discarding this testnet stack's data.
After dependency changes, rebuild the image and refresh the testnet `indexer_node_modules` volume.

## Checks

```sh
pnpm --filter @hood/indexer test:testnet
pnpm --filter @hood/indexer test
pnpm --filter @hood/indexer typecheck
docker compose -f docker-compose.testnet.yml config --quiet
```

The renderer and seed-isolation tests do not require the Envio native addon or a live RPC. Full
handler tests, codegen and typecheck require Envio's matching platform package. For a native local
indexer (with separate testnet database/Hasura variables already exported), use
`pnpm --filter @hood/indexer start:testnet`. This regenerates the testnet config before starting.
