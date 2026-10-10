import { type Child, h } from './dom';
import { icon, type IconName } from './icons';
import { formatTime } from './copy';
import type { Entry } from '../models/types';
import type { EntryJobState } from '../services/entryPipeline';

export interface BarAction {
  icon: IconName;
  label: string;
  onclick: () => void;
  disabled?: boolean;
}

/** Top bar with an optional back arrow and icon actions. */
export function appBar(o: { title: string; back?: boolean; actions?: BarAction[] }): HTMLElement {
  return h(
    'header',
    { class: `appbar${o.back ? ' has-back' : ''}` },
    o.back && h('button', { class: 'icon-btn', 'aria-label': 'Back', title: 'Back', onclick: () => history.back() }, icon('arrow_back')),
    h('h1', null, o.title),
    ...(o.actions ?? []).map((a) => iconButton(a)),
  );
}

export function iconButton(a: BarAction & { class?: string }): HTMLButtonElement {
  return h('button', { class: `icon-btn ${a.class ?? ''}`.trim(), type: 'button', 'aria-label': a.label, title: a.label, disabled: a.disabled, onclick: a.onclick }, icon(a.icon));
}

export function button(o: {
  label: string;
  /** Accessible name when it differs from the visible label (e.g. "Next" shown, "Next stop" announced). */
  aria?: string;
  variant?: 'filled' | 'outlined' | 'text';
  icon?: IconName;
  onclick?: () => void;
  disabled?: boolean;
  small?: boolean;
  busy?: boolean;
}): HTMLButtonElement {
  return h(
    'button',
    { class: `btn ${o.variant ?? 'filled'}${o.small ? ' small-btn' : ''}`, type: 'button', disabled: o.disabled, 'aria-label': o.aria, onclick: o.onclick },
    o.busy ? h('span', { class: 'spinner' }) : o.icon && icon(o.icon, 20),
    o.label,
  );
}

export const card = (children: Child, o: { tint?: boolean; warn?: boolean; flush?: boolean } = {}): HTMLElement =>
  h('div', { class: `card${o.tint ? ' tint' : ''}${o.warn ? ' warn' : ''}${o.flush ? ' flush' : ''}` }, children);

export const chip = (label: string): HTMLElement => h('span', { class: 'chip' }, label);

export function choiceChip(label: string, selected: boolean, onclick: () => void): HTMLButtonElement {
  return h('button', { class: 'chip choice', type: 'button', 'aria-pressed': String(selected), onclick }, label);
}

export const spinner = (big = false): HTMLElement => h('span', { class: `spinner${big ? ' big' : ''}`, role: 'status', 'aria-label': 'Loading' });

export const loading = (): HTMLElement => h('div', { class: 'loading' }, spinner(true));

export function progressBar(value: number | null): HTMLElement {
  return h(
    'div',
    { class: `progress${value === null ? ' indeterminate' : ''}`, role: 'progressbar', 'aria-valuenow': value === null ? undefined : Math.round(value * 100) },
    h('div', { style: value === null ? '' : `width:${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }),
  );
}

/** A labelled on/off row. */
export function switchRow(o: { title: string; subtitle?: string; checked: boolean; onchange: (on: boolean) => void }): HTMLElement {
  const input = h('input', { type: 'checkbox', role: 'switch', checked: o.checked, onchange: () => o.onchange(input.checked) });
  return h(
    'label',
    { class: 'setting' },
    h('span', { class: 'grow' }, h('span', null, o.title), o.subtitle && h('span', { class: 'label' }, o.subtitle)),
    h('span', { class: 'switch' }, input, h('span', { class: 'track' }), h('span', { class: 'thumb' })),
  );
}

/** A labelled drop-down row. */
export function selectRow<T extends string | number>(o: {
  title: string;
  subtitle?: string;
  value: T;
  options: { value: T; label: string }[];
  onchange: (v: T) => void;
}): HTMLElement {
  const sel = h(
    'select',
    {
      'aria-label': o.title,
      onchange: () => {
        const picked = o.options[sel.selectedIndex];
        if (picked) o.onchange(picked.value);
      },
    },
    ...o.options.map((opt) => h('option', { value: String(opt.value), selected: opt.value === o.value }, opt.label)),
  );
  return h('div', { class: 'setting' }, h('span', { class: 'grow' }, h('span', null, o.title), o.subtitle && h('span', { class: 'label' }, o.subtitle)), sel);
}

// --- Toasts and dialogs ---

let toastHost: HTMLElement | null = null;

/** A short message at the bottom of the screen, gone after a few seconds. */
export function toast(message: string, ms = 4000): void {
  toastHost ??= document.body.appendChild(h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' }));
  const el = h('div', { class: 'toast' }, message);
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/** Resolves with the chosen action's value, or `undefined` if dismissed. */
export function dialog<T>(o: { title: string; body?: Child; actions?: { label: string; value: T; variant?: 'filled' | 'text' }[]; options?: { label: string; value: T }[] }): Promise<T | undefined> {
  return new Promise((resolve) => {
    const close = (v: T | undefined) => {
      scrim.remove();
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close(undefined);
    const scrim = h(
      'div',
      { class: 'scrim', onclick: (e: Event) => e.target === scrim && close(undefined) },
      h(
        'div',
        { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title },
        h('h2', null, o.title),
        o.body,
        o.options && h('div', { class: 'options' }, ...o.options.map((opt) => h('button', { class: 'btn text', type: 'button', onclick: () => close(opt.value) }, opt.label))),
        h(
          'div',
          { class: 'actions' },
          ...(o.actions ?? []).map((a) => h('button', { class: `btn ${a.variant ?? 'text'}`, type: 'button', onclick: () => close(a.value) }, a.label)),
        ),
      ),
    );
    document.addEventListener('keydown', onKey);
    document.body.appendChild(scrim);
    scrim.querySelector<HTMLElement>('button')?.focus();
  });
}

// --- Photos ---

/** Blob URLs for photo bytes. Call `release()` when the screen goes away. */
export class PhotoUrls {
  private urls: string[] = [];

  url(bytes: Uint8Array, mime: string): string {
    const u = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    this.urls.push(u);
    return u;
  }

  release(): void {
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls = [];
  }
}

/** A photo that opens full screen (pinch to zoom) when tapped. */
export function photoThumb(src: string, height?: number): HTMLElement {
  const img = h('img', { class: 'photo', src, alt: 'Walk photo', style: height ? `height:${height}px` : '' });
  return h('button', { class: 'entry-photo-btn', type: 'button', 'aria-label': 'View photo full screen', onclick: () => openViewer(src) }, img);
}

function openViewer(src: string): void {
  const close = () => viewer.remove();
  const viewer = h(
    'div',
    { class: 'viewer', role: 'dialog', 'aria-label': 'Photo' },
    h('header', null, h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close photo', onclick: close }, icon('close'))),
    h('div', { class: 'stage', onclick: (e: Event) => e.target === e.currentTarget && close() }, h('img', { src, alt: 'Walk photo' })),
  );
  document.body.appendChild(viewer);
}

// --- Journal entries ---

/** One journal entry: transcript (raw or cleaned), photo, and pipeline status. */
export function entryCard(o: {
  entry: Entry;
  showCleaned: boolean;
  jobState?: EntryJobState;
  onRetry?: () => void;
  /** Type the note instead. Offered when speech recognition can't (or hasn't yet) turned the recording into text. */
  onType?: () => void;
  /** Shares or unshares the note with people nearby. Shown only when set and the note has cleaned text. */
  onShare?: (on: boolean) => void;
  photoSrc?: string | null;
}): HTMLElement {
  const e = o.entry;
  const text = o.showCleaned ? (e.cleanedText ?? e.rawTranscript) : e.rawTranscript;
  const hasTranscript = e.rawTranscript !== null;

  const status = (): Child => {
    switch (o.jobState) {
      case 'transcribing': return busy('Transcribing…');
      case 'cleaning': return busy('Cleaning up…');
      case 'waiting': return h('span', { class: 'label' }, 'Waiting for the speech model');
      case 'failed': return button({ label: 'Retry', variant: 'text', icon: 'refresh', small: true, onclick: o.onRetry });
      default:
        // Audio job lost (e.g. the app was closed mid-transcription).
        return !hasTranscript && !e.hasPhoto ? h('span', { class: 'small' }, 'No transcript') : null;
    }
  };

  return h(
    'div',
    { class: 'card flush' },
    o.photoSrc && photoThumb(o.photoSrc, 180),
    h(
      'div',
      { style: 'padding:12px' },
      h('div', { class: 'row' }, h('span', { class: 'label grow' }, formatTime(e.recordedAt)), status()),
      text ? h('p', { style: 'margin-top:6px', class: 'entry-text' }, text) : hasTranscript && h('p', { class: 'italic', style: 'margin-top:6px' }, 'No speech detected'),
      o.jobState === 'waiting' && h('p', { class: 'label', style: 'margin-top:6px' }, 'Your recording is saved. It becomes text once the speech model is downloaded.'),
      o.jobState === 'failed' && h('p', { class: 'label', style: 'margin-top:6px' }, 'Couldn’t turn this recording into text. It’s still saved: retry, or type it instead.'),
      (o.jobState === 'waiting' || o.jobState === 'failed') && o.onType && h('div', { style: 'margin-top:8px' }, button({ label: 'Type it instead', variant: 'outlined', small: true, icon: 'notes', onclick: o.onType })),
      o.onShare && (e.cleanedText ?? '').trim() !== '' &&
        switchRow({
          title: 'Share with people nearby',
          subtitle: e.shared ? 'Others see the cleaned text, without your name. Turn off to take it back.' : 'Only the cleaned text, never your voice or photo.',
          checked: e.shared,
          onchange: o.onShare,
        }),
      !o.photoSrc && e.hasPhoto && h('div', { class: 'row', style: 'margin-top:8px' }, icon('photo_camera', 16), h('span', { class: 'label' }, 'Walk photo taken here')),
      o.showCleaned && hasTranscript && e.cleanedText === null && !o.jobState && h('p', { class: 'small' }, 'Raw text shown until cleanup finishes'),
    ),
  );
}

const busy = (label: string): HTMLElement => h('span', { class: 'row' }, h('span', { class: 'spinner' }), h('span', { class: 'label' }, label));

/** Asks for the words of a note. Resolves with the text, or undefined if cancelled. */
export function typeNoteDialog(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const box = h('textarea', { rows: 5, placeholder: 'What did you notice here?', 'aria-label': 'Your note', style: 'width:100%;border:1px solid var(--outline);border-radius:10px;padding:12px;font:inherit;resize:vertical' });
    const done = (v: string | undefined) => {
      scrim.remove();
      resolve(v);
    };
    const scrim = h(
      'div',
      { class: 'scrim', onclick: (e: Event) => e.target === scrim && done(undefined) },
      h(
        'div',
        { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Type your note' },
        h('h2', null, 'Type your note'),
        box,
        h('div', { class: 'actions' }, button({ label: 'Cancel', variant: 'text', onclick: () => done(undefined) }), button({ label: 'Save note', onclick: () => done(box.value.trim() || undefined) })),
      ),
    );
    document.body.appendChild(scrim);
    box.focus();
  });
}
