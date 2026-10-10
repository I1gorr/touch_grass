/** A WGS84 point. */
export interface LatLng {
  lat: number;
  lng: number;
}

const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance (haversine), in metres. */
export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = 6371000;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

/** Dart's `num.round()`: halves round away from zero (`Math.round` rounds them toward +Infinity). */
export const roundHalfAway = (v: number): number => (v < 0 ? -Math.round(-v) : Math.round(v));
