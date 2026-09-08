import { h, api, fmt, sortableTable, disclaimer, toast, navigate } from '../app.js';

/**
 * §48 — the evidence explorer.
 *
 * Every column the brief asks for, plus the six factors that multiply into the
 * weighted score, because the screen exists so a number can be taken apart.
 */
export async function evidenceView({ params }) {
  const data = await api(`/api/associations/${params.id}/evidence?include_excluded=1`);
  const { association, evidence, surface_forms: surfaceForms } = data;

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
    { key: 'source', label: 'Source', render: (r) => h('div', {},
        h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.source),
        r.source_classification ? h('div', { class: 'small dim' }, r.source_classification) : null) },
    { key: 'evidence_text', label: 'Evidence', sortable: false, render: (r) => h('div', { class: 'evidence-text' }, r.evidence_text) },
    { key: 'relationship', label: 'Relation', render: (r) => h('span', { class: 'small mono' }, r.relationship) },
    { key: 'source_reliability', label: 'Source rel.', num: true, title: 'External Source Reliability Proxy (§26) — not Domain Authority', render: (r) => fmt.score(r.source_reliability * 100) },
    { key: 'relationship_confidence', label: 'Rel. conf.', num: true, render: (r) => r.relationship_confidence?.toFixed(2) },
    { key: 'proximity', label: 'Proximity', num: true, title: 'Token distance blended with grammatical boundary (§25)',
      render: (r) => h('span', { title: `${r.token_distance ?? '?'} tokens, ${r.boundary ?? '?'}` }, r.proximity?.toFixed(2)) },
    { key: 'independence_weight', label: 'Independence', num: true, title: '§22 — duplicates and same-domain repeats are discounted here',
      render: (r) => h('span', { class: r.independence_weight < 1 ? 'dup' : '' }, r.independence_weight?.toFixed(2)) },
    { key: 'recency_weight', label: 'Recency', num: true, render: (r) => r.recency_weight?.toFixed(2) },
    { key: 'duplicate_cluster_id', label: 'Duplicate', render: (r) => r.duplicate_cluster_id
        ? h('span', { class: 'chip warn', title: `${r.duplicate_kind} cluster of ${r.cluster_size}` },
            `${r.is_cluster_primary ? 'original' : r.duplicate_kind} (${r.cluster_size})`)
        : h('span', { class: 'dim' }, '—') },
    { key: 'sentiment', label: 'Sentiment', render: (r) => h('span', { class: `sentiment ${r.sentiment}` }, r.sentiment) },
    { key: 'weighted_evidence_score', label: 'Weighted', num: true, title: '§31 — the product of all six factors',
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
    h('div', { class: 'page-head' },
      h('div', {},
        h('h1', {}, association.canonical_label),
        h('div', { class: 'sub' },
          h('span', { class: `chip kind-${association.kind}` }, association.kind === 'named_entity' ? 'named entity' : 'concept'), ' ',
          h('span', { class: 'chip' }, association.category), ' ',
          `${active.length} contributing evidence rows`, excluded.length ? ` · ${excluded.length} excluded` : '')
      ),
      h('div', { class: 'toolbar' },
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
    h('div', { class: 'panel' },
      h('h2', {}, 'Supporting evidence'),
      h('div', { class: 'panel-body tight' },
        evidence.length
          ? sortableTable(columns, evidence, { initialSort: 'weighted_evidence_score' })
          : h('div', { class: 'empty' }, 'No evidence rows.')
      )
    )
  );
}
