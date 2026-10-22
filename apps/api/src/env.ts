import { z } from 'zod';
import { resolveNetwork, type NetworkConfig } from '@hood/shared';

const list = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((s) =>
      s
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    );

const optional = z
  .string()
  .optional()
  .transform((v) => (v?.trim() ? v.trim() : undefined));

/** docs/BRIEF.md §13. Production refuses to start without real secrets; dev runs with stand-ins. */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().default(8787),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: optional,
    RPC_URL_SERVER: optional,
    CHAIN_ID: z.coerce.number().int().refine((id) => id === 4663 || id === 46630, 'must be 4663 or 46630').default(4663),
    PONS_LAUNCH_FACTORY: optional,
    PONS_LAUNCH_AND_BUY: optional,
    PAIR_TOKENS_JSON: optional,
    OFFICIAL_TOKEN_ADDRESS: optional,
    DEEPSEEK_API_KEY: optional,
    DEEPSEEK_BASE_URL: z.string().default('https://api.deepseek.com'),
    DEEPSEEK_MODEL: z.string().default('deepseek-v4-flash'),
    PINATA_JWT: optional,
    SESSION_SECRET: z.string().default('dev-only-session-secret-change-me-0000'),
    COOKIE_DOMAIN: optional,
    CORS_ORIGINS: list('http://localhost:3000'),
    /** Envio indexer GraphQL (apps/indexer). Without it, launches are found by scanning RPC logs (local only). */
    ENVIO_GRAPHQL_URL: optional,
    /** Explore's token table sync; 'off' when another process runs it. */
    TOKEN_INDEX: z.enum(['on', 'off']).default('on'),
    TOKEN_INDEX_BACKFILL_BLOCKS: z.coerce.number().int().min(0).default(300_000),
    /** Wallets shown as official in Callouts (blue left border). */
    OFFICIAL_WALLETS: list(''),
    /** Extra blocklist terms for callouts, comma-separated. */
    BLOCKLIST_EXTRA: list(''),
    /**
     * 'allow' lets production run without DeepSeek and Pinata while they're being set up: theorems come back
     * unscored, callouts get the blocklist only, and /ipfs refuses, which blocks launches before any transaction.
     */
    STAND_INS: z.enum(['refuse', 'allow']).default('refuse'),
    /** Shared with the web app (its PROXY_SECRET): proves an x-hood-client-ip header came through its /api proxy. */
    PROXY_SECRET: optional,
    /** The self-hosted indexer's own Postgres; the worker prunes old trades and candles there (docs/DEPLOY.md). */
    INDEXER_DATABASE_URL: optional,

    // ── Formal verification (hood-exe-formal-verification-brief.md §10) ──
    /** New proof submissions; off until the pool is funded and the contracts are reviewed (brief §9, §15). */
    VERIFICATION_SUBMISSIONS_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
    /** Proofs compiled at once by the verifier worker. */
    VERIFICATION_MAX_CONCURRENT: z.coerce.number().int().min(1).max(16).default(2),
    /** Lean compile timeout per proof. */
    VERIFICATION_TIMEOUT_SEC: z.coerce.number().int().min(60).default(7200),
    /** Shown before the wallet reads the contract's submissionFee(), which is the truth. */
    VERIFICATION_SUBMISSION_FEE_WEI: z.string().regex(/^\d+$/).default('10000000000000000'),
    /** API-side limit on prepared proofs, before the contract's own weekly limit. */
    VERIFICATION_MAX_PER_USER_PER_WEEK: z.coerce.number().int().min(1).default(3),
    /** The verifier worker's signing key (VPS only; never set on the API service). */
    VERIFIER_BOT_PRIVATE_KEY: optional,
    /** Wallets allowed into /admin/verification (review, tiers, pause). */
    ADMIN_WALLETS: list(''),
    VERIFICATION_POOL_ADDRESS: optional,
    FEE_SPLITTER_ADDRESS: optional,
    RIGOR_REGISTRY_ADDRESS: optional,
    /** Per-machine sandbox memory, overriding sandbox-config.json: RAM for the checker, and swap it may add. */
    VERIFICATION_MEMORY_MB: z.coerce.number().int().min(1024).optional(),
    VERIFICATION_SWAP_MB: z.coerce.number().int().min(0).optional(),
    /** The checker image the worker runs (apps/verifier). */
    VERIFIER_IMAGE: z.string().default('hoodexe/verifier:latest'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    const required = env.STAND_INS === 'allow' ? (['REDIS_URL', 'RPC_URL_SERVER'] as const) : (['REDIS_URL', 'DEEPSEEK_API_KEY', 'PINATA_JWT', 'RPC_URL_SERVER'] as const);
    for (const key of required) {
      if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'required in production' });
    }
    if (env.TOKEN_INDEX === 'on' && !env.ENVIO_GRAPHQL_URL) {
      ctx.addIssue({ code: 'custom', path: ['ENVIO_GRAPHQL_URL'], message: 'required in production (log scanning needs a paid RPC tier)' });
    }
    if (env.SESSION_SECRET.length < 32 || env.SESSION_SECRET.startsWith('dev-only')) {
      ctx.addIssue({ code: 'custom', path: ['SESSION_SECRET'], message: 'set a random secret of 32+ characters' });
    }
  });

export type Env = z.output<typeof envSchema> & { network: NetworkConfig };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // `KEY=` in a .env file (or a blank Railway variable) means unset, so defaults and checks apply.
  // Without this an empty SESSION_SECRET slips past the default and cookie signing breaks.
  const present = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = envSchema.safeParse(present);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  const env = parsed.data;
  try {
    const pairs = env.PAIR_TOKENS_JSON === undefined ? undefined : JSON.parse(env.PAIR_TOKENS_JSON);
    if (pairs !== undefined && !Array.isArray(pairs)) throw new Error('PAIR_TOKENS_JSON must be a JSON array');
    const network = resolveNetwork({
      chainId: env.CHAIN_ID,
      rpcUrl: env.RPC_URL_SERVER,
      launchFactory: env.PONS_LAUNCH_FACTORY,
      launchAndBuy: env.PONS_LAUNCH_AND_BUY,
      pairs,
      officialToken: env.OFFICIAL_TOKEN_ADDRESS,
    });
    return { ...env, network };
  } catch (error) {
    throw new Error(`Invalid environment network configuration (CHAIN_ID, PONS_LAUNCH_FACTORY, PONS_LAUNCH_AND_BUY, PAIR_TOKENS_JSON, OFFICIAL_TOKEN_ADDRESS): ${error instanceof Error ? error.message : String(error)}`);
  }
}
