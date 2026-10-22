import { createTransport, http, type EIP1193RequestFn, type HttpTransport } from 'viem';

/** Check the effective endpoint before forwarding any reads, simulations or transactions. */
export function guardedHttp(url: string, chainId: number): HttpTransport {
  return (options) => {
    const rpc = http(url, { retryCount: 2, retryDelay: 250, timeout: 10_000 })(options);
    let verification: Promise<`0x${string}`> | undefined;

    const verify = () => verification ??= (async () => {
      let id: unknown;
      try {
        // Use the underlying transport, not the guarded request (which would recurse).
        id = await rpc.request({ method: 'eth_chainId' });
      } catch {
        // A transient outage may recover. Never include endpoint URLs or provider errors.
        verification = undefined;
        throw new Error('Unable to verify RPC network. Check your connection and try again.');
      }
      if (typeof id !== 'string' || !/^0x[0-9a-f]+$/i.test(id)) {
        throw new Error('RPC returned an invalid chain ID. Check the network configuration.');
      }
      if (BigInt(id) !== BigInt(chainId)) {
        throw new Error(`RPC network mismatch. Expected chain ${chainId}. Check the network configuration.`);
      }
      return id as `0x${string}`;
    })();

    return createTransport({
      ...rpc.config,
      // The inner HTTP transport retries transient failures; never retry a mismatch.
      retryCount: 0,
      request: (async (args, requestOptions) => {
        const id = await verify();
        if (args.method === 'eth_chainId') return id;
        return rpc.request(args, requestOptions);
      }) as EIP1193RequestFn,
    }, rpc.value);
  };
}
