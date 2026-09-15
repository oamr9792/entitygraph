import { h } from '../lib/dom.js';
import { METRICS, BANDS, BAND_ORDER, DISCLAIMERS, getMode } from '../lib/metrics-ui.js';

/**
 * §96 — the glossary, generated entirely from the copy registry.
 *
 * Nothing on this screen is written here. Every definition, band description
 * and disclaimer is read from src/copy/metrics.js, which is the point: the
 * glossary cannot disagree with a tooltip, because they are the same words.
 */
export async function glossaryView({ query }) {
  const target = query.get('term');
  const mode = getMode();
  const primary = (entry) => (mode === 'advanced' ? entry.advanced : entry.plain);
  const secondary = (entry) => (mode === 'advanced' ? entry.plain : entry.advanced);

  const entries = Object.entries(METRICS)
    .filter(([, entry]) => entry.status !== 'planned')
    .sort(([, a], [, b]) => primary(a).localeCompare(primary(b)));
  const planned = Object.entries(METRICS).filter(([, entry]) => entry.status === 'planned');

  const definition = ([key, entry]) => [
    h('dt', { id: `term-${key}`, class: key === target ? 'targeted' : '' },
      primary(entry),
      secondary(entry) && secondary(entry) !== primary(entry) ? h('span', { class: 'alt' }, secondary(entry)) : null),
    h('dd', {},
      h('p', { style: { margin: '0 0 0.2rem' } }, entry.what, ' ', entry.look),
      entry.caveat ? h('p', { class: 'small dim', style: { margin: 0 } }, entry.caveat) : null),
  ];

  if (target) {
    // After the screen is attached. The term link in every tooltip lands here.
    setTimeout(() => document.getElementById(`term-${target}`)?.scrollIntoView({ block: 'center' }), 60);
  }

  return h('div', { class: 'glossary' },
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Glossary'),
        h('div', { class: 'sub' }, 'Every term this tool uses, defined once. Tooltips across the app read from the same definitions.'))),

    h('div', { class: 'panel' },
      h('h2', {}, 'What this is, and is not'),
      h('div', { class: 'panel-body narrative' },
        h('p', {}, DISCLAIMERS.external_estimate),
        h('p', {}, DISCLAIMERS.source_reliability),
        h('p', {}, DISCLAIMERS.query_behavior),
        h('p', { style: { marginBottom: 0 } }, DISCLAIMERS.simulation))),

    h('div', { class: 'panel' },
      h('h2', {}, 'Terms'),
      h('div', { class: 'panel-body' }, h('dl', {}, entries.map(definition)))),

    h('div', { class: 'panel' },
      h('h2', {}, 'Bands'),
      h('div', { class: 'panel-body' },
        h('dl', {}, BAND_ORDER.map((band) => [h('dt', {}, BANDS[band].plain), h('dd', {}, BANDS[band].what)])),
        h('p', { class: 'band-note' }, DISCLAIMERS.bands))),

    planned.length
      ? h('div', { class: 'panel' },
          h('h2', {}, 'Not yet available'),
          h('div', { class: 'panel-body' },
            h('p', { class: 'small dim', style: { marginTop: 0 } },
              'Defined so the vocabulary is settled, but not yet computed anywhere in the app.'),
            h('dl', {}, planned.map(definition))))
      : null
  );
}
