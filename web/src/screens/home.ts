import type { Walk } from '../models/types';
import { go } from '../router';
import { currentLocation, formatCoords, LocationError } from '../services/location';
import { appBar, button, card, chip, dialog, iconButton, loading, toast } from '../ui/components';
import { formatDate, plural, walkConditions, walkStatusLabel } from '../ui/copy';
import { h, reactive, type Screen } from '../ui/dom';
import { icon, type IconName } from '../ui/icons';
import { ctx } from './context';
import { needsSpeechModel, speechModelCard } from './speechSetup';

const STATUS_ICON: Record<Walk['status'], IconName> = {
  preparing: 'hourglass',
  ready: 'play_circle',
  active: 'directions_walk',
  done: 'check_circle',
};

export function homeScreen(): Screen {
  const { services: s } = ctx();
  const c = s.config;
  let walks: Walk[] | null = null;
  const refresh = async () => {
    walks = await s.repo.listWalks();
    view.update();
  };

  const open = (w: Walk, journal = false) => go(journal || w.status === 'done' ? `/journal/${w.id}` : `/walk/${w.id}`);

  const requestDelete = async (w: Walk) => {
    if (w.status === 'active') {
      toast('Finish this walk before deleting it.');
      return;
    }
    const confirmed = await dialog<boolean>({
      title: 'Delete this journey?',
      body: h('p', null, 'This permanently removes the quest, journal entries, and local photo. If cloud backup is enabled, its Atlas copy is removed too.'),
      actions: [
        { label: 'Keep journey', value: false },
        { label: 'Delete journey', value: true, variant: 'filled' },
      ],
    });
    if (!confirmed) return;
    try {
      if (s.sync) await s.sync.deleteWalk(w.id);
      await s.repo.deleteWalk(w.id);
      await refresh();
      toast('Journey deleted.');
    } catch (e) {
      console.warn('[walk delete] failed:', e);
      toast('Couldn’t delete it from the cloud. Nothing was removed.');
    }
  };

  const journeyButton = (w: Walk) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let longPressed = false;
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    return h(
      'button',
      {
        class: 'list-item grow',
        type: 'button',
        style: 'touch-action:manipulation',
        onpointerdown: () => {
          longPressed = false;
          cancel();
          timer = setTimeout(() => {
            timer = null;
            longPressed = true;
            void requestDelete(w);
          }, 650);
        },
        onpointerup: cancel,
        onpointercancel: cancel,
        onpointerleave: cancel,
        oncontextmenu: (e: Event) => {
          e.preventDefault();
          longPressed = true;
          void requestDelete(w);
        },
        onclick: (e: Event) => {
          if (longPressed) {
            e.preventDefault();
            longPressed = false;
            return;
          }
          open(w);
        },
      },
      icon(STATUS_ICON[w.status]),
      h('span', { class: 'grow' }, h('div', null, formatDate(w.createdAt)), h('div', { class: 'label' }, walkConditions(w))),
      chip(walkStatusLabel(w.status)),
    );
  };

  const syncButton = () => {
    const sync = s.sync;
    if (!sync) return null;
    const [name, tip] = sync.running
      ? (['cloud_sync', 'Syncing…'] as const)
      : sync.lastError
        ? (['cloud_off', `Not backed up yet: ${plural(sync.pending, 'change')} waiting`] as const)
        : sync.pending > 0
          ? (['cloud_upload', `${plural(sync.pending, 'change')} waiting`] as const)
          : (['cloud_done', 'Backed up'] as const);
    return iconButton({ icon: name, label: tip, onclick: () => void sync.syncNow() });
  };

  const speechBanner = () => (needsSpeechModel() ? speechModelCard(s.pipeline.waitingCount) : null);

  let locating = false;
  const useMyLocation = async () => {
    locating = true;
    view.update();
    try {
      const here = await currentLocation();
      await ctx().reconfigure({ ...c, demoCoords: here }); // saves it and rebuilds this screen
      toast(`Area set to your location: ${formatCoords(here)}`);
    } catch (e) {
      locating = false;
      view.update();
      toast(e instanceof LocationError ? e.message : 'Couldn’t read your location.');
    }
  };

  const host = h('div', { class: 'content' });
  const view = reactive(host, () => [
    card(
      h(
        'div',
        { class: 'stack' },
        h('h2', { class: 'title-lg' }, 'New quest'),
        h('p', null, 'Prepare it while you’re online, then walk offline.'),
        h('p', { class: 'small' }, `Area: ${formatCoords(c.demoCoords)}`),
        h('div', { class: 'row', style: 'padding-top:4px;flex-wrap:wrap' },
          button({ label: 'Prepare quest', icon: 'explore', onclick: () => go('/routes') }),
          button({ label: locating ? 'Finding you…' : 'Use my location', variant: 'text', busy: locating, disabled: locating, onclick: () => void useMyLocation() })),
      ),
    ),
    speechBanner(),
    h('h2', { class: 'title-md', style: 'margin:16px 0 4px' }, 'Your walks'),
    walks === null
      ? loading()
      : walks.length === 0
        ? h('p', { class: 'pad-y center' }, 'No walks yet.')
        : walks.map((w) =>
            h(
              'div',
              { class: 'row' },
              journeyButton(w),
              w.status !== 'done' && button({ label: 'Journal', variant: 'text', small: true, onclick: () => open(w, true) }),
            ),
          ),
  ]);

  // The sync button changes with the sync state, so the bar is rebuilt when that changes.
  const barHost = h('div');
  const drawBar = () => {
    const b = appBar({
      title: 'Touch Grass',
      actions: [
        { icon: 'storage', label: 'Database', onclick: () => go('/db') },
        { icon: 'settings', label: 'Settings', onclick: () => go('/settings') },
      ],
    });
    const sb = syncButton();
    if (sb) b.insertBefore(sb, b.children[1]);
    barHost.replaceChildren(b);
  };
  drawBar();
  const el = h('div', { class: 'screen' }, barHost, host);

  const offs = [
    s.repo.onChange(() => void refresh()),
    s.pipeline.subscribe(() => view.update()),
    s.models.subscribe(() => view.update()),
    s.sync?.subscribe(() => drawBar()),
  ];
  void refresh();
  return {
    el,
    dispose() {
      view.stop();
      offs.forEach((off) => off?.());
    },
  };
}
