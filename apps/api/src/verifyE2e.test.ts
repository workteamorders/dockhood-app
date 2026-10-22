import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('local verification E2E safety', () => {
  it.each([
    { RPC_URL_SERVER: 'https://rpc.testnet.chain.robinhood.com', target: 'RPC' },
    { RPC_URL_SERVER: 'https://localhost.example.com', target: 'RPC' },
    { RPC_URL_SERVER: 'https://example.com/127.0.0.1', target: 'RPC' },
    { API_URL: 'https://example.com', target: 'API' },
  ])('refuses non-local endpoints before using public Anvil keys: %j', ({ target, ...overrides }) => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../scripts/verify-e2e.ts', import.meta.url))], {
      env: {
        ...process.env,
        RPC_URL_SERVER: 'http://127.0.0.1:8545',
        API_URL: 'http://127.0.0.1:8787',
        DATABASE_URL: 'memory',
        VERIFICATION_POOL_ADDRESS: '0x0000000000000000000000000000000000000011',
        RIGOR_REGISTRY_ADDRESS: '0x0000000000000000000000000000000000000012',
        ...overrides,
      },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Refusing to run against a non-local ${target}.`);
  }, 30_000);
});
