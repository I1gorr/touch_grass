import { roundHalfAway, type LatLng } from './geo';

/**
 * Google encoded-polyline format (precision 1e-5 deg, ~1 m). Compact enough to store
 * a whole route in one string field.
 */
export function encodePolyline(points: LatLng[]): string {
  let out = '';
  let pLat = 0;
  let pLng = 0;
  const put = (v: number) => {
    let x = v < 0 ? ~(v << 1) : v << 1;
    while (x >= 0x20) {
      out += String.fromCharCode((0x20 | (x & 0x1f)) + 63);
      x >>= 5;
    }
    out += String.fromCharCode(x + 63);
  };
  for (const p of points) {
    const la = roundHalfAway(p.lat * 1e5);
    const ln = roundHalfAway(p.lng * 1e5);
    put(la - pLat);
    put(ln - pLng);
    pLat = la;
    pLng = ln;
  }
  return out;
}

export function decodePolyline(s: string): LatLng[] {
  const out: LatLng[] = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  const next = (): number => {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = s.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < s.length) {
    lat += next();
    lng += next();
    out.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return out;
}

/**
 * Douglas-Peucker. Returns the indices to keep (sorted). Indices in [keep], plus the
 * first and last point, are always kept so stops stay addressable after simplifying.
 */
export function simplifyIndices(pts: LatLng[], toleranceM: number, keep: Set<number> = new Set()): number[] {
  if (pts.length <= 2) return pts.map((_, i) => i);
  const lat0 = pts[0].lat;
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111320;
  const ky = 110540;
  const xs = pts.map((p) => (p.lng - pts[0].lng) * kx);
  const ys = pts.map((p) => (p.lat - lat0) * ky);

  const dist = (i: number, a: number, b: number): number => {
    const dx = xs[b] - xs[a];
    const dy = ys[b] - ys[a];
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(xs[i] - xs[a], ys[i] - ys[a]);
    const t = Math.min(1, Math.max(0, ((xs[i] - xs[a]) * dx + (ys[i] - ys[a]) * dy) / len2));
    return Math.hypot(xs[i] - (xs[a] + t * dx), ys[i] - (ys[a] + t * dy));
  };

  const anchors = [...new Set([0, pts.length - 1, ...[...keep].filter((i) => i >= 0 && i < pts.length)])].sort(
    (a, b) => a - b,
  );
  const kept = new Set(anchors);
  for (let k = 0; k + 1 < anchors.length; k++) {
    const stack: [number, number][] = [[anchors[k], anchors[k + 1]]];
    while (stack.length > 0) {
      const [a, b] = stack.pop()!;
      let worst = -1;
      let idx = -1;
      for (let i = a + 1; i < b; i++) {
        const d = dist(i, a, b);
        if (d > worst) {
          worst = d;
          idx = i;
        }
      }
      if (idx !== -1 && worst > toleranceM) {
        kept.add(idx);
        stack.push([a, idx], [idx, b]);
      }
    }
  }
  return [...kept].sort((a, b) => a - b);
}
