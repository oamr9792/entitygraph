import { h, api, fmt, sortableTable, disclaimer, toast, navigate, clear } from '../app.js';
import { DISCLAIMERS } from '../lib/metrics-ui.js';
import { weakStatesBanner } from '../lib/weak-states.js';
import { polarityControl } from './audit.js';

/**
 * §48 — the evidence explorer.
 *
 * Every column the brief asks for, plus the six factors that multiply into the
 * weighted score, because the screen exists so a number can be taken apart.
 */
/**
 * §17 — what this association travels with.
 *
 * Loaded after the page renders rather than blocking it, because the evidence
 * table is what someone came for and this is the follow-up question.
 *
 * The column that earns its place is "% of these" — the share of *this*
 * association's documents that also carry the other one. When that is high and
 * the reverse is low, the association is riding on something else, and going
 * after it directly will not work.
 */
function relatedPanel(associationId) {
  const body = h('div', { class: 'panel-body' }, h('div', { class: 'dim small' }, 'Loading…'));
  const panel = h('div', { class: 'panel' },
    h('h2', {}, 'What this travels with',
      h('span', { class: 'small dim' }, 'co-occurrence inside this entity’s corpus')),
    body
  );

  api(`/api/associations/${associationId}/related?limit=20`)
    .then((data) => {
      clear(body);
      if (!data.related.length && !data.disjoint.length) {
        body.append(h('div', { class: 'empty' }, 'No association shares enough documents with this one to report.'));
        return;
      }

      body.append(h('p', { class: 'interpretation' }, data.interpretation));

      if (data.related.length) {
        body.append(sortableTable(
          [
            {
              key: 'label', label: 'Association',
              render: (r) => h('div', {},
                h('a', { href: `#/associations/${r.association_id}` }, r.label), ' ',
                r.carries_this
                  ? h('span', {
                      class: `chip ${r.mutual ? 'warn' : 'bad'}`,
                      title: r.mutual
                        ? 'Each rarely appears without the other — one story, not an inherited association.'
                        : 'This association rarely appears without that one, but not the reverse: it is carried by it.',
                    }, r.mutual ? 'paired' : 'carries this')
                  : null
              ),
            },
            { key: 'shared', metric: 'shared_documents', num: true },
            { key: 'share_of_this', metric: 'share_of_this', num: true, render: (r) => fmt.pct(r.share_of_this) },
            { key: 'share_of_other', metric: 'share_of_other', num: true, render: (r) => fmt.pct(r.share_of_other) },
            {
              key: 'lift', metric: 'lift', num: true,
              render: (r) => h('span', { class: r.lift >= 3 ? 'score-cell' : 'dim' }, r.lift.toFixed(1)),
            },
            { key: 'documents', metric: 'documents', num: true, render: (r) => fmt.n(r.documents) },
          ],
          data.related,
          { initialSort: 'shared' }
        ));
      }

      if (data.disjoint.length) {
        body.append(
          h('div', { class: 'disjoint' },
            h('div', { class: 'small muted' },
              'Shares no document with — separate populations in the corpus, not one connected account:'),
            data.disjoint.map((d) => h('a', {
              class: 'chip',
              href: `#/associations/${d.association_id}`,
              style: { marginRight: '0.35rem' },
            }, `${d.label} · ${d.documents}`))
          )
        );
      }
    })
    .catch((err) => {
      clear(body).append(h('div', { class: 'empty' }, `Could not load related associations: ${err.message}`));
    });

  return panel;
}

export async function evidenceView({ params, query }) {
  const data = await api(`/api/associations/${params.id}/evidence?include_excluded=1`);
  const { association, surface_forms: surfaceForms } = data;
  // Pages Google shows for the name are what searchers read, so they can be
  // looked at on their own.
  const onGoogle = data.evidence.filter((e) => e.google_rank);
  const googleOnly = query.get('google') === '1';
  const evidence = googleOnly ? onGoogle : data.evidence;

  const act = async (payload, message) => {
    try {
      await api('/api/review', { method: 'POST', body: { entity_id: association.entity_id, ...payload } });
      toast(message, 'success');
      navigate(location.hash); // re-render with fresh scores
      location.reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const columns = [
    { key: 'date', label: 'Date', render: (r) => h('span', { title: r.date_is_inferred ? 'Date inferred from the provider’s group date, not stated by the publisher' : '' },
        fmt.date(r.date), r.date_is_inferred ? h('span', { class: 'dim' }, '*') : null) },
    { key: 'google_rank', metric: 'google_position', num: true, sortValue: (r) => r.google_rank ?? null,
      render: (r) => (r.google_rank ? h('span', { class: 'score-cell' }, `#${r.google_rank}`) : h('span', { class: 'dim' }, '—')) },
    { key: 'source', label: 'Source', render: (r) => h('div', {},
        h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.source),
        r.source_classification ? h('div', { class: 'small dim' }, r.source_classification) : null) },
    { key: 'evidence_text', label: 'Evidence', sortable: false, render: (r) => h('div', { class: 'evidence-text' }, r.evidence_text) },
    { key: 'relationship', label: 'Relation', render: (r) => h('span', { class: 'small mono' }, r.relationship) },
    { key: 'entity_confidence', metric: 'entity_confidence', num: true, render: (r) => r.entity_confidence?.toFixed(2) },
    { key: 'source_reliability', metric: 'source_reliability', num: true, render: (r) => fmt.score(r.source_reliability * 100) },
    { key: 'relationship_confidence', metric: 'relationship_confidence', num: true, render: (r) => r.relationship_confidence?.toFixed(2) },
    { key: 'proximity', metric: 'proximity', num: true,
      render: (r) => h('span', { title: `${r.token_distance ?? '?'} tokens, ${r.boundary ?? '?'}` }, r.proximity?.toFixed(2)) },
    { key: 'independence_weight', metric: 'independence_weight', num: true,
      render: (r) => h('span', { class: r.independence_weight < 1 ? 'dup' : '' }, r.independence_weight?.toFixed(2)) },
    { key: 'recency_weight', metric: 'recency_weight', num: true, render: (r) => r.recency_weight?.toFixed(2) },
    { key: 'duplicate_cluster_id', metric: 'duplicate_cluster', render: (r) => r.duplicate_cluster_id
        ? h('span', { class: 'chip warn', title: `${r.duplicate_kind} cluster of ${r.cluster_size}` },
            `${r.is_cluster_primary ? 'original' : r.duplicate_kind} (${r.cluster_size})`)
        : h('span', { class: 'dim' }, '—') },
    { key: 'sentiment', metric: 'sentiment', render: (r) => h('span', { class: `sentiment ${r.sentiment}` }, r.sentiment) },
    // §97: which extractor produced a row is stamped on the row, in both modes.
    { key: 'extractor', metric: 'extractor', render: (r) => h('span', {
        class: `extractor-stamp ${r.extractor === 'heuristic' ? 'heuristic' : ''}`.trim(),
      }, r.extractor ?? 'unknown') },
    { key: 'weighted_evidence_score', metric: 'evidence_score', num: true,
      render: (r) => h('span', { class: 'score-cell' }, r.weighted_evidence_score?.toFixed(3)) },
    { key: 'actions', label: '', sortable: false, render: (r) => h('div', { class: 'toolbar', style: { margin: 0, gap: '0.25rem' } },
        r.excluded
          ? h('button', { class: 'small', onclick: () => act({ action: 'include_evidence', evidence_id: r.evidence_id }, 'Included') }, 'include')
          : h('button', { class: 'small', onclick: () => act({ action: 'exclude_evidence', evidence_id: r.evidence_id }, 'Excluded') }, 'exclude'),
        h('button', { class: 'small danger', title: 'Mark this document as a different entity',
          onclick: () => act({ action: 'wrong_entity', document_id: r.document_id }, 'Marked as the wrong entity') }, 'wrong person'),
        h('button', { class: 'small', title: 'Exclude every document from this domain',
          onclick: () => act({ action: 'exclude_source', root_domain: r.source }, `Excluded ${r.source}`) }, 'drop source')
      ) },
  ];

  const active = evidence.filter((e) => !e.excluded);
  const excluded = evidence.filter((e) => e.excluded);

  return h('div', {},
    weakStatesBanner(association.entity_id),
    h('div', { class: 'page-head' },
      h('div', {},
        h('h1', {}, association.canonical_label),
        h('div', { class: 'sub' },
          h('span', { class: `chip kind-${association.kind}` }, association.kind === 'named_entity' ? 'named entity' : 'concept'), ' ',
          h('span', { class: 'chip' }, association.category), ' ',
          `${active.length} contributing evidence rows`, excluded.length ? ` · ${excluded.length} excluded` : '')
      ),
      h('div', { class: 'toolbar' },
        h('button', { class: 'primary', onclick: () => navigate(`#/associations/${association.id}/plan`) }, 'Action plan'),
        h('button', { onclick: () => navigate(`#/associations/${association.id}/content`) }, 'Build content'),
        polarityControl(association.id),
        h('a', { class: 'btn', href: `/api/associations/${association.id}/evidence?format=csv` }, 'Export CSV'),
        h('button', { onclick: () => navigate(`#/entities/${association.entity_id}`) }, 'Back to dashboard')
      )
    ),
    disclaimer(data.disclaimer),
    surfaceForms?.length
      ? h('div', { class: 'panel' },
          h('h2', {}, 'Surface forms found in the corpus (§19)'),
          h('div', { class: 'panel-body' },
            surfaceForms.map((s) => h('span', { class: 'chip', style: { marginRight: '0.35rem' } }, `${s.surface_form} · ${s.occurrences}`)),
            h('p', { class: 'small dim', style: { marginBottom: 0, marginTop: '0.6rem' } },
              'Surface forms are kept after clustering. If one of these does not belong, split it out from the review screen.')
          )
        )
      : null,
    relatedPanel(params.id),
    h('div', { class: 'panel' },
      h('h2', {}, 'Supporting evidence',
        h('span', { class: 'small dim' }, `${onGoogle.length} of ${data.evidence.length} rows are from pages Google shows for the name`)),
      h('div', { class: 'toolbar', style: { padding: '0.6rem 0.95rem 0', marginBottom: '0.3rem' } },
        h('div', { class: 'segmented' },
          h('button', { class: googleOnly ? '' : 'active', onclick: () => navigate(`#/associations/${params.id}`) }, 'All pages'),
          h('button', { class: googleOnly ? 'active' : '', onclick: () => navigate(`#/associations/${params.id}?google=1`) }, 'Only pages on Google'))),
      h('div', { class: 'panel-body tight' },
        evidence.length
          ? sortableTable(columns, evidence, { initialSort: 'weighted_evidence_score' })
          : h('div', { class: 'empty' }, 'No evidence rows.'),
        h('p', { class: 'small dim', style: { padding: '0 0.7rem 0.7rem', margin: 0 } }, DISCLAIMERS.source_reliability)
      )
    )
  );
}
