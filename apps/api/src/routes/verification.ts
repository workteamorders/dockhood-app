import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { and, asc, count, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { encodeFunctionData, formatEther, getAddress, isAddress, isHash, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { DEFAULT_REWARD_ETH, MAX_PROOF_BYTES, TIERS, screenProof, verificationPoolAbi, type Tier } from '@hood/shared';
import { HttpError } from '../app';
import { schema, type Db } from '../db';
import { allow } from '../kv';
import type { PoolSubmission } from '../services/poolChain';
import { estimateTier } from '../services/tierEstimator';

const PAGE = 30;
const PAUSE_KEY = 'verification:paused';
/** Until enough proofs have been timed, assume this per proof. */
const DEFAULT_COMPILE_MS = 15 * 60_000;
const LIVE = ['queued', 'compiling', 'passed', 'approved'] as const;

const subs = schema.verificationSubmissions;

export const isAdminWallet = (admins: readonly string[], wallet: string | null | undefined) => !!wallet && admins.some((a) => a.toLowerCase() === wallet.toLowerCase());

export async function submissionsPaused(db: Db): Promise<boolean> {
  const [row] = await db.select().from(schema.indexState).where(eq(schema.indexState.key, PAUSE_KEY)).limit(1);
  return row?.value === 'true';
}

/**
 * Records on-chain submissions (from a confirmed transaction or the worker's log scan). A submission whose proof
 * wasn't prepared here, or whose coin isn't a hood.exe theorem coin, is recorded as failed, with the reason the worker
 * then posts on-chain. Each id is recorded once.
 */
export async function ingestSubmissions(db: Db, found: PoolSubmission[]): Promise<{ id: string; status: string }[]> {
  const out: { id: string; status: string }[] = [];
  for (const s of found) {
    const [proof] = await db.select({ hash: schema.verificationProofs.proofHash }).from(schema.verificationProofs).where(eq(schema.verificationProofs.proofHash, s.proofHash)).limit(1);
    const [coin] = await db
      .select({ hood: schema.tokens.hood, statement: schema.tokens.statement })
      .from(schema.tokens)
      .where(sql`lower(${schema.tokens.tokenAddress}) = ${s.token.toLowerCase()}`)
      .limit(1);
    const why = !coin?.hood || !coin.statement ? 'Not a Dockhood theorem coin.' : !proof ? 'The proof file was not uploaded through Dockhood.' : null;
    const [row] = await db
      .insert(subs)
      .values({
        id: s.id,
        tokenAddress: s.token,
        submitter: s.submitter,
        proofHash: s.proofHash,
        ipfsCid: s.ipfsCid,
        submittedAt: s.submittedAt,
        txHashSubmit: s.txHash,
        status: why ? 'failed' : 'queued',
        errorSummary: why,
        checkedAt: why ? new Date() : null,
      })
      .onConflictDoNothing()
      .returning({ id: subs.id, status: subs.status });
    if (row) out.push(row);
    else {
      const [existing] = await db.select({ id: subs.id, status: subs.status }).from(subs).where(eq(subs.id, s.id)).limit(1);
      if (existing) out.push(existing);
    }
  }
  return out;
}

/** Average compile-and-check time of recent proofs: the basis of every wait estimate. */
async function averageMs(db: Db): Promise<number> {
  const recent = await db.select({ ms: subs.compileMs }).from(subs).where(isNotNull(subs.compileMs)).orderBy(desc(subs.checkedAt)).limit(20);
  return recent.length ? recent.reduce((a, r) => a + r.ms!, 0) / recent.length : DEFAULT_COMPILE_MS;
}

/** Formal verification queue (hood-exe-formal-verification-brief.md §5). */
export async function verificationRoutes(app: FastifyInstance) {
  const { db, kv, pinner, env, pool, now } = app.deps;
  await app.register(multipart, { limits: { fileSize: MAX_PROOF_BYTES, files: 1, fields: 2, fieldSize: 256, parts: 3 } });

  const enabled = async () => env.VERIFICATION_SUBMISSIONS_ENABLED && !!pool && !(await submissionsPaused(db));
  const requireAdmin = async (wallet: string | null) => {
    if (!isAdminWallet(env.ADMIN_WALLETS, wallet)) throw new HttpError(403, 'Only Dockhood admins can do that.');
  };

  const tokenInfo = async (addresses: string[]) => {
    if (!addresses.length) return new Map<string, { symbol: string; name: string; statement: string | null; rigorScore: number | null }>();
    const rows = await db
      .select({ token: schema.tokens.tokenAddress, symbol: schema.tokens.symbol, name: schema.tokens.name, statement: schema.tokens.statement, rigorScore: schema.tokens.rigorScore })
      .from(schema.tokens)
      .where(inArray(sql`lower(${schema.tokens.tokenAddress})`, addresses.map((a) => a.toLowerCase())));
    return new Map(rows.map((r) => [r.token.toLowerCase(), r]));
  };

  /** Position in the queue and the estimated wait, for queued and compiling rows. */
  const waits = async () => {
    const avg = await averageMs(db);
    const queued = await db.select({ id: subs.id }).from(subs).where(eq(subs.status, 'queued')).orderBy(asc(subs.submittedAt));
    const position = new Map(queued.map((q, i) => [q.id, i + 1]));
    const slots = env.VERIFICATION_MAX_CONCURRENT;
    return (row: { id: string; status: string; startedAt: Date | null }) => {
      if (row.status === 'compiling') return { position: 0, estimatedWaitSec: Math.max(60, Math.round((avg - (now().getTime() - (row.startedAt?.getTime() ?? now().getTime()))) / 1000)) };
      const p = position.get(row.id);
      return p ? { position: p, estimatedWaitSec: Math.round((Math.ceil(p / slots) * avg) / 1000) } : { position: null, estimatedWaitSec: null };
    };
  };

  const present = (row: typeof subs.$inferSelect, tokens: Awaited<ReturnType<typeof tokenInfo>>, wait: Awaited<ReturnType<typeof waits>>, withError: boolean) => {
    const t = tokens.get(row.tokenAddress.toLowerCase());
    return {
      id: row.id,
      token: row.tokenAddress,
      ticker: t?.symbol ?? null,
      name: t?.name ?? null,
      submitter: row.submitter,
      status: row.status,
      submittedAt: row.submittedAt.toISOString(),
      tier: row.tier,
      rewardWei: row.rewardWei,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      txHashSubmit: row.txHashSubmit,
      txHashResult: row.txHashResult,
      ipfsCid: row.ipfsCid,
      errorSummary: withError ? row.errorSummary : null,
      ...wait(row),
    };
  };

  /**
   * The pool's fee and rewards, read from the contract (the owner can change them) and cached for a minute. Falls
   * back to the env fee and the default rewards when the chain can't be read.
   */
  let terms: { at: number; feeWei: bigint; rewardsEth: Record<Tier, string> } | null = null;
  const poolTerms = async () => {
    if (terms && now().getTime() - terms.at < 60_000) return terms;
    try {
      if (!pool) throw new Error('no pool');
      const [feeWei, ...rewards] = await Promise.all([pool.submissionFee(), ...TIERS.map((t) => pool.rewardWei(t))]);
      terms = { at: now().getTime(), feeWei, rewardsEth: Object.fromEntries(TIERS.map((t, i) => [t, formatEther(rewards[i])])) as Record<Tier, string> };
      return terms;
    } catch {
      return terms ?? { at: 0, feeWei: BigInt(env.VERIFICATION_SUBMISSION_FEE_WEI), rewardsEth: DEFAULT_REWARD_ETH };
    }
  };

  app.get('/verification/config', async (req) => {
    const wallet = await app.sessionWallet(req);
    const { feeWei, rewardsEth } = await poolTerms();
    return {
      enabled: await enabled(),
      poolAddress: pool?.address ?? null,
      submissionFeeWei: feeWei.toString(),
      maxPerWeek: env.VERIFICATION_MAX_PER_USER_PER_WEEK,
      maxProofBytes: MAX_PROOF_BYTES,
      rewardsEth,
      admin: isAdminWallet(env.ADMIN_WALLETS, wallet),
    };
  });

  app.post('/verification/prepare', { preHandler: app.requireSession }, async (req) => {
    if (!(await enabled()) || !pool) throw new HttpError(503, 'Proof submissions are closed right now.');
    if (env.NODE_ENV === 'production' && !env.PINATA_JWT) throw new HttpError(503, 'Proof uploads are paused while IPFS storage is being set up.');
    const wallet = req.wallet!;
    if (!(await allow(kv, `verify-prepare:${wallet}`, 20, 86_400))) throw new HttpError(429, 'Too many uploads today. Try again tomorrow.');

    let tokenAddress: string | undefined;
    let file: Buffer | undefined;
    for await (const part of req.parts()) {
      if (part.type === 'file' && part.fieldname === 'proof') {
        file = await part.toBuffer().catch(() => {
          throw new HttpError(413, 'The proof file must be 10 MB or less.');
        });
      } else if (part.type === 'field' && part.fieldname === 'tokenAddress' && typeof part.value === 'string') tokenAddress = part.value;
    }
    if (!tokenAddress || !isAddress(tokenAddress, { strict: false })) throw new HttpError(400, 'Choose the coin this proof is for.');
    if (!file?.length) throw new HttpError(400, 'Attach your proof.lean file.');
    let source: string;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(file, { stream: false });
    } catch {
      throw new HttpError(400, 'The proof file must be valid UTF-8 text.');
    }

    const [coin] = await db
      .select({ token: schema.tokens.tokenAddress, hood: schema.tokens.hood, statement: schema.tokens.statement, formal: schema.tokens.formal })
      .from(schema.tokens)
      .where(sql`lower(${schema.tokens.tokenAddress}) = ${tokenAddress.toLowerCase()}`)
      .limit(1);
    if (!coin?.hood || !coin.statement) throw new HttpError(400, 'Only Dockhood theorem coins can be formally verified.');
    if (coin.formal) throw new HttpError(409, 'This coin is already formally verified.');

    // The API's own weekly limit, so nobody pays a fee the contract would refuse.
    const weekAgo = new Date(now().getTime() - 7 * 86_400_000);
    const [{ n }] = await db.select({ n: count() }).from(subs).where(and(eq(subs.submitter, wallet), gte(subs.submittedAt, weekAgo)));
    if (n >= env.VERIFICATION_MAX_PER_USER_PER_WEEK) throw new HttpError(429, `Up to ${env.VERIFICATION_MAX_PER_USER_PER_WEEK} proofs a week. Try again later.`);

    const problems = screenProof(source);
    if (problems.length) {
      const first = problems[0];
      throw new HttpError(422, `This proof can't be accepted: line ${first.line} ${first.why}${first.text ? ` (${first.text})` : ''}.${problems.length > 1 ? ` ${problems.length - 1} more problem(s).` : ''}`);
    }

    const proofHash = `0x${createHash('sha256').update(file).digest('hex')}` as Hex;
    const [taken] = await db.select({ id: subs.id }).from(subs).where(and(eq(subs.proofHash, proofHash), sql`lower(${subs.tokenAddress}) = ${tokenAddress.toLowerCase()}`)).limit(1);
    if (taken) throw new HttpError(409, 'This exact proof was already submitted for this coin.');

    const cid = await pinner.pin(new Uint8Array(file), 'proof.lean', 'text/plain');
    await db
      .insert(schema.verificationProofs)
      .values({ proofHash, cid, content: source, bytes: file.length, tokenAddress: coin.token, uploader: wallet })
      .onConflictDoNothing();

    const fee = (await poolTerms()).feeWei;
    const token = getAddress(coin.token);
    return {
      ipfsCid: cid,
      proofHash,
      submissionFee: fee.toString(),
      estimatedTier: estimateTier(source).tier,
      txData: { to: pool.address, data: encodeFunctionData({ abi: verificationPoolAbi, functionName: 'submit', args: [token, proofHash, cid] }), value: fee.toString() },
    };
  });

  app.post('/verification/confirm', async (req, reply) => {
    if (!pool) throw new HttpError(503, 'Formal verification is not set up.');
    const { txHash } = z.object({ txHash: z.string().refine((h) => isHash(h), 'Invalid transaction hash.') }).parse(req.body);
    const found = await pool.submissionsFromTx(txHash as Hex);
    if (found === 'pending') return reply.code(202).send({ pending: true, submissions: [] });
    if (!found.length) throw new HttpError(400, 'That transaction made no proof submission.');
    return { pending: false, submissions: await ingestSubmissions(db, found) };
  });

  app.get('/verification/queue', async (req) => {
    const q = z.object({ tab: z.enum(['public', 'mine', 'verified']).default('public'), page: z.coerce.number().int().min(0).max(1_000).default(0) }).parse(req.query);
    const wallet = await app.sessionWallet(req);
    if (q.tab === 'mine' && !wallet) throw new HttpError(401, 'Sign in to see your submissions.');
    const where =
      q.tab === 'public' ? inArray(subs.status, [...LIVE]) : q.tab === 'verified' ? eq(subs.status, 'verified') : sql`lower(${subs.submitter}) = ${wallet!.toLowerCase()}`;
    const order = q.tab === 'public' ? [asc(subs.submittedAt)] : q.tab === 'verified' ? [desc(subs.verifiedAt)] : [desc(subs.submittedAt)];
    const rows = await db.select().from(subs).where(where).orderBy(...order).limit(PAGE + 1).offset(q.page * PAGE);
    const [tokens, wait] = await Promise.all([tokenInfo(rows.map((r) => r.tokenAddress)), waits()]);
    return { tab: q.tab, items: rows.slice(0, PAGE).map((r) => present(r, tokens, wait, q.tab === 'mine')), more: rows.length > PAGE };
  });

  app.get<{ Params: { id: string } }>('/verification/submission/:id', async (req) => {
    if (!isHash(req.params.id)) throw new HttpError(404, 'No such submission.');
    const [row] = await db.select().from(subs).where(eq(subs.id, req.params.id)).limit(1);
    if (!row) throw new HttpError(404, 'No such submission.');
    const [[proof], tokens, wait] = await Promise.all([
      db.select({ content: schema.verificationProofs.content, bytes: schema.verificationProofs.bytes }).from(schema.verificationProofs).where(eq(schema.verificationProofs.proofHash, row.proofHash)).limit(1),
      tokenInfo([row.tokenAddress]),
      waits(),
    ]);
    const t = tokens.get(row.tokenAddress.toLowerCase());
    return { submission: present(row, tokens, wait, true), theorems: row.theorems ?? [], coinStatement: t?.statement ?? null, proof: proof?.content ?? null, proofBytes: proof?.bytes ?? null };
  });

  app.get<{ Params: { address: string } }>('/verification/token/:address', async (req) => {
    if (!isAddress(req.params.address, { strict: false })) throw new HttpError(400, 'Invalid address.');
    const lower = req.params.address.toLowerCase();
    const [verified] = await db.select().from(subs).where(and(sql`lower(${subs.tokenAddress}) = ${lower}`, eq(subs.status, 'verified'))).orderBy(desc(subs.verifiedAt)).limit(1);
    const [{ pending }] = await db.select({ pending: count() }).from(subs).where(and(sql`lower(${subs.tokenAddress}) = ${lower}`, inArray(subs.status, [...LIVE])));
    if (!verified) return { verified: null, pending };
    const [proof] = await db.select({ content: schema.verificationProofs.content }).from(schema.verificationProofs).where(eq(schema.verificationProofs.proofHash, verified.proofHash)).limit(1);
    return {
      verified: { id: verified.id, tier: verified.tier, rewardWei: verified.rewardWei, verifiedAt: verified.verifiedAt?.toISOString() ?? null, ipfsCid: verified.ipfsCid, txHashResult: verified.txHashResult, theorems: verified.theorems ?? [], proof: proof?.content ?? null },
      pending,
    };
  });

  // ── Admin (/admin/verification) ──

  app.get('/verification/admin/overview', { preHandler: app.requireSession }, async (req) => {
    await requireAdmin(req.wallet);
    const weekAgo = new Date(now().getTime() - 7 * 86_400_000);
    const [byStatus, [week], [oldest], avg, review, [paid]] = await Promise.all([
      db.select({ status: subs.status, n: count() }).from(subs).groupBy(subs.status),
      db.select({ n: count() }).from(subs).where(gte(subs.submittedAt, weekAgo)),
      db.select({ at: subs.submittedAt }).from(subs).where(eq(subs.status, 'queued')).orderBy(asc(subs.submittedAt)).limit(1),
      averageMs(db),
      db.select().from(subs).where(eq(subs.status, 'passed')).orderBy(asc(subs.checkedAt)),
      db.select({ wei: sql<string>`coalesce(sum(${subs.rewardWei}), 0)::text` }).from(subs).where(eq(subs.status, 'verified')),
    ]);
    const counts = Object.fromEntries(byStatus.map((r) => [r.status, r.n]));
    const done = (counts.verified ?? 0) + (counts.passed ?? 0) + (counts.approved ?? 0) + (counts.failed ?? 0) + (counts.rejected ?? 0);
    const tokens = await tokenInfo(review.map((r) => r.tokenAddress));
    const proofs = review.length
      ? new Map(
          (await db.select({ hash: schema.verificationProofs.proofHash, content: schema.verificationProofs.content }).from(schema.verificationProofs).where(inArray(schema.verificationProofs.proofHash, review.map((r) => r.proofHash)))).map((p) => [p.hash, p.content]),
        )
      : new Map<string, string>();
    const balances = pool ? await pool.balances().catch(() => null) : null;
    return {
      pool: { address: pool?.address ?? null, balanceWei: balances?.balance.toString() ?? null, availableWei: balances?.available.toString() ?? null },
      /** The fee splitter, whose pool share the owner wallet sets from the admin page. */
      feeSplitterAddress: env.FEE_SPLITTER_ADDRESS ?? null,
      paused: await submissionsPaused(db),
      enabledByEnv: env.VERIFICATION_SUBMISSIONS_ENABLED,
      counts,
      queueLength: (counts.queued ?? 0) + (counts.compiling ?? 0),
      oldestQueuedAt: oldest?.at.toISOString() ?? null,
      submissionsThisWeek: week.n,
      successRate: done ? ((counts.verified ?? 0) + (counts.passed ?? 0) + (counts.approved ?? 0)) / done : null,
      averageCheckSec: Math.round(avg / 1000),
      paidOutWei: paid.wei,
      review: review.map((r) => {
        const proof = proofs.get(r.proofHash) ?? '';
        const t = tokens.get(r.tokenAddress.toLowerCase());
        return {
          id: r.id,
          token: r.tokenAddress,
          ticker: t?.symbol ?? null,
          coinStatement: t?.statement ?? null,
          submitter: r.submitter,
          checkedAt: r.checkedAt?.toISOString() ?? null,
          theorems: r.theorems ?? [],
          suggestedTier: r.suggestedTier,
          suggestion: estimateTier(proof).reasons,
          proof,
        };
      }),
    };
  });

  app.post('/verification/admin/review', { preHandler: app.requireSession }, async (req) => {
    await requireAdmin(req.wallet);
    const body = z
      .object({ id: z.string().refine((h) => isHash(h)), decision: z.enum(['approve', 'reject']), tier: z.enum(TIERS).optional(), note: z.string().max(500).optional() })
      .refine((b) => b.decision === 'reject' || !!b.tier, 'Choose a tier to approve.')
      .parse(req.body);
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(subs).where(eq(subs.id, body.id)).limit(1);
      if (!row) throw new HttpError(404, 'No such submission.');
      if (row.status !== 'passed') throw new HttpError(409, `Only proofs that passed the checker can be reviewed (this one is ${row.status}).`);
      if (body.decision === 'approve') {
        // Serialize approvals per coin across API processes, including differently cased addresses.
        await tx.execute(sql`select pg_advisory_xact_lock(7667, hashtext(${row.tokenAddress.toLowerCase()}))`);
        const sameCoin = sql`lower(${subs.tokenAddress}) = ${row.tokenAddress.toLowerCase()}`;
        const [first] = await tx.select({ id: subs.id }).from(subs).where(and(sameCoin, inArray(subs.status, ['approved', 'verified']))).limit(1);
        const [coin] = await tx.select({ formal: schema.tokens.formal }).from(schema.tokens).where(sql`lower(${schema.tokens.tokenAddress}) = ${row.tokenAddress.toLowerCase()}`).limit(1);
        if (first || coin?.formal) throw new HttpError(409, 'This coin already has an approved proof. Reject this one.');
      }
      const reviewed = { reviewedBy: req.wallet, reviewedAt: now(), reviewNote: body.note ?? null };
      const [updated] = await tx
        .update(subs)
        .set(
          body.decision === 'approve'
            ? { ...reviewed, status: 'approved', tier: body.tier!, adminTierOverride: body.tier !== row.suggestedTier, lastError: null }
            : { ...reviewed, status: 'rejected', errorSummary: `Review: ${body.note?.trim() || "the proof doesn't prove this coin's theorem."}` },
        )
        .where(and(eq(subs.id, body.id), eq(subs.status, 'passed')))
        .returning({ status: subs.status, tier: subs.tier });
      if (!updated) throw new HttpError(409, 'Someone reviewed this proof a moment ago.');
      return updated;
    });
  });

  app.post('/verification/admin/pause', { preHandler: app.requireSession }, async (req) => {
    await requireAdmin(req.wallet);
    const { paused } = z.object({ paused: z.boolean() }).parse(req.body);
    await db
      .insert(schema.indexState)
      .values({ key: PAUSE_KEY, value: String(paused) })
      .onConflictDoUpdate({ target: schema.indexState.key, set: { value: String(paused) } });
    return { paused };
  });
}

