import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';

describe('verification sandbox environment', () => {
  it('leaves the runner default work directory unchanged when unset or blank', () => {
    expect(loadEnv({ DATABASE_URL: 'memory' }).VERIFICATION_WORK_DIR).toBeUndefined();
    expect(loadEnv({ DATABASE_URL: 'memory', VERIFICATION_WORK_DIR: '  ' }).VERIFICATION_WORK_DIR).toBeUndefined();
  });

  it('accepts a Docker-shared work directory alongside per-machine limits', () => {
    const env = loadEnv({ DATABASE_URL: 'memory', VERIFICATION_WORK_DIR: ' /repo/.testnet/sandbox ', VERIFICATION_MEMORY_MB: '4096', VERIFICATION_MAX_CONCURRENT: '1' });
    expect(env.VERIFICATION_WORK_DIR).toBe('/repo/.testnet/sandbox');
    expect(env.VERIFICATION_MEMORY_MB).toBe(4096);
    expect(env.VERIFICATION_MAX_CONCURRENT).toBe(1);
  });
});
