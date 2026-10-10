import { STT_MODELS, type ModelOption } from '../ml/models';
import { button, card, progressBar, toast, typeNoteDialog } from '../ui/components';
import { formatBytes, plural } from '../ui/copy';
import { h } from '../ui/dom';
import { icon } from '../ui/icons';
import { ctx } from './context';

/** The speech model the settings ask for. */
export function speechModel(): ModelOption {
  const id = ctx().services.config.ml.sttModel;
  return STT_MODELS.find((m) => m.id === id) ?? STT_MODELS[0];
}

/** True when voice notes can't become text yet because the speech model isn't on the phone. */
export function needsSpeechModel(): boolean {
  const { config, ml } = ctx().services;
  return config.sttMode !== 'fake' && ml.sttKind !== 'device';
}

/** Downloads the speech model, then switches the engines over and finishes any notes that were waiting. */
export async function downloadSpeechModel(): Promise<void> {
  const s = ctx().services;
  try {
    await s.models.download(speechModel());
    await s.refreshEngines();
    toast('Speech model ready. Your waiting notes are being turned into text.');
  } catch (e) {
    console.warn('[models] speech download failed:', e);
    toast('The download didn’t finish. Check your connection and try again.');
  }
}

/**
 * Explains that voice notes need the speech model and lets the person get it right here (no trip to Settings), with
 * progress. `waiting` is how many recorded notes are already waiting for it.
 */
export function speechModelCard(waiting: number): HTMLElement {
  const s = ctx().services;
  const model = speechModel();
  const st = s.models.status(model);
  const size = `about ${model.sizeMb} MB, best on Wi-Fi`;
  return card(
    h(
      'div',
      { class: 'banner' },
      icon('warning'),
      h(
        'div',
        { class: 'grow stack' },
        h('p', { class: 'title-md' }, 'Voice notes need the speech model'),
        waiting > 0
          ? h('p', null, `${waiting === 1 ? 'Your recording is' : `${plural(waiting, 'recording')} are`} saved. They turn into text on this phone once the model is downloaded.`)
          : h('p', null, `Download it once (${size}). After that your recordings turn into text on this phone, even offline. Until then recordings are saved and wait, or you can type a note instead.`),
        st.state === 'downloading'
          ? [
              progressBar(st.fraction > 0 && st.fraction < 0.999 ? st.fraction : null),
              h('p', { class: 'label' }, st.fraction < 0.001 ? 'Starting the download… Keep this page open.' : st.fraction >= 0.999 ? 'Almost done: setting it up on this phone…' : `Downloading… ${formatBytes(st.bytes)} (${Math.round(st.fraction * 100)}%). Keep this page open.`),
            ]
          : [
              st.state === 'error' && h('p', { class: 'label', style: 'color:var(--recording)' }, `Couldn’t download: ${st.message}`),
              button({ label: st.state === 'error' ? 'Try again' : `Download speech model (${model.sizeMb} MB)`, icon: 'download', small: true, onclick: () => void downloadSpeechModel() }),
            ],
      ),
    ),
    { warn: true },
  );
}

/** Lets the person type a note that speech recognition can't (or hasn't yet) handle. */
export async function typeNoteFor(entryId: string): Promise<void> {
  const text = await typeNoteDialog();
  if (!text) return;
  const ok = await ctx().services.pipeline.submitText(entryId, text);
  toast(ok ? 'Note saved.' : 'That note was already turned into text.');
}
