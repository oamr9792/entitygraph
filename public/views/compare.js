import { h, api, fmt, disclaimer, navigate } from '../app.js';
import { metricLabel, scoreWithBasis, labelText } from '../lib/metrics-ui.js';

/** §50 — historical state beside current state, split at a chosen date. */
export async function oldVsCurrentView({ params, query }) {
  const cutoff = query.get('cutoff') ?? '';
  const data = await api(`/api/entities/${params.id}/old-vs-current${cutoff ? `?cutoff=${cutoff}` : ''}`);
  const pages = labelText('documents').toLowerCase();

  const input = h('input', { type: 'date', value: (data.cutoff ?? '').slice(0, 10), style: { width: '11rem' } });
  const column = (title, key, rows) => h('div', { class: 'panel' },
    h('h2', {}, title, h('span', { class: 'small dim' }, ' ', metricLabel(key))),
    h('div', { class: 'panel-body tight' },
      rows.length
        ? h('table', {}, h('tbody', {}, rows.map((r) => h('tr', {},
            h('td', {}, h('a', { href: `#/associations/${r.association_id}` }, r.label)),
            h('td', { class: 'num' }, scoreWithBasis(key, r.score, { documents: r.documents }))
          ))))
        : h('div', { class: 'empty' }, 'Nothing in this window.')
    )
  );

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Old vs current'),
        h('div', { class: 'sub' }, 'The same corpus, split at a date. The evidence did not change — the window did.'))
    ),
    disclaimer(),
    h('div', { class: 'toolbar' },
      h('span', { class: 'small muted' }, 'Cutoff'),
      input,
      h('button', { onclick: () => navigate(`#/entities/${params.id}/old-vs-current?cutoff=${input.value}`) }, 'Apply'),
      h('span', { class: 'small dim' }, `${fmt.n(data.historical_documents)} ${pages} before · ${fmt.n(data.current_documents)} after`)
    ),
    h('div', { class: 'split-2' },
      column('Historical entity state', 'historical_pias', data.historical),
      column('Current entity state', 'current_pias', data.current)
    ),
    data.replaced?.length || data.emerged?.length
      ? h('div', { class: 'panel' },
          h('h2', {}, 'What changed'),
          h('div', { class: 'panel-body' },
            data.replaced?.length
              ? h('p', {}, h('strong', {}, 'Present historically, absent now: '), data.replaced.map((r) => r.label).join(', '))
              : null,
            data.emerged?.length
              ? h('p', { style: { marginBottom: 0 } }, h('strong', {}, 'New in the current window: '), data.emerged.map((r) => r.label).join(', '))
              : null
          )
        )
      : null
  );
}

/** §51 — the association competition view. */
export async function compareView({ params, query }) {
  const board = await api(`/api/entities/${params.id}/leaderboard`);
  const selected = (query.get('associations') ?? '').split(',').filter(Boolean);

  const pick = (index) => h('select', {
    onchange: (e) => {
      const next = [...selected];
      next[index] = e.target.value;
      navigate(`#/entities/${params.id}/compare?associations=${next.filter(Boolean).join(',')}`);
    },
  },
    h('option', { value: '' }, '— select —'),
    board.associations.map((a) => h('option', {
      value: String(a.association_id),
      selected: selected[index] === String(a.association_id) ? 'selected' : null,
    }, a.label))
  );

  const controls = h('div', { class: 'toolbar' }, pick(0), h('span', { class: 'muted' }, 'vs'), pick(1));

  if (selected.length < 2) {
    return h('div', {},
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Association competition'),
        h('div', { class: 'sub' }, 'Pick two associations to compare on every metric.'))),
      disclaimer(), controls,
      h('div', { class: 'panel' }, h('div', { class: 'empty' }, 'Select two associations above.'))
    );
  }

  const data = await api(`/api/entities/${params.id}/compare?associations=${selected.join(',')}`);
  if (data.error) {
    return h('div', {}, controls, h('div', { class: 'panel' }, h('div', { class: 'empty' }, data.error)));
  }

  // The count rows sit in the same table as the score rows, so every score here
  // is read against its denominator (§93) without repeating it in each cell.
  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, data.associations.map((a) => a.label).join('  vs  ')),
        h('div', { class: 'sub' }, 'Every metric side by side (§51).'))
    ),
    disclaimer(), controls,
    h('div', { class: 'panel' },
      h('div', { class: 'panel-body tight' },
        h('table', {},
          h('thead', {}, h('tr', {},
            h('th', { class: 'no-sort' }, 'Metric'),
            data.associations.map((a) => h('th', { class: 'no-sort num' }, a.label))
          )),
          h('tbody', {}, data.rows.map((row) => h('tr', {},
            h('td', { class: 'muted' }, metricLabel(row.metric_key)),
            row.values.map((v) => h('td', { class: 'num' }, String(v)))
          )))
        )
      )
    )
  );
}

/** §59, §60 — gap finder and campaign priorities. */
export async function gapsView({ params }) {
  const data = await api(`/api/entities/${params.id}/gaps`);

  const list = (title, rows, note) => h('div', { class: 'panel' },
    h('h2', {}, title, h('span', { class: 'small dim' }, note)),
    h('div', { class: 'panel-body tight' },
      rows.length
        ? h('table', {}, h('tbody', {}, rows.map((r) => h('tr', {},
            h('td', {}, h('a', { href: `#/associations/${r.association_id}` }, r.label),
              h('div', { class: 'small dim' }, r.reason ?? r.note ?? '')),
            h('td', { class: 'num' },
              scoreWithBasis('current_pias', r.current_pias, { documents: r.current_documents }, { compact: true })),
            h('td', { class: 'num dim small' }, `${fmt.n(r.domains)} `, metricLabel('domains'))
          ))))
        : h('div', { class: 'empty' }, 'Nothing in this bucket.')
    )
  );

  const buckets = data.priorities ?? {};
  const bucketPanel = h('div', { class: 'panel' },
    h('h2', {}, 'Campaign priorities (§60)'),
    h('div', { class: 'panel-body' },
      Object.entries(buckets).map(([bucket, rows]) => rows.length
        ? h('div', { style: { marginBottom: '0.7rem' } },
            h('span', { class: `chip ${bucket === 'risk' ? 'bad' : bucket === 'defend' ? 'good' : bucket === 'build' ? 'warn' : ''}` }, bucket),
            ' ',
            rows.map((r, i) => [i ? ', ' : '', h('a', { href: `#/associations/${r.association_id}` }, r.label)]).flat()
          )
        : null),
      h('p', { class: 'small dim', style: { marginBottom: 0 } },
        'Buckets are derived from measurements on the leaderboard, not from judgement. Every row carries its reasoning.')
    )
  );

  return h('div', {},
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Gaps & priorities'),
      h('div', { class: 'sub' }, 'Where the current picture and the historical one disagree, and what that implies.'))),
    disclaimer(),
    bucketPanel,
    h('div', { class: 'grid cols-2' },
      list('Historically strong, currently weak', data.historically_strong_currently_weak, ' §59'),
      list('Currently growing', data.currently_growing, ' §59'),
      list('Valid but under-represented', data.valid_but_underrepresented, ' §59'),
      list('Risk — negative and gaining', data.risk, ' §60')
    )
  );
}
