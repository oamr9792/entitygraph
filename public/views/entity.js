import { h, api, fmt, sortableTable, disclaimer, navigate, sentimentClass, buildStatus, clear } from '../app.js';

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

/**
 * Shown in place of the dashboard when there is nothing to draw.
 *
 * The failure mode this exists for: a build runs all twelve steps, retrieves
 * a corpus, rejects every document as the wrong person, and reports success.
 * The money is spent, the screen is blank, and nothing anywhere says why.
 */
function diagnosisPanel(entityId) {
  const body = h('div', { class: 'panel-body' }, h('div', { class: 'dim small' }, 'Checking what the last build did…'));
  const panel = h('div', { class: 'panel' }, h('h2', {}, 'Nothing to show — here is why'), body);

  const REMEDIES = {
    identity: ['Identity profile', `#/entities/${entityId}/identity`],
    review: ['Review queue', `#/entities/${entityId}/review`],
    settings: ['Settings & model', '#/settings'],
  };

  api(`/api/entities/${entityId}/diagnosis`)
    .then((d) => {
      clear(body);
      body.append(h('p', { class: 'diagnosis-headline' }, d.headline));
      if (d.detail) body.append(h('p', { class: 'diagnosis-detail' }, d.detail));

      // The counts matter here: "244 retrieved, 0 accepted" is a different
      // problem from "0 retrieved", and the numbers distinguish them faster
      // than any prose can.
      if (d.counts) {
        body.append(h('div', { class: 'diagnosis-counts' },
          [
            ['documents retrieved', d.counts.documents],
            ['accepted as this entity', d.counts.accepted],
            ['awaiting review', d.counts.review],
            ['rejected as someone else', d.counts.rejected],
            ['evidence rows', d.counts.evidence],
            ['active associations', d.counts.associations],
          ].map(([label, value]) =>
            h('div', { class: `count ${value ? '' : 'zero'}` },
              h('span', { class: 'n' }, fmt.n(value)),
              h('span', { class: 'l' }, label))
          )
        ));
      }

      if (d.spend?.calls) {
        body.append(h('p', { class: 'small dim' },
          `${fmt.n(d.spend.calls)} provider calls, $${(d.spend.usd ?? 0).toFixed(4)} spent on this entity` +
          (d.spend.failures ? `, ${d.spend.failures} failed` : '')));
      }

      const actions = h('div', { class: 'toolbar' });
      if (d.remedy && REMEDIES[d.remedy]) {
        const [label, href] = REMEDIES[d.remedy];
        actions.append(h('button', { class: 'primary', onclick: () => navigate(href) }, label));
      }
      actions.append(h('button', { onclick: () => navigate(`#/entities/${entityId}/jobs`) }, 'Jobs & cost'));
      body.append(actions);

      if (d.steps?.length) {
        body.append(h('details', { class: 'diagnosis-steps' },
          h('summary', {}, 'What each step reported'),
          h('div', { class: 'progress' }, d.steps.map((s) =>
            h('div', { class: `step ${s.status}` },
              h('span', { class: 'mark' }, s.status === 'done' ? '✓' : s.status === 'skipped' ? '–' : '…'),
              h('span', { style: { minWidth: '14rem' } }, s.step.replace(/_/g, ' ')),
              h('span', { class: 'detail' }, s.detail ?? '')
            )
          ))
        ));
      }
    })
    .catch((err) => {
      clear(body).append(h('div', { class: 'empty' }, `Could not read the build log: ${err.message}`));
    });

  return panel;
}

/** §44/§45 — the dashboard. */
export async function dashboardView({ params, query }) {
  const search = new URLSearchParams();
  if (query.get('window')) search.set('window', query.get('window'));
  if (query.get('half_life')) search.set('half_life', query.get('half_life'));
  const data = await api(`/api/entities/${params.id}/dashboard?${search}`);
  const { state, leaderboard: board, coverage, narrative, alerts } = data;

  if (!board?.associations?.length) {
    // An empty dashboard is the moment someone most needs an explanation and
    // is least likely to get one — a build can complete every step, spend the
    // corpus budget, and produce nothing. The diagnosis panel reads what the
    // last job actually reported and says where the pipeline ran dry.
    return h('div', {},
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, board?.entity?.canonical_name ?? 'Entity'))),
      buildStatus(params.id),
      diagnosisPanel(params.id)
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
    // Its own module, loaded after the page renders, so a slow Google snapshot
    // never holds up the leaderboard.
    (() => {
      const slot = h('div', {});
      import('./google.js').then((m) => slot.append(m.googlePanel(params.id))).catch(() => {});
      return slot;
    })(),
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
