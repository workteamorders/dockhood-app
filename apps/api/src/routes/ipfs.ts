import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { LAUNCH_LIMITS, theoremMetadataSchema, type TheoremMetadata } from '@hood/shared';
import { HttpError } from '../app';
import { allow } from '../kv';
import { storedScore } from './score';

/** Sniffs the real image type; the browser-declared one is not trusted. */
export function imageType(b: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;

/** POST /ipfs (docs/BRIEF.md §5.2 step 1): pins the logo and the theorem metadata JSON. */
export async function ipfsRoutes(app: FastifyInstance) {
  const { db, kv, pinner, env } = app.deps;
  await app.register(multipart, {
    limits: { fileSize: LAUNCH_LIMITS.logoBytes, files: 1, fields: 1, fieldSize: 16 * 1024, parts: 2 },
  });

  app.post('/ipfs', { preHandler: app.requireSession }, async (req) => {
    // Production on stand-ins (STAND_INS=allow): a launch pinned by the dev pinner would put a dead IPFS link on-chain forever.
    if (env.NODE_ENV === 'production' && !env.PINATA_JWT) throw new HttpError(503, 'Launching is paused while Dockhood finishes setting up. Browsing and trading still work.');
    if (!(await allow(kv, `ipfs:${req.wallet}`, 20, 3_600))) throw new HttpError(429, 'Too many uploads. Wait a while and try again.');

    let logo: Uint8Array | undefined;
    let metadataText: string | undefined;
    for await (const part of req.parts()) {
      if (part.type === 'file' && part.fieldname === 'logo') {
        logo = await part.toBuffer().catch(() => {
          throw new HttpError(413, 'The logo must be 1 MB or less.');
        });
      } else if (part.type === 'field' && part.fieldname === 'metadata' && typeof part.value === 'string') {
        metadataText = part.value;
      }
    }
    if (!logo) throw new HttpError(400, 'Attach a logo image.');
    const type = imageType(logo);
    if (!type) throw new HttpError(400, 'The logo must be a PNG, JPG or WebP image.');
    if (!metadataText) throw new HttpError(400, 'Missing theorem metadata.');

    let json: unknown;
    try {
      json = JSON.parse(metadataText);
    } catch {
      throw new HttpError(400, 'Theorem metadata is not valid JSON.');
    }
    const parsed = theoremMetadataSchema.safeParse(json);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid theorem metadata.');

    // The score that gets pinned is ours, never the client's: a forged 100/100 can't ride into IPFS.
    const scored = await storedScore(db, parsed.data.statement);
    const metadata: TheoremMetadata = {
      ...parsed.data,
      rigor: scored
        ? {
            score: scored.score,
            ...scored.parts,
            statusLabel: scored.statusLabel as NonNullable<TheoremMetadata['rigor']>['statusLabel'],
            reasoning: scored.reasoning,
            model: scored.model,
          }
        : null,
    };

    const ticker = metadata.ticker;
    const logoCid = await pinner.pin(logo, `${ticker}-logo.${EXT[type]}`, type);
    const metadataCid = await pinner.pin(new TextEncoder().encode(JSON.stringify(metadata)), `${ticker}.json`, 'application/json');
    return { logoCid, metadataCid, rigorScore: metadata.rigor?.score ?? null };
  });
}
