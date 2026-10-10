// Optionally serves the built web app (web/dist) from the same server as the API. Same origin means no CORS and no
// mixed-content problems, and one thing to deploy. Off unless STATIC_DIR is set.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import express from 'express';

/**
 * Express middleware serving `dir` and falling back to index.html for page navigations (so a reload on a deep link
 * works). API paths and anything that looks like a file are never rewritten, so a missing asset is a real 404.
 */
export function serveWebApp(dir) {
  const root = resolve(dir);
  if (!existsSync(join(root, 'index.html'))) throw new Error(`STATIC_DIR ${root} has no index.html (run \`npm run build\` in web/)`);
  const files = express.static(root, {
    index: 'index.html',
    setHeaders(res, file) {
      // The service worker and the page that registers it must always be revalidated, or an update never arrives.
      if (/(^|[\\/])(sw\.js|index\.html|manifest\.webmanifest|workbox-[^\\/]*\.js)$/.test(file)) {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (/[\\/]assets[\\/]/.test(file)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // content-hashed file names
      }
    },
  });
  return [
    files,
    (req, res, next) => {
      const wantsPage = (req.method === 'GET' || req.method === 'HEAD') && !req.path.startsWith('/v1/') && req.path !== '/healthz' && !/\.[a-z0-9]+$/i.test(req.path);
      if (!wantsPage) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(root, 'index.html'));
    },
  ];
}
