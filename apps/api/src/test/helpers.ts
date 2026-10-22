import { verifyMessage, type Hash } from 'viem';
import type { PoolReader } from '../services/poolChain';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import type { RigorBreakdown } from '@hood/shared';
import { buildApp } from '../app';
import { connectMemory } from '../db';
import { loadEnv } from '../env';
import { memoryKv } from '../kv';
import type { ChainReader, LaunchOnChain, LaunchRecord } from '../services/chain';
import type { CurveState, TokenMetadata } from '../services/tokenIndex';
import type { EnvioClient } from '../services/envio';
import type { Moderator } from '../services/moderation';
import { devPinner } from '../services/pinner';
import { memoryPubSub } from '../services/pubsub';
import type { Scorer } from '../services/scorer';

// Anvil's well-known dev keys; never funded on mainnet.
export const alice = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
export const bob = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

export const ORIGIN = 'http://localhost:3000';

export const BREAKDOWN: RigorBreakdown = {
  score: 91,
  parts: { wellFormed: 25, status: 33, significance: 22, clarity: 11 },
  statusLabel: 'proven',
  reasoning: "Euler's identity, a classical result.",
};

export async function setup(opts: { scorer?: Scorer; launches?: Map<string, LaunchOnChain | 'pending' | null>; envio?: EnvioClient; moderator?: Moderator; official?: string; env?: Record<string, string>; pool?: PoolReader } = {}) {
  const { db, close } = await connectMemory();
  let clock = new Date('2026-10-09T12:00:00Z').getTime();
  const scorerCalls: string[] = [];
  const scorer: Scorer = opts.scorer ?? {
    score: async (_name, statement) => {
      scorerCalls.push(statement);
      return { breakdown: BREAKDOWN, model: 'test-model' };
    },
  };
  const launches = opts.launches ?? new Map();
  /** ETH balances by lowercase address; anyone not listed holds 1 ETH. */
  const balances = new Map<string, bigint>();
  /** ERC-20 balances keyed "token:owner" (lowercase), and factory records for coins outside the token table. */
  const tokenBalances = new Map<string, bigint>();
  const launchRecords = new Map<string, LaunchRecord>();
  /** Live metadata and curve state the portfolio reads, by lowercase token address. */
  const market = { meta: new Map<string, TokenMetadata>(), state: new Map<string, CurveState>() };
  const chain: ChainReader = {
    verifySignature: (address, message, signature) => verifyMessage({ address, message, signature }),
    launchFromTx: async (hash) => launches.get(hash.toLowerCase()) ?? null,
    balance: async (address) => balances.get(address.toLowerCase()) ?? 10n ** 18n,
    tokenBalances: async (owner, tokens) => new Map(tokens.flatMap((t) => { const b = tokenBalances.get(t.toLowerCase() + ':' + owner.toLowerCase()); return b == null ? [] : [[t, b] as const]; })),
    launchRecords: async (tokens) => new Map(tokens.flatMap((t) => { const r = launchRecords.get(t.toLowerCase()); return r ? [[t, r] as const] : []; })),
  };
  const pinner = devPinner();
  const pubsub = memoryPubSub();
  /** Allows everything, recording what it was asked. */
  const moderated: string[] = [];
  const moderator: Moderator = { check: async (text) => (moderated.push(text), { allow: true, reason: 'ok' }) };
  const app = await buildApp({
    env: loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'memory', CORS_ORIGINS: ORIGIN, OFFICIAL_WALLETS: opts.official ?? '', ...opts.env }),
    db,
    kv: memoryKv(() => clock),
    scorer,
    pinner,
    chain,
    envio: opts.envio,
    market: {
      metadata: async (tokens) => new Map(tokens.flatMap((t) => { const m = market.meta.get(t.toLowerCase()); return m ? [[t, m] as const] : []; })),
      state: async (items) => new Map(items.flatMap((i) => { const s = market.state.get(i.token.toLowerCase()); return s ? [[i.token, s] as const] : []; })),
    },
    moderator: opts.moderator ?? moderator,
    pubsub,
    pool: opts.pool,
    now: () => new Date(clock),
  });
  return {
    app,
    db,
    pinner,
    scorerCalls,
    launches,
    balances,
    tokenBalances,
    launchRecords,
    market,
    pubsub,
    moderated,
    advance: (ms: number) => void (clock += ms),
    now: () => new Date(clock),
    close: async () => {
      await app.close();
      await close();
    },
  };
}

type Ctx = Awaited<ReturnType<typeof setup>>;
type Account = typeof alice;

export async function siweMessage(ctx: Ctx, account: Account, overrides: Partial<Parameters<typeof createSiweMessage>[0]> = {}) {
  const { nonce } = (await ctx.app.inject({ method: 'GET', url: '/auth/siwe' })).json<{ nonce: string }>();
  return createSiweMessage({
    domain: 'localhost:3000',
    address: account.address,
    statement: 'Sign in to hood.exe',
    uri: ORIGIN,
    version: '1',
    chainId: ctx.app.deps.env.network.chainId,
    nonce,
    issuedAt: ctx.now(),
    ...overrides,
  });
}

/** Signs in and returns the Cookie header for later requests. */
export async function signIn(ctx: Ctx, account: Account = alice): Promise<string> {
  const message = await siweMessage(ctx, account);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/auth/siwe',
    payload: { message, signature: await account.signMessage({ message }) },
  });
  if (res.statusCode !== 200) throw new Error(`sign-in failed: ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'hood_session');
  return `hood_session=${cookie!.value}`;
}

export async function multipart(fields: Record<string, string | Blob>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = new Response(form);
  return { payload: Buffer.from(await res.arrayBuffer()), headers: { 'content-type': res.headers.get('content-type')! } };
}

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

export const txHash = (n: number): Hash => `0x${n.toString(16).padStart(64, '0')}`;
