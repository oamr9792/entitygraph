import { h, api, fmt, navigate, disclaimer } from '../app.js';
import {
  term, scoreWithBasis, basisPhrase, bandChip, bandNote, labelText, NOTICES, METRICS, BANDS, getMode,
} from '../lib/metrics-ui.js';

/**
 * §91 — the one-screen summary.
 *
 * Sentences, not a dashboard, and written here by template from structured
 * data rather than generated, so a sentence can only say what a field says. The
 * plain/advanced toggle relabels it through the registry and changes nothing
 * else. Five sections, in the order someone reading a report asks the questions.
 */
export async function summaryView({ params }) {
  const s = await api(`/api/entities/${params.id}/summary`);
  const name = s.entity?.canonical_name ?? 'This client';
  const pages = labelText('documents').toLowerCase();
  const whole = (v) => Number(v ?? 0).toLocaleString('en-GB');
  const link = (row) => h('a', { href: `#/associations/${row.association_id}` }, row.label);

  const head = h('div', { class: 'page-head' },
    h('div', {},
      h('h1', {}, name),
      h('div', { class: 'sub' },
        s.available
          ? `What we found, from ${whole(s.entity_documents)} ${pages} · ${fmt.date(s.generated_at)}`
          : 'What we found')),
    h('div', { class: 'toolbar' },
      h('button', { onclick: () => navigate(`#/entities/${params.id}`) }, 'Full dashboard'),
      h('a', { class: 'btn', href: '#/glossary' }, 'Glossary')));

  if (!s.available) {
    return h('div', { class: 'summary' }, head, disclaimer(s.disclaimer),
      h('div', { class: 'panel' }, h('div', { class: 'empty' },
        h('p', {}, 'Nothing to summarise yet: the build has not produced any associations.'),
        h('div', { class: 'toolbar', style: { justifyContent: 'center' } },
          h('button', { class: 'primary', onclick: () => navigate(`#/quickstart/${params.id}?step=build`) }, 'Build'),
          h('button', { onclick: () => navigate(`#/entities/${params.id}`) }, 'Why is it empty?')))));
  }

  // 1. What they are known for.
  const knownFor = h('section', {},
    h('h2', { class: 'summary-h' }, 'What they are known for'),
    h('p', {}, 'Ranked by ', term('pias'), ', the web most strongly links ', h('strong', {}, name), ' with:'),
    h('ul', {}, s.known_for.map((r) => h('li', {},
      link(r), ' ', bandChip(r.band), ' ',
      scoreWithBasis('pias', r.pias, { sources: r.independent_sources, documents: r.documents }),
      r.is_identity_marker
        ? h('span', { class: 'small dim' }, ' — one of the markers used to recognise them, so it appears by construction')
        : null))),
    bandNote());

  // 2. What has changed.
  const { rising, fading } = s.changes;
  const changeLine = (r, verb) => h('li', {},
    link(r), ` ${verb}: `, term('current_pias'), ` ${fmt.score(r.current_pias)} against `,
    term('historical_pias'), ` ${fmt.score(r.historical_pias)}, from ${whole(r.current_documents)} recent and ${whole(r.historical_documents)} older ${pages}.`);
  const changed = h('section', {},
    h('h2', { class: 'summary-h' }, 'What has changed'),
    rising.length || fading.length
      ? h('div', {},
          h('p', {}, 'Comparing recent coverage with older coverage (', term('strength_change'), '):'),
          h('ul', {},
            rising.map((r) => changeLine(r, 'is rising')),
            fading.map((r) => changeLine(r, 'is fading'))))
      : h('p', {}, 'Nothing has moved enough to call. No association has changed by fifteen points or more between older and recent coverage.'));

  // 3. What Google shows instead.
  let google;
  if (!s.google.available) {
    google = h('p', {}, NOTICES.no_google());
  } else {
    const gapLine = (g, lead, tail) => h('li', {},
      lead, link(g), tail,
      `${g.current_corpus_share_pct}% of recent ${pages} carry it (`, term('current_corpus_share'), '), against ',
      term('google_retrieval_score'), ` ${fmt.score(g.google_retrieval_score)}, from ${whole(g.google_results)} of ${whole(s.google.first_page_results)} first-page results.`);
    const lines = [
      ...s.google.web_ahead.map((g) => gapLine(g, 'The web associates them with ', ' more than Google currently shows: ')),
      ...s.google.google_ahead.map((g) => gapLine(g, 'Google shows ', ' more than the recent web associates them with it: ')),
    ];
    google = h('div', {},
      lines.length
        ? h('ul', {}, lines)
        : h('p', {}, 'Google’s first page and the recent web broadly agree: no association differs between them by fifteen points or more.'),
      h('p', { class: 'small dim' }, METRICS.google_retrieval_score.caveat));
  }
  const googleSection = h('section', {}, h('h2', { class: 'summary-h' }, 'What Google shows instead'), google);

  // 4. How much to trust this.
  const t = s.trust;
  const reasonText = {
    too_few_documents: (r) => NOTICES.low_coverage(r),
    dates_inferred: (r) => NOTICES.dates_inferred(r),
    no_llm_key: () => NOTICES.no_llm_key(),
    heuristic_rows: (r) => NOTICES.heuristic_rows(r),
  };
  const trust = h('section', {},
    h('h2', { class: 'summary-h' }, 'How much to trust this'),
    h('p', {}, term('coverage_confidence'), ': ', h('span', { class: `level ${t.level}` }, t.level),
      `, based on ${whole(t.documents)} ${pages} from ${whole(t.domains)} websites.`),
    t.reasons.length
      ? h('ul', {}, t.reasons.map((r) => h('li', {}, (reasonText[r.key] ?? (() => r.key))(r))))
      : h('p', {}, 'No specific weakness found in coverage, dating or extraction.'));

  // 5. Three things to do.
  const bandWord = (band) => (BANDS[band]?.plain ?? 'present').toLowerCase();
  const websites = (count) => `${whole(count)} ${Math.round(count) === 1 ? 'website' : 'websites'}`;
  const actionCopy = {
    defend: ['Defend', 'good', (a) => ['Defend ', link(a), `: it is ${bandWord(a.band)} now and reads ${a.sentiment}, from ${basisPhrase({ sources: a.independent_sources, documents: a.documents })}.`]],
    build: ['Build', 'warn', (a) => ['Build ', link(a), `: it is real and recent but rests on only ${websites(a.domains)}.`]],
    risk: ['Risk', 'bad', (a) => ['Watch ', link(a), `: coverage reads negative and is ${a.momentum?.label ?? 'moving'}.`]],
    historical: ['Fading', '', (a) => ['Let ', link(a), ' keep fading: it was strong before and is weak now, so check its action plan before spending on it.']],
    monitor: ['Monitor', '', (a) => ['Monitor ', link(a), ': nothing about it calls for action yet.']],
  };
  const todo = h('section', {},
    h('h2', { class: 'summary-h' }, 'Three things to do'),
    s.actions.length
      ? h('ul', { class: 'todo' }, s.actions.map((a) => {
          const [chip, cls, sentence] = actionCopy[a.kind] ?? actionCopy.monitor;
          return h('li', {},
            h('span', { class: `chip ${cls}`.trim() }, chip),
            h('span', {}, ...sentence(a), ' ', h('a', { class: 'small', href: `#/associations/${a.association_id}/plan` }, 'Action plan')));
        }))
      : h('p', {}, 'No clear action stands out yet.'));

  return h('div', { class: 'summary' },
    head,
    disclaimer(s.disclaimer),
    h('div', { class: 'panel' }, h('div', { class: 'panel-body' }, knownFor, changed, googleSection, trust, todo)),
    h('p', { class: 'small dim' },
      getMode() === 'plain'
        ? 'Everything else — the full leaderboard, the evidence behind each score, the Google overlay — is one click away on the dashboard.'
        : 'Plain summary of the dashboard. Every figure here is on the leaderboard with its full breakdown.'));
}
