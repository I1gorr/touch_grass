import { type Candidate } from '../src/routing/candidate';
import type { LatLng } from '../src/routing/geo';
import type { WalkWay } from '../src/routing/walkWay';

/** Stable string hash standing in for Dart's `String.hashCode` (only used to make distinct ids). */
const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};

/** A square street grid: n x n nodes, ~spacingM metres apart, centred on `center`. */
export class Grid {
  readonly dLat: number;
  readonly dLng: number;

  constructor(
    readonly n: number,
    readonly spacingM = 100,
    readonly center: LatLng = { lat: 40.7829, lng: -73.9654 },
  ) {
    this.dLat = spacingM / 110540;
    this.dLng = spacingM / (111320 * Math.cos((center.lat * Math.PI) / 180));
  }

  latAt = (r: number) => this.center.lat + (r - Math.trunc(this.n / 2)) * this.dLat;
  lngAt = (c: number) => this.center.lng + (c - Math.trunc(this.n / 2)) * this.dLng;
  idAt = (r: number, c: number) => r * 1000 + c + 1;

  /** Rows and columns as footways. Pass `skip` to remove grid edges (r1,c1,r2,c2) and make obstacles. */
  ways(highway = 'footway', skip?: (r1: number, c1: number, r2: number, c2: number) => boolean): WalkWay[] {
    const out: WalkWay[] = [];
    let wid = 1;
    for (let r = 0; r < this.n; r++) {
      for (let c = 0; c + 1 < this.n; c++) {
        if (skip?.(r, c, r, c + 1)) continue;
        out.push(this.seg(wid++, highway, r, c, r, c + 1));
      }
    }
    for (let c = 0; c < this.n; c++) {
      for (let r = 0; r + 1 < this.n; r++) {
        if (skip?.(r, c, r + 1, c)) continue;
        out.push(this.seg(wid++, highway, r, c, r + 1, c));
      }
    }
    return out;
  }

  private seg(id: number, h: string, r1: number, c1: number, r2: number, c2: number): WalkWay {
    return {
      id,
      highway: h,
      nodes: [this.idAt(r1, c1), this.idAt(r2, c2)],
      coords: [this.latAt(r1), this.lngAt(c1), this.latAt(r2), this.lngAt(c2)],
    };
  }

  poi(name: string, r: number, c: number, tags: Record<string, string>): Candidate {
    return {
      osmId: `node/${hash(name)}`,
      name,
      lat: this.latAt(r),
      lng: this.lngAt(c),
      tags: { name, ...tags },
    };
  }

  /** A handful of POIs spread around the centre, with mixed categories. */
  pois(): Candidate[] {
    return [
      this.poi('Fountain A', 12, 10, { amenity: 'fountain' }),
      this.poi('Mural B', 10, 14, { tourism: 'artwork' }),
      this.poi('View C', 6, 10, { tourism: 'viewpoint' }),
      this.poi('Garden D', 10, 5, { leisure: 'garden' }),
      this.poi('Chapel E', 14, 13, { amenity: 'place_of_worship' }),
      this.poi('Park F', 8, 15, { leisure: 'park' }),
      this.poi('Old Gate G', 15, 8, { historic: 'gate' }),
      this.poi('Far Statue H', 20, 20, { tourism: 'artwork' }),
    ];
  }

  /** The grid as an Overpass `out geom` response. */
  overpassWaysBody(): string {
    return JSON.stringify({
      elements: this.ways().map((w) => ({
        type: 'way',
        id: w.id,
        nodes: w.nodes,
        geometry: w.nodes.map((_, i) => ({ lat: w.coords[2 * i], lon: w.coords[2 * i + 1] })),
        tags: { highway: w.highway },
      })),
    });
  }

  /** The POIs as an Overpass `out center` response. */
  overpassPoisBody(): string {
    return JSON.stringify({
      elements: this.pois().map((c, i) => ({ type: 'node', id: i + 1, lat: c.lat, lon: c.lng, tags: c.tags })),
    });
  }
}
