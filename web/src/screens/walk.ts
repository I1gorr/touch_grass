import { replace } from '../router';
import { WakeLockHolder } from '../services/wakeLock';
import { WalkController } from '../services/walkController';
import { appBar, button, card, dialog, entryCard, iconButton, loading, PhotoUrls, toast } from '../ui/components';
import { h, reactive, type Screen } from '../ui/dom';
import { icon } from '../ui/icons';
import { miniMap } from '../ui/miniMap';
import { ctx } from './context';
import { needsSpeechModel, speechModelCard, typeNoteFor } from './speechSetup';

export function walkScreen(walkId: string): Screen {
  const { services: s } = ctx();
  const c = new WalkController({ walkId, repo: s.repo, pipeline: s.pipeline, recorder: s.recorder, photos: s.photos });
  const urls = new PhotoUrls();
  const wake = new WakeLockHolder();
  let photoSrc: string | null = null;
  let photoKey = '';
  let currentLocation: { lat: number; lng: number } | null = null;
  let locationWatch: number | null = null;

  const finish = async () => {
    if (!(await c.finish())) return;
    replace(`/journal/${walkId}`);
  };

  /** One photo per walk: the second tap asks before replacing. */
  const photo = async () => {
    if (!c.hasPhoto) return c.takePhoto();
    const ok = await dialog<boolean>({
      title: 'Replace photo?',
      body: h('p', null, 'Each walk keeps one photo. A new one replaces the current photo.'),
      actions: [
        { label: 'Keep', value: false },
        { label: 'Replace', value: true, variant: 'filled' },
      ],
    });
    if (ok) await c.takePhoto({ replace: true });
  };

  const stopHeader = (name: string, blurb: string, prompt: string) =>
    card(
      h(
        'div',
        { class: 'stack' },
        h('h2', { class: 'headline' }, name),
        blurb && h('p', { style: 'font-size:1.0625rem' }, blurb),
        prompt && h('div', { class: 'row top', style: 'padding-top:4px' }, icon('record_voice_over', 20), h('p', { class: 'title-md italic', style: 'font-weight:400;color:var(--green-dark)' }, prompt)),
      ),
      { tint: true },
    );

  const body = h('div', { class: 'content' });
  const chrome = h('div');
  const view = reactive(body, () => {
    chrome.replaceChildren(...chromeParts());
    const stop = c.current;
    if (c.loading) return loading();
    if (!stop) return h('p', { class: 'center pad-y' }, 'This walk has no stops.');
    // The photo URL only changes when the photo does.
    const key = c.walkPhoto ? `${c.walkPhoto.entryId}:${c.walkPhoto.createdAt}:${c.walkPhoto.bytes.length}` : '';
    if (key !== photoKey) {
      photoKey = key;
      urls.release();
      photoSrc = c.walkPhoto ? urls.url(c.walkPhoto.bytes, c.walkPhoto.mime) : null;
    }
    const waiting = s.pipeline.waitingCount;
    return [
      c.walk && miniMap({ routeJson: c.walk.routeJson, stops: c.stops, start: { lat: c.walk.startLat, lng: c.walk.startLng }, current: currentLocation, floating: true }),
      stopHeader(stop.name, stop.blurb, stop.prompt),
      h('div', { class: 'row', style: 'margin-top:12px' }, h('span', { class: 'title-sm grow' }, 'Your notes'), h('span', { class: 'label' }, c.showCleaned ? 'Cleaned text' : 'Raw text')),
      c.entries.length === 0 && h('p', { class: 'pad-y center' }, 'Tap the mic and answer the prompt out loud.'),
      needsSpeechModel() && (waiting > 0 || c.entries.length === 0) && speechModelCard(waiting),
      ...[...c.entries].reverse().map((e) =>
        entryCard({
          entry: e,
          showCleaned: c.showCleaned,
          photoSrc: c.walkPhoto?.entryId === e.id ? photoSrc : null,
          jobState: s.pipeline.stateOf(e.id),
          onRetry: () => void s.pipeline.retry(e.id),
          onType: () => void typeNoteFor(e.id),
        }),
      ),
    ];
  });

  const chromeParts = () => {
    const stop = c.current;
    const title = c.loading || !stop ? 'Walk' : `Stop ${c.index + 1} of ${c.stops.length}`;
    const parts: Node[] = [
      appBar({
        title,
        back: true,
        actions: [{ icon: c.showCleaned ? 'auto_fix_high' : 'notes', label: c.showCleaned ? 'Show raw text' : 'Show cleaned text', onclick: () => c.toggleView() }],
      }),
    ];
    if (!c.loading) {
      parts.push(
        h(
          'button',
          { class: `record-fab${c.recording ? ' live' : ''}`, type: 'button', disabled: c.busy, 'aria-label': c.recording ? 'Stop recording' : 'Record', title: c.recording ? 'Stop recording' : 'Record', onclick: () => void c.toggleRecording() },
          icon(c.recording ? 'stop' : 'mic', 40),
        ),
        h(
          'div',
          { class: 'bottombar' },
          iconButton({ icon: 'chevron_left', label: 'Previous stop', disabled: c.isFirst || c.locked, onclick: () => void c.previous() }),
          iconButton({ icon: 'photo_camera', label: c.hasPhoto ? 'Replace this walk’s photo' : 'Take this walk’s photo', disabled: c.busy || c.recording, onclick: () => void photo(), class: c.hasPhoto ? 'tinted' : '' }),
          h('span', { class: 'spacer' }),
          c.isLast
            ? button({ label: 'Finish', aria: 'Finish walk', icon: 'flag', disabled: c.locked, onclick: () => void finish() })
            : button({ label: 'Next', aria: 'Next stop', icon: 'chevron_right', disabled: c.locked, onclick: () => void c.next() }),
        ),
      );
    }
    return parts;
  };

  let wasRecording = false;
  const offModels = s.models.subscribe(() => view.update());
  const off = c.subscribe(() => {
    const msg = c.message;
    if (msg) {
      c.clearMessage();
      toast(msg);
    }
    if (c.recording !== wasRecording) {
      wasRecording = c.recording;
      void wake.set(c.recording);
    }
    view.update();
  });
  const onVisible = () => document.visibilityState === 'visible' && void wake.reacquire();
  document.addEventListener('visibilitychange', onVisible);

  const el = h('div', { class: 'screen has-bar' }, chrome, body);
  if ('geolocation' in navigator) {
    locationWatch = navigator.geolocation.watchPosition(
      (position) => {
        currentLocation = { lat: position.coords.latitude, lng: position.coords.longitude };
        view.update();
      },
      () => undefined,
      { enableHighAccuracy: false, maximumAge: 30_000, timeout: 10_000 },
    );
  }
  void c.load();
  return {
    el,
    dispose() {
      off();
      offModels();
      view.stop();
      document.removeEventListener('visibilitychange', onVisible);
      if (locationWatch !== null) navigator.geolocation.clearWatch(locationWatch);
      void wake.set(false);
      c.dispose();
      urls.release();
    },
  };
}
