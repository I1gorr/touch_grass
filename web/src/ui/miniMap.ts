import type { Stop, Location } from '../models/types';
import { decodePolyline } from '../routing/polyline';
import { h } from './dom';

const SVG_NS = 'http://www.w3.org/2000/svg';

type RouteShape = { polyline?: unknown; mode?: unknown };

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

function routePoints(routeJson: string | null, stops: Stop[], start: Location): Location[] {
  if (routeJson) {
    try {
      const route = JSON.parse(routeJson) as RouteShape;
      if (typeof route.polyline === 'string' && route.polyline.length > 0) {
        const decoded = decodePolyline(route.polyline);
        if (decoded.length > 1) return decoded;
      }
    } catch {
      // A malformed or older route still gets a useful stop-to-stop sketch below.
    }
  }
  return [start, ...stops.map((stop) => ({ lat: stop.lat, lng: stop.lng }))];
}

function project(points: Location[], width: number, height: number, padding: number): (p: Location) => [number, number] {
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const latSpan = Math.max(maxLat - minLat, 0.00001);
  const lngSpan = Math.max(maxLng - minLng, 0.00001);
  const scale = Math.min((width - padding * 2) / lngSpan, (height - padding * 2) / latSpan);
  const x0 = (width - lngSpan * scale) / 2;
  const y0 = (height - latSpan * scale) / 2;
  return (p) => [x0 + (p.lng - minLng) * scale, y0 + (maxLat - p.lat) * scale];
}

/** Renders the saved route without network tiles, so it remains visible offline. */
export function miniMap(options: {
  routeJson: string | null;
  stops: Stop[];
  start: Location;
  current?: Location | null;
  floating?: boolean;
}): HTMLElement {
  const width = 320;
  const height = 188;
  const points = routePoints(options.routeJson, options.stops, options.start);
  const toSvg = project(points, width, height, 22);
  const path = points.map(toSvg).map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const root = h('div', { class: `mini-map${options.floating ? ' mini-map-floating' : ''}`, role: 'img', 'aria-label': 'Offline route map' });
  const header = h('div', { class: 'mini-map-header' }, h('span', { class: 'mini-map-title' }, 'Your route'), h('span', { class: 'mini-map-badge' }, 'Offline'));
  const canvas = svg('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true' });
  canvas.append(
    svg('rect', { x: '0', y: '0', width: `${width}`, height: `${height}`, rx: '16', class: 'mini-map-surface' }),
    svg('path', { d: path, class: 'mini-map-route' }),
  );

  const start = toSvg(options.start);
  const finish = toSvg(points[points.length - 1]);
  canvas.append(
    svg('circle', { cx: `${start[0]}`, cy: `${start[1]}`, r: '6', class: 'mini-map-start' }),
    svg('circle', { cx: `${finish[0]}`, cy: `${finish[1]}`, r: '5', class: 'mini-map-finish' }),
  );

  for (const [index, stop] of options.stops.entries()) {
    const [x, y] = toSvg({ lat: stop.lat, lng: stop.lng });
    const marker = svg('circle', { cx: `${x}`, cy: `${y}`, r: '8', class: 'mini-map-stop' });
    marker.setAttribute('aria-label', `Stop ${index + 1}: ${stop.name}`);
    canvas.append(marker);
    const label = svg('text', { x: `${x}`, y: `${y + 4}`, class: 'mini-map-stop-label', 'text-anchor': 'middle' });
    label.textContent = `${index + 1}`;
    canvas.append(label);
  }

  if (options.current) {
    const [rawX, rawY] = toSvg(options.current);
    const x = Math.min(width - 10, Math.max(10, rawX));
    const y = Math.min(height - 10, Math.max(10, rawY));
    canvas.append(svg('circle', { cx: `${x}`, cy: `${y}`, r: '9', class: 'mini-map-user-halo' }), svg('circle', { cx: `${x}`, cy: `${y}`, r: '5', class: 'mini-map-user' }));
  }
  root.append(header, canvas);
  return root;
}
