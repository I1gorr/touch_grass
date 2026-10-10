import { NoPackError, type RecommendedRoute } from '../data/routeService';
import type { PlaceCard } from '../routing/placeCard';
import type { CommunityNote } from '../routing/placeStats';
import { totalM, type RouteRequest } from '../routing/recommender';
import { replace } from '../router';
import { factsFor } from '../util/stopFacts';
import { appBar, button, card, choiceChip, dialog, loading, toast } from '../ui/components';
import { categoryLabel, distanceLabel, durationLabel, plural, reasonSentence } from '../ui/copy';
import { h, reactive, type Screen } from '../ui/dom';
import { icon } from '../ui/icons';
import { ctx } from './context';

const REPORT_REASONS = [
  { value: 'inappropriate', label: 'It’s inappropriate' },
  { value: 'private_info', label: 'It shares private information' },
  { value: 'wrong_place', label: 'It’s about a different place' },
  { value: 'spam', label: 'It’s spam' },
];

type Load = { state: 'loading' } | { state: 'error'; error: unknown } | { state: 'ready'; routes: RecommendedRoute[] };

/**
 * Pick a walk: 2-3 street-routed loops from the offline map pack, with what other people said about each
 * stop. Skip a place, ask for other options, or start one. Planning runs on the phone's data, so it also works offline.
 */
export function routeReviewScreen(): Screen {
  const { services: s } = ctx();
  let request: RouteRequest = s.requestFor();
  const skipped = new Set<string>();
  let hidden = new Set<string>();
  let load: Load = { state: 'loading' };
  let selected = 0;
  let starting = false;
  let alive = true;
  let generation = 0;

  const loadRoutes = (first = false) => {
    const mine = ++generation;
    load = { state: 'loading' };
    selected = 0;
    view.update();
    const p = first ? s.routes.recommend(request) : s.routes.recalculate(request, { skip: skipped });
    p.then(
      (routes) => mine === generation && alive && ((load = { state: 'ready', routes }), view.update()),
      (error) => mine === generation && alive && ((load = { state: 'error', error }), view.update()),
    );
    void s.reports.hiddenIds().then((ids) => alive && ((hidden = ids), view.update()));
  };

  const otherOptions = () => {
    const today = Math.trunc(Date.now() / 86_400_000);
    request = { ...request, seed: (request.seed ?? today) + 1 };
    loadRoutes();
  };

  const report = async (note: CommunityNote) => {
    const reason = await dialog({
      title: 'Report this note?',
      options: REPORT_REASONS.map((r) => ({ label: r.label, value: r.value })),
      actions: [{ label: 'Cancel', value: undefined as unknown as string }],
    });
    if (!reason) return;
    await s.reports.report(note.id, reason); // hidden here at once; sent when online
    hidden = await s.reports.hiddenIds();
    view.update();
    toast('Thanks. The note is hidden for you.');
  };

  /** Writes each stop's description with the language model (facts only), then saves the walk. */
  const start = async (route: RecommendedRoute) => {
    starting = true;
    view.update();
    try {
      const { walk } = route.quest;
      const stops = [];
      for (const stop of route.quest.stops) {
        stops.push(
          stop.blurb !== ''
            ? stop
            : { ...stop, blurb: await s.ml.tasks.blurb(factsFor(stop, { timeOfDay: walk.timeOfDay, weatherSummary: walk.weatherSummary })) },
        );
      }
      await s.repo.saveQuest({ walk, stops });
      if (alive) replace(`/walk/${walk.id}`);
    } catch (e) {
      console.warn('[routes] start failed:', e);
      starting = false;
      view.update();
      toast('Couldn’t start this walk. Try again.');
    }
  };

  const stopCard = (c: PlaceCard) => {
    const notes = c.sharedNotes.filter((n) => !hidden.has(n.id));
    const community =
      c.people === 0
        ? 'No one has shared anything here yet'
        : `${plural(c.walks, 'walk')} · ${plural(c.people, 'person', 'people')} · ${plural(c.notes, 'note')}`;
    return card(
      h(
        'div',
        null,
        h(
          'div',
          { class: 'row top' },
          h('div', { class: 'grow' }, h('h3', { class: 'title-md' }, c.name), h('div', { class: 'label' }, categoryLabel(c.category))),
          button({ label: 'Skip', variant: 'text', small: true, disabled: starting, onclick: () => (skipped.add(c.osmId), loadRoutes()) }),
        ),
        c.reason && h('p', { style: 'margin-top:6px' }, reasonSentence(c.reason)),
        h('p', { class: 'label', style: 'margin-top:4px' }, c.myVisits > 0 ? `${community} · you’ve been ${c.myVisits}×` : community),
        ...notes.map((n) =>
          h(
            'div',
            { class: 'quote' },
            h('span', { class: 'grow' }, `“${n.text}”`),
            h('button', { class: 'icon-btn', type: 'button', style: 'width:36px;height:36px', 'aria-label': 'Report this note', title: 'Report this note', onclick: () => void report(n) }, icon('flag_outline', 18)),
          ),
        ),
      ),
    );
  };

  const problem = (message: string, retry?: { label: string; run: () => void }) =>
    h('div', { class: 'center pad-y stack' }, h('p', null, message), retry && button({ label: retry.label, variant: 'outlined', onclick: retry.run }));

  const body = h('div', { class: 'content' });
  const bottom = h('div');
  const view = reactive(body, () => {
    bottom.replaceChildren(bottomBar());
    if (load.state === 'loading') return loading();
    if (load.state === 'error') {
      const e = load.error;
      const message = e instanceof NoPackError ? 'There’s no offline map for this area yet. Connect to the internet once to download it.' : 'Couldn’t plan a walk here. Try again.';
      if (!(e instanceof NoPackError)) console.warn('[routes]', e);
      return problem(message, { label: 'Try again', run: () => loadRoutes(true) });
    }
    const { routes } = load;
    if (routes.length === 0) {
      return problem(`No loop of about ${request.minutes} minutes fits here.`, skipped.size > 0 ? { label: 'Bring back skipped places', run: () => (skipped.clear(), loadRoutes()) } : undefined);
    }
    const o = routes[Math.min(selected, routes.length - 1)].option;
    return [
      h('div', { class: 'chips' }, ...routes.map((r, i) => choiceChip(`${distanceLabel(totalM(r.option))} · ${durationLabel(r.option.durationS)}`, i === selected, () => ((selected = i), view.update())))),
      h('p', { class: 'title-sm', style: 'margin-top:12px' }, `${o.cards.length} stops · loop back to the start`),
      o.mode !== 'street' && h('p', { class: 'label', style: 'margin-top:4px' }, 'No street map for this area yet, so distances are estimates.'),
      h('div', { style: 'margin-top:8px' }, ...o.cards.map(stopCard)),
      skipped.size > 0 && button({ label: `Bring back ${plural(skipped.size, 'skipped place')}`, variant: 'text', onclick: () => (skipped.clear(), loadRoutes()) }),
    ];
  });

  const bottomBar = () => {
    const ready = load.state === 'ready' && load.routes.length > 0 && !starting;
    return h(
      'div',
      { class: 'bottombar' },
      button({ label: 'Other options', variant: 'outlined', disabled: !ready, onclick: otherOptions }),
      h('span', { class: 'spacer' }),
      button({
        label: starting ? 'Preparing…' : 'Start this walk',
        icon: 'directions_walk',
        busy: starting,
        disabled: !ready,
        onclick: () => load.state === 'ready' && void start(load.routes[Math.min(selected, load.routes.length - 1)]),
      }),
    );
  };

  const el = h('div', { class: 'screen has-bar' }, appBar({ title: `A ${request.minutes}-minute walk`, back: true }), body, bottom);
  loadRoutes(true);
  return {
    el,
    dispose() {
      alive = false;
      view.stop();
    },
  };
}
