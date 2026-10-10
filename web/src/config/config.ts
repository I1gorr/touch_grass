import type { Location } from '../models/types';
import { DEFAULT_LLM_MODEL, DEFAULT_STT_MODEL, findModel } from '../ml/models';

/** `auto` = the on-device model if it has been downloaded, else pre-written text (LLM) / saved audio (STT). */
export type MlMode = 'auto' | 'device' | 'fallback' | 'fake';
export type SttMode = 'auto' | 'device' | 'fake';

export const ML_MODES: readonly MlMode[] = ['auto', 'device', 'fallback', 'fake'];
export const STT_MODES: readonly SttMode[] = ['auto', 'device', 'fake'];

/** Tunables for the on-device models. */
export interface MlConfig {
  llmModel: string;
  sttModel: string;
  blurbMaxTokens: number;
  cleanupMaxTokens: number;
  temperature: number;
  sttLanguage: string;
  /** Per-call budget before LlmTasks gives up and uses the backup. */
  llmTimeoutMs: number;
}

export const DEFAULT_ML: MlConfig = {
  llmModel: DEFAULT_LLM_MODEL,
  sttModel: DEFAULT_STT_MODEL,
  blurbMaxTokens: 96,
  cleanupMaxTokens: 256,
  temperature: 0.3,
  sttLanguage: 'en',
  llmTimeoutMs: 45_000,
};

/** The data track's demo area (Central Park), covered by the bundled map pack, so routes work offline on a fresh install. */
export const DEFAULT_DEMO_COORDS: Location = { lat: 40.7829, lng: -73.9654 };

export const WALK_MINUTE_CHOICES = [15, 30, 45, 60, 90] as const;
export const COMMUNITY_RADIUS_CHOICES = [0, 500, 1000, 2000, 5000] as const;

/** Every runtime knob in one place. Defaults come from build-time `VITE_*` variables; the Settings screen edits a copy. */
export interface AppConfig {
  llmMode: MlMode;
  sttMode: SttMode;
  /** Use only the bundled demo pack: no Overpass, weather or community requests. */
  fakeQuest: boolean;
  /** Use a fake microphone and camera (desk testing, CI). */
  fakeDevices: boolean;
  demoCoords: Location;
  /** Upper bound on stops per quest. */
  maxStops: number;
  /** Street routing: how long the person wants to walk. */
  walkMinutes: number;
  /** Community notes from places within this many metres of the start. 0 = don't use community data. */
  communityRadiusM: number;
  /** Vary routes between walks. Off = same places every time for the same area (scripted demos). */
  routeVariety: boolean;
  /** Base URL of the sync API in server/. Empty = cloud backup off; the app is fully functional without it. */
  syncUrl: string;
  /** Key for the sync API. Build-time only, never written to settings. NOTE: it ships inside the web bundle. */
  syncApiKey: string;
  ml: MlConfig;
}

export const DEFAULT_CONFIG: AppConfig = {
  llmMode: 'auto',
  sttMode: 'auto',
  fakeQuest: false,
  fakeDevices: false,
  demoCoords: DEFAULT_DEMO_COORDS,
  maxStops: 6,
  walkMinutes: 30,
  communityRadiusM: 2000,
  routeVariety: true,
  syncUrl: '',
  syncApiKey: '',
  ml: DEFAULT_ML,
};

/** Everything faked: what tests and the desk demo use. */
export const ALL_FAKES: AppConfig = { ...DEFAULT_CONFIG, llmMode: 'fake', sttMode: 'fake', fakeQuest: true, fakeDevices: true };

export const syncEnabled = (c: AppConfig): boolean => c.syncUrl !== '';

/** Parses "lat,lng". */
export function parseCoords(s: string): Location | null {
  const parts = s.split(',');
  if (parts.length !== 2) return null;
  const [a, b] = parts.map((p) => p.trim());
  if (a === '' || b === '') return null;
  const lat = Number(a);
  const lng = Number(b);
  return isValidLocation({ lat, lng }) ? { lat, lng } : null; // rejects NaN/Infinity too
}

export const isValidLocation = (l: Location): boolean =>
  Number.isFinite(l.lat) && Number.isFinite(l.lng) && Math.abs(l.lat) <= 90 && Math.abs(l.lng) <= 180;

/**
 * '' -> '' (sync off); valid http(s) URL -> trimmed without trailing '/'; anything else -> null (invalid).
 * Plain http is allowed only for local development hosts (an https page can't call plain http anyway).
 */
export function normalizeSyncUrl(s: string): string | null {
  const t = s.trim();
  if (t === '') return '';
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if (u.hostname === '' || !(u.protocol === 'https:' || u.protocol === 'http:')) return null;
  const devHosts = ['localhost', '127.0.0.1', '10.0.2.2'];
  if (u.protocol === 'http:' && !devHosts.includes(u.hostname) && !u.hostname.startsWith('192.168.')) return null;
  return t.endsWith('/') ? t.slice(0, -1) : t;
}

const oneOf = <T extends string>(values: readonly T[], v: unknown): T | undefined =>
  typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : undefined;
const asBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const asChoice = (choices: readonly number[], v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && choices.includes(v) ? v : undefined;

/** Defines applied only where a value was given (so `undefined` keeps the base value). */
const defined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/** User-editable settings only (the sync key stays build-time). */
export function configToJson(c: AppConfig): Record<string, unknown> {
  return {
    version: 1,
    llmMode: c.llmMode,
    sttMode: c.sttMode,
    fakeQuest: c.fakeQuest,
    fakeDevices: c.fakeDevices,
    demoCoords: [c.demoCoords.lat, c.demoCoords.lng],
    maxStops: c.maxStops,
    walkMinutes: c.walkMinutes,
    communityRadiusM: c.communityRadiusM,
    routeVariety: c.routeVariety,
    syncUrl: c.syncUrl,
    llmModel: c.ml.llmModel,
    sttModel: c.ml.sttModel,
  };
}

/**
 * Overlays saved settings on `base`. Unknown keys are ignored and invalid or missing values keep the base
 * value, so settings from older or newer builds never break startup.
 */
export function configFromJson(j: Record<string, unknown>, base: AppConfig = DEFAULT_CONFIG): AppConfig {
  const coords = Array.isArray(j.demoCoords) && j.demoCoords.length === 2 && typeof j.demoCoords[0] === 'number' && typeof j.demoCoords[1] === 'number'
    ? { lat: j.demoCoords[0], lng: j.demoCoords[1] }
    : undefined;
  const stops = j.maxStops;
  const llm = typeof j.llmModel === 'string' && findModel('llm', j.llmModel) ? j.llmModel : undefined;
  const stt = typeof j.sttModel === 'string' && findModel('stt', j.sttModel) ? j.sttModel : undefined;
  return {
    ...base,
    ...defined({
      llmMode: oneOf(ML_MODES, j.llmMode),
      sttMode: oneOf(STT_MODES, j.sttMode),
      fakeQuest: asBool(j.fakeQuest),
      fakeDevices: asBool(j.fakeDevices),
      demoCoords: coords && isValidLocation(coords) ? coords : undefined,
      maxStops: typeof stops === 'number' && Number.isInteger(stops) && stops >= 1 && stops <= 20 ? stops : undefined,
      routeVariety: asBool(j.routeVariety),
      walkMinutes: asChoice(WALK_MINUTE_CHOICES, j.walkMinutes),
      communityRadiusM: asChoice(COMMUNITY_RADIUS_CHOICES, j.communityRadiusM),
      syncUrl: typeof j.syncUrl === 'string' ? (normalizeSyncUrl(j.syncUrl) ?? undefined) : undefined,
    }),
    ml: { ...base.ml, ...defined({ llmModel: llm, sttModel: stt }) },
  };
}

/** Build-time defaults from `VITE_*` variables (`import.meta.env`). Invalid values keep the built-in default. */
export function configFromEnv(env: Record<string, string | undefined>): AppConfig {
  const flag = (v: string | undefined) => v === 'true' || v === '1';
  const mlMode = oneOf(ML_MODES, env.VITE_ML_MODE?.toLowerCase());
  const sttMode = oneOf(STT_MODES, env.VITE_STT_MODE?.toLowerCase());
  const coords = env.VITE_DEMO_COORDS ? parseCoords(env.VITE_DEMO_COORDS) : null;
  const stops = Number(env.VITE_MAX_STOPS);
  return {
    ...DEFAULT_CONFIG,
    llmMode: flag(env.VITE_FAKE_ML) ? 'fake' : (mlMode ?? DEFAULT_CONFIG.llmMode),
    sttMode: flag(env.VITE_FAKE_STT) ? 'fake' : (sttMode ?? DEFAULT_CONFIG.sttMode),
    fakeQuest: flag(env.VITE_FAKE_QUEST),
    fakeDevices: flag(env.VITE_FAKE_DEVICES),
    demoCoords: coords ?? DEFAULT_DEMO_COORDS,
    maxStops: Number.isInteger(stops) && stops >= 1 ? Math.min(20, stops) : DEFAULT_CONFIG.maxStops,
    routeVariety: env.VITE_ROUTE_VARIETY === undefined ? true : flag(env.VITE_ROUTE_VARIETY),
    syncUrl: normalizeSyncUrl(env.VITE_SYNC_URL ?? '') ?? '',
    syncApiKey: env.VITE_SYNC_API_KEY ?? '',
  };
}

const SETTINGS_KEY = 'touch_grass.settings';

/** Persists user settings as JSON in localStorage. Any read problem (missing, corrupt, blocked) yields the defaults. */
export class ConfigStore {
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = safeLocalStorage()) {}

  load(defaults: AppConfig): AppConfig {
    try {
      const raw = this.storage?.getItem(SETTINGS_KEY);
      if (!raw) return defaults;
      const j = JSON.parse(raw);
      if (!j || typeof j !== 'object' || Array.isArray(j)) return defaults;
      return configFromJson(j, defaults);
    } catch {
      return defaults;
    }
  }

  /** Returns false if the browser refused (private mode, quota): settings then last for this session only. */
  save(config: AppConfig): boolean {
    try {
      this.storage?.setItem(SETTINGS_KEY, JSON.stringify(configToJson(config)));
      return this.storage != null;
    } catch {
      return false;
    }
  }

  clear(): void {
    try {
      this.storage?.removeItem(SETTINGS_KEY);
    } catch {
      /* nothing to clear */
    }
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // blocked (e.g. sandboxed iframe)
  }
}
