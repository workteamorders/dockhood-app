import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, it } from 'vitest';
import { BigDecimal, createTestIndexer } from 'envio';

const CHAIN = 4663;
const FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
const TOKEN = '0x00000000000000000000000000000000000000A1';
const CURVE = '0x00000000000000000000000000000000000000C1';
const DEPLOYER = '0x00000000000000000000000000000000000000D1';
const TRADER = '0x00000000000000000000000000000000000000E1';
const ETH = '0x0000000000000000000000000000000000000000';

// A coin launched before the start block, known only from the seed file (seeds/pre-start-launches.csv.gz).
const OLD_TOKEN = '0x00000000000000000000000000000000000000B1';
const OLD_CURVE = '0x00000000000000000000000000000000000000c2';
const seedFile = join(mkdtempSync(join(tmpdir(), 'hood-seed-')), 'seed.csv.gz');
writeFileSync(
  seedFile,
  gzipSync(`token,curve,deployer,pairToken,launchConfigId,graduationThreshold,launchBlock,launchedAt
${OLD_TOKEN},${OLD_CURVE},${DEPLOYER},${ETH},0,4200000000000000000,30000000,1786000000
`),
);
process.env.HOOD_LAUNCH_SEED = seedFile;

/** After both configs' start blocks, or the indexer drops the events. */
const B = 84_000_000;
const E18 = 10n ** 18n;
const T0 = 1_791_500_000; // a minute boundary: 1791500000 % 60 === 20, so buckets are checked explicitly

const launch = {
  contract: 'PonsV2Factory',
  event: 'TokenLaunched',
  srcAddress: FACTORY,
  block: { number: B, timestamp: T0 },
  params: { token: TOKEN, curve: CURVE, deployer: DEPLOYER, pairToken: ETH, launchConfigId: 0n, graduationThreshold: 42n * E18 / 10n },
} as const;

const buy = (n: number, at: number, quoteIn: bigint, tokensOut: bigint, fee: bigint, tax: bigint) =>
  ({
    contract: 'PonsV2Curve',
    event: 'CurveBuy',
    srcAddress: CURVE,
    logIndex: n,
    block: { number: B + n, timestamp: at },
    transaction: { hash: `0x${n.toString(16).padStart(64, '0')}` },
    params: { buyer: TRADER, recipient: TRADER, quoteIn, tokensOut, fee, tax },
  }) as const;

const sell = (n: number, at: number, tokensIn: bigint, quoteOut: bigint, fee: bigint, tax: bigint) =>
  ({
    contract: 'PonsV2Curve',
    event: 'CurveSell',
    srcAddress: CURVE,
    logIndex: n,
    block: { number: B + n, timestamp: at },
    transaction: { hash: `0x${n.toString(16).padStart(64, '0')}` },
    params: { seller: TRADER, recipient: TRADER, tokensIn, quoteOut, fee, tax },
  }) as const;

describe('Pons V2 handlers', () => {
  it('records a launch and registers its curve so trades are indexed', async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { [CHAIN]: { simulate: [launch, buy(1, T0 + 5, E18, 1_000n * E18, E18 / 100n, 0n)] } } });

    const token = await indexer.Token.getOrThrow(TOKEN);
    t.expect(token).toMatchObject({ curve: CURVE, deployer: DEPLOYER, pairToken: ETH, phase: 0, launchedAt: T0, launchBlock: B, trades: 1, buys: 1 });
    t.expect((await indexer.Curve.getOrThrow(CURVE)).token).toBe(TOKEN);
  });

  it('books buys net of fee and tax, sells gross, and prices at the curve', async (t) => {
    const indexer = createTestIndexer();
    // Buy: spent 1 ETH, fee 0.01, creator tax 0.02 → 0.97 ETH into the curve for 970 tokens (0.001 ETH/token).
    // Sell: 100 tokens for 0.096 ETH net, fee 0.001, tax 0.002 → 0.099 ETH off the curve (0.00099 ETH/token).
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            launch,
            buy(1, T0 + 5, E18, 970n * E18, E18 / 100n, E18 / 50n),
            sell(2, T0 + 70, 100n * E18, (96n * E18) / 1000n, E18 / 1000n, (2n * E18) / 1000n),
          ],
        },
      },
    });

    const token = await indexer.Token.getOrThrow(TOKEN);
    t.expect(token.raisedQuote).toBe((97n * E18) / 100n - (99n * E18) / 1000n);
    t.expect(token.volumeQuote).toBe(E18 + (99n * E18) / 1000n);
    t.expect(token).toMatchObject({ trades: 2, buys: 1, sells: 1, lastTradeAt: T0 + 70 });
    t.expect(token.lastPrice?.toString()).toBe('0.00099');

    const first = await indexer.Trade.getOrThrow(`${B + 1}-1`);
    t.expect(first).toMatchObject({ token: TOKEN, isBuy: true, quoteAmount: E18, tokenAmount: 970n * E18, blockNumber: B + 1 });
    t.expect(first.price.toString()).toBe('0.001');
    const second = await indexer.Trade.getOrThrow(`${B + 2}-2`);
    t.expect(second).toMatchObject({ isBuy: false, quoteAmount: (99n * E18) / 1000n });
  });

  it('keeps average-cost positions: router buys count for the recipient, a full sell removes it', async (t) => {
    const ROUTER = '0x00000000000000000000000000000000000000F1';
    const routerBuy = { ...buy(1, T0 + 5, E18, 1_000n * E18, 0n, 0n), params: { buyer: ROUTER, recipient: TRADER, quoteIn: E18, tokensOut: 1_000n * E18, fee: 0n, tax: 0n } } as const;
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            launch,
            routerBuy, // 1000 tokens for 1 ETH, bought by the router for TRADER
            buy(2, T0 + 6, 3n * E18, 1_000n * E18, 0n, 0n), // 1000 more for 3 ETH: avg 0.002 ETH/token
            sell(3, T0 + 7, 500n * E18, E18, 0n, 0n), // sells a quarter: releases 1 ETH of cost
          ],
        },
      },
    });
    const p = await indexer.Position.getOrThrow(`${TRADER}-${TOKEN}`);
    t.expect(p).toMatchObject({ wallet: TRADER, token: TOKEN, qty: 1_500n * E18, cost: 3n * E18 });
    t.expect(await indexer.Position.get(`${ROUTER}-${TOKEN}`)).toBeUndefined();

    await indexer.process({ chains: { [CHAIN]: { simulate: [sell(4, T0 + 8, 2_000n * E18, E18, 0n, 0n)] } } });
    t.expect(await indexer.Position.get(`${TRADER}-${TOKEN}`)).toBeUndefined();
  });

  it('records trades on coins launched before the start block from the seed file', async (t) => {
    const indexer = createTestIndexer();
    const oldBuy = { ...buy(1, T0 + 5, E18, 1_000n * E18, 0n, 0n), srcAddress: OLD_CURVE } as const;
    await indexer.process({ chains: { [CHAIN]: { simulate: [oldBuy] } } });
    t.expect(await indexer.Curve.getOrThrow(OLD_CURVE)).toMatchObject({ token: OLD_TOKEN });
    t.expect(await indexer.Token.getOrThrow(OLD_TOKEN)).toMatchObject({ curve: OLD_CURVE, deployer: DEPLOYER, launchBlock: 30_000_000, trades: 1, buys: 1 });
    t.expect(await indexer.Position.getOrThrow(`${TRADER}-${OLD_TOKEN}`)).toMatchObject({ qty: 1_000n * E18, cost: E18 });
  });

  it('builds 1m/5m/1h/1d candles with OHLC and volume', async (t) => {
    const indexer = createTestIndexer();
    const at = T0 - (T0 % 3_600) + 10; // 10 s into an hour, so every interval's bucket is predictable
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            launch,
            buy(1, at, 1_000n, 1_000n, 0n, 0n), // price 1
            buy(2, at + 20, 3_000n, 1_000n, 0n, 0n), // price 3
            buy(3, at + 40, 2_000n, 1_000n, 0n, 0n), // price 2
            buy(4, at + 65, 500n, 1_000n, 0n, 0n), // price 0.5, next minute
          ],
        },
      },
    });

    const minute = await indexer.Candle.getOrThrow(`${TOKEN}-60-${at - 10}`);
    t.expect(minute).toMatchObject({ interval: 60, bucketStart: at - 10, trades: 3, volumeQuote: 6_000n });
    t.expect([minute.open, minute.high, minute.low, minute.close].map(String)).toEqual(['1', '3', '1', '2']);

    const next = await indexer.Candle.getOrThrow(`${TOKEN}-60-${at + 50}`);
    t.expect(next.open.toString()).toBe('0.5');

    const hour = await indexer.Candle.getOrThrow(`${TOKEN}-3600-${at - 10}`);
    t.expect(hour).toMatchObject({ trades: 4, volumeQuote: 6_500n });
    t.expect([hour.open, hour.high, hour.low, hour.close].map(String)).toEqual(['1', '3', '0.5', '0.5']);
    t.expect(new BigDecimal(hour.high.toString()).gt(hour.close)).toBe(true);
  });

  it('moves a token to swept, then pool, and records the graduation', async (t) => {
    const indexer = createTestIndexer();
    const swept = {
      contract: 'PonsV2Factory',
      event: 'LaunchSwept',
      srcAddress: FACTORY,
      block: { number: B + 200, timestamp: T0 + 600 },
      params: { token: TOKEN, quoteOut: 42n * E18 / 10n, tokenOut: 285n * E18 },
    } as const;
    const pool = {
      contract: 'PonsV2Factory',
      event: 'PoolGraduated',
      srcAddress: FACTORY,
      block: { number: B + 201, timestamp: T0 + 610 },
      params: { token: TOKEN, positionId: 7n, tokenAmount: 285n * E18, pairTokenAmount: 42n * E18 / 10n },
    } as const;

    await indexer.process({ chains: { [CHAIN]: { simulate: [launch, swept] } } });
    t.expect((await indexer.Token.getOrThrow(TOKEN)).phase).toBe(1);

    await indexer.process({ chains: { [CHAIN]: { simulate: [pool] } } });
    t.expect((await indexer.Token.getOrThrow(TOKEN)).phase).toBe(2);
    t.expect(await indexer.Graduation.getOrThrow(TOKEN)).toMatchObject({ sweptAt: T0 + 600, sweptQuote: 42n * E18 / 10n, poolAt: T0 + 610, positionId: 7n });
  });

  it('ignores curve events from contracts it never registered', async (t) => {
    const indexer = createTestIndexer();
    // Wildcard events reach the handler, but unknown curves must not create entities.
    await indexer.process({ chains: { [CHAIN]: { simulate: [{ ...buy(1, T0, E18, E18, 0n, 0n), srcAddress: '0x00000000000000000000000000000000000000ff' }] } } });
    t.expect(await indexer.Trade.getAll()).toEqual([]);
    t.expect(await indexer.Token.getAll()).toEqual([]);
  });
});
