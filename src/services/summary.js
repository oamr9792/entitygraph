import { get } from '../db.js';
import { MODEL, SCORE_DISCLAIMER } from '../config.js';
import { leaderboard } from './metrics.js';
import { coverageConfidence } from './coverage.js';
import { gaps } from './insights.js';
import { retrievalGap } from './serp.js';
import { llmStatus } from '../providers/llm/index.js';
import { round } from '../util/stats.js';

/**
 * §91 — the one-screen summary, and §94 — the weak states behind it.
 *
 * Structured data, not prose. The browser writes the sentences by template from
 * these fields, using the copy registry, so the summary cannot say anything the
 * data does not and the plain/advanced toggle relabels it without changing it.
 *
 * Every association returned carries its denominator (§93), because the
 * summary is the screen most likely to be pasted into a client report.
 */

// Deliberately round numbers. A change of under fifteen points on a 0–100
// within-entity scale is within the noise of which documents were retrieved.
const CHANGE_POINTS = 15;
const MIN_DOCUMENTS = 3;
const GAP_POINTS = 15;
// Below one document in ten, an inferred date is a footnote rather than a caveat
// on every recent-versus-historical split.
const INFERRED_DATE_NOTICE_SHARE = 0.1;

const basisOf = (r) => ({
  independent_sources: r.independent_sources,
  documents: r.documents,
  domains: r.domains,
});

export function entitySummary(entityId) {
  const board = leaderboard(entityId);
  if (!board) return null;
  const entity = {
    id: board.entity.id,
    canonical_name: board.entity.canonical_name,
    entity_type: board.entity.entity_type,
  };
  const coverage = coverageConfidence(entityId);
  const trust = trustReading(entityId, coverage);

  if (!board.associations.length) {
    return { entity, available: false, reason: 'no_associations', trust, disclaimer: SCORE_DISCLAIMER };
  }

  const rows = board.associations;
  const byId = new Map(rows.map((r) => [r.association_id, r]));

  // 1. What they are known for.
  const knownFor = rows.slice(0, 5).map((r) => ({
    association_id: r.association_id,
    label: r.label,
    pias: r.pias,
    band: r.band,
    is_identity_marker: r.is_identity_marker,
    sentiment: r.sentiment.label,
    ...basisOf(r),
  }));

  // 2. What has changed. Both sides need enough documents to be a change in
  // coverage rather than a change in which pages happened to be found.
  const change = (r) => ({
    association_id: r.association_id,
    label: r.label,
    current_pias: r.current_pias,
    historical_pias: r.historical_pias,
    delta: round(r.current_pias - r.historical_pias, 1),
    current_documents: r.current_documents,
    historical_documents: Math.max(0, r.documents - r.current_documents),
    ...basisOf(r),
  });
  const rising = rows
    .filter((r) => r.current_pias - r.historical_pias >= CHANGE_POINTS && r.current_documents >= MIN_DOCUMENTS)
    .sort((a, b) => b.current_pias - b.historical_pias - (a.current_pias - a.historical_pias))
    .slice(0, 3)
    .map(change);
  const fading = rows
    .filter((r) => r.historical_pias - r.current_pias >= CHANGE_POINTS && r.documents - r.current_documents >= MIN_DOCUMENTS)
    .sort((a, b) => b.historical_pias - b.current_pias - (a.historical_pias - a.current_pias))
    .slice(0, 3)
    .map(change);

  // 3. What Google shows instead.
  const gap = retrievalGap(entityId, rows);
  const gapRow = (g) => {
    const r = byId.get(g.association_id);
    return {
      association_id: g.association_id,
      label: g.label,
      google_retrieval_score: g.google_retrieval_score,
      google_results: r?.google_results ?? 0,
      current_corpus_share_pct: g.current_corpus_share_pct,
      current_documents: r?.current_documents ?? 0,
      gap: g.gap,
    };
  };
  const google = gap
    ? {
        available: true,
        snapshot_at: gap.snapshot_at,
        first_page_results: board.serp?.first_page_results ?? 0,
        web_ahead: gap.rows
          .filter((g) => g.gap <= -GAP_POINTS && (byId.get(g.association_id)?.current_documents ?? 0) >= MIN_DOCUMENTS)
          .sort((a, b) => a.gap - b.gap)
          .slice(0, 3)
          .map(gapRow),
        google_ahead: gap.rows
          .filter((g) => g.gap >= GAP_POINTS)
          .sort((a, b) => b.gap - a.gap)
          .slice(0, 3)
          .map(gapRow),
      }
    : { available: false };

  return {
    entity,
    available: true,
    generated_at: board.generated_at,
    disclaimer: SCORE_DISCLAIMER,
    entity_documents: board.entity_documents,
    current_entity_documents: board.current_entity_documents,
    known_for: knownFor,
    changes: { rising, fading },
    google,
    trust,
    actions: pickActions(entityId, rows, byId),
  };
}

/**
 * §91.5 — three things to do: one defend, one build, one risk or monitor.
 *
 * Taken from the campaign buckets rather than invented, and never an identity
 * marker: "defend New York" is what a list of priorities looks like when it has
 * forgotten that the city was how we recognised the client in the first place.
 */
function pickActions(entityId, rows, byId) {
  const buckets = gaps(entityId)?.priorities ?? {};
  const isMarker = (id) => Boolean(byId.get(id)?.is_identity_marker);
  const first = (bucket) => (buckets[bucket] ?? []).find((p) => !isMarker(p.association_id) && byId.has(p.association_id));
  const shape = (kind, p) => {
    const r = byId.get(p.association_id);
    return {
      kind,
      association_id: p.association_id,
      label: p.label,
      current_pias: r.current_pias,
      band: r.current_band,
      sentiment: r.sentiment.label,
      momentum: r.momentum,
      current_documents: r.current_documents,
      ...basisOf(r),
    };
  };

  const actions = [];
  const defend = first('defend');
  if (defend) actions.push(shape('defend', defend));
  const build = first('build');
  if (build) actions.push(shape('build', build));
  for (const bucket of ['risk', 'historical', 'monitor']) {
    const pick = first(bucket);
    if (pick) {
      actions.push(shape(bucket, pick));
      break;
    }
  }
  return actions;
}

/** §91.4 and §94 — how much to trust this, with the reasons named. */
function trustReading(entityId, coverage) {
  const dating = get(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN d.published_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS publisher,
            COALESCE(SUM(CASE WHEN d.published_at IS NULL THEN 1 ELSE 0 END), 0) AS inferred
       FROM documents d
       JOIN entity_document_matches m ON m.document_id = d.id
      WHERE m.entity_id = ? AND m.verdict = 'accept'`,
    entityId
  ) ?? { total: 0, publisher: 0, inferred: 0 };

  const extraction = get(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN extractor = 'heuristic' THEN 1 ELSE 0 END), 0) AS heuristic
       FROM evidence WHERE entity_id = ? AND excluded = 0`,
    entityId
  ) ?? { total: 0, heuristic: 0 };

  const llm = llmStatus();
  const documents = coverage?.documents_analysed ?? 0;
  const reasons = [];
  if (documents < 100) reasons.push({ key: 'too_few_documents', documents });
  if (dating.total && dating.inferred / dating.total >= INFERRED_DATE_NOTICE_SHARE) {
    reasons.push({ key: 'dates_inferred', inferred: dating.inferred, total: dating.total });
  }
  if (!llm.key_configured) reasons.push({ key: 'no_llm_key' });
  else if (extraction.heuristic > 0) {
    reasons.push({ key: 'heuristic_rows', heuristic: extraction.heuristic, total: extraction.total });
  }

  return {
    level: coverage?.level ?? 'LOW',
    documents,
    domains: coverage?.independent_domains ?? 0,
    reasons,
    dating,
    extraction,
    llm: { key_configured: Boolean(llm.key_configured), available: Boolean(llm.available), degraded: Boolean(llm.degraded) },
  };
}

/** §94 — what every entity screen needs to say before it shows a number. */
export function weakStates(entityId) {
  const entity = get(`SELECT id FROM entities WHERE id = ? AND deleted_at IS NULL`, entityId);
  if (!entity) return null;
  const coverage = coverageConfidence(entityId);
  const trust = trustReading(entityId, coverage);
  const snapshot = get(
    `SELECT captured_at FROM serp_snapshots WHERE entity_id = ? AND query_kind = 'entity'
      ORDER BY captured_at DESC LIMIT 1`,
    entityId
  );
  return {
    entity_id: entityId,
    coverage_level: trust.level,
    low_coverage: trust.level === 'LOW',
    documents: trust.documents,
    dating: trust.dating,
    show_dates_notice: trust.reasons.some((r) => r.key === 'dates_inferred'),
    extraction: trust.extraction,
    llm: trust.llm,
    google_available: Boolean(snapshot),
    momentum_floor: MODEL.momentum.minDocuments,
  };
}
