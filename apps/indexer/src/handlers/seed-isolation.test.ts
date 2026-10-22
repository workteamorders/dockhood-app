import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, readFileSync } = vi.hoisted(() => ({
  handlers: new Map<string, (input: any) => Promise<void>>(),
  readFileSync: vi.fn(),
}));
vi.mock('node:fs', () => ({ readFileSync }));
// Exercise the registered handlers without loading Envio's platform-specific native addon.
vi.mock('envio', () => ({
  BigDecimal: class {},
  indexer: { onEvent: ({ event }: { event: string }, handler: (input: any) => Promise<void>) => handlers.set(event, handler) },
}));
import './pons';

const curve = '0x00000000000000000000000000000000000000c2';
const token = '0x00000000000000000000000000000000000000b1';
const csv = `token,curve,deployer,pairToken,launchConfigId,graduationThreshold,launchBlock,launchedAt
${token},${curve},0x00000000000000000000000000000000000000d1,0x0000000000000000000000000000000000000000,0,4200000000000000000,30000000,1786000000
`;

async function trade(chainId: number, event: 'CurveBuy' | 'CurveSell') {
  const context = {
    chain: { id: chainId },
    Curve: { get: vi.fn().mockResolvedValue(undefined), set: vi.fn() },
    Token: { get: vi.fn().mockResolvedValue(undefined), set: vi.fn() },
    Trade: { set: vi.fn() },
  };
  await handlers.get(event)!({
    context,
    event: {
      srcAddress: curve,
      params: { quoteIn: 100n, tokensOut: 100n, tokensIn: 100n, quoteOut: 100n, fee: 0n, tax: 0n },
    },
  });
  return context;
}

describe('mainnet launch seed isolation', () => {
  beforeEach(() => {
    readFileSync.mockReset().mockReturnValue(gzipSync(csv));
  });

  it('never opens the default CSV for testnet buy or sell events', async () => {
    for (const event of ['CurveBuy', 'CurveSell'] as const) {
      const context = await trade(46630, event);
      expect(context.Curve.set).not.toHaveBeenCalled();
      expect(context.Token.set).not.toHaveBeenCalled();
      expect(context.Trade.set).not.toHaveBeenCalled();
    }
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it('preserves mainnet seeding but cannot reuse its cached CSV on testnet, even with an override', async () => {
    vi.stubEnv('HOOD_LAUNCH_SEED', '/explicit/mainnet.csv.gz');
    try {
      const mainnet = await trade(4663, 'CurveBuy');
      expect(readFileSync).toHaveBeenCalledWith('/explicit/mainnet.csv.gz');
      expect(mainnet.Curve.set).toHaveBeenCalledWith({ id: curve, token });
      expect(mainnet.Token.set).toHaveBeenCalledWith(expect.objectContaining({ id: token, launchBlock: 30000000 }));
      readFileSync.mockClear();
      for (const chainId of [46630, 1]) {
        for (const event of ['CurveBuy', 'CurveSell'] as const) {
          const context = await trade(chainId, event);
          expect(context.Curve.set).not.toHaveBeenCalled();
          expect(context.Token.set).not.toHaveBeenCalled();
        }
      }
      expect(readFileSync).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
