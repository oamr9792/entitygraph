import { h, api, fmt, disclaimer, navigate } from '../app.js';
import { metricLabel, scoreWithBasis, bandChip, bandNote } from '../lib/metrics-ui.js';
import { weakStatesBanner } from '../lib/weak-states.js';

/**
 * §57–§60 — the action plan for one association.
 *
 * Ordered the way the decision is actually made: what kind of association is
 * this, is it moving on its own, what would it cost to move it, and where does
 * Google sit relative to the corpus. The routes come first because they are
 * the answer; the arithmetic below them is the working.
 */

const VERDICT_LABELS = {
  central_and_corroborated: ['Established in the public record', 'bad'],
  substantive: ['Substantively corroborated', 'warn'],
  concentrated: ['Thin, concentrated base', 'warn'],
  peripheral: ['Peripheral', 'good'],
  possibly_misattributed: ['Possibly the wrong person', 'good'],
};

// The routes content can serve, and the format each starts from.
const CONTENT_FORMAT = {
  displace: 'article',
  retrieval_gap: 'profile',
  not_a_metrics_problem: 'profile',
  challenge_accuracy: 'correction_request',
};

export async function planView({ params }) {
  const plan = await api(`/api/associations/${params.id}/action-plan`);

  if (plan.verdict === 'merged' || plan.verdict === 'excluded' || plan.verdict === 'no_active_evidence') {
    return h('div', {},
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, plan.association.label))),
      h('div', { class: 'panel' }, h('div', { class: 'panel-body' },
        h('p', {}, plan.headline),
        plan.detail ? h('p', { class: 'small dim' }, plan.detail) : null,
        plan.redirect_to
          ? h('button', { class: 'primary', onclick: () => navigate(`#/associations/${plan.redirect_to.id}/plan`) },
              `Open the plan for ${plan.redirect_to.label}`)
          : null
      ))
    );
  }

  const [verdictLabel, verdictClass] = VERDICT_LABELS[plan.character.verdict] ?? [plan.character.verdict, ''];

  const screens = {
    evidence: [`#/associations/${params.id}`, 'Open evidence'],
    related: [`#/associations/${params.id}`, 'See what it travels with'],
    compare: [`#/entities/${plan.entity.id}/old-vs-current`, 'Old vs current'],
    timeline: [`#/entities/${plan.entity.id}/timeline`, 'Timeline'],
    gaps: [`#/entities/${plan.entity.id}/gaps`, 'Gaps & priorities'],
    serp: [`#/entities/${plan.entity.id}/serp`, 'Google overlay'],
  };

  const routeCards = plan.routes.length
    ? plan.routes.map((r, i) =>
        h('div', { class: `route ${r.key === 'not_a_metrics_problem' ? 'route-stop' : ''}` },
          h('div', { class: 'route-head' },
            h('span', { class: 'route-n' }, String(i + 1)),
            h('strong', {}, r.title)
          ),
          h('p', { class: 'route-why' }, r.rationale),
          h('ul', { class: 'route-actions' }, r.actions.map((a) => h('li', {}, a))),
          h('div', { class: 'toolbar', style: { margin: 0 } },
            screens[r.screen]
              ? h('button', { class: 'small', onclick: () => navigate(screens[r.screen][0]) }, screens[r.screen][1])
              : null,
            CONTENT_FORMAT[r.key]
              ? h('button', {
                  class: 'small',
                  onclick: () => navigate(`#/associations/${params.id}/content?format=${CONTENT_FORMAT[r.key]}&purpose=displace`),
                }, 'Draft content for this')
              : null)
        )
      )
    : [h('div', { class: 'empty' }, 'No route applies — this association is not currently actionable through this model.')];

  const stat = (label, value, note) =>
    h('div', { class: 'stat' },
      h('div', { class: 'label' }, label),
      h('div', { class: 'value' }, value ?? '—'),
      note ? h('div', { class: 'note' }, note) : null
    );

  const d = plan.displacement;
  const displacementPanel = h('div', { class: 'panel' },
    h('h2', {}, 'What it would take', h('span', { class: 'small dim' }, 'share arithmetic, §58')),
    h('div', { class: 'panel-body' },
      d.applicable
        ? h('div', {},
            h('p', { class: 'interpretation' },
              `Its ${fmt.n(d.documents_carrying_association)} current-window documents cannot be removed — they are independently published and the corroboration model treats them as evidence. Share falls only if the rest of the corpus grows. Moving from ${fmt.pct(d.current_share, 1)} to ${fmt.pct(d.target_share, 1)} needs roughly ${fmt.n(d.additional_documents_required)} additional documents about the entity, on domains not already in the corpus, that do not carry this association.`),
            h('table', {},
              h('thead', {}, h('tr', {},
                h('th', {}, 'If placed at this tier'),
                h('th', { class: 'num' }, 'Documents'),
                h('th', { class: 'num' }, 'Evidence each'),
                h('th', { class: 'num' }, 'Evidence added')
              )),
              h('tbody', {}, d.by_tier.map((t) => h('tr', {},
                h('td', {}, t.label),
                h('td', { class: 'num' }, fmt.n(t.documents)),
                h('td', { class: 'num dim' }, t.evidence_contribution_each.toFixed(2)),
                h('td', { class: 'num' }, t.total_evidence_added.toFixed(1))
              )))
            ),
            h('p', { class: 'small dim' }, d.assumptions.note)
          )
        : h('p', { class: 'interpretation' }, d.reason)
    )
  );

  const decayRows = plan.decay.horizons.map((hz) =>
    h('tr', {},
      h('td', {}, `in ${hz.in_days} days`),
      h('td', { class: 'num' }, fmt.pct(hz.weight_remaining, 0)),
      h('td', { class: 'num dim' }, fmt.n(hz.documents_still_in_current_window))
    )
  );

  const c = plan.current;
  const olderDocuments = Math.max(0, (c.documents ?? 0) - (c.current_documents ?? 0));

  return h('div', {},
    weakStatesBanner(plan.entity.id),
    h('div', { class: 'page-head' },
      h('div', {},
        h('h1', {}, plan.association.label),
        h('div', { class: 'sub' },
          h('span', { class: `chip ${verdictClass}` }, verdictLabel), ' ',
          h('span', { class: 'chip' }, plan.association.category), ' ',
          h('span', { class: `sentiment ${plan.association.sentiment?.label ?? ''}` }, plan.association.sentiment?.label ?? ''))
      ),
      h('div', { class: 'toolbar' },
        h('button', { class: 'primary', onclick: () => navigate(`#/associations/${params.id}/content`) }, 'Build content'),
        h('button', { onclick: () => navigate(`#/associations/${params.id}`) }, 'Evidence'),
        h('button', { onclick: () => navigate(`#/entities/${plan.entity.id}`) }, 'Dashboard')
      )
    ),
    disclaimer(plan.disclaimer),

    h('div', { class: 'grid cols-5' },
      stat(metricLabel('pias'),
        scoreWithBasis('pias', c.pias, { sources: c.independent_sources, documents: c.documents }, { compact: true }),
        h('span', {}, 'older: ', scoreWithBasis('historical_pias', c.historical_pias, { documents: olderDocuments }, { compact: true }))),
      stat(metricLabel('current_pias'),
        scoreWithBasis('current_pias', c.current_pias, { documents: c.current_documents }, { compact: true }),
        h('span', {}, `${fmt.pct(c.current_corpus_share)} `, metricLabel('current_corpus_share'))),
      stat(metricLabel('domains'), fmt.n(c.domains),
        h('span', {}, `${plan.character.top_tier_domains} `, metricLabel('high_authority_domains'))),
      stat(metricLabel('median_age'), plan.character.median_age, `${fmt.n(c.current_documents)} in current window`),
      stat(metricLabel('google_retrieval_score'),
        scoreWithBasis('google_retrieval_score', c.google_retrieval_score,
          { results: c.google_results ?? 0, total: c.first_page_results ?? 0 }, { compact: true }),
        plan.retrieval.measurable
          ? h('span', {}, metricLabel('retrieval_gap'), ` ${plan.retrieval.gap > 0 ? '+' : ''}${plan.retrieval.gap}`)
          : 'no Google snapshot')
    ),

    c.band ? h('div', {}, bandChip(c.band), bandNote()) : null,

    h('div', { style: { height: '1.1rem' } }),

    h('div', { class: 'panel' },
      h('h2', {}, 'What this association is'),
      h('div', { class: 'panel-body' },
        h('p', { class: 'interpretation' }, plan.character.reasoning),
        h('div', { class: 'diagnosis-counts' },
          [
            ['domains', plan.character.distinct_domains],
            ['high_authority_domains', plan.character.top_tier_domains],
            ['direct_statement_share', `${Math.round(plan.character.direct_relationship_share * 100)}%`],
            ['top_domain_share', `${Math.round(plan.character.top_domain_share * 100)}%`],
            ['entity_confidence', plan.character.mean_entity_confidence],
          ].map(([key, value]) =>
            h('div', { class: 'count' }, h('span', { class: 'n' }, String(value)), h('span', { class: 'l' }, metricLabel(key))))
        )
      )
    ),

    h('div', { class: 'panel' },
      h('h2', {}, 'Recommended routes', h('span', { class: 'small dim' }, 'in the order they should be considered')),
      h('div', { class: 'panel-body' }, routeCards)
    ),

    h('div', { class: 'split-2' },
      h('div', { class: 'panel' },
        h('h2', {}, 'If nothing is done', h('span', { class: 'small dim' }, '§30 decay')),
        h('div', { class: 'panel-body' },
          h('p', { class: 'interpretation' }, plan.decay.note),
          h('table', {},
            h('thead', {}, h('tr', {},
              h('th', {}, 'Horizon'),
              h('th', { class: 'num' }, metricLabel('weight_remaining')),
              h('th', { class: 'num' }, 'Docs in window')
            )),
            h('tbody', {}, decayRows)
          )
        )
      ),
      displacementPanel
    ),

    h('div', { class: 'panel' },
      h('div', { class: 'panel-body' },
        h('p', { class: 'small dim', style: { margin: 0 } }, plan.simulation_disclaimer)
      )
    )
  );
}
