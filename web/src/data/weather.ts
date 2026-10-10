import type { LatLng } from '../routing/geo';
import { type Fetch, fetchWithTimeout } from './http';

export function describeCode(c: number): string {
  if (c === 0) return 'clear';
  if (c <= 3) return 'cloudy';
  if (c === 45 || c === 48) return 'foggy';
  if (c >= 51 && c <= 67) return 'rainy';
  if (c >= 71 && c <= 77) return 'snowy';
  if (c >= 80 && c <= 82) return 'showers';
  if (c >= 95) return 'stormy';
  return 'mixed';
}

export class WeatherService {
  constructor(private readonly f: Fetch = (...a) => fetch(...a)) {}

  /** Short summary like "clear, 18°C". Returns "unknown" on any failure. */
  async snapshot(l: LatLng): Promise<string> {
    try {
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${l.lat}&longitude=${l.lng}` + '&current=temperature_2m,weather_code';
      const res = await fetchWithTimeout(this.f, url, {}, 8000);
      if (res.status !== 200) return 'unknown';
      const cur = ((await res.json()) as { current: { weather_code: number; temperature_2m: number } }).current;
      return `${describeCode(Math.trunc(cur.weather_code))}, ${Math.round(cur.temperature_2m)}°C`;
    } catch {
      return 'unknown';
    }
  }
}
