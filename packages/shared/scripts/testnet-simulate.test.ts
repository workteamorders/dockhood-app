import { describe, expect, it } from 'vitest';
import { parseAbi } from 'viem';
import { assertForkIdentity, assertLocalRpc, LOCAL_RPC, safeFailure } from './testnet-simulate';

describe('simulation transaction destination', () => {
  it('accepts only the fixed exact loopback RPC', () => {
    expect(() => assertLocalRpc(LOCAL_RPC)).not.toThrow();
    for (const url of [
      'https://robinhood-sepolia-rpc.publicnode.com', 'https://robinhood-testnet.drpc.org',
      'http://localhost:18545', 'http://127.0.0.1:8545', 'http://127.0.0.1:18545/',
      'http://127.0.0.1:18545@evil.example', 'http://127.0.0.1:18545?redirect=https://evil.example',
      'http://0.0.0.0:18545', 'http://[::1]:18545',
    ]) expect(() => assertLocalRpc(url)).toThrow('exact loopback');
  });

  it('requires Anvil, both chain IDs and the exact pinned fork identity', () => {
    const upstream = 'https://robinhood-sepolia-rpc.publicnode.com';
    const info = { environment: { chainId: 46630 }, forkConfig: { forkUrl: upstream, forkBlockNumber: 123 } };
    expect(() => assertForkIdentity(46630, 'anvil/v1.7.1', info, upstream, 123n)).not.toThrow();
    expect(() => assertForkIdentity(4663, 'anvil/v1.7.1', info, upstream, 123n)).toThrow('chain ID');
    expect(() => assertForkIdentity(46630, 'Geth/anvil-compatible', info, upstream, 123n)).toThrow('not Anvil');
    for (const invalid of [null, {}, { ...info, environment: { chainId: 4663 } },
      { ...info, forkConfig: { ...info.forkConfig, forkBlockNumber: 124 } },
      { ...info, forkConfig: { ...info.forkConfig, forkUrl: 'https://other.example' } },
    ]) expect(() => assertForkIdentity(46630, 'anvil/v1.7.1', invalid, upstream, 123n)).toThrow('fork identity');
  });
});

describe('sanitized rehearsal failures', () => {
  it('finds nested provider reverts without exposing request, message or signing data', () => {
    const result = safeFailure({ name: 'TransactionExecutionError', message: 'SECRET RPC URL AND KEY',
      cause: { name: 'RpcRequestError', data: { error: { data: '0x82b42900' } } },
      request: { data: '0xdeadbeef', key: 'SECRET KEY' },
    }, parseAbi(['error Unauthorized()']));
    expect(result).toEqual({ errorTypes: ['TransactionExecutionError', 'RpcRequestError'], revertSelector: '0x82b42900', errorName: 'Unauthorized' });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('reports funding error types without inventing a contract revert', () => {
    expect(safeFailure({ name: 'TransactionExecutionError', cause: { name: 'InsufficientFundsError', message: 'RAW RPC' } }))
      .toEqual({ errorTypes: ['TransactionExecutionError', 'InsufficientFundsError'] });
  });
});
