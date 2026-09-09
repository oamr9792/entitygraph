import { h, api, fmt, sortableTable, disclaimer, navigate, sentimentClass, buildStatus } from '../app.js';

/** §49 — the global time control, shared by every screen that takes a window. */
export function timeControl(query, { extra = null } = {}) {
  const current = query.get('window') ?? 'all';
  const halfLife = query.get('half_life') ?? '365';
  const go = (params) => {
    const next = new URLSearchParams(query);
    for (const [k, v] of Object.entries(params)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    navigate(`#${location.hash.replace(/^#/, '').split('?')[0]}?${next}`);
  };

  const options = [
    ['all', 'All time'], ['1825', '5 years'], ['730', '2 years'],
    ['365', '12 months'], ['182', '6 months'], ['90', '90 days'],
  ];

  return h('div', { class: 'toolbar' },
    h('div', { class: 'segmented' }, options.map(([value, label]) =>
      h('button', {
        class: current === value ? 'active' : '',
        onclick: () => go({ window: value === 'all' ? null : value }),
      }, label)
    )),
    h('span', { class: 'small dim' }, 'Half-life'),
    h('div', { class: 'segmented' }, [['180', '180d'], ['365', '365d'], ['730', '730d']].map(([value, label]) =>
      h('button', {
        class: halfLife === value ? 'active' : '',
        title: 'Recency decay half-life (§30). A modelling parameter, not a Google curve.',
        onclick: () => go({ half_life: value }),
      }, label)
    )),
    h('span', { class: 'spacer' }),
    extra
  );
}

const arrow = (m) => h('span', { class: `trend ${m.bucket}`, title: `${m.label} (${fmt.change(m.basis)})` }, m.arrow);

/** §44/§45 — the dashboard. */
export async function dashboardView({ params, query }) {
  const search = new URLSearchParams();
  if (query.get('window')) search.set('window', query.get('window'));
  if (query.get('half_life')) search.set('half_life', query.get('half_life'));
  const data = await api(`/api/entities/${params.id}/dashboard?${search}`);
  const { state, leaderboard: board, coverage, narrative, alerts } = data;

  if (!board?.associations?.length) {
    // The status strip carries the reason: a build in progress, or the error
    // that stopped one. An empty dashboard with no explanation is the thing
    // that makes a failed build look like a slow one.
    return h('div', {},
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, board?.entity?.canonical_name ?? 'Entity'))),
      buildStatus(params.id),
      h('div', { class: 'panel' }, h('div', { class: 'empty' },
        h('p', {}, 'No associations yet. If no build is running above, start one — or open the job log to see what the last one did.'),
        h('button', { onclick: () => navigate(`#/entities/${params.id}/jobs`) }, 'Jobs & cost')
      ))
    );
  }

  const stat = (label, value, note = null, score = false) =>
    h('div', { class: 'stat' },
      h('div', { class: 'label' }, label),
      h('div', { class: 'value' }, value ?? '—'),
      note ? h('div', { class: 'note' }, note) : null
    );

  const stateRow = h('div', { class: 'grid cols-5' },
    stat('Historical dominant', state?.historical_dominant?.label, `HAS ${fmt.score(state?.historical_dominant?.score)}`),
    stat('Current dominant', state?.current_dominant?.label, `CES ${fmt.score(state?.current_dominant?.score)}`),
    stat('Fastest growing', state?.fastest_growing?.label, `${state?.fastest_growing?.change ?? ''} ${state?.fastest_growing?.arrow ?? ''}`),
    stat('Most recent', state?.most_recent?.label, state?.most_recent?.age ? `${state.most_recent.age} ago` : null),
    stat('Current-state change',
      state?.state_change ? `${state.state_change.points > 0 ? '+' : ''}${state.state_change.points} pts` : '—',
      state?.state_change ? `${state.state_change.association} since ${fmt.date(state.state_change.since)}` : 'needs an earlier snapshot')
  );

  const columns = [
    {
      key: 'label', label: 'Association',
      render: (r) => h('div', {},
        h('a', { href: `#/associations/${r.association_id}` }, r.label), ' ',
        h('span', { class: `chip kind-${r.kind}` }, r.kind === 'named_entity' ? 'entity' : 'concept'),
        r.is_identity_marker ? h('span', { class: 'chip marker', title: 'This is one of the entity’s identity markers, so it co-occurs by construction.' }, ' identity') : null
      ),
    },
    { key: 'category', label: 'Category', render: (r) => h('span', { class: 'dim small' }, r.category) },
    {
      key: 'pias', label: 'PIAS', num: true, title: 'Patent-Inspired Association Score, lifetime (§33)',
      render: (r) => h('span', { class: 'score-cell' }, fmt.score(r.pias)),
    },
    {
      key: 'current_pias', label: 'Current', num: true, title: 'Current Entity Score — same model, current window only (§39)',
      render: (r) => h('span', { class: 'score-cell' }, fmt.score(r.current_pias)),
    },
    {
      key: 'historical_pias', label: 'Historical', num: true, title: 'Historical Association Score — evidence older than the current window',
      render: (r) => h('span', { class: 'score-cell dim' }, fmt.score(r.historical_pias)),
    },
    { key: 'documents', label: 'Docs', num: true, render: (r) => fmt.n(r.documents) },
    { key: 'domains', label: 'Domains', num: true, render: (r) => fmt.n(r.domains) },
    {
      key: 'independent_sources', label: 'Ind. sources', num: true,
      title: 'Documents after duplicate and syndication adjustment (§22, §23)',
      render: (r) => fmt.score(r.independent_sources),
    },
    {
      key: 'current_corpus_share', label: 'Current share', num: true,
      title: 'Share of current-window documents about this entity that carry this association (§37, §39)',
      render: (r) => fmt.pct(r.current_corpus_share),
    },
    {
      key: 'median_age', label: 'Median age', num: true, sortValue: (r) => r.freshness.median_age_days,
      render: (r) => h('span', { class: 'dim' }, r.freshness.median_age ?? '—'),
    },
    {
      key: 'momentum', label: 'Momentum', num: true, sortValue: (r) => r.momentum.basis ?? -99,
      title: 'Share-adjusted change over the last period versus the one before (§40, §41)',
      render: (r) => arrow(r.momentum),
    },
    {
      key: 'sentiment', label: 'Sentiment', sortValue: (r) => r.sentiment.label,
      title: 'Reported beside strength, never inside it (§43)',
      render: (r) => h('span', { class: `sentiment ${r.sentiment.label}` }, r.sentiment.label),
    },
    {
      key: 'google_retrieval_score', label: 'Google', num: true,
      title: 'Google Retrieval Score — share of classified first-page weight (§53). Not an internal Google metric.',
      render: (r) => (r.google_retrieval_score === null ? h('span', { class: 'dim' }, '—') : fmt.score(r.google_retrieval_score)),
    },
  ];

  const table = sortableTable(columns, board.associations, { initialSort: 'pias' });

  const coveragePanel = h('div', { class: 'panel' },
    h('h2', {}, 'Coverage confidence', h('span', { class: `level ${coverage.level}` }, coverage.level)),
    h('div', { class: 'panel-body' },
      h('ul', { class: 'criteria' }, coverage.criteria.map((c) =>
        h('li', {},
          h('span', { class: `dot ${c.met ? 'met' : c.partial ? 'partial' : 'unmet'}` }, c.met ? '●' : c.partial ? '◐' : '○'),
          h('span', {}, h('span', { class: 'muted' }, `${c.key.replace(/_/g, ' ')}: `), c.detail)
        )
      )),
      coverage.warnings.length ? h('ul', { class: 'warnings' }, coverage.warnings.map((w) => h('li', {}, w))) : null
    )
  );

  const narrativePanel = h('div', { class: 'panel' },
    h('h2', {}, 'Summary'),
    h('div', { class: 'panel-body narrative' },
      narrative ? narrative.sentences.map((s) => h('p', {}, s)) : h('p', { class: 'dim' }, 'Not enough data to summarise.')
    )
  );

  const alertsPanel = alerts?.length
    ? h('div', { class: 'panel' },
        h('h2', {}, `Alerts (${alerts.length})`),
        h('div', { class: 'panel-body' }, alerts.map((a) =>
          h('div', { style: { marginBottom: '0.6rem' } },
            h('span', { class: `chip ${a.severity === 'critical' ? 'bad' : a.severity === 'warning' ? 'warn' : ''}` }, a.kind.replace(/_/g, ' ')),
            ' ', a.headline,
            a.detail ? h('div', { class: 'small dim' }, a.detail) : null
          )
        ))
      )
    : null;

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {},
        h('h1', {}, board.entity.canonical_name),
        h('div', { class: 'sub' },
          `${fmt.n(board.entity_documents)} accepted documents · ${fmt.n(board.current_entity_documents)} in the current ${Math.round(board.current_window_days / 30.44)} months · half-life ${board.half_life_days}d`)
      ),
      h('div', { class: 'toolbar' },
        h('a', { class: 'btn', href: `/api/entities/${params.id}/leaderboard?format=csv${query.get('window') ? `&window=${query.get('window')}` : ''}` }, 'Export CSV'),
        h('button', { onclick: () => navigate(`#/entities/${params.id}/jobs`) }, 'Rebuild')
      )
    ),
    buildStatus(params.id),
    disclaimer(data.disclaimer),
    stateRow,
    h('div', { style: { height: '1.1rem' } }),
    timeControl(query),
    h('div', { class: 'panel' },
      h('h2', {}, 'Association leaderboard', h('span', { class: 'small dim' }, 'click any column to sort')),
      h('div', { class: 'panel-body tight' }, table)
    ),
    alertsPanel,
    h('div', { class: 'grid cols-2' }, narrativePanel, coveragePanel)
  );
}
