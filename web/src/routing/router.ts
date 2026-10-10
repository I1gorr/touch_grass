import { distanceMeters } from './geo';
import type { WalkGraph } from './walkGraph';

/** Binary min-heap keyed by number. Duplicate nodes are allowed (lazy deletion). */
class MinHeap {
  private k: number[] = [];
  private v: number[] = [];

  get isEmpty(): boolean {
    return this.k.length === 0;
  }

  push(key: number, value: number): void {
    this.k.push(key);
    this.v.push(value);
    let i = this.k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= this.k[i]) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): [number, number] {
    const top: [number, number] = [this.k[0], this.v[0]];
    const lastK = this.k.pop()!;
    const lastV = this.v.pop()!;
    if (this.k.length > 0) {
      this.k[0] = lastK;
      this.v[0] = lastV;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.k.length && this.k[l] < this.k[m]) m = l;
        if (r < this.k.length && this.k[r] < this.k[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number) {
    [this.k[a], this.k[b]] = [this.k[b], this.k[a]];
    [this.v[a], this.v[b]] = [this.v[b], this.v[a]];
  }
}

export interface PathResult {
  nodes: number[];
  lengthM: number;
  cost: number;
}

/** Cheapest path by preference-weighted cost. Null if [to] is unreachable. */
export function astar(g: WalkGraph, from: number, to: number): PathResult | null {
  const n = g.nodeCount;
  const best = new Float64Array(n).fill(Infinity);
  const len = new Float64Array(n);
  const parent = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const h = (i: number) => distanceMeters(g.lat[i], g.lng[i], g.lat[to], g.lng[to]);

  const heap = new MinHeap();
  heap.push(h(from), from);
  best[from] = 0;
  while (!heap.isEmpty) {
    const [, u] = heap.pop();
    if (closed[u] === 1) continue;
    closed[u] = 1;
    if (u === to) {
      const path: number[] = [];
      for (let c = to; c !== -1; c = parent[c]) path.push(c);
      return { nodes: path.reverse(), lengthM: len[to], cost: best[to] };
    }
    for (const e of g.adj[u]) {
      const c = best[u] + e.cost;
      if (c < best[e.to]) {
        best[e.to] = c;
        len[e.to] = len[u] + e.len;
        parent[e.to] = u;
        heap.push(c + h(e.to), e.to);
      }
    }
  }
  return null;
}

export interface DijkstraResult {
  /** Cost to each node (Infinity if beyond maxCost / unreachable). */
  cost: Float64Array;
  /** Walked length in metres along the cheapest path. */
  len: Float64Array;
}

export function dijkstra(g: WalkGraph, from: number, maxCost = Infinity): DijkstraResult {
  const n = g.nodeCount;
  const cost = new Float64Array(n).fill(Infinity);
  const len = new Float64Array(n).fill(Infinity);
  const closed = new Uint8Array(n);
  const heap = new MinHeap();
  heap.push(0, from);
  cost[from] = 0;
  len[from] = 0;
  while (!heap.isEmpty) {
    const [, u] = heap.pop();
    if (closed[u] === 1) continue;
    closed[u] = 1;
    for (const e of g.adj[u]) {
      const c = cost[u] + e.cost;
      if (c <= maxCost && c < cost[e.to]) {
        cost[e.to] = c;
        len[e.to] = len[u] + e.len;
        heap.push(c, e.to);
      }
    }
  }
  return { cost, len };
}
