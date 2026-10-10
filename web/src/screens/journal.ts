import type { Entry, Stop, Walk, WalkPhoto } from '../models/types';
import { appBar, entryCard, loading, PhotoUrls, photoThumb, toast } from '../ui/components';
import { formatDate, routeSummary, walkConditions } from '../ui/copy';
import { h, reactive, type Screen } from '../ui/dom';
import { ctx } from './context';
import { typeNoteFor } from './speechSetup';

/** Read-only walk journal: photo + entries grouped by stop. */
export function journalScreen(walkId: string): Screen {
  const { services: s } = ctx();
  const urls = new PhotoUrls();
  let cleaned = true;
  let data: { walk: Walk | null; stops: Stop[]; entries: Entry[]; photo: WalkPhoto | null } | null = null;
  let photoSrc: string | null = null;
  let alive = true;

  const load = async () => {
    const [walk, stops, entries, photo] = await Promise.all([
      s.repo.getWalk(walkId), s.repo.stopsForWalk(walkId), s.repo.entriesForWalk(walkId), s.repo.walkPhoto(walkId),
    ]);
    if (!alive) return;
    urls.release();
    photoSrc = photo ? urls.url(photo.bytes, photo.mime) : null;
    data = { walk, stops, entries, photo };
    view.update();
  };

  /** Sharing is a snapshot of the cleaned text (at most 280 characters); it reaches others after the next backup. */
  const share = async (entryId: string, on: boolean) => {
    try {
      if (on) await s.repo.shareEntry(entryId);
      else await s.repo.unshareEntry(entryId);
    } catch (e) {
      console.warn('[journal] share failed:', e);
      toast('Couldn’t change sharing. Try again.');
    }
  };

  const body = h('div', { class: 'content' });
  const bar = h('div');
  const view = reactive(body, () => {
    bar.replaceChildren(
      appBar({
        title: 'Walk journal',
        back: true,
        actions: [{ icon: cleaned ? 'auto_fix_high' : 'notes', label: cleaned ? 'Show raw text' : 'Show cleaned text', onclick: () => ((cleaned = !cleaned), view.update()) }],
      }),
    );
    if (!data) return loading();
    const { walk, stops, entries } = data;
    if (!walk) return h('p', { class: 'center pad-y' }, 'Walk not found');
    return [
      h('p', { class: 'label', style: 'font-weight:700' }, [formatDate(walk.createdAt), walkConditions(walk), routeSummary(walk)].filter(Boolean).join(' · ')),
      photoSrc && h('div', { style: 'margin-top:16px;border-radius:12px;overflow:hidden' }, photoThumb(photoSrc, 220)),
      ...stops.map((stop) => {
        const here = entries.filter((e) => e.stopId === stop.id);
        return h(
          'section',
          { style: 'margin-top:20px' },
          h('h2', { class: 'title-lg' }, stop.name),
          stop.prompt && h('p', { class: 'italic' }, stop.prompt),
          ...here.map((e) =>
            entryCard({
              entry: e,
              showCleaned: cleaned,
              jobState: s.pipeline.stateOf(e.id),
              onRetry: () => void s.pipeline.retry(e.id),
              onType: () => void typeNoteFor(e.id),
              onShare: (on) => void share(e.id, on),
            }),
          ),
          here.length === 0 && h('p', { class: 'small italic' }, 'Nothing recorded here'),
        );
      }),
    ];
  });

  const el = h('div', { class: 'screen' }, bar, body);
  // Re-query whenever the data changes: background cleanup may still be finishing.
  const offs = [s.repo.onChange(() => void load()), s.pipeline.subscribe(() => view.update())];
  void load();
  return {
    el,
    dispose() {
      alive = false;
      offs.forEach((off) => off());
      view.stop();
      urls.release();
    },
  };
}
