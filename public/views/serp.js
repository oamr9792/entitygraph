import { h, api, fmt, disclaimer, toast, colourFor } from '../app.js';
import { metricLabel, term, scoreWithBasis, labelText, METRICS } from '../lib/metrics-ui.js';
import { googleTracePanel } from './google-trace.js';

/**
 * §52, §53, §77 — the Google overlay.
 *
 * The screen's job is the comparison, not the ranking: what the corpus
 * currently says about this entity against what Google currently retrieves for
 * it. Where those disagree is the ORM opportunity.
 */
export async function serpView({ params }) {
  const data = await api(`/api/entities/${params.id}/serp`);

  const capture = h('button', {
    class: 'primary',
    onclick: async () => {
      capture.disabled = true;
      capture.textContent = 'Capturing…';
      try {
        await api(`/api/entities/${params.id}/serp`, { method: 'POST', body: {} });
        toast('Google results captured', 'success');
        location.reload();
      } catch (err) {
        toast(err.message, 'error');
        capture.disabled = false;
        capture.textContent = 'Capture Google results now';
      }
    },
  }, 'Capture Google results now');

  if (!data.overlay) {
    return h('div', {},
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Google overlay'))),
      disclaimer(),
      h('div', { class: 'panel' }, h('div', { class: 'empty' },
        h('p', {}, data.note ?? 'No Google snapshot yet.'),
        h('p', { class: 'small dim' }, 'This costs one DataForSEO SERP call.'),
        capture
      ))
    );
  }

  const { overlay, gap } = data;
  const firstPage = overlay.first_page_results ?? 0;
  const pages = labelText('documents').toLowerCase();
  const olderDocuments = (r) => Math.max(0, (r.documents ?? 0) - (r.current_documents ?? 0));

  const results = h('table', {},
    h('thead', {}, h('tr', {},
      h('th', { class: 'num no-sort' }, '#'),
      h('th', { class: 'num no-sort', title: '§53 rank weights: #1 = 1.00 down to #10 = 0.10, zero beyond' }, 'Weight'),
      h('th', { class: 'no-sort' }, 'Result'),
      h('th', { class: 'no-sort' }, 'Supports'),
      h('th', { class: 'no-sort' }, 'Method')
    )),
    h('tbody', {}, overlay.results.slice(0, 30).map((r) => h('tr', {},
      h('td', { class: 'num' }, r.rank),
      h('td', { class: 'num' }, r.rank_weight ? r.rank_weight.toFixed(2) : h('span', { class: 'dim' }, '0')),
      h('td', {}, h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.root_domain),
        h('div', { class: 'small dim' }, r.title ?? '')),
      h('td', {}, r.associations.length
        ? r.associations.map((a) => h('span', { class: 'chip', style: { marginRight: '0.25rem', borderColor: colourFor(a.label) } }, a.label))
        : h('span', { class: 'dim' }, 'unclassified')),
      h('td', { class: 'small dim' }, r.method ?? '—')
    )))
  );

  const scores = h('table', {},
    h('thead', {}, h('tr', {},
      h('th', { class: 'no-sort' }, 'Association'),
      h('th', { class: 'num no-sort' }, 'Weight'),
      h('th', { class: 'num no-sort' }, metricLabel('google_retrieval_score'))
    )),
    h('tbody', {}, overlay.scores.map((s) => h('tr', {},
      h('td', {}, h('a', { href: `#/associations/${s.association_id}` }, s.label)),
      h('td', { class: 'num dim' }, s.weight.toFixed(2)),
      h('td', { class: 'num' },
        scoreWithBasis('google_retrieval_score', s.google_retrieval_score, { results: s.results ?? 0, total: firstPage }, { compact: true }))
    )))
  );

  const gapRows = gap
    ? h('table', {},
        h('thead', {}, h('tr', {},
          h('th', { class: 'no-sort' }, 'Association'),
          h('th', { class: 'num no-sort' }, metricLabel('current_pias')),
          h('th', { class: 'num no-sort' }, metricLabel('historical_pias')),
          h('th', { class: 'num no-sort' }, metricLabel('current_corpus_share')),
          h('th', { class: 'num no-sort' }, metricLabel('google_retrieval_score')),
          h('th', { class: 'num no-sort' }, metricLabel('retrieval_gap'))
        )),
        h('tbody', {}, gap.rows.map((r) => h('tr', {},
          h('td', {}, h('a', { href: `#/associations/${r.association_id}` }, r.label)),
          h('td', { class: 'num' }, scoreWithBasis('current_pias', r.current_pias, { documents: r.current_documents }, { compact: true })),
          h('td', { class: 'num dim' }, scoreWithBasis('historical_pias', r.historical_pias, { documents: olderDocuments(r) }, { compact: true })),
          h('td', { class: 'num' }, fmt.pctRaw(r.current_corpus_share_pct, 1),
            h('div', { class: 'small dim' }, `of ${fmt.n(r.current_documents)} recent ${pages} carry it`)),
          h('td', { class: 'num' },
            scoreWithBasis('google_retrieval_score', r.google_retrieval_score, { results: r.google_results ?? 0, total: firstPage }, { compact: true })),
          h('td', { class: `num ${r.gap > 0 ? 'sentiment negative' : 'sentiment positive'}` },
            `${r.gap > 0 ? '+' : ''}${r.gap}`)
        )))
      )
    : null;

  // Prefer the superseded-state case (§77) over any merely over-represented
  // association: a strong current association ranking well is not a finding.
  const finding = gap?.historically_anchored?.[0] ?? gap?.overweighted_by_google?.[0];

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {},
        h('h1', {}, 'Google overlay'),
        h('div', { class: 'sub' },
          `"${overlay.snapshot.query}" · ${fmt.date(overlay.snapshot.captured_at)} · top ${overlay.snapshot.depth} · ${fmt.pct(overlay.unclassified_share)} of first-page weight unclassified`)
      ),
      capture
    ),
    disclaimer(),
    finding
      ? h('div', { class: 'panel' },
          h('h2', {}, 'The finding (§77)'),
          h('div', { class: 'panel-body narrative' },
            h('p', {},
              'Google’s first page shows ', h('strong', {}, finding.label),
              ' more than the recent web carries it: ', term('google_retrieval_score'),
              ` ${fmt.score(finding.google_retrieval_score)}, from ${fmt.n(finding.google_results ?? 0)} of ${fmt.n(firstPage)} first-page results, against ${finding.current_corpus_share_pct}% of ${fmt.n(finding.current_documents)} recent ${pages} (`,
              term('current_corpus_share'), ')',
              finding.historical_pias > finding.current_pias
                ? h('span', {}, ', and it is weaker now (', term('current_pias'), ` ${fmt.score(finding.current_pias)}) than it was (`,
                    term('historical_pias'), ` ${fmt.score(finding.historical_pias)}).`)
                : '.'),
            h('p', { class: 'small dim', style: { marginBottom: 0 } },
              'A positive gap means Google’s results may still reflect an older picture the current web has moved on from. That is the situation this product exists to detect — it is not a prediction that anything will change.')
          )
        )
      : null,
    googleTracePanel(params.id),
    h('div', { class: 'split-2' },
      h('div', { class: 'panel' },
        h('h2', {}, metricLabel('google_retrieval_score')),
        h('div', { class: 'panel-body tight' }, scores,
          h('p', { class: 'small dim', style: { padding: '0 0.7rem 0.7rem', margin: 0 } }, METRICS.google_retrieval_score.caveat ?? ''))),
      h('div', { class: 'panel' }, h('h2', {}, 'Recent web vs Google (§14, §77)'), h('div', { class: 'panel-body tight' }, gapRows ?? h('div', { class: 'empty' }, 'No comparison available.')))
    ),
    h('div', { class: 'panel' },
      h('h2', {}, 'Ranking URLs and the associations they support (§52)'),
      h('div', { class: 'panel-body tight' }, results)
    )
  );
}
