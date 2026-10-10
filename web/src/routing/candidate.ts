export interface Candidate {
  osmId: string;
  name: string;
  lat: number;
  lng: number;
  tags: Record<string, string>;
}

/** Primary category used for variety and scoring, e.g. "tourism=artwork". */
export function categoryOf(c: Candidate): string {
  for (const k of ['tourism', 'historic', 'leisure', 'amenity', 'natural', 'man_made']) {
    const v = c.tags[k];
    if (v !== undefined) return `${k}=${k === 'historic' ? '*' : v}`;
  }
  return 'other';
}

/** Parses an Overpass JSON body (`out center`) into candidates. */
export function parseOverpass(body: string): Candidate[] {
  const data = JSON.parse(body) as { elements?: any[] };
  const out: Candidate[] = [];
  for (const m of data.elements ?? []) {
    const lat = m.lat ?? m.center?.lat;
    const lng = m.lon ?? m.center?.lon;
    if (lat == null || lng == null) continue;
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.tags ?? {})) tags[k] = String(v);
    out.push({ osmId: `${m.type}/${m.id}`, name: tags.name ?? '', lat: Number(lat), lng: Number(lng), tags });
  }
  return out;
}

/** Drops wikidata/wikipedia-tagged (famous) items, nameless items and duplicate names. */
export function filterCandidates(input: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of input) {
    const name = c.name.trim();
    if (name === '') continue;
    if (Object.keys(c.tags).some((k) => k.includes('wikidata') || k.includes('wikipedia'))) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

const CATEGORY_WEIGHT: Record<string, number> = {
  'tourism=artwork': 5,
  'tourism=viewpoint': 5,
  'amenity=fountain': 4,
  'historic=*': 4,
  'leisure=garden': 3,
  'leisure=park': 3,
  'amenity=place_of_worship': 3,
  'tourism=attraction': 2,
};

/** Base value of a stop by category (1 for anything unlisted). */
export const categoryWeight = (c: Candidate): number => CATEGORY_WEIGHT[categoryOf(c)] ?? 1;
