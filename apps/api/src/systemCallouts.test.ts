import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { NATIVE_PAIR } from '@hood/shared';
import { schema } from './db';
import type { EnvioClient } from './services/envio';
import { CALLOUTS_CHANNEL } from './services/pubsub';
import { BIG_BUY_ETH, systemCalloutsTick } from './systemCallouts';
import { setup } from './test/helpers';

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.close();
});

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

async function coin(n: number, symbol: string, opts: { hood?: boolean; phase?: number; pair?: string; launchedAt?: Date } = {}) {
  await ctx.db.insert(schema.tokens).values({
    tokenAddress: addr(n),
    curveAddress: addr(n + 1_000),
    deployer: addr(1),
    pairToken: opts.pair ?? NATIVE_PAIR,
    blockNumber: n,
    launchedAt: opts.launchedAt ?? ctx.now(),
    name: symbol,
    symbol,
    logo: '',
    description: '',
    hood: opts.hood ?? true,
    graduationThreshold: '4200000000000000000',
    phase: opts.phase ?? 0,
  });
}

type Buy = Awaited<ReturnType<EnvioClient['bigBuys']>>[number];
const buy = (id: string, token: string, eth: bigint, block: number, at: number): Buy => ({
  id,
  token,
  trader: '0x12ab000000000000000000000000000000009f0c',
  isBuy: true,
  quoteAmount: eth,
  tokenAmount: 1n,
  price: '1',
  timestamp: at,
  txHash: `0xb${id}`,
  blockNumber: block,
});

/** An indexer stand-in that answers bigBuys like the real query: by token, size and block. */
function fakeEnvio(buys: Buy[], head = 1_000) {
  const asked: { tokens: string[]; after: number }[] = [];
  const envio = {
    latestBlock: async () => head,
    bigBuys: async (tokens: string[], min: bigint, after: number) => {
      asked.push({ tokens, after });
      return buys.filter((b) => tokens.includes(b.token) && b.quoteAmount >= min && b.blockNumber > after);
    },
  } as unknown as EnvioClient;
  return { envio, asked };
}

/** What POST /launches stores for a launch made through hood.exe. */
async function recordLaunch(n: number, txHash: string) {
  await ctx.db.insert(schema.launches).values({ txHash, tokenAddress: addr(n), curveAddress: addr(n + 1_000), creator: addr(1), pairToken: NATIVE_PAIR, blockNumber: String(n) });
}

const txHashes = async () =>
  Object.fromEntries((await ctx.db.select().from(schema.callouts).where(eq(schema.callouts.kind, 'system'))).map((r) => [r.text, r.txHash]));

const texts = async () => (await ctx.db.select().from(schema.callouts).where(eq(schema.callouts.kind, 'system'))).map((r) => r.text).sort();

describe('system callouts', () => {
  it('posts each hood.exe launch and graduation once, and ignores other coins', async () => {
    await coin(1, 'EULER');
    await coin(2, 'GAUSS', { phase: 2 });
    await coin(3, 'RANDO', { hood: false, phase: 2 });
    const tick = () => systemCalloutsTick({ db: ctx.db, pubsub: ctx.pubsub, now: ctx.now });

    expect(await tick()).toBe(3);
    expect(await texts()).toEqual(['$EULER launched', '$GAUSS graduated to Uniswap V4', '$GAUSS launched']);
    expect(await tick()).toBe(0);
  });

  it('posts big ETH buys from the indexer, starting at its head and following a cursor', async () => {
    await coin(1, 'EULER');
    await coin(2, 'STABLE', { pair: USDG });
    const at = Math.floor(ctx.now().getTime() / 1000);
    const buys = [
      buy('1001-1', addr(1), 1_200_000_000_000_000_000n, 1_001, at), // 1.2 ETH
      buy('1002-1', addr(1), BIG_BUY_ETH - 1n, 1_002, at), // just under the bar
      buy('1003-1', addr(2), 5n * 10n ** 18n, 1_003, at), // a USDG coin: not an ETH measure
      buy('900-1', addr(1), 3n * 10n ** 18n, 900, at), // before the first run's head
    ];
    const f = fakeEnvio(buys, 1_000);
    const tick = () => systemCalloutsTick({ db: ctx.db, pubsub: ctx.pubsub, envio: f.envio, now: ctx.now });

    await tick();
    expect(f.asked[0]).toEqual({ tokens: [addr(1)], after: 1_000 });
    expect((await texts()).filter((t) => t.includes('bought'))).toEqual(['0x12ab…9f0c bought 1.2 ETH of $EULER']);

    buys.push(buy('1010-2', addr(1), 25n * 10n ** 18n, 1_010, at));
    await tick();
    expect(f.asked[1].after).toBe(1_001);
    expect((await texts()).filter((t) => t.includes('bought'))).toEqual(['0x12ab…9f0c bought 1.2 ETH of $EULER', '0x12ab…9f0c bought 25 ETH of $EULER']);
    expect(await txHashes()).toMatchObject({ '0x12ab…9f0c bought 1.2 ETH of $EULER': '0xb1001-1', '0x12ab…9f0c bought 25 ETH of $EULER': '0xb1010-2' });
  });

  it('links launch callouts to the recorded launch transaction, filling it in once the launch is recorded', async () => {
    await coin(1, 'EULER');
    await coin(2, 'GAUSS');
    await recordLaunch(1, '0xaaa');
    const tick = () => systemCalloutsTick({ db: ctx.db, pubsub: ctx.pubsub, now: ctx.now });

    await tick();
    expect(await txHashes()).toEqual({ '$EULER launched': '0xaaa', '$GAUSS launched': null });

    await recordLaunch(2, '0xbbb');
    expect(await tick()).toBe(0);
    expect(await txHashes()).toEqual({ '$EULER launched': '0xaaa', '$GAUSS launched': '0xbbb' });
  });

  it('broadcasts only recent events, oldest first, as "hood.exe"', async () => {
    await coin(1, 'OLD', { launchedAt: new Date(ctx.now().getTime() - 3_600_000) });
    await coin(2, 'NEW');
    const seen: { type: string; callout: { text: string; wallet: string; official?: boolean } }[] = [];
    await ctx.pubsub.subscribe(CALLOUTS_CHANNEL, (m) => seen.push(m as (typeof seen)[number]));
    await systemCalloutsTick({ db: ctx.db, pubsub: ctx.pubsub, now: ctx.now });
    expect(seen.map((m) => m.callout.text)).toEqual(['$NEW launched']);
    expect(seen[0].callout).toMatchObject({ wallet: 'Dockhood', official: true, kind: 'system' });
    expect(seen[0].callout).not.toHaveProperty('txHash');
  });
});
