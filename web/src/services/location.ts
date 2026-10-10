import { isValidLocation } from '../config/config';
import type { Location } from '../models/types';

/** Why a location couldn't be read, in words that can be shown as they are. */
export class LocationError extends Error {
  override name = 'LocationError';
  constructor(
    message: string,
    readonly reason: 'denied' | 'unavailable' | 'timeout' | 'unsupported' | 'invalid',
  ) {
    super(message);
  }
}

type GeoLike = Pick<Geolocation, 'getCurrentPosition'>;

/**
 * The phone's current position, once. Asks for permission the first time. A rough position is fine for
 * choosing a walking area, so this prefers a quick answer over a precise one.
 */
export function currentLocation(geo: GeoLike | undefined = globalThis.navigator?.geolocation, timeoutMs = 15_000): Promise<Location> {
  return new Promise((resolve, reject) => {
    if (!geo) return reject(new LocationError('This browser can’t share your location.', 'unsupported'));
    geo.getCurrentPosition(
      (pos) => {
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        if (isValidLocation(loc)) resolve(loc);
        else reject(new LocationError('The phone gave an unusable location.', 'invalid'));
      },
      (err) => {
        // 1 = permission denied, 2 = position unavailable, 3 = timeout
        if (err.code === 1) reject(new LocationError('Location access is off. Allow it in the browser’s site settings to use your position.', 'denied'));
        else if (err.code === 3) reject(new LocationError('Finding your location took too long. Try again outdoors.', 'timeout'));
        else reject(new LocationError('Couldn’t work out where you are.', 'unavailable'));
      },
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 5 * 60_000 },
    );
  });
}

/** "51.5313, -0.1570", the way the coordinates field shows it. */
export const formatCoords = (l: Location): string => `${l.lat.toFixed(4)}, ${l.lng.toFixed(4)}`;
