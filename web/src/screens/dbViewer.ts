import { appBar, loading } from '../ui/components';
import { h, reactive, type Screen } from '../ui/dom';
import { ctx } from './context';

const TABLES = ['walk', 'stop', 'entry', 'photo'] as const;

/** Debug view of the raw walk/stop/entry/photo rows. */
export function dbViewerScreen(): Screen {
  const { services: s } = ctx();
  let tab: (typeof TABLES)[number] = 'walk';
  let rows: Record<string, object[]> | null = null;
  const refresh = async () => {
    rows = await s.repo.dumpTables();
    view.update();
  };

  const body = h('div');
  const view = reactive(body, () => [
    h('div', { class: 'tabs', role: 'tablist' }, ...TABLES.map((t) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(t === tab), onclick: () => ((tab = t), view.update()) }, t))),
    h(
      'div',
      { class: 'content', style: 'padding:12px' },
      rows === null
        ? loading()
        : (rows[tab] ?? []).length === 0
          ? h('p', { class: 'center pad-y' }, '(no rows)')
          : (rows[tab] ?? []).map((r) => h('div', { class: 'mono', style: 'padding:12px 0;border-bottom:1px solid var(--line)' }, Object.entries(r).map(([k, v]) => `${k}: ${v}`).join('\n'))),
    ),
  ]);

  const off = s.repo.onChange(() => void refresh());
  void refresh();
  return {
    el: h('div', { class: 'screen' }, appBar({ title: 'Database', back: true }), body),
    dispose() {
      off();
      view.stop();
    },
  };
}
