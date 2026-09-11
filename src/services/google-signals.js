import { all, get } from '../db.js';
import { findOccurrences, normaliseForMatch } from '../util/text.js';
import { round, safeDiv } from '../util/stats.js';

/**
 * What Google associates with the entity, surface by surface (§13, §14, §52).
 *
 * The corpus scores answer "what does the observable web associate with this
 * entity". This answers the question an analyst usually arrives with: "what is
 * Google showing people who search the name". Those are different questions
 * and §14 requires them to stay apart, so nothing here feeds PIAS.
 *
 * Google states its associations on several surfaces, and they disagree:
 *
 *   organic results   which associations the ranking pages carry
 *   related searches  what Google has learned people look for next
 *   people also ask   the questions it expects
 *   knowledge panel   what it asserts as fact about the entity
 *
 * Each is reported on its own. Averaging them into one number would hide the
 * disagreement, and the disagreement is usually the finding — a panel that
 * says "lawyer" above a page where a fifth of the results are about a former
 * client is exactly the situation this product exists to surface.
 */
export function googleView(entityId) {
  const snapshot = get(
    `SELECT * FROM serp_snapshots
      WHERE entity_id = ? AND query_kind = 'entity'
      ORDER BY captured_at DESC, id DESC LIMIT 1`,
    entityId
  );
  if (!snapshot) {
    return { available: false, reason: 'No Google snapshot yet. One is captured during every build.' };
  }

  let signals = {};
  try {
    signals = JSON.parse(snapshot.signals || '{}') ?? {};
  } catch {
    signals = {};
  }
  const signalsCaptured = Boolean(
    signals.related_searches || signals.people_also_ask || signals.knowledge_graph
  );

  const totals = get(
    `SELECT COUNT(*) AS results, COALESCE(SUM(CASE WHEN rank <= 10 THEN 1 ELSE 0 END), 0) AS top10
       FROM serp_results WHERE snapshot_id = ?`,
    snapshot.id
  ) ?? { results: 0, top10: 0 };

  const rows = all(
    `SELECT a.id AS association_id, a.canonical_label AS label, a.kind, a.category,
            COUNT(DISTINCT r.id) AS results,
            COUNT(DISTINCT CASE WHEN r.rank <= 10 THEN r.id END) AS top10,
            MIN(r.rank) AS best_rank,
            GROUP_CONCAT(DISTINCT ra.method) AS methods
       FROM serp_result_associations ra
       JOIN serp_results r ON r.id = ra.serp_result_id
       JOIN associations a ON a.id = ra.association_id
      WHERE r.snapshot_id = ? AND a.status = 'active'
      GROUP BY a.id
      ORDER BY results DESC, best_rank ASC
      LIMIT 30`,
    snapshot.id
  );

  const entity = get(`SELECT canonical_name FROM entities WHERE id = ?`, entityId);
  const ownTokens = new Set(normaliseForMatch(entity?.canonical_name ?? '').split(' ').filter(Boolean));

  const surfaces = {
    related: (signals.related_searches ?? []).join(' | '),
    also_ask: (signals.people_also_ask ?? []).join(' | '),
    panel: [
      signals.knowledge_graph?.subtitle,
      signals.knowledge_graph?.description,
      ...(signals.knowledge_graph?.facts ?? []).map((f) => f.text),
    ]
      .filter(Boolean)
      .join(' | '),
  };

  // The same forms the SERP classifier matches on, including a person's
  // surname — headlines and related searches use surnames far more than labels.
  const formsFor = (row) => {
    const forms = [
      row.label,
      ...all(`SELECT surface_form FROM association_aliases WHERE association_id = ?`, row.association_id).map(
        (r) => r.surface_form
      ),
    ];
    if (row.kind === 'named_entity' && row.category === 'person') {
      const surname = normaliseForMatch(row.label).split(' ').filter(Boolean).at(-1);
      if (surname && surname.length >= 4 && !ownTokens.has(surname)) forms.push(surname);
    }
    return forms;
  };
  const appearsIn = (text, forms) => Boolean(text) && findOccurrences(text, forms).length > 0;

  const associations = rows.map((row) => {
    const forms = formsFor(row);
    return {
      association_id: row.association_id,
      label: row.label,
      kind: row.kind,
      category: row.category,
      organic_results: row.results,
      organic_share: round(safeDiv(row.results, totals.results, 0), 3),
      top10_results: row.top10,
      best_rank: row.best_rank,
      matched_by: String(row.methods ?? '').split(',').filter(Boolean),
      in_related_searches: appearsIn(surfaces.related, forms),
      in_people_also_ask: appearsIn(surfaces.also_ask, forms),
      in_knowledge_panel: appearsIn(surfaces.panel, forms),
    };
  });

  // What Google shows on the first page that this tool could not connect to
  // any association. Shown rather than hidden, because an unexplained result
  // near the top is where a missing association usually is.
  const unmapped = all(
    `SELECT r.rank, r.url, r.root_domain, r.title FROM serp_results r
      WHERE r.snapshot_id = ? AND r.rank <= 10
        AND NOT EXISTS (SELECT 1 FROM serp_result_associations ra WHERE ra.serp_result_id = r.id)
      ORDER BY r.rank`,
    snapshot.id
  );

  return {
    available: true,
    query: snapshot.query,
    captured_at: snapshot.captured_at,
    organic_results: totals.results,
    organic_top10: totals.top10,
    signals_captured: signalsCaptured,
    related_searches: signals.related_searches ?? [],
    people_also_ask: signals.people_also_ask ?? [],
    people_also_search: signals.people_also_search ?? [],
    top_stories: signals.top_stories ?? [],
    knowledge_graph: signals.knowledge_graph ?? null,
    associations,
    unmapped_top_results: unmapped,
    note: signalsCaptured
      ? null
      : 'This snapshot predates capturing related searches and the knowledge panel. The next build records them.',
  };
}
