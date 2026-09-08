import { h, api, fmt, disclaimer, toast, colourFor } from '../app.js';

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
        toast('SERP captured', 'success');
        location.reload();
      } catch (err) {
        toast(err.message, 'error');
        capture.disabled = false;
        capture.textContent = 'Capture SERP now';
      }
    },
  }, 'Capture SERP now');

  if (!data.overlay) {
    return h('div', {},
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Google overlay'))),
      disclaimer(),
      h('div', { class: 'panel' }, h('div', { class: 'empty' },
        h('p', {}, data.note ?? 'No SERP snapshot yet.'),
        h('p', { class: 'small dim' }, 'This costs one DataForSEO SERP call.'),
        capture
      ))
    );
  }

  const { overlay, gap } = data;

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
      h('th', { class: 'num no-sort' }, 'GRS')
    )),
    h('tbody', {}, overlay.scores.map((s) => h('tr', {},
      h('td', {}, h('a', { href: `#/associations/${s.association_id}` }, s.label)),
      h('td', { class: 'num dim' }, s.weight.toFixed(2)),
      h('td', { class: 'num score-cell' }, fmt.score(s.google_retrieval_score))
    )))
  );

  const gapRows = gap
    ? h('table', {},
        h('thead', {}, h('tr', {},
          h('th', { class: 'no-sort' }, 'Association'),
          h('th', { class: 'num no-sort', title: 'Current Entity Score' }, 'CES'),
          h('th', { class: 'num no-sort', title: 'Historical Association Score' }, 'HAS'),
          h('th', { class: 'num no-sort', title: 'Share of the entity’s current association evidence mass' }, 'Current corpus'),
          h('th', { class: 'num no-sort', title: 'Share of the classified first page' }, 'Google'),
          h('th', { class: 'num no-sort', title: 'Google minus corpus. Positive: Google surfaces more of this than the current web carries.' }, 'Gap')
        )),
        h('tbody', {}, gap.rows.map((r) => h('tr', {},
          h('td', {}, h('a', { href: `#/associations/${r.association_id}` }, r.label)),
          h('td', { class: 'num' }, fmt.score(r.current_pias)),
          h('td', { class: 'num dim' }, fmt.score(r.historical_pias)),
          h('td', { class: 'num' }, fmt.pctRaw(r.current_association_share_pct, 1)),
          h('td', { class: 'num' }, fmt.pctRaw(r.google_retrieval_score, 1)),
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
              `Google's first page overweights `, h('strong', {}, finding.label),
              ` relative to the current corpus: it accounts for ${finding.google_retrieval_score}% of the classified first-page weight against ${finding.current_association_share_pct}% of the entity's current association mass`,
              finding.historical_pias > finding.current_pias
                ? `, and this association is weaker now (${finding.current_pias}) than it was historically (${finding.historical_pias}).`
                : '.'),
            h('p', { class: 'small dim', style: { marginBottom: 0 } },
              'A positive gap means Google’s results may still reflect a historical entity state the current web has moved on from. That is the situation this product exists to detect — it is not a prediction that anything will change.')
          )
        )
      : null,
    h('div', { class: 'split-2' },
      h('div', { class: 'panel' }, h('h2', {}, 'Google Retrieval Score (§53)'), h('div', { class: 'panel-body tight' }, scores)),
      h('div', { class: 'panel' }, h('h2', {}, 'Corpus vs Google (§14, §77)'), h('div', { class: 'panel-body tight' }, gapRows ?? h('div', { class: 'empty' }, 'No comparison available.')))
    ),
    h('div', { class: 'panel' },
      h('h2', {}, 'Ranking URLs and the associations they support (§52)'),
      h('div', { class: 'panel-body tight' }, results)
    )
  );
}
