import { h, api, fmt, disclaimer } from '../app.js';
import { metricLabel, labelText, DISCLAIMERS, METRICS, BANDS, BAND_ORDER } from '../lib/metrics-ui.js';

/**
 * Settings is mostly a read-out. Credentials live in .env, not in the
 * database, so this screen reports what is configured and what the model
 * parameters currently are — and says, in each case, that the parameters are
 * ours rather than Google's.
 */
export async function settingsView() {
  const settings = await api('/api/settings');
  let dataforseo = { configured: settings.dataforseo_configured };
  if (settings.dataforseo_configured) {
    try { dataforseo = await api('/api/settings/dataforseo'); } catch { /* reported below */ }
  }

  const status = (ok, label, detail) => h('div', { style: { marginBottom: '0.55rem' } },
    h('span', { class: `chip ${ok ? 'good' : 'bad'}` }, ok ? 'ready' : 'not configured'),
    ' ', h('strong', {}, label),
    detail ? h('div', { class: 'small dim' }, detail) : null
  );

  const providersPanel = h('div', { class: 'panel' },
    h('h2', {}, 'Providers'),
    h('div', { class: 'panel-body' },
      status(
        dataforseo.configured && dataforseo.ok !== false,
        'DataForSEO — corpus, phrase trends and SERP',
        dataforseo.configured
          ? dataforseo.error
            ? `Error: ${dataforseo.error}`
            : `${dataforseo.login ?? ''} · balance $${dataforseo.balance ?? '—'}`
          : 'Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD in .env. The password is the API password from app.dataforseo.com/api-access, not the account login password.'
      ),
      status(
        settings.llm.available,
        `LLM extraction — ${settings.llm.configured_provider}`,
        settings.llm.available
          ? `Model ${settings.llm.model}. Structured JSON via strict tool use; associations without a supporting quote are discarded.`
          : 'No key set. The pipeline runs with the deterministic heuristic extractor — lower precision, no cost. Set ANTHROPIC_API_KEY in .env.'
      ),
      h('div', { class: 'small dim' }, 'Corpus providers: ',
        settings.corpus_providers.map((p) =>
          h('span', { class: `chip ${p.available ? '' : 'marker'}`, style: { marginRight: '0.25rem' }, title: p.notes },
            `${p.name}${p.available ? '' : ' (off)'}`))
      )
    )
  );

  const bands = settings.model.bands ?? {};
  const rows = [
    ['Entity confidence — accept', settings.model.entityConfidence.accept, 'Documents below this do not affect scoring (§8).'],
    ['Entity confidence — review', settings.model.entityConfidence.review, 'Between review and accept goes to a human.'],
    ['Proximity token decay', settings.model.proximity.tokenDecay, 'exp(−distance / decay) (§25).'],
    ['Proximity blend', settings.model.proximity.blend, '0 = grammatical boundary only, 1 = token distance only.'],
    ['Recency half-life (days)', settings.model.recency.halfLifeDays, '0.5 ^ (age / half-life) (§30). Not a Google curve.'],
    ['Current window (days)', settings.model.currentWindowDays, 'What counts as "current" (§39).'],
    ['Momentum period (days)', settings.model.momentum.periodDays, 'Compared against the preceding period (§40).'],
    ['Momentum — minimum documents', settings.model.momentum.minDocuments, 'Below this in either period, momentum is shown as a dash rather than an arrow (§94).'],
    ['Bands — lower bounds', BAND_ORDER.filter((b) => b in bands).map((b) => `${BANDS[b].plain} ${bands[b]}`).join(' · '),
      'Display grouping only; feeds no calculation (§95).'],
    ['Independence — first on domain', settings.model.independence.first_unique_on_domain, '§22, and these are modelling assumptions, not Google weights.'],
    ['Independence — additional on domain', settings.model.independence.additional_unique_on_domain, ''],
    ['Independence — syndicated elsewhere', settings.model.independence.syndicated_other_domain, ''],
    ['Independence — near duplicate, same domain', settings.model.independence.near_duplicate_same_domain, ''],
    ['Independence — exact duplicate', settings.model.independence.exact_duplicate, ''],
    ['Mention cap', settings.model.mentionCap.join(', '), 'Weight of the 1st, 2nd, 3rd occurrence in one document; 0 after (§32).'],
  ];

  const piasRows = Object.entries(settings.model.pias).map(([k, v]) =>
    h('tr', {}, h('td', {}, k), h('td', { class: 'num score-cell' }, fmt.pct(v))));

  const strength = labelText('pias');

  return h('div', {},
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Settings & model'),
      h('div', { class: 'sub' },
        'Credentials come from the environment. Model parameters are shown here so nothing about the score is hidden.'),
      // Which commit is actually serving this page. The question "is my fix
      // live yet" should be answerable from the app, not from a dashboard in
      // another tab.
      h('div', { class: 'sub mono small dim' },
        `build ${settings.build?.commit ?? 'unknown'}`,
        settings.build?.source === 'none' ? ' (not determinable in this environment)' : ''))),
    disclaimer(settings.disclaimer),
    providersPanel,
    h('div', { class: 'split-2' },
      h('div', { class: 'panel' },
        h('h2', {}, metricLabel('pias'), ' — composition (§33)'),
        h('div', { class: 'panel-body tight' },
          h('table', {}, h('tbody', {}, piasRows)),
          h('p', { class: 'small dim', style: { padding: '0.7rem', marginBottom: 0 } },
            'Each component is normalised 0–100 against the strongest association for the same entity, then weighted. ' +
            `${strength} therefore ranks associations within one entity; comparing it across entities is meaningless.`)
        )
      ),
      h('div', { class: 'panel' },
        h('h2', {}, 'Model parameters'),
        h('div', { class: 'panel-body tight' },
          h('table', {}, h('tbody', {}, rows.map(([label, value, note]) => h('tr', {},
            h('td', {}, label, note ? h('div', { class: 'small dim' }, note) : null),
            h('td', { class: 'num mono' }, String(value))
          ))))
        )
      )
    ),
    h('div', { class: 'panel' },
      h('h2', {}, 'What this tool does not claim'),
      h('div', { class: 'panel-body narrative' },
        h('p', {}, DISCLAIMERS.external_estimate),
        h('p', {}, DISCLAIMERS.source_reliability),
        h('p', {}, DISCLAIMERS.query_behavior),
        h('p', { style: { marginBottom: 0 } }, METRICS.google_retrieval_score.caveat ?? ''),
        h('p', { class: 'small dim', style: { marginBottom: 0, marginTop: '0.7rem' } },
          'Every definition is in the ', h('a', { href: '#/glossary' }, 'glossary'), '.')
      )
    )
  );
}
