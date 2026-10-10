import { MongoClient, ServerApiVersion } from 'mongodb';

import { createApp } from './app.js';
import { parseAllowedOrigins } from './cors.js';
import { ensureIndexes } from './store.js';

const { MONGODB_URI, MONGODB_DB = 'touch_grass', API_KEY, PORT = '8080' } = process.env;

if (!MONGODB_URI) {
  console.error('MONGODB_URI is not set (see .env.example)');
  process.exit(1);
}
if (!API_KEY || API_KEY.length < 16) {
  console.error('API_KEY must be set to at least 16 characters (see .env.example)');
  process.exit(1);
}

const client = new MongoClient(MONGODB_URI, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

await client.connect();
const db = client.db(MONGODB_DB);
await ensureIndexes(db);

const server = createApp({
  db,
  apiKey: API_KEY,
  minDevices: Number(process.env.MIN_DEVICES ?? 2),
  hideAfter: Number(process.env.HIDE_AFTER ?? 3),
  allowedOrigins: parseAllowedOrigins(process.env.ALLOWED_ORIGINS),
  staticDir: process.env.STATIC_DIR || null,
}).listen(Number(PORT), () => {
  console.log(`touch-grass sync API listening on :${PORT} (db ${MONGODB_DB})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => client.close().finally(() => process.exit(0)));
  });
}
