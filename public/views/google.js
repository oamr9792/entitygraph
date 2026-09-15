import { h, api, fmt, clear } from '../app.js';
import { metricLabel } from '../lib/metrics-ui.js';

/**
 * "What Google associates" — the panel at the top of the dashboard.
 *
 * Deliberately separate from the leaderboard below it. The leaderboard scores
 * what the web corpus says; this shows what Google puts in front of someone who
 * searches the name. §14 requires those to stay apart, and when they disagree,
 * the disagreement is the thing worth acting on.
 */
export function googlePanel(entityId) {
  const body = h('div', { class: 'panel-body' }, h('div', { class: 'dim small' }, 'Reading Google’s page for this name…'));
  const panel = h('div', { class: 'panel' },
    h('h2', {}, 'What Google associates',
      h('span', { class: 'small dim' }, 'observed on Google’s page for the name · separate from the corpus scores')),
    body
  );

  api(`/api/entities/${entityId}/google`)
    .then((g) => {
      clear(body);
      if (!g.available) {
        body.append(h('div', { class: 'empty' }, g.reason));
        return;
      }

      body.append(h('p', { class: 'small dim', style: { marginTop: 0 } },
        `Google’s results for “${g.query}”, captured ${fmt.date(g.captured_at)} — ${fmt.n(g.organic_results)} organic results. `,
        h('a', { href: `#/entities/${entityId}/serp` }, 'See where each result ended up')));

      if (g.note) body.append(h('p', { class: 'interpretation' }, g.note));

      // Organic results: which associations the ranking pages carry.
      body.append(h('h3', { class: 'google-h' }, 'In the organic results'));
      if (g.associations.length) {
        body.append(h('table', {},
          h('thead', {}, h('tr', {},
            h('th', {}, 'Association'),
            h('th', { class: 'num' }, metricLabel('organic_results')),
            h('th', { class: 'num' }, metricLabel('top10_results')),
            h('th', { class: 'num' }, metricLabel('best_rank')),
            h('th', {}, 'Also on Google as')
          )),
          h('tbody', {}, g.associations.map((a) => h('tr', {},
            h('td', {}, h('a', { href: `#/associations/${a.association_id}` }, a.label)),
            h('td', { class: 'num' }, `${a.organic_results} · ${fmt.pct(a.organic_share)}`),
            h('td', { class: 'num' }, fmt.n(a.top10_results)),
            h('td', { class: 'num dim' }, `#${a.best_rank}`),
            h('td', {},
              a.in_knowledge_panel ? h('span', { class: 'chip good' }, 'knowledge panel') : null,
              a.in_related_searches ? h('span', { class: 'chip warn' }, 'related search') : null,
              a.in_people_also_ask ? h('span', { class: 'chip' }, 'people also ask') : null)
          )))
        ));
      } else {
        body.append(h('p', { class: 'small dim' }, 'No organic result has been linked to an association yet.'));
      }

      const kg = g.knowledge_graph;
      const side = h('div', { class: 'google-grid' },
        h('div', {},
          h('h3', { class: 'google-h' }, 'Knowledge panel'),
          kg
            ? h('div', {},
                h('div', { class: 'kg-title' }, kg.title ?? '', kg.subtitle ? h('span', { class: 'dim' }, ` — ${kg.subtitle}`) : null),
                kg.description ? h('p', { class: 'small muted' }, kg.description) : null,
                kg.facts?.length ? h('ul', { class: 'kg-facts' }, kg.facts.map((f) => h('li', { class: 'small' }, f.text))) : null)
            : h('p', { class: 'small dim' }, g.signals_captured ? 'Google showed no knowledge panel for this name.' : '—')
        ),
        h('div', {},
          h('h3', { class: 'google-h' }, 'Related searches'),
          g.related_searches.length
            ? h('div', { class: 'probe-list' }, g.related_searches.map((s) => h('span', { class: 'chip' }, s)))
            : h('p', { class: 'small dim' }, g.signals_captured ? 'None shown.' : '—'),
          h('h3', { class: 'google-h' }, 'People also ask'),
          g.people_also_ask.length
            ? h('ul', { class: 'kg-facts' }, g.people_also_ask.map((q) => h('li', { class: 'small' }, q)))
            : h('p', { class: 'small dim' }, g.signals_captured ? 'None shown.' : '—')
        )
      );
      body.append(side);

      if (g.unmapped_top_results.length) {
        body.append(
          h('h3', { class: 'google-h' }, 'On the first page, not linked to any association'),
          h('p', { class: 'small dim', style: { marginTop: 0 } },
            'An unexplained result near the top is usually where a missing association is. Open the page, and if it is about something that matters, add it as a paired probe.'),
          h('ul', { class: 'kg-facts' }, g.unmapped_top_results.map((r) =>
            h('li', { class: 'small' },
              h('span', { class: 'dim mono' }, `#${r.rank} `),
              h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.title ?? r.url),
              h('span', { class: 'dim' }, ` · ${r.root_domain ?? ''}`))
          ))
        );
      }
    })
    .catch((err) => {
      clear(body).append(h('div', { class: 'empty' }, `Could not read the Google snapshot: ${err.message}`));
    });

  return panel;
}
