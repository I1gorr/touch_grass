import { createHash, timingSafeEqual } from 'node:crypto';

import express from 'express';

import { cors } from './cors.js';
import { parsePlacesQuery, placeStats } from './places.js';
import { HIDE_AFTER_DEFAULT, saveReport, validateReport } from './reports.js';
import { serveWebApp } from './static.js';
import { applySync, totals } from './store.js';
import { ValidationError, validatePayload } from './validate.js';

function sameSecret(a, b) {
  // Hash first so lengths match and comparison time doesn't leak the key.
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Builds the HTTP app. `db` is a connected mongodb Db; `apply` is injectable
 * so routes can be tested without Atlas. `minDevices` / `hideAfter` tune the
 * community rules (privacy floor, reports needed to hide a note).
 * `allowedOrigins` lists the web-app origins that may call the API from a browser (see cors.js).
 * `staticDir` (optional) is the built web app to serve from this same server (see static.js).
 */
export function createApp({
  db,
  apiKey,
  apply = applySync,
  log = console,
  minDevices = 2,
  hideAfter = HIDE_AFTER_DEFAULT,
  allowedOrigins = [],
  staticDir = null,
}) {
  if (!apiKey) throw new Error('API_KEY must be set');
  const app = express();
  app.disable('x-powered-by');
  app.use(cors(allowedOrigins));
  app.use(express.json({ limit: '2mb' }));

  app.get('/healthz', async (_req, res) => {
    try {
      await db.command({ ping: 1 });
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false, error: 'database unreachable' });
    }
  });

  const requireKey = (req, res, next) =>
    sameSecret(req.get('x-api-key') ?? '', apiKey) ? next() : res.status(401).json({ error: 'invalid api key' });

  app.post('/v1/sync', requireKey, async (req, res, next) => {
    try {
      const payload = validatePayload(req.body);
      const counts = await apply(db, payload);
      // `counts` is the original reply; `accepted`/`skipped` are totals for the
      // data track's SyncClient. Both are always present.
      res.json({ ok: true, counts, ...totals(counts) });
    } catch (e) {
      next(e);
    }
  });

  // Community read path: per-place counts and opt-in shared notes for an area.
  // Never raw rows, transcripts or photos.
  app.get('/v1/places', requireKey, async (req, res, next) => {
    try {
      res.json(await placeStats(db, parsePlacesQuery(req.query), { minDevices, hideAfter }));
    } catch (e) {
      next(e);
    }
  });

  // "Report this note". 202 = recorded or already reported; hiding is computed
  // at read time once the author or `hideAfter` phones have reported it.
  app.post('/v1/reports', requireKey, async (req, res, next) => {
    try {
      const outcome = await saveReport(db, validateReport(req.body));
      if (outcome === 'unknown_entry') return res.status(404).json({ error: 'unknown note' });
      res.status(202).json({ status: outcome });
    } catch (e) {
      next(e);
    }
  });

  if (staticDir) app.use(serveWebApp(staticDir));

  // Rows and community data only. Images never reach this server or Atlas:
  // photos stay in the phone's SQLite database, so there is no upload route.

  app.use((_req, res) => res.status(404).json({ error: 'not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload too large' });
    log.error('[sync] unexpected error', err);
    res.status(500).json({ error: 'internal error' }); // 5xx → app retries later
  });

  return app;
}
