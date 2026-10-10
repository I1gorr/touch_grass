import type { Screen } from './ui/dom';

/** A route pattern like `/walk/:id` and the screen it shows. */
export interface Route {
  pattern: string;
  screen: (params: Record<string, string>) => Screen | Promise<Screen>;
}

export interface ParsedRoute {
  route: Route;
  params: Record<string, string>;
}

/** Matches `#/walk/abc` style paths. Returns null for no match. */
export function matchRoute(routes: Route[], path: string): ParsedRoute | null {
  const clean = path.replace(/^#/, '').split('?')[0].replace(/\/+$/, '') || '/';
  const segs = clean.split('/').filter(Boolean);
  for (const route of routes) {
    const pat = route.pattern.split('/').filter(Boolean);
    if (pat.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (const [i, p] of pat.entries()) {
      if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(segs[i]);
      else if (p !== segs[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

/**
 * Shows one screen at a time inside `outlet`, driven by the URL hash, so the phone's Back button works. The
 * previous screen is disposed when the person leaves it (stops its timers and listeners).
 */
export class Router {
  private current: Screen | null = null;
  private token = 0;

  constructor(
    private readonly outlet: HTMLElement,
    private readonly routes: Route[],
    private readonly notFound: () => Screen,
  ) {}

  start(): void {
    window.addEventListener('hashchange', () => void this.render());
    void this.render();
  }

  async render(): Promise<void> {
    const my = ++this.token;
    const m = matchRoute(this.routes, location.hash || '#/');
    const next = m ? await m.route.screen(m.params) : this.notFound();
    if (my !== this.token) {
      next.dispose?.(); // another navigation won while this screen was loading
      return;
    }
    this.current?.dispose?.();
    this.current = next;
    this.outlet.replaceChildren(next.el);
    window.scrollTo(0, 0);
  }
}

export const go = (path: string): void => {
  location.hash = path;
};

/** Navigates without leaving the old page in the Back history (like pushReplacement). */
export const replace = (path: string): void => {
  location.replace(`#${path}`);
};

export const back = (): void => history.back();
