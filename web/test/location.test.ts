import { describe, expect, it } from 'vitest';
import { currentLocation, formatCoords, LocationError } from '../src/services/location';

const geo = (impl: (ok: PositionCallback, err: PositionErrorCallback, opts?: PositionOptions) => void) => ({ getCurrentPosition: impl }) as Pick<Geolocation, 'getCurrentPosition'>;
const fix = (lat: number, lng: number) => ({ coords: { latitude: lat, longitude: lng } }) as GeolocationPosition;
const fail = (code: number) => ({ code, message: '' }) as GeolocationPositionError;

describe('current location', () => {
  it('resolves with the position', async () => {
    expect(await currentLocation(geo((ok) => ok(fix(51.53, -0.16))))).toEqual({ lat: 51.53, lng: -0.16 });
  });

  it('asks for a quick, possibly cached, rough position', async () => {
    let opts: PositionOptions | undefined;
    await currentLocation(geo((ok, _e, o) => ((opts = o), ok(fix(1, 2)))), 9000);
    expect(opts).toMatchObject({ enableHighAccuracy: false, timeout: 9000 });
    expect(opts!.maximumAge).toBeGreaterThan(0);
  });

  it('explains each way it can fail', async () => {
    const reason = async (g: ReturnType<typeof geo> | undefined) => (await currentLocation(g).catch((e) => e)) as LocationError;
    expect((await reason(geo((_o, err) => err(fail(1))))).reason).toBe('denied');
    expect((await reason(geo((_o, err) => err(fail(2))))).reason).toBe('unavailable');
    expect((await reason(geo((_o, err) => err(fail(3))))).reason).toBe('timeout');
    expect((await reason(geo((ok) => ok(fix(95, 0))))).reason).toBe('invalid');
    expect((await reason(geo((ok) => ok(fix(NaN, 0))))).reason).toBe('invalid');
    const none = await currentLocation(undefined).catch((e) => e);
    expect(none).toBeInstanceOf(LocationError);
    expect(none.reason).toBe('unsupported');
  });

  it('messages are written for people, not for logs', async () => {
    const e = (await currentLocation(geo((_o, err) => err(fail(1)))).catch((x) => x)) as LocationError;
    expect(e.message).toMatch(/site settings/);
  });

  it('formats like the coordinates field', () => expect(formatCoords({ lat: 51.53131, lng: -0.157 })).toBe('51.5313, -0.1570'));
});
