import { afterEach, describe, expect, it, vi } from 'vitest';
import { guardedHttp } from './rpcTransport';

afterEach(() => vi.unstubAllGlobals());

function endpoint(chainId: unknown = '0xb626') {
  const methods: string[] = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string);
    methods.push(body.method);
    return Response.json({ jsonrpc: '2.0', id: body.id, result: body.method === 'eth_chainId' ? chainId : '0x1' });
  });
  vi.stubGlobal('fetch', fetch);
  return { methods, fetch };
}

describe('guarded RPC transport', () => {
  it.each([['0x1237', 4663], ['0xb626', 46630]] as const)('checks once and caches success without recursion on %s', async (id, chainId) => {
    const { methods } = endpoint(id);
    const rpc = guardedHttp('https://rpc.example.test', chainId)({});
    await Promise.all([
      rpc.request({ method: 'eth_blockNumber' }),
      rpc.request({ method: 'eth_getBalance', params: ['0x1111111111111111111111111111111111111111', 'latest'] }),
      rpc.request({ method: 'eth_chainId' }),
    ]);
    await rpc.request({ method: 'eth_chainId' });
    expect(methods).toEqual(['eth_chainId', 'eth_blockNumber', 'eth_getBalance']);
  });

  it('fails closed permanently for a mainnet endpoint with testnet selected, without forwarding queries', async () => {
    const { methods } = endpoint('0x1237');
    const rpc = guardedHttp('https://rpc.example.test/private-key', 46630)({});
    await expect(rpc.request({ method: 'eth_call' })).rejects.toThrow('RPC network mismatch. Expected chain 46630.');
    await expect(rpc.request({ method: 'eth_sendRawTransaction' })).rejects.toThrow('RPC network mismatch');
    expect(methods).toEqual(['eth_chainId']);
  });

  it.each([null, '', '46630', '0xgarbage', {}])('rejects malformed eth_chainId result %j', async (id) => {
    const { methods } = endpoint(id);
    const rpc = guardedHttp('https://rpc.example.test', 46630)({});
    await expect(rpc.request({ method: 'eth_blockNumber' })).rejects.toThrow('invalid chain ID');
    expect(methods).toEqual(['eth_chainId']);
  });

  it('retries transient HTTP failures, then allows a fresh check after failure without leaking details', async () => {
    const { methods, fetch } = endpoint();
    fetch.mockRejectedValueOnce(new Error('secret-provider-url'))
      .mockRejectedValueOnce(new Error('secret-provider-url'))
      .mockRejectedValueOnce(new Error('secret-provider-url'));
    const rpc = guardedHttp('https://rpc.example.test/private-key', 46630)({});
    const failure = await rpc.request({ method: 'eth_blockNumber' }).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain('Unable to verify RPC network');
    expect(String(failure)).not.toMatch(/secret-provider-url|private-key|rpc\.example/);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(methods).toEqual([]);
    await expect(rpc.request({ method: 'eth_blockNumber' })).resolves.toBe('0x1');
    expect(methods).toEqual(['eth_chainId', 'eth_blockNumber']);
  });

  it('recovers from a transient check failure before forwarding the pending query', async () => {
    const { methods, fetch } = endpoint();
    fetch.mockRejectedValueOnce(new Error('Temporary connection failure'));
    const rpc = guardedHttp('https://rpc.example.test', 46630)({});
    await expect(rpc.request({ method: 'eth_blockNumber' })).resolves.toBe('0x1');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(methods).toEqual(['eth_chainId', 'eth_blockNumber']);
  });

  it('does not share verification between separate transport instances', async () => {
    const { methods } = endpoint();
    const transport = guardedHttp('https://rpc.example.test', 46630);
    await transport({}).request({ method: 'eth_chainId' });
    await transport({}).request({ method: 'eth_chainId' });
    expect(methods).toEqual(['eth_chainId', 'eth_chainId']);
  });
});
