import type { FastifyInstance } from 'fastify';
import { allow } from '../kv';

/**
 * The browser's JSON-RPC (POST /rpc): forwards read calls to RPC_URL_SERVER so the provider key never ships
 * to browsers. Wallets send transactions through their own RPC, so nothing that writes is allowed here.
 */
const READ_METHODS = new Set([
  'eth_chainId',
  'net_version',
  'eth_blockNumber',
  'eth_call',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionCount',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getLogs',
]);

const MAX_BATCH = 20;
/** Per visitor: generous for an open Token Detail (live curve, balances, receipts), small for a script. */
const PER_MINUTE = 600;

type RpcRequest = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export async function rpcRoutes(app: FastifyInstance) {
  const { env, kv } = app.deps;
  const upstream = env.network.rpcUrl;

  app.post('/rpc', { bodyLimit: 256 * 1024 }, async (req, reply) => {
    const body = req.body as RpcRequest | RpcRequest[] | undefined;
    const calls = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : [];
    if (!calls.length || calls.length > MAX_BATCH) return reply.code(400).send(rpcError(null, -32600, `Send 1 to ${MAX_BATCH} JSON-RPC requests.`));

    if (!(await allow(kv, `rpc:${req.clientIp}`, Math.floor(PER_MINUTE / calls.length), 60))) {
      return reply.code(429).send(calls.map((c) => rpcError(c.id, -32005, 'Too many requests. Slow down.')));
    }

    const refused = calls.find((c) => typeof c.method !== 'string' || !READ_METHODS.has(c.method));
    if (refused) {
      const res = rpcError(refused.id, -32601, `Method ${String(refused.method)} is not available here.`);
      return reply.code(400).send(Array.isArray(body) ? [res] : res);
    }

    // Forward the calls as they came (id, params), so the answers line up with what the client sent.
    const forwarded = calls.map((c) => ({ jsonrpc: '2.0', id: c.id ?? null, method: c.method, params: Array.isArray(c.params) ? c.params : [] }));
    let res: Response;
    try {
      res = await fetch(upstream, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Array.isArray(body) ? forwarded : forwarded[0]),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return reply.code(502).send(rpcError(calls[0].id, -32603, 'The RPC provider did not answer.'));
    }
    const text = await res.text();
    return reply.code(res.ok ? 200 : 502).header('content-type', 'application/json').send(text);
  });
}
