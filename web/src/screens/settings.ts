import {
  type AppConfig, COMMUNITY_RADIUS_CHOICES, ML_MODES, normalizeSyncUrl, parseCoords, STT_MODES, WALK_MINUTE_CHOICES,
} from '../config/config';
import { hasWebGpu } from '../ml/capabilities';
import { LLM_MODELS, type ModelOption, STT_MODELS } from '../ml/models';
import { appBar, button, card, chip, progressBar, selectRow, switchRow, toast } from '../ui/components';
import { distanceLabel, engineLabel, formatBytes, formatTime, plural } from '../ui/copy';
import { h, reactive, type Screen } from '../ui/dom';
import { go } from '../router';
import { currentLocation, formatCoords, LocationError } from '../services/location';
import { ctx } from './context';

/** A hint that the connection is metered, so a big download deserves a second thought. */
function meteredHint(): string | null {
  const conn = (navigator as unknown as { connection?: { saveData?: boolean; type?: string; effectiveType?: string } }).connection;
  if (!conn) return null;
  if (conn.saveData) return 'Data Saver is on.';
  if (conn.type === 'cellular') return 'You’re on mobile data.';
  return null;
}

/** Runtime knobs. Applying rebuilds the services; the database stays open. */
export function settingsScreen(): Screen {
  const c = ctx();
  const { services: s } = c;
  let draft: AppConfig = s.config;
  let coords = `${draft.demoCoords.lat}, ${draft.demoCoords.lng}`;
  let syncUrl = draft.syncUrl;
  let applying = false;
  let gpu: boolean | null = null; // null = still checking

  const set = (patch: Partial<AppConfig>) => {
    draft = { ...draft, ...patch };
    view.update();
    modelsView.update();
  };

  async function apply() {
    const parsed = parseCoords(coords);
    if (!parsed) return toast('Enter the area as “latitude, longitude”, for example 51.53, -0.16.');
    const url = normalizeSyncUrl(syncUrl);
    if (url === null) return toast('Use an https:// address. Plain http:// only works on this computer or your local network.');
    applying = true;
    view.update();
    try {
      await c.reconfigure({ ...draft, demoCoords: parsed, syncUrl: url });
      toast('Settings applied.'); // the shell rebuilds this screen with the new services
    } catch (e) {
      console.error('[settings] apply failed:', e);
      applying = false;
      view.update();
      toast('Couldn’t apply the settings. Nothing was changed.');
    }
  }

  async function locate() {
    try {
      coords = formatCoords(await currentLocation());
      view.update();
    } catch (e) {
      toast(e instanceof LocationError ? e.message : 'Couldn’t read your location.');
    }
  }

  // --- On-device models ---
  const download = async (o: ModelOption) => {
    const warning = meteredHint();
    try {
      await s.models.download(o);
      await s.refreshEngines();
      toast(`${o.label} is ready.`);
    } catch (e) {
      console.warn('[models] download failed:', e);
      toast(warning ? `Download failed. ${warning}` : 'Download failed. Check your connection and try again.');
    }
  };
  const remove = async (o: ModelOption) => {
    await s.models.remove(o);
    await s.refreshEngines();
    toast(`${o.label} was removed from this phone.`);
  };

  const modelRow = (o: ModelOption) => {
    const st = s.models.status(o);
    // The language model can't run without WebGPU, so don't let someone spend ~880 MB on it.
    if (o.kind === 'llm' && st.state !== 'ready' && gpu === false) {
      return h('div', { class: 'stack', style: 'padding:10px 0' }, h('div', { class: 'title-md' }, o.label), h('p', { class: 'label' }, 'This browser has no WebGPU, which the language model needs, so it can’t be used here. The app uses its pre-written text instead, which works fine.'));
    }
    return h(
      'div',
      { class: 'stack', style: 'padding:10px 0' },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'title-md' }, o.label), h('div', { class: 'label' }, `About ${o.sizeMb >= 1000 ? `${(o.sizeMb / 1000).toFixed(1)} GB` : `${o.sizeMb} MB`}. ${o.note}`)),
        st.state === 'ready'
          ? button({ label: 'Remove', variant: 'text', icon: 'delete', small: true, onclick: () => void remove(o) })
          : button({ label: st.state === 'error' ? 'Try again' : 'Download', variant: 'outlined', icon: 'download', small: true, disabled: st.state === 'downloading', onclick: () => void download(o) })),
      st.state === 'downloading' && [
        progressBar(st.fraction > 0 && st.fraction < 0.999 ? st.fraction : null),
        h('p', { class: 'label' }, st.fraction < 0.001
          ? 'Starting the download… Keep this page open.'
          : st.fraction >= 0.999
            ? 'Almost done: setting it up on this phone…'
            : `Downloading… ${formatBytes(st.bytes)} (${Math.round(st.fraction * 100)}%). Keep this page open.`),
      ],
      st.state === 'ready' && h('p', { class: 'label' }, 'On this phone. Works offline.'),
      st.state === 'error' && h('p', { class: 'label', style: 'color:var(--recording)' }, `Couldn’t download: ${st.message}`),
    );
  };

  const modelChoice = (kind: 'stt' | 'llm') => {
    const list = kind === 'stt' ? STT_MODELS : LLM_MODELS;
    const current = kind === 'stt' ? draft.ml.sttModel : draft.ml.llmModel;
    return selectRow({
      title: kind === 'stt' ? 'Speech model' : 'Language model',
      value: current,
      options: list.map((m) => ({ value: m.id, label: `${m.label} (${m.sizeMb} MB)` })),
      onchange: (id) => set({ ml: { ...draft.ml, [kind === 'stt' ? 'sttModel' : 'llmModel']: id } }),
    });
  };

  const modelsCard = () => {
    const stt = STT_MODELS.find((m) => m.id === draft.ml.sttModel) ?? STT_MODELS[0];
    const llm = LLM_MODELS.find((m) => m.id === draft.ml.llmModel) ?? LLM_MODELS[0];
    const hint = meteredHint();
    return card(
      h(
        'div',
        null,
        h('h2', { class: 'title-md' }, 'On-device models'),
        h('p', { class: 'label', style: 'margin:4px 0' }, 'These run in your browser, so your voice never leaves the phone. Download them once; they stay until you remove them.'),
        hint && h('p', { class: 'label', style: 'color:var(--recording)' }, `${hint} The speech model is about ${stt.sizeMb} MB. Consider waiting for Wi-Fi.`),
        h('p', { class: 'title-sm', style: 'margin-top:12px' }, 'Speech to text (needed for voice notes)'),
        modelChoice('stt'),
        modelRow(stt),
        h('p', { class: 'title-sm', style: 'margin-top:12px' }, 'Language model (optional)'),
        h('p', { class: 'label' }, 'Writes stop descriptions and tidies your notes. Without it the app uses pre-written text and simple rule-based cleanup, which is reliable. Small models sometimes get it wrong; wrong answers are discarded automatically.'),
        modelChoice('llm'),
        modelRow(llm),
      ),
    );
  };

  const syncStatus = () => {
    const sync = s.sync;
    if (!sync) return null;
    const last = sync.lastSuccess;
    const lines = [
      `${plural(sync.pending, 'change')} waiting to upload`,
      last === null ? 'Not backed up yet' : `Last backed up at ${formatTime(last.getTime())}`,
      sync.waitingForWalk && 'Backup waits until your walk is finished.',
      sync.lastError && 'The last attempt didn’t reach the server.',
      sync.paused && 'Automatic backup is paused. Tap “Sync now” to try again.',
      sync.refused > 0 && `${plural(sync.refused, 'change was', 'changes were')} refused because they belong to another install.`,
    ].filter(Boolean);
    return h('div', { class: 'row' }, h('p', { class: 'grow label', style: 'white-space:pre-line' }, lines.join('\n')), sync.running ? h('span', { class: 'spinner' }) : button({ label: 'Sync now', variant: 'outlined', small: true, onclick: () => void sync.syncNow() }));
  };

  const body = h('div', { class: 'content' });
  // The models section updates on its own while a download runs, so progress ticks never re-render (and un-focus) the text fields.
  const modelsHost = h('div');
  const modelsView = reactive(modelsHost, modelsCard);
  const view = reactive(body, () => [
    h('h2', { class: 'title-md' }, 'In use now'),
    h('div', { class: 'chips', style: 'margin-top:8px' }, ...Object.entries(s.kinds).map(([k, v]) => chip(`${k}: ${v}`))),
    h('div', { class: 'divider' }),
    modelsHost,
    selectRow({ title: 'Language model use', subtitle: 'Writes stop text and tidies your notes', value: draft.llmMode, options: ML_MODES.map((m) => ({ value: m, label: engineLabel(m) })), onchange: (v) => set({ llmMode: v }) }),
    selectRow({ title: 'Speech-to-text use', subtitle: 'Turns your voice notes into text', value: draft.sttMode, options: STT_MODES.map((m) => ({ value: m, label: engineLabel(m) })), onchange: (v) => set({ sttMode: v }) }),
    switchRow({ title: 'Sample places and weather', subtitle: 'Only the built-in Central Park map, nothing downloaded', checked: draft.fakeQuest, onchange: (v) => set({ fakeQuest: v }) }),
    switchRow({ title: 'Simulated microphone and camera', subtitle: 'For desk testing', checked: draft.fakeDevices, onchange: (v) => set({ fakeDevices: v }) }),
    h('label', { class: 'field' }, h('span', null, 'Walking area (latitude, longitude)'), h('input', { id: 'coords', type: 'text', inputMode: 'decimal', value: coords, oninput: (e: Event) => (coords = (e.target as HTMLInputElement).value) })),
    button({ label: 'Use my current location', variant: 'outlined', small: true, onclick: () => void locate() }),
    selectRow({ title: 'Walk length', subtitle: 'Routes follow real streets and loop back to the start', value: draft.walkMinutes, options: WALK_MINUTE_CHOICES.map((m) => ({ value: m, label: `${m} min` })), onchange: (v) => set({ walkMinutes: v }) }),
    selectRow({ title: 'Community notes from', subtitle: 'What other walkers shared about places near you', value: draft.communityRadiusM, options: COMMUNITY_RADIUS_CHOICES.map((r) => ({ value: r, label: r === 0 ? 'Off' : `Within ${distanceLabel(r)}` })), onchange: (v) => set({ communityRadiusM: v }) }),
    switchRow({ title: 'Vary routes', subtitle: 'Rotate through different places each day. Off keeps the same places.', checked: draft.routeVariety, onchange: (v) => set({ routeVariety: v }) }),
    selectRow({ title: 'Max stops per walk', value: draft.maxStops, options: [2, 3, 4, 5, 6, 8, 10].map((n) => ({ value: n, label: String(n) })), onchange: (v) => set({ maxStops: v }) }),
    h('div', { class: 'divider' }),
    h('h2', { class: 'title-md' }, 'Cloud backup'),
    h('p', { class: 'label' }, 'Everything is saved on this phone first. With a sync server set, your walks and notes are also backed up whenever you’re online. Photos never leave the phone.'),
    h('label', { class: 'field' }, h('span', null, 'Sync server address'), h('input', { type: 'url', placeholder: 'https://… (leave empty to turn off)', autocomplete: 'off', autocapitalize: 'off', spellcheck: false, value: syncUrl, oninput: (e: Event) => (syncUrl = (e.target as HTMLInputElement).value) })),
    syncStatus(),
    h('div', { class: 'stack', style: 'margin-top:16px;display:flex;flex-direction:column;align-items:stretch' },
      button({ label: applying ? 'Applying…' : 'Apply changes', busy: applying, disabled: applying, onclick: () => void apply() }),
      button({ label: 'Reset to defaults', variant: 'text', disabled: applying, onclick: () => ((draft = c.defaults), (coords = `${draft.demoCoords.lat}, ${draft.demoCoords.lng}`), (syncUrl = draft.syncUrl), view.update()) })),
    h('div', { class: 'divider' }),
    h('button', { class: 'list-item', type: 'button', onclick: () => go('/db') }, h('span', { class: 'grow' }, 'Database')),
  ]);

  void hasWebGpu().then((v) => ((gpu = v), modelsView.update()));
  const offs = [s.models.subscribe(() => modelsView.update()), s.sync?.subscribe(() => view.update())];
  return {
    el: h('div', { class: 'screen' }, appBar({ title: 'Settings', back: true }), body),
    dispose() {
      offs.forEach((off) => off?.());
      view.stop();
      modelsView.stop();
    },
  };
}
