// CORS for the web app (a browser blocks calls to another origin unless the server says it is fine).
// Secure by default: with no ALLOWED_ORIGINS configured no CORS headers are sent at all, so only same-origin
// pages (or non-browser clients such as the old Android app) can use the API.

/** Parses `ALLOWED_ORIGINS`: comma-separated origins (`https://app.example.com`), or `*` for any. */
export function parseAllowedOrigins(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/**
 * Express middleware. Allowed origins get the CORS headers; a preflight (`OPTIONS`) is answered right here with
 * 204 and never reaches the API-key check (browsers don't send the key on preflights).
 */
export function cors(allowedOrigins = []) {
  const any = allowedOrigins.includes('*');
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.get('origin');
    const ok = !!origin && (any || allowed.has(origin));
    if (ok) {
      res.set('Access-Control-Allow-Origin', any ? '*' : origin);
      if (!any) res.vary('Origin'); // the answer depends on who asks
    }
    if (req.method === 'OPTIONS' && req.get('access-control-request-method')) {
      if (ok) {
        res.set({
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'content-type, x-api-key',
          'Access-Control-Max-Age': '600',
        });
      }
      return res.status(204).end();
    }
    next();
  };
}
