import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getAddress, isHex } from 'viem';
import { generateSiweNonce, parseSiweMessage } from 'viem/siwe';
import { z } from 'zod';
import { HttpError, SESSION_COOKIE } from '../app';
import { schema } from '../db';
import { allow } from '../kv';

const NONCE_TTL = 10 * 60;
const SESSION_DAYS = 7;
const CLOCK_SKEW_MS = 60_000;

const verifyBody = z.object({
  message: z.string().min(1).max(2_000),
  signature: z.string().refine((s) => isHex(s), 'Invalid signature.'),
});

/** SIWE: 10-minute nonce, 7-day httpOnly session cookie on the configured chain. */
export async function authRoutes(app: FastifyInstance) {
  const { db, kv, chain, env } = app.deps;
  // The SIWE domain must be a site we serve the app from (a CORS_ORIGINS host).
  const domains = new Set(env.CORS_ORIGINS.map((o) => new URL(o).host));
  const cookieOptions = {
    signed: true,
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    domain: env.COOKIE_DOMAIN,
  };

  app.get('/auth/siwe', async (req) => {
    if (!(await allow(kv, `siwe:${req.clientIp}`, 30, 600))) throw new HttpError(429, 'Too many sign-in attempts. Wait a few minutes.');
    const nonce = generateSiweNonce();
    await kv.set(`siwe:nonce:${nonce}`, '1', NONCE_TTL);
    return { nonce };
  });

  app.post('/auth/siwe', async (req, reply) => {
    const body = verifyBody.parse(req.body);
    const msg = parseSiweMessage(body.message);
    const now = app.deps.now().getTime();

    if (!msg.address || !msg.nonce || !msg.domain || !msg.issuedAt) throw new HttpError(400, 'Invalid sign-in message.');
    if (msg.chainId !== env.network.chainId) throw new HttpError(400, `Sign in on ${env.network.chain.name}.`);
    if (!domains.has(msg.domain)) throw new HttpError(400, 'This sign-in message is for another site.');
    const issued = msg.issuedAt.getTime();
    if (issued > now + CLOCK_SKEW_MS || issued < now - NONCE_TTL * 1000) throw new HttpError(400, 'Sign-in message expired. Try again.');
    if (msg.expirationTime && msg.expirationTime.getTime() < now) throw new HttpError(400, 'Sign-in message expired. Try again.');
    if (msg.notBefore && msg.notBefore.getTime() > now + CLOCK_SKEW_MS) throw new HttpError(400, 'Sign-in message is not valid yet.');
    // Spend the nonce before verifying, so a replay fails even if verification is slow.
    if (!(await kv.take(`siwe:nonce:${msg.nonce}`))) throw new HttpError(401, 'Sign-in expired. Try again.');
    if (!(await chain.verifySignature(msg.address, body.message, body.signature as `0x${string}`))) {
      throw new HttpError(401, 'Signature does not match the wallet.');
    }

    const wallet = getAddress(msg.address);
    const id = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now + SESSION_DAYS * 86_400_000);
    await db.insert(schema.sessions).values({ id, wallet, expiresAt });
    reply.setCookie(SESSION_COOKIE, id, { ...cookieOptions, expires: expiresAt });
    return { wallet, expiresAt: expiresAt.toISOString() };
  });

  app.get('/auth/me', { preHandler: app.requireSession }, async (req) => {
    const [profile] = await db.select({ nickname: schema.profiles.nickname }).from(schema.profiles).where(eq(schema.profiles.wallet, req.wallet!)).limit(1);
    return {
      wallet: req.wallet,
      nickname: profile?.nickname ?? null,
      official: env.OFFICIAL_WALLETS.some((w) => w.toLowerCase() === req.wallet!.toLowerCase()),
    };
  });

  app.post('/auth/logout', async (req, reply) => {
    const signed = req.cookies[SESSION_COOKIE];
    const unsigned = signed ? req.unsignCookie(signed) : null;
    if (unsigned?.valid && unsigned.value) await db.delete(schema.sessions).where(eq(schema.sessions.id, unsigned.value));
    reply.clearCookie(SESSION_COOKIE, cookieOptions);
    return { ok: true };
  });
}
