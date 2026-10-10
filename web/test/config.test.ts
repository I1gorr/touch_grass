import { describe, expect, it } from 'vitest';
import {
  ALL_FAKES, ConfigStore, DEFAULT_CONFIG, configFromEnv, configFromJson, configToJson, normalizeSyncUrl, parseCoords,
} from '../src/config/config';
import { DEFAULT_LLM_MODEL, DEFAULT_STT_MODEL } from '../src/ml/models';

const memoryStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};

describe('config', () => {
  it('sync URL validation', () => {
    expect(normalizeSyncUrl('')).toBe('');
    expect(normalizeSyncUrl(' https://a.b/ ')).toBe('https://a.b');
    expect(normalizeSyncUrl('http://10.0.2.2:8080')).toBe('http://10.0.2.2:8080');
    expect(normalizeSyncUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeSyncUrl('http://192.168.1.5:3000')).toBe('http://192.168.1.5:3000');
    expect(normalizeSyncUrl('http://evil.example.com')).toBeNull(); // no plain http to the internet
    expect(normalizeSyncUrl('ftp://a.b')).toBeNull();
    expect(normalizeSyncUrl('not a url')).toBeNull();
  });

  it('the API key is never written to settings', () => {
    const c = { ...DEFAULT_CONFIG, syncUrl: 'https://a.b', syncApiKey: 'secret' };
    expect(JSON.stringify(configToJson(c))).not.toContain('secret');
    expect(configFromJson(configToJson(c)).syncUrl).toBe('https://a.b');
  });

  it('parseCoords', () => {
    expect(parseCoords('51.5, -0.15')).toEqual({ lat: 51.5, lng: -0.15 });
    expect(parseCoords('91,0')).toBeNull();
    expect(parseCoords('0,181')).toBeNull();
    expect(parseCoords('abc')).toBeNull();
    expect(parseCoords('1,2,3')).toBeNull();
    expect(parseCoords('1,')).toBeNull();
    expect(parseCoords('Infinity,0')).toBeNull();
  });

  it('round-trips every user setting', () => {
    const c = {
      ...DEFAULT_CONFIG, llmMode: 'fallback' as const, sttMode: 'device' as const, fakeQuest: true, fakeDevices: true,
      demoCoords: { lat: 51.5, lng: -0.15 }, maxStops: 4, walkMinutes: 45, communityRadiusM: 500, routeVariety: false,
      syncUrl: 'https://a.b', ml: { ...DEFAULT_CONFIG.ml, llmModel: 'onnx-community/gemma-3-1b-it-ONNX', sttModel: 'onnx-community/whisper-tiny.en' },
    };
    expect(configFromJson(configToJson(c))).toEqual(c);
  });

  it('invalid or unknown values keep the base, so old or new settings never break startup', () => {
    const c = configFromJson({
      llmMode: 'nonsense', sttMode: 7, fakeQuest: 'yes', demoCoords: [200, 0], maxStops: 99, walkMinutes: 17,
      communityRadiusM: -1, syncUrl: 'http://evil.example.com', llmModel: 'some/other-model', future: true,
    });
    expect(c).toEqual(DEFAULT_CONFIG);
    expect(configFromJson({ maxStops: 3, walkMinutes: 60 }, ALL_FAKES)).toMatchObject({ maxStops: 3, walkMinutes: 60, fakeQuest: true });
  });
});

describe('config from the build environment', () => {
  it('has safe defaults', () => expect(configFromEnv({})).toEqual(DEFAULT_CONFIG));

  it('reads VITE_* variables', () => {
    const c = configFromEnv({
      VITE_ML_MODE: 'Fallback', VITE_STT_MODE: 'fake', VITE_FAKE_QUEST: 'true', VITE_FAKE_DEVICES: '1',
      VITE_DEMO_COORDS: '51.5313,-0.1570', VITE_MAX_STOPS: '99', VITE_ROUTE_VARIETY: 'false',
      VITE_SYNC_URL: 'https://tg.example.com/', VITE_SYNC_API_KEY: 'abc',
    });
    expect(c).toMatchObject({
      llmMode: 'fallback', sttMode: 'fake', fakeQuest: true, fakeDevices: true, demoCoords: { lat: 51.5313, lng: -0.157 },
      maxStops: 20, routeVariety: false, syncUrl: 'https://tg.example.com', syncApiKey: 'abc',
    });
  });

  it('FAKE_ML / FAKE_STT are shorthands, and bad values fall back', () => {
    expect(configFromEnv({ VITE_FAKE_ML: 'true', VITE_ML_MODE: 'device' }).llmMode).toBe('fake');
    expect(configFromEnv({ VITE_FAKE_STT: '1' }).sttMode).toBe('fake');
    expect(configFromEnv({ VITE_ML_MODE: 'warp', VITE_DEMO_COORDS: 'x', VITE_MAX_STOPS: 'many', VITE_SYNC_URL: 'http://evil.example.com' }))
      .toEqual(DEFAULT_CONFIG);
  });
});

describe('ConfigStore', () => {
  it('saves and loads settings', () => {
    const s = new ConfigStore(memoryStorage());
    expect(s.load(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
    expect(s.save({ ...DEFAULT_CONFIG, walkMinutes: 60 })).toBe(true);
    expect(s.load(DEFAULT_CONFIG).walkMinutes).toBe(60);
    s.clear();
    expect(s.load(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
  });

  it('corrupt storage yields the defaults', () => {
    for (const bad of ['{nope', '[1,2]', '"str"', 'null', '']) {
      const st = memoryStorage();
      st.setItem('touch_grass.settings', bad);
      expect(new ConfigStore(st).load(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
    }
  });

  it('survives storage that is blocked, full or missing', () => {
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); }, removeItem: () => { throw new Error('blocked'); } };
    const s = new ConfigStore(throwing);
    expect(s.load(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
    expect(s.save(DEFAULT_CONFIG)).toBe(false);
    expect(() => s.clear()).not.toThrow();
    expect(new ConfigStore(null).save(DEFAULT_CONFIG)).toBe(false);
  });

  it('defaults point at models that exist in the catalog', () => {
    expect(DEFAULT_CONFIG.ml).toMatchObject({ llmModel: DEFAULT_LLM_MODEL, sttModel: DEFAULT_STT_MODEL });
  });
});
