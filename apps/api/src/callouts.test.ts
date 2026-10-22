import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getAddress } from 'viem';
import { NATIVE_PAIR } from '@hood/shared';
import { schema } from './db';
import type { EnvioClient } from './services/envio';
import { blocklistHit, cleanCalloutText } from './services/moderation';
import { CALLOUTS_CHANNEL } from './services/pubsub';
import { alice, bob, setup, signIn } from './test/helpers';

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.close();
});

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

async function seedToken(n: number, symbol: string, opts: { hood?: boolean; block?: number; phase?: number; deployer?: string } = {}) {
  await ctx.db.insert(schema.tokens).values({
    tokenAddress: addr(n),
    curveAddress: addr(n + 1_000),
    deployer: opts.deployer ?? addr(1),
    pairToken: NATIVE_PAIR,
    blockNumber: opts.block ?? n,
    launchedAt: new Date(),
    name: symbol,
    symbol,
    logo: '',
    description: '',
    hood: opts.hood ?? false,
    graduationThreshold: '4200000000000000000',
    phase: opts.phase ?? 0,
  });
}

const post = (cookie: string, text: string, extra: Record<string, unknown> = {}) =>
  ctx.app.inject({ method: 'POST', url: '/callouts', headers: { cookie }, payload: { text, ...extra } });
const list = (qs = '', cookie?: string) => ctx.app.inject({ method: 'GET', url: `/callouts${qs}`, headers: cookie ? { cookie } : {} }).then((r) => r.json());

describe('callout text', () => {
  it('strips links, bare domains and extra whitespace', () => {
    expect(cleanCalloutText('gm  https://scam.xyz/claim  $PEPE to the moon www.foo.com')).toBe('gm $PEPE to the moon');
    expect(cleanCalloutText('join t.me/pumpgroup or x.com/hoodexe now')).toBe('join or now');
    expect(cleanCalloutText('e^{i pi} + 1 = 0, 3.14 is pi')).toBe('e^{i pi} + 1 = 0, 3.14 is pi');
  });

  it('blocks scam phrases and slurs, including spaced-out spellings', () => {
    expect(blocklistHit('DM me for the airdrop claim')).toBe('airdrop claim');
    expect(blocklistHit('d.m   me fren')).toBe('dm me');
    expect(blocklistHit('send me your s e e d p h r a s e')).toBe('seed phrase');
    expect(blocklistHit('this is spicy, ser')).toBeNull();
    expect(blocklistHit('rug alert', ['rug alert'])).toBe('rug alert');
  });
});

describe('POST /callouts', () => {
  it('needs a session', async () => {
    expect((await ctx.app.inject({ method: 'POST', url: '/callouts', payload: { text: 'gm' } })).statusCode).toBe(401);
  });

  it('posts, links the $TICKER (hood.exe launch first) and broadcasts it', async () => {
    await seedToken(10, 'PEPE', { block: 900 });
    await seedToken(11, 'PEPE', { block: 100, hood: true });
    const seen: unknown[] = [];
    await ctx.pubsub.subscribe(CALLOUTS_CHANNEL, (m) => seen.push(m));

    const cookie = await signIn(ctx);
    const res = await post(cookie, '$pepe is going up https://scam.xyz');
    expect(res.statusCode).toBe(201);
    const { callout, hidden } = res.json();
    expect(hidden).toBe(false);
    expect(callout).toMatchObject({ wallet: alice.address, text: '$pepe is going up', kind: 'user', tokenAddress: addr(11), ticker: 'PEPE', reactions: { rocket: 0, eyes: 0, skull: 0 } });
    expect(ctx.moderated).toEqual(['$pepe is going up']);
    expect(seen).toEqual([{ type: 'callout', callout }]);
  });

  it('prefers an explicit token over the text, and leaves unknown tickers unlinked', async () => {
    await seedToken(12, 'DOGE');
    const cookie = await signIn(ctx);
    expect((await post(cookie, 'watching this one', { tokenAddress: addr(12) })).json().callout).toMatchObject({ ticker: 'DOGE', tokenAddress: addr(12) });
    expect((await post(cookie, '$NOPE ngmi')).json().callout).toMatchObject({ ticker: null, tokenAddress: null });
  });

  it("attaches the poster's latest trade on the linked coin, and posts without one if the indexer fails", async () => {
    const asked: { wallet: string; token: string; since: number }[] = [];
    let down = false;
    const envio = {
      latestWalletTrade: async (wallet: string, token: string, since: number) => {
        asked.push({ wallet, token, since });
        if (down) throw new Error('indexer down');
        return { id: 't1', trader: wallet, isBuy: false, quoteAmount: 1n, tokenAmount: 1n, price: '1', timestamp: since + 60, txHash: '0xfeed' };
      },
    } as unknown as EnvioClient;
    await ctx.close();
    ctx = await setup({ envio });
    await seedToken(12, 'DOGE');
    const cookie = await signIn(ctx);

    expect((await post(cookie, 'sold some $DOGE')).json().callout).toMatchObject({ ticker: 'DOGE', txHash: '0xfeed', txSide: 'sell' });
    expect(asked).toEqual([{ wallet: getAddress(alice.address), token: getAddress(addr(12)), since: Math.floor(ctx.now().getTime() / 1000) - 86_400 }]);
    expect((await post(cookie, 'gm, no coin here')).json().callout).not.toHaveProperty('txHash');
    expect(asked).toHaveLength(1);

    down = true;
    const res = await post(cookie, '$DOGE again');
    expect(res.statusCode).toBe(201);
    expect(res.json().callout).not.toHaveProperty('txHash');
  });

  it('enforces length, emptiness and the ETH-holder rule', async () => {
    const cookie = await signIn(ctx);
    expect((await post(cookie, 'x'.repeat(181))).statusCode).toBe(400);
    expect((await post(cookie, 'https://only-a-link.xyz')).json().error).toMatch(/links are removed/);
    ctx.balances.set(alice.address.toLowerCase(), 0n);
    const broke = await post(cookie, 'gm');
    expect(broke.statusCode).toBe(403);
    expect(broke.json().error).toMatch(/ETH on Robinhood Chain/);
  });

  it('holds blocklisted, model-hidden and unmoderated posts as hidden', async () => {
    // Asked twice (the blocklisted post never reaches it): can't decide, then hides; then allows.
    const verdicts = [null, { allow: false, reason: 'harassment' }];
    await ctx.close();
    ctx = await setup({ moderator: { check: async () => (verdicts.length ? verdicts.shift()! : { allow: true, reason: '' }) } });
    const seen: unknown[] = [];
    await ctx.pubsub.subscribe(CALLOUTS_CHANNEL, (m) => seen.push(m));
    const cookie = await signIn(ctx);

    expect((await post(cookie, 'DM me for alpha')).json().hidden).toBe(true); // blocklist, model never asked
    expect((await post(cookie, 'something the model cannot judge')).json().hidden).toBe(true);
    expect((await post(cookie, 'something mean')).json().hidden).toBe(true);
    expect((await post(cookie, 'a normal callout')).json().hidden).toBe(false);

    const rows = await ctx.db.select({ text: schema.callouts.text, reason: schema.callouts.hiddenReason }).from(schema.callouts).orderBy(schema.callouts.createdAt);
    expect(rows.map((r) => r.reason)).toEqual(['blocklist', 'moderation_unavailable', 'model: harassment', null]);
    expect((await list()).items.map((i: { text: string }) => i.text)).toEqual(['a normal callout']);
    expect(seen).toHaveLength(1);
  });

  it('allows 5 a minute per wallet', async () => {
    const cookie = await signIn(ctx);
    for (let i = 0; i < 5; i++) expect((await post(cookie, `call ${i}`)).statusCode).toBe(201);
    expect((await post(cookie, 'one more')).statusCode).toBe(429);
    ctx.advance(61_000);
    expect((await post(cookie, 'one more')).statusCode).toBe(201);
  });
});

describe('GET /callouts', () => {
  async function seedFeed(n: number) {
    const cookie = await signIn(ctx);
    for (let i = 0; i < n; i++) {
      ctx.advance(1_000);
      const response = await post(cookie, `call ${i}`);
      expect(response.statusCode).toBe(201);
      // Database defaults use wall time, not the fixture clock; avoid timestamp ties in pagination.
      await ctx.db.update(schema.callouts).set({ createdAt: ctx.now() }).where(eq(schema.callouts.id, response.json().callout.id));
    }
    return cookie;
  }

  it('pages older with `before`, polls newer with `after`, and reports live counts', async () => {
    await seedFeed(5);
    const first = await list('?limit=2');
    expect(first.items.map((i: { text: string }) => i.text)).toEqual(['call 4', 'call 3']);
    expect(first.live).toEqual({ callouts: 5, users: 1 });
    const second = await list(`?limit=2&before=${first.nextCursor}`);
    expect(second.items.map((i: { text: string }) => i.text)).toEqual(['call 2', 'call 1']);
    const last = await list(`?limit=2&before=${second.nextCursor}`);
    expect(last.items.map((i: { text: string }) => i.text)).toEqual(['call 0']);
    expect(last.nextCursor).toBeNull();

    const bobCookie = await signIn(ctx, bob);
    ctx.advance(1_000);
    await post(bobCookie, 'fresh one');
    const newer = await list(`?after=${first.newestCursor}`);
    expect(newer.items.map((i: { text: string }) => i.text)).toEqual(['fresh one']);
    expect((await list('?before=garbage')).error).toBe('Invalid cursor.');
  });

  it('filters by token', async () => {
    await seedToken(20, 'MOON');
    const cookie = await signIn(ctx);
    await post(cookie, '$MOON soon');
    await post(cookie, 'unrelated');
    expect((await list(`?token=${addr(20).toUpperCase().replace('0X', '0x')}`)).items.map((i: { text: string }) => i.text)).toEqual(['$MOON soon']);
  });

  it('marks official wallets, verified creators and nicknames', async () => {
    await ctx.close();
    ctx = await setup({ official: bob.address });
    await seedToken(30, 'GRAD', { hood: true, phase: 2, deployer: alice.address });
    const a = await signIn(ctx);
    const b = await signIn(ctx, bob);
    await ctx.app.inject({ method: 'PUT', url: '/profile', headers: { cookie: a }, payload: { nickname: 'euler' } });
    await post(a, 'from alice');
    await post(b, 'from bob');
    const items = (await list()).items;
    expect(items.find((i: { text: string }) => i.text === 'from alice')).toMatchObject({ nickname: 'euler', verified: true });
    expect(items.find((i: { text: string }) => i.text === 'from alice').official).toBeUndefined();
    expect(items.find((i: { text: string }) => i.text === 'from bob')).toMatchObject({ official: true });
  });
});

describe('reactions', () => {
  it('toggles one of each kind per wallet and broadcasts counts', async () => {
    const a = await signIn(ctx);
    const b = await signIn(ctx, bob);
    const { callout } = (await post(a, 'react to me')).json();
    const seen: unknown[] = [];
    await ctx.pubsub.subscribe(CALLOUTS_CHANNEL, (m) => seen.push(m));
    const react = (cookie: string, kind: string) => ctx.app.inject({ method: 'POST', url: `/callouts/${callout.id}/react`, headers: { cookie }, payload: { kind } }).then((r) => r.json());

    expect(await react(a, 'rocket')).toMatchObject({ reactions: { rocket: 1, eyes: 0, skull: 0 }, reacted: true });
    expect(await react(b, 'rocket')).toMatchObject({ reactions: { rocket: 2 } });
    expect(await react(b, 'skull')).toMatchObject({ reactions: { rocket: 2, skull: 1 } });
    expect(await react(a, 'rocket')).toMatchObject({ reactions: { rocket: 1 }, reacted: false });
    expect(seen.at(-1)).toEqual({ type: 'reactions', id: callout.id, reactions: { rocket: 1, eyes: 0, skull: 1 } });
    expect((await list('', b)).items[0].mine.sort()).toEqual(['rocket', 'skull']);
    expect((await list()).items[0].mine).toBeUndefined();
  });

  it('refuses unknown kinds and hidden callouts', async () => {
    const a = await signIn(ctx);
    const { callout } = (await post(a, 'DM me')).json();
    expect((await ctx.app.inject({ method: 'POST', url: `/callouts/${callout.id}/react`, headers: { cookie: a }, payload: { kind: 'rocket' } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'POST', url: `/callouts/${callout.id}/react`, headers: { cookie: a }, payload: { kind: 'heart' } })).statusCode).toBe(400);
  });
});

describe('nicknames', () => {
  it('validates, keeps them unique, and allows one change a day', async () => {
    const a = await signIn(ctx);
    const b = await signIn(ctx, bob);
    const put = (cookie: string, nickname: string) => ctx.app.inject({ method: 'PUT', url: '/profile', headers: { cookie }, payload: { nickname } });
    expect((await put(a, 'Euler!')).statusCode).toBe(400);
    expect((await put(a, 'euler')).statusCode).toBe(200);
    expect((await put(b, 'euler')).statusCode).toBe(409);
    expect((await put(a, 'gauss')).statusCode).toBe(429);
    ctx.advance(86_400_001);
    expect((await put(a, 'gauss')).statusCode).toBe(200);
    const [row] = await ctx.db.select().from(schema.profiles).where(eq(schema.profiles.wallet, alice.address));
    expect(row.nickname).toBe('gauss');
  });
});

describe('GET /ws', () => {
  it('greets, then pushes new callouts', async () => {
    await ctx.app.ready();
    const ws = await ctx.app.injectWS('/ws');
    const messages: unknown[] = [];
    const got = (n: number) =>
      new Promise<void>((resolve) => {
        const check = () => (messages.length >= n ? resolve() : setTimeout(check, 10));
        check();
      });
    ws.on('message', (data: Buffer) => messages.push(JSON.parse(data.toString())));
    const cookie = await signIn(ctx);
    await post(cookie, 'live!');
    await got(1);
    expect(messages.at(-1)).toMatchObject({ type: 'callout', callout: { text: 'live!' } });
    ws.terminate();
  });
});

describe('CORS', () => {
  it('lets the web app preflight PUT /profile with credentials', async () => {
    const res = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/profile',
      headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type' },
    });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['access-control-allow-methods'])).toContain('PUT');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });
});
