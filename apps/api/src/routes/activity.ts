import type { FastifyInstance } from 'fastify';
import { RECENT_WINDOW_S, toActivity, watchedTokens, type ActivityItem } from '../activity';

const CACHE_MS = 10_000;
const LIMIT = 10;

/**
 * GET /activity/recent: the newest notable $HEXE and hood-coin trades of the last 15 minutes, oldest first. The
 * desktop's first balloon comes from here, and it's what the page polls while its WebSocket is down. Balloons are a
 * nicety, so no indexer (or a failing one) is an empty list rather than an error.
 */
export async function activityRoutes(app: FastifyInstance) {
  const { db, envio, now, env: { network } } = app.deps;
  // One answer shared by every visitor for 10 s keeps this inside Envio's per-minute query budget.
  let cache: { at: number; body: { items: ActivityItem[] } } | null = null;

  app.get('/activity/recent', async () => {
    const at = Date.now();
    if (cache && at - cache.at < CACHE_MS) return cache.body;
    let items: ActivityItem[] = [];
    if (envio) {
      try {
        const { tiers, tickers } = await watchedTokens(db, network);
        const since = Math.floor(now().getTime() / 1000) - RECENT_WINDOW_S;
        items = (await envio.notableTrades(tiers, { since }, LIMIT, 'interactive')).map((t) => toActivity(t, tickers));
      } catch (e) {
        app.log.warn(`recent activity failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    cache = { at, body: { items } };
    return cache.body;
  });
}
