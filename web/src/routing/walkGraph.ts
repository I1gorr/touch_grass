import { distanceMeters } from './geo';
import type { WalkWay } from './walkWay';

export interface Edge {
  to: number;
  len: number;
  /** `len` x a preference factor (>= 1): quiet footpaths are cheaper than busy roads. */
  cost: number;
}

/** Routing preference per OSM highway class. Always >= 1 so haversine stays an admissible A* heuristic. */
export function highwayFactor(h: string): number {
  switch (h) {
    case 'footway':
    case 'path':
    case 'pedestrian':
    case 'track':
      return 1.0;
    case 'cycleway':
    case 'residential':
    case 'living_street':
      return 1.05;
    case 'unclassified':
      return 1.1;
    case 'service':
      return 1.15;
    case 'tertiary':
    case 'tertiary_link':
      return 1.2;
    case 'steps':
    case 'secondary':
    case 'secondary_link':
      return 1.5;
    case 'primary':
    case 'primary_link':
      return 1.7;
    default:
      return 1.3;
  }
}

const CELL = 0.001; // ~110 m
const key = (cy: number, cx: number) => cy * 2000003 + cx;

/** Walking network built from pack ways. Ways that share an OSM node id are connected there. */
export class WalkGraph {
  private grid: Map<number, number[]> | null = null;
  private readonly lngScale: number;

  private constructor(
    readonly lat: number[],
    readonly lng: number[],
    readonly adj: Edge[][],
  ) {
    this.lngScale = lat.length === 0 ? 1 : Math.cos((lat[Math.floor(lat.length / 2)] * Math.PI) / 180);
  }

  get nodeCount(): number {
    return this.lat.length;
  }

  static fromWays(ways: WalkWay[]): WalkGraph {
    const index = new Map<number, number>();
    const lat: number[] = [];
    const lng: number[] = [];
    const adj: Edge[][] = [];
    const nodeOf = (osmId: number, la: number, lo: number): number => {
      let i = index.get(osmId);
      if (i === undefined) {
        i = lat.length;
        index.set(osmId, i);
        lat.push(la);
        lng.push(lo);
        adj.push([]);
      }
      return i;
    };

    for (const w of ways) {
      const f = highwayFactor(w.highway);
      let prev = nodeOf(w.nodes[0], w.coords[0], w.coords[1]);
      for (let i = 1; i < w.nodes.length; i++) {
        const cur = nodeOf(w.nodes[i], w.coords[2 * i], w.coords[2 * i + 1]);
        if (cur !== prev) {
          const len = distanceMeters(lat[prev], lng[prev], lat[cur], lng[cur]);
          adj[prev].push({ to: cur, len, cost: len * f });
          adj[cur].push({ to: prev, len, cost: len * f });
        }
        prev = cur;
      }
    }
    return new WalkGraph(lat, lng, adj);
  }

  /** 1 for every node reachable from [node] (walking), 0 otherwise. */
  reachableFrom(node: number): Uint8Array {
    const seen = new Uint8Array(this.nodeCount);
    seen[node] = 1;
    const queue = [node];
    for (let head = 0; head < queue.length; head++) {
      for (const e of this.adj[queue[head]]) {
        if (seen[e.to] === 0) {
          seen[e.to] = 1;
          queue.push(e.to);
        }
      }
    }
    return seen;
  }

  private cx(lng: number) {
    return Math.floor((lng * this.lngScale) / CELL);
  }
  private cy(lat: number) {
    return Math.floor(lat / CELL);
  }

  private buildGrid(): Map<number, number[]> {
    const g = new Map<number, number[]>();
    for (let i = 0; i < this.nodeCount; i++) {
      const k = key(this.cy(this.lat[i]), this.cx(this.lng[i]));
      const cell = g.get(k);
      if (cell) cell.push(i);
      else g.set(k, [i]);
    }
    return g;
  }

  /** Closest node to the point within [maxSnapM], optionally limited to nodes where [mask] is 1. */
  nearestNode(
    la: number,
    lo: number,
    opts: { mask?: Uint8Array; maxSnapM?: number } = {},
  ): { node: number; distM: number } | null {
    const { mask, maxSnapM = 300 } = opts;
    const grid = (this.grid ??= this.buildGrid());
    const rings = Math.ceil(maxSnapM / 100) + 1;
    const cy = this.cy(la);
    const cx = this.cx(lo);
    let best = -1;
    let bestD = Infinity;
    for (let dy = -rings; dy <= rings; dy++) {
      for (let dx = -rings; dx <= rings; dx++) {
        for (const n of grid.get(key(cy + dy, cx + dx)) ?? []) {
          if (mask && mask[n] === 0) continue;
          const d = distanceMeters(la, lo, this.lat[n], this.lng[n]);
          if (d < bestD || (d === bestD && n < best)) {
            bestD = d;
            best = n;
          }
        }
      }
    }
    return best === -1 || bestD > maxSnapM ? null : { node: best, distM: bestD };
  }
}
