import { type AppConfig, ConfigStore, configFromEnv } from './config/config';
import { dbViewerScreen } from './screens/dbViewer';
import { ctx, setCtx } from './screens/context';
import { homeScreen } from './screens/home';
import { journalScreen } from './screens/journal';
import { routeReviewScreen } from './screens/routeReview';
import { settingsScreen } from './screens/settings';
import { walkScreen } from './screens/walk';
import { AppServices, type ServiceOverrides } from './services/appServices';
import { Router, type Route } from './router';
import { appBar, button, loading } from './ui/components';
import { h, type Screen } from './ui/dom';

export const ROUTES: Route[] = [
  { pattern: '/', screen: () => homeScreen() },
  { pattern: '/routes', screen: () => routeReviewScreen() },
  { pattern: '/walk/:id', screen: (p) => walkScreen(p.id) },
  { pattern: '/journal/:id', screen: (p) => journalScreen(p.id) },
  { pattern: '/settings', screen: () => settingsScreen() },
  { pattern: '/db', screen: () => dbViewerScreen() },
];

const notFound = (): Screen => ({
  el: h('div', { class: 'screen' }, appBar({ title: 'Touch Grass' }), h('div', { class: 'content center pad-y stack' }, h('p', null, 'There’s nothing here.'), button({ label: 'Go home', onclick: () => (location.hash = '#/') }))),
});

/**
 * Starts the app in `root`: loads the saved settings, builds the services (database, models, sync) and shows the
 * screens. Pass `overrides` to plug in other pieces (tests).
 */
export async function startApp(root: HTMLElement, o: { overrides?: ServiceOverrides; defaults?: AppConfig; store?: ConfigStore } = {}): Promise<void> {
  root.replaceChildren(h('div', { class: 'screen' }, loading()));
  const defaults = o.defaults ?? configFromEnv(import.meta.env as Record<string, string | undefined>);
  const store = o.store ?? new ConfigStore();
  let services: AppServices;
  try {
    services = await AppServices.create(store.load(defaults), o.overrides, { recoverPending: true });
  } catch (e) {
    console.error('[app] startup failed:', e);
    root.replaceChildren(
      h('div', { class: 'screen' }, appBar({ title: 'Touch Grass' }), h('div', { class: 'content stack' }, h('p', { class: 'title-md' }, 'Touch Grass couldn’t start.'), h('p', null, 'The phone’s storage may be unavailable (for example in a private window). Try again in a normal browser window.'), h('p', { class: 'small mono' }, String(e)))),
    );
    return;
  }

  let router!: Router;
  const reconfigure = async (config: AppConfig) => {
    const old = ctx().services;
    // Keep the open database and the model worker; rebuild the rest from the new settings.
    const next = await AppServices.create(config, { ...o.overrides, repo: old.repo, client: old.client });
    setCtx({ ...ctx(), services: next });
    // The new services are live now; cleaning up the old ones must not be able to fail the switch.
    await old.dispose({ keepRepo: true }).catch((e) => console.warn('[app] cleaning up the old services failed:', e));
    if (!store.save(config)) console.warn('[settings] could not be saved; they apply for this session only');
    await router.render();
  };
  setCtx({ services, reconfigure, defaults, store });

  // Ask the browser not to clear walks and recordings when the phone is short on space.
  void navigator.storage?.persist?.().catch(() => undefined);

  const outlet = h('div');
  root.replaceChildren(outlet);
  router = new Router(outlet, ROUTES, notFound);
  router.start();
}
