/** A tiny DOM builder, enough for these screens without a framework. */

export type Child = Node | string | number | false | null | undefined | Child[];

type Attrs = {
  class?: string;
  style?: string;
  /** Event handlers: `onclick`, `oninput`, ... */
  [k: string]: unknown;
};

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k in el && k !== 'list' && k !== 'style') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (Array.isArray(c)) append(el, c);
    else if (c === false || c === null || c === undefined) continue;
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

/** Replaces all children of `el`. */
export function replaceChildren(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

/** A screen: its root element plus a cleanup that runs when the person leaves it. */
export interface Screen {
  el: HTMLElement;
  dispose?: () => void;
}

/**
 * Re-renders `render()` into `host` whenever `update()` is called (coalesced to one per animation frame). The first
 * render runs in a microtask, after the screen function has finished declaring its helpers, so `render` may use
 * anything defined later in the same function (a synchronous first render hits "before initialization" errors).
 */
export function reactive(host: Element, render: () => Child): { update: () => void; stop: () => void } {
  let scheduled = false;
  let stopped = false;
  const run = () => {
    scheduled = false;
    if (!stopped) replaceChildren(host, render());
  };
  queueMicrotask(run);
  return {
    update() {
      if (scheduled || stopped) return;
      scheduled = true;
      requestAnimationFrame(run);
    },
    stop() {
      stopped = true;
    },
  };
}
