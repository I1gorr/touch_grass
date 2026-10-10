// Pure validation for sync payloads. No dependencies, so it is unit-testable
// without Atlas or npm install.

export const LIMITS = {
  maxRowsPerRequest: 1000,
  maxStringLength: 20000,
  // A shared note is a public snapshot, kept short.
  maxSharedText: 280,
};

export const ID = /^[A-Za-z0-9_-]{1,100}$/;
export const DEVICE_ID = /^[0-9a-f]{32}$/;
const WALK_STATUS = new Set(['preparing', 'ready', 'active', 'done']);

// Field allow-lists mirror the SQLite schema (docs/DATA_SCHEMA.md).
// Type tags: 'id' | 'str' | 'int' | 'num' | 'status' | 'flag' (0/1) | 'snippet'
// (short public text); '?' suffix = nullable. Every new field is nullable so
// older clients that don't send it keep working.
export const SCHEMAS = {
  walks: {
    id: 'id',
    created_at: 'int?',
    start_lat: 'num?',
    start_lng: 'num?',
    time_of_day: 'str?',
    weather_summary: 'str?',
    status: 'status?',
    // Planned street route (data track, schema v3 there): JSON text, read whole.
    route_json: 'str?',
    updated_at: 'int?',
  },
  stops: {
    id: 'id',
    walk_id: 'id',
    position: 'int?',
    osm_id: 'str?',
    name: 'str?',
    lat: 'num?',
    lng: 'num?',
    tags_json: 'str?',
    blurb: 'str?',
    prompt: 'str?',
    updated_at: 'int?',
  },
  entries: {
    id: 'id',
    stop_id: 'id',
    recorded_at: 'int?',
    raw_transcript: 'str?',
    cleaned_text: 'str?',
    // Photos stay on the phone: only whether the note has one (for community
    // counts). Never a path or image data. Legacy `photo_path` is converted.
    has_photo: 'flag?',
    // Opt-in sharing: a short public snapshot of the cleaned text.
    shared: 'flag?',
    shared_text: 'snippet?',
    updated_at: 'int?',
  },
};

export class ValidationError extends Error {}

function check(type, value, path) {
  const nullable = type.endsWith('?');
  const base = nullable ? type.slice(0, -1) : type;
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new ValidationError(`${path} is required`);
  }
  switch (base) {
    case 'id':
      if (typeof value !== 'string' || !ID.test(value)) throw new ValidationError(`${path} must be an id`);
      return value;
    case 'str':
      if (typeof value !== 'string') throw new ValidationError(`${path} must be a string`);
      if (value.length > LIMITS.maxStringLength) throw new ValidationError(`${path} is too long`);
      return value;
    case 'int':
      if (!Number.isSafeInteger(value)) throw new ValidationError(`${path} must be an integer`);
      return value;
    case 'num':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new ValidationError(`${path} must be a number`);
      return value;
    case 'flag':
      if (value !== 0 && value !== 1) throw new ValidationError(`${path} must be 0 or 1`);
      return value;
    case 'snippet':
      if (typeof value !== 'string') throw new ValidationError(`${path} must be a string`);
      if (value.length > LIMITS.maxSharedText) {
        throw new ValidationError(`${path} must be at most ${LIMITS.maxSharedText} characters`);
      }
      return value;
    case 'status':
      if (!WALK_STATUS.has(value)) throw new ValidationError(`${path} must be one of ${[...WALK_STATUS]}`);
      return value;
    default:
      throw new Error(`unknown type ${type}`);
  }
}

/** Returns a clean row containing only allow-listed fields; unknown fields are dropped. */
export function validateRow(collection, row, path = collection) {
  const schema = SCHEMAS[collection];
  if (!schema) throw new ValidationError(`unknown collection ${collection}`);
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new ValidationError(`${path} must be an object`);
  }
  const out = {};
  for (const [field, type] of Object.entries(schema)) {
    out[field] = check(type, row[field], `${path}.${field}`);
  }
  // Older clients (data track) send the phone-local photo path. Keep only the
  // fact that a photo exists; the path itself never reaches the database.
  if (collection === 'entries' && out.has_photo === null && 'photo_path' in row) {
    const p = row.photo_path;
    if (p !== null && p !== undefined && typeof p !== 'string') {
      throw new ValidationError(`${path}.photo_path must be a string or null`);
    }
    out.has_photo = typeof p === 'string' && p.trim() !== '' ? 1 : 0;
  }
  // Rows from before change tracking existed have no version; treat as 1.
  if (out.updated_at === null) out.updated_at = 1;
  return out;
}

/** Validates a whole POST /v1/sync body. Returns { deviceId, walks, stops, entries }. */
export function validatePayload(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('body must be a JSON object');
  }
  if (typeof body.deviceId !== 'string' || !DEVICE_ID.test(body.deviceId)) {
    throw new ValidationError('deviceId must be 32 lowercase hex chars');
  }
  const result = { deviceId: body.deviceId };
  let total = 0;
  for (const collection of Object.keys(SCHEMAS)) {
    const rows = body[collection] ?? [];
    if (!Array.isArray(rows)) throw new ValidationError(`${collection} must be an array`);
    total += rows.length;
    if (total > LIMITS.maxRowsPerRequest) {
      throw new ValidationError(`too many rows (max ${LIMITS.maxRowsPerRequest} per request)`);
    }
    result[collection] = rows.map((r, i) => validateRow(collection, r, `${collection}[${i}]`));
  }
  return result;
}

/** Alias kept for the data track's server code and tests. */
export const validateSync = validatePayload;
