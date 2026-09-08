import { MODEL } from '../config.js';
import { all, get, run, tx } from '../db.js';
import {
  proximityScore, recencyWeight, sourceReliability, classifyDomain, mentionWeightAt,
  evidenceScore, associationComponents, composePias, momentum, conditionalScores,
  aggregateSentiment, googleRetrievalScores, MOMENTUM_ARROWS,
} from './scoring.js';
import { assignIndependence } from './duplicates.js';
import { round, median, ageDays, safeDiv, parseDate, monthKey, humanAge, DAY_MS } from '../util/stats.js';

/**
 * §23, §31–§43 — turning evidence rows into the numbers on the dashboard.
 *
 * Two passes, deliberately separated:
 *
 *   rescoreEntity()   recomputes every per-document factor and writes it back.
 *                     Runs after ingestion, and again whenever a MODEL
 *                     parameter or a human correction changes.
 *
 *   leaderboard()     reads those stored factors and composes the scores for a
 *                     requested time window. Pure aggregation, no writes, fast
 *                     enough to run per request — which is what makes the §49
 *                     global time control instant.
 *
 * The split is why changing the half-life in the UI does not require a rebuild
 * of the corpus, and why two different windows can never disagree about the
 * underlying evidence.
 */

const modelFor = (entity) => {
  try {
    return JSON.parse(entity.model_overrides || '{}');
  } catch {
    return {};
  }
};

/** Percentile rank of each value, used to normalise the unbounded prominence score. */
function percentileMap(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return (value) => {
    if (!Number.isFinite(value) || !sorted.length) return null;
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    return sorted.length === 1 ? 1 : lo / (sorted.length - 1);
  };
}

/**
 * §26 — reliability for every accepted document, with the domain's stored
 * classification and any human override applied.
 */
export function documentReliability(entityId, overrides = null) {
  const docs = all(
    `SELECT d.*, dom.classification AS dom_class, dom.classification_override AS dom_override,
            dom.reliability_override AS rel_override, dom.spam_score AS dom_spam
       FROM documents d
       JOIN entity_document_matches m ON m.document_id = d.id
       LEFT JOIN domains dom ON dom.root_domain = d.root_domain
      WHERE m.entity_id = ? AND m.verdict = 'accept'`,
    entityId
  );
  const prominencePercentile = percentileMap(docs.map((d) => d.prominence));
  const out = new Map();
  for (const d of docs) {
    const classification =
      d.dom_override ||
      d.dom_class ||
      classifyDomain({ domainRank: d.domain_rank, spamScore: d.spam_score ?? d.dom_spam }, overrides);
    out.set(d.id, {
      reliability: sourceReliability(
        {
          domainRank: d.domain_rank,
          urlRank: d.url_rank,
          prominence: prominencePercentile(d.prominence),
          classification,
          spamScore: d.spam_score ?? d.dom_spam,
          override: d.rel_override,
        },
        overrides
      ),
      classification,
    });
  }
  return { map: out, documents: docs };
}

/**
 * Recomputes every factor of §31 for every evidence row, then rolls up to one
 * row per (association, document) — the unit §32's cap and §22's independence
 * both operate on.
 */
export function rescoreEntity(entityId, { halfLifeDays = null, now = Date.now() } = {}) {
  const entity = get(`SELECT * FROM entities WHERE id = ?`, entityId);
  if (!entity) return { rescored: 0 };
  const overrides = modelFor(entity);
  const halfLife = halfLifeDays ?? overrides.recency?.halfLifeDays ?? MODEL.recency.halfLifeDays;

  const { map: reliabilityMap } = documentReliability(entityId, overrides);
  const matches = new Map(
    all(`SELECT document_id, entity_confidence FROM entity_document_matches WHERE entity_id = ? AND verdict = 'accept'`, entityId)
      .map((m) => [m.document_id, m.entity_confidence])
  );

  const associations = all(`SELECT id FROM associations WHERE entity_id = ? AND status = 'active'`, entityId);
  let rescored = 0;

  tx(() => {
    run(`DELETE FROM association_document_scores WHERE entity_id = ?`, entityId);

    for (const association of associations) {
      const rows = all(
        `SELECT e.*, d.root_domain, d.published_at AS doc_published, d.group_date, d.duplicate_cluster_id,
                d.is_cluster_primary, c.kind AS cluster_kind
           FROM evidence e
           JOIN documents d ON d.id = e.document_id
           LEFT JOIN document_duplicate_clusters c ON c.id = d.duplicate_cluster_id
          WHERE e.association_id = ? AND e.excluded = 0
          ORDER BY e.document_id, e.occurrence_index`,
        association.id
      );
      if (!rows.length) continue;

      // Only documents that survived disambiguation contribute.
      const usable = rows.filter((r) => matches.has(r.document_id));
      if (!usable.length) continue;

      const byDocument = new Map();
      for (const row of usable) {
        if (!byDocument.has(row.document_id)) byDocument.set(row.document_id, []);
        byDocument.get(row.document_id).push(row);
      }

      const docSummaries = [...byDocument.entries()].map(([documentId, rowsForDoc]) => {
        const first = rowsForDoc[0];
        return {
          id: documentId,
          root_domain: first.root_domain,
          duplicate_cluster_id: first.duplicate_cluster_id,
          is_cluster_primary: first.is_cluster_primary,
          cluster_kind: first.cluster_kind,
          source_reliability: reliabilityMap.get(documentId)?.reliability ?? 0,
          rows: rowsForDoc,
        };
      });

      const independence = assignIndependence(docSummaries, overrides);

      for (const doc of docSummaries) {
        const independenceWeight = independence.get(doc.id)?.weight ?? 0;
        const reliability = doc.source_reliability;
        // The effective date: publisher's date when present, group date when
        // not. Which was used is reported in coverage, never silently assumed.
        const published = doc.rows[0].doc_published ?? doc.rows[0].group_date ?? null;
        const recency = recencyWeight(published, { halfLifeDays: halfLife, now }, overrides);

        let documentEvidence = 0;
        let documentEvidenceUndecayed = 0;
        let bestProximity = 0;
        let maxRelationship = 0;
        let cappedWeight = 0;
        let sentimentSum = 0;

        doc.rows.forEach((row, index) => {
          const proximity = proximityScore(
            { tokenDistance: row.token_distance, boundary: row.boundary },
            overrides
          );
          const mentionWeight = mentionWeightAt(index, overrides);
          const entityConfidence = matches.get(doc.id) ?? row.entity_confidence;

          const score = evidenceScore({
            entityConfidence,
            relationshipConfidence: row.relationship_confidence,
            proximity,
            sourceReliability: reliability,
            independence: independenceWeight,
            recency,
            mentionWeight,
          });
          const undecayed = evidenceScore({
            entityConfidence,
            relationshipConfidence: row.relationship_confidence,
            proximity,
            sourceReliability: reliability,
            independence: independenceWeight,
            recency: 1,
            mentionWeight,
          });

          run(
            `UPDATE evidence SET proximity_score = ?, source_reliability = ?, recency_weight = ?,
                    independence_weight = ?, mention_cap_weight = ?, evidence_score = ?,
                    entity_confidence = ?, published_at = ?
              WHERE id = ?`,
            proximity,
            reliability,
            recency,
            independenceWeight,
            mentionWeight,
            score,
            entityConfidence,
            published,
            row.id
          );
          rescored += 1;

          documentEvidence += score;
          documentEvidenceUndecayed += undecayed;
          cappedWeight += mentionWeight;
          bestProximity = Math.max(bestProximity, proximity);
          maxRelationship = Math.max(maxRelationship, row.relationship_confidence);
          sentimentSum += (row.sentiment_positive ?? 0) - (row.sentiment_negative ?? 0);
        });

        run(
          `INSERT INTO association_document_scores
             (entity_id, association_id, document_id, raw_mentions, capped_weight, best_proximity,
              max_relationship_confidence, independence_weight, recency_weight, source_reliability,
              document_evidence, document_evidence_undecayed, sentiment, published_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(association_id, document_id) DO UPDATE SET
             raw_mentions = excluded.raw_mentions, capped_weight = excluded.capped_weight,
             best_proximity = excluded.best_proximity,
             max_relationship_confidence = excluded.max_relationship_confidence,
             independence_weight = excluded.independence_weight, recency_weight = excluded.recency_weight,
             source_reliability = excluded.source_reliability, document_evidence = excluded.document_evidence,
             document_evidence_undecayed = excluded.document_evidence_undecayed,
             sentiment = excluded.sentiment, published_at = excluded.published_at,
             computed_at = datetime('now')`,
          entityId,
          association.id,
          doc.id,
          doc.rows.length,
          round(cappedWeight, 4),
          round(bestProximity, 4),
          round(maxRelationship, 4),
          independenceWeight,
          recency,
          reliability,
          round(documentEvidence, 6),
          round(documentEvidenceUndecayed, 6),
          round(safeDiv(sentimentSum, doc.rows.length, 0), 4),
          published
        );
      }
    }
  });

  run(`UPDATE entities SET updated_at = datetime('now') WHERE id = ?`, entityId);
  return { rescored, associations: associations.length };
}

// --- Aggregation ------------------------------------------------------------

/** Documents confidently about the entity — the denominator for §37. */
export function entityDocumentCount(entityId, { since = null, until = null } = {}) {
  const row = get(
    `SELECT COUNT(*) AS n FROM documents d
       JOIN entity_document_matches m ON m.document_id = d.id
      WHERE m.entity_id = ? AND m.verdict = 'accept'
        AND (? IS NULL OR COALESCE(d.published_at, d.group_date) >= ?)
        AND (? IS NULL OR COALESCE(d.published_at, d.group_date) < ?)`,
    entityId,
    since,
    since,
    until,
    until
  );
  return row?.n ?? 0;
}

function docRowsFor(entityId, { since = null, until = null } = {}) {
  return all(
    `SELECT s.*, d.root_domain, d.sentiment_positive, d.sentiment_negative, d.sentiment_neutral,
            COALESCE(d.published_at, d.group_date) AS effective_date,
            d.published_at AS publisher_date, d.duplicate_cluster_id
       FROM association_document_scores s
       JOIN documents d ON d.id = s.document_id
      WHERE s.entity_id = ?
        AND (? IS NULL OR COALESCE(d.published_at, d.group_date) >= ?)
        AND (? IS NULL OR COALESCE(d.published_at, d.group_date) < ?)`,
    entityId,
    since,
    since,
    until,
    until
  );
}

const toComponentDoc = (r) => ({
  documentId: r.document_id,
  rootDomain: r.root_domain,
  rawMentions: r.raw_mentions,
  cappedWeight: r.capped_weight,
  entityConfidence: 1, // already folded into document_evidence; kept explicit for §35
  relationshipConfidence: r.max_relationship_confidence,
  proximity: r.best_proximity,
  sourceReliability: r.source_reliability,
  independenceWeight: r.independence_weight,
  evidenceScoreUndecayed: r.document_evidence_undecayed,
  publishedAt: r.effective_date,
  sentimentPositive: r.sentiment_positive,
  sentimentNegative: r.sentiment_negative,
  sentimentNeutral: r.sentiment_neutral,
  excluded: false,
});

/**
 * §42 — the freshness panel. Reported as a distribution rather than one
 * number, because "latest mention: 3 days ago" and "91% of evidence is under a
 * year old" answer different questions and an association can pass one while
 * failing the other.
 */
function freshness(docs, now) {
  const ages = docs.map((d) => ageDays(d.effective_date, now)).filter((a) => a !== null);
  const totalWeight = docs.reduce((a, d) => a + (d.document_evidence_undecayed ?? 0), 0);
  const shareUnder = (days) =>
    totalWeight
      ? round(
          docs
            .filter((d) => {
              const age = ageDays(d.effective_date, now);
              return age !== null && age < days;
            })
            .reduce((a, d) => a + (d.document_evidence_undecayed ?? 0), 0) / totalWeight,
          4
        )
      : null;
  const shareOver = (days) =>
    totalWeight
      ? round(
          docs
            .filter((d) => {
              const age = ageDays(d.effective_date, now);
              return age !== null && age >= days;
            })
            .reduce((a, d) => a + (d.document_evidence_undecayed ?? 0), 0) / totalWeight,
          4
        )
      : null;

  const latest = ages.length ? Math.min(...ages) : null;
  const med = median(ages);
  return {
    latest_mention_age_days: latest === null ? null : round(latest, 1),
    latest_mention_age: humanAge(latest),
    median_age_days: med === null ? null : round(med, 1),
    median_age: humanAge(med),
    undated_documents: docs.length - ages.length,
    evidence_share_under_90d: shareUnder(90),
    evidence_share_under_365d: shareUnder(365),
    evidence_share_over_3y: shareOver(3 * 365),
  };
}

/**
 * The leaderboard (§45) plus everything §77 says must never be conflated:
 * historical PIAS, current PIAS, corpus share, momentum and Google retrieval,
 * each computed from its own window and each labelled.
 */
export function leaderboard(entityId, { windowDays = null, halfLifeDays = null, now = Date.now(), cutoff = null } = {}) {
  const entity = get(`SELECT * FROM entities WHERE id = ?`, entityId);
  if (!entity) return null;
  const overrides = modelFor(entity);
  const currentWindow = overrides.currentWindowDays ?? MODEL.currentWindowDays;
  const halfLife = halfLifeDays ?? overrides.recency?.halfLifeDays ?? MODEL.recency.halfLifeDays;

  // The global time control (§49) narrows every window; the "old vs current"
  // cutoff (§50) splits the same corpus in two at a chosen date.
  const windowStart = windowDays ? new Date(now - windowDays * DAY_MS).toISOString() : null;
  const currentStart = cutoff ?? new Date(now - currentWindow * DAY_MS).toISOString();

  const associations = all(
    `SELECT * FROM associations WHERE entity_id = ? AND status = 'active' ORDER BY id`,
    entityId
  );
  if (!associations.length) return { entity, associations: [], generated_at: new Date(now).toISOString() };

  const allRows = docRowsFor(entityId, { since: windowStart });
  const rowsByAssociation = new Map();
  for (const r of allRows) {
    if (!rowsByAssociation.has(r.association_id)) rowsByAssociation.set(r.association_id, []);
    rowsByAssociation.get(r.association_id).push(r);
  }

  const totalDocs = entityDocumentCount(entityId, { since: windowStart });
  const currentDocs = entityDocumentCount(entityId, { since: currentStart });
  const historicalDocs = entityDocumentCount(entityId, { since: windowStart, until: currentStart });

  const lifetimeComponents = {};
  const currentComponents = {};
  const historicalComponents = {};

  for (const association of associations) {
    const rows = rowsByAssociation.get(association.id) ?? [];
    const currentRows = rows.filter((r) => r.effective_date && r.effective_date >= currentStart);
    const historicalRows = rows.filter((r) => !r.effective_date || r.effective_date < currentStart);

    lifetimeComponents[association.id] = associationComponents(
      rows.map(toComponentDoc),
      { entityDocumentCount: totalDocs, halfLifeDays: halfLife, now },
      overrides
    );
    currentComponents[association.id] = associationComponents(
      currentRows.map(toComponentDoc),
      { entityDocumentCount: currentDocs, halfLifeDays: halfLife, now },
      overrides
    );
    historicalComponents[association.id] = associationComponents(
      historicalRows.map(toComponentDoc),
      { entityDocumentCount: historicalDocs, halfLifeDays: halfLife, now },
      overrides
    );
  }

  /**
   * §77's comparison needs the corpus and the SERP expressed on the same base.
   * Corpus share (§37) is share of *documents*, and one document supports
   * several associations, so those shares sum well past 100%. The Google
   * Retrieval Score is a share of first-page weight and sums to 100%.
   * Comparing them directly makes every association look under-served.
   *
   * So we also compute each association's share of the entity's total
   * association evidence mass, which sums to 100% by construction and is the
   * honest counterpart to GRS. Corpus share stays as the brief defines it.
   */
  const currentMass = Object.fromEntries(
    associations.map((a) => [a.id, currentComponents[a.id].historicalEvidence ?? 0])
  );
  const totalCurrentMass = Object.values(currentMass).reduce((a, b) => a + b, 0);

  const lifetimePias = composePias(lifetimeComponents, overrides);
  const currentPias = composePias(currentComponents, overrides);
  const historicalPias = composePias(historicalComponents, overrides);
  const grs = googleRetrievalFor(entityId);

  const period = overrides.momentum?.periodDays ?? MODEL.momentum.periodDays;

  // An identity marker co-occurs with the entity by construction — "New York"
  // appears in every document precisely because we used it to decide the
  // documents were about this John Smith. Those rows are real associations and
  // stay on the board, but they are flagged so the UI can separate them from
  // findings, and so nobody reads a tautology as a discovery.
  const markerValues = new Set(
    all(`SELECT value FROM entity_identity_markers WHERE entity_id = ? AND polarity = 1`, entityId)
      .map((m) => String(m.value).toLowerCase())
  );

  const rows = associations.map((association) => {
    const docs = rowsByAssociation.get(association.id) ?? [];
    const lifetime = lifetimeComponents[association.id];
    const current = currentComponents[association.id];
    const historical = historicalComponents[association.id];

    const mom = momentumFor(entityId, association.id, { now, periodDays: period });
    const sentiment = aggregateSentiment(docs.map(toComponentDoc));

    return {
      association_id: association.id,
      label: association.canonical_label,
      kind: association.kind,
      category: association.category,
      parent_id: association.parent_id,
      is_identity_marker: markerValues.has(association.canonical_label.toLowerCase()),

      // §79's metric names, all present and all distinct.
      pias: lifetimePias[association.id].pias,
      pias_components: lifetimePias[association.id].components,
      current_pias: currentPias[association.id].pias,
      historical_pias: historicalPias[association.id].pias,
      google_retrieval_score: grs.scores[association.id]?.grs ?? null,

      documents: lifetime.documents,
      domains: lifetime.domains,
      raw_mentions: lifetime.rawMentions,
      independent_sources: lifetime.independentSources,
      authority_evidence: lifetime.authorityEvidence,

      current_documents: current.documents,
      current_domains: current.domains,

      corpus_share: lifetime.corpusShare,
      current_corpus_share: current.corpusShare,
      historical_corpus_share: historical.corpusShare,
      // Share of the entity's current association mass. Sums to 1 across
      // associations, so it is directly comparable with the SERP's share.
      current_association_share: round(safeDiv(currentMass[association.id], totalCurrentMass, 0), 4),

      recency_ratio: lifetime.recencyRatio,
      ...conditionalScores({
        coOccurrence: lifetime.documents,
        entityDocuments: totalDocs,
        associationDocuments: association.corpus_total_count ?? null,
      }),

      momentum: mom,
      trend: mom.arrow,
      freshness: freshness(docs, now),
      sentiment,
    };
  });

  rows.sort((a, b) => b.pias - a.pias);

  return {
    entity,
    generated_at: new Date(now).toISOString(),
    window_days: windowDays,
    half_life_days: halfLife,
    current_window_days: currentWindow,
    current_window_start: currentStart,
    entity_documents: totalDocs,
    current_entity_documents: currentDocs,
    historical_entity_documents: historicalDocs,
    serp: { classified_weight: grs.classified_weight, unclassified_share: grs.unclassified_share, snapshot_at: grs.snapshot_at },
    associations: rows,
  };
}

/**
 * §40/§41 — momentum. Weighted evidence in the last period against the period
 * before it, normalised by the entity's overall volume in each so a general
 * rise in coverage does not read as a rise in every association.
 */
export function momentumFor(entityId, associationId, { now = Date.now(), periodDays = MODEL.momentum.periodDays } = {}) {
  const startCurrent = new Date(now - periodDays * DAY_MS).toISOString();
  const startPrevious = new Date(now - 2 * periodDays * DAY_MS).toISOString();

  const weightIn = (from, to) =>
    get(
      `SELECT COALESCE(SUM(s.document_evidence_undecayed), 0) AS w
         FROM association_document_scores s
         JOIN documents d ON d.id = s.document_id
        WHERE s.association_id = ? AND COALESCE(d.published_at, d.group_date) >= ?
          AND COALESCE(d.published_at, d.group_date) < ?`,
      associationId,
      from,
      to
    )?.w ?? 0;

  const entityWeightIn = (from, to) =>
    get(
      `SELECT COALESCE(SUM(s.document_evidence_undecayed), 0) AS w
         FROM association_document_scores s
         JOIN documents d ON d.id = s.document_id
        WHERE s.entity_id = ? AND COALESCE(d.published_at, d.group_date) >= ?
          AND COALESCE(d.published_at, d.group_date) < ?`,
      entityId,
      from,
      to
    )?.w ?? 0;

  const nowIso = new Date(now).toISOString();
  return momentum({
    current: weightIn(startCurrent, nowIso),
    previous: weightIn(startPrevious, startCurrent),
    currentEntityTotal: entityWeightIn(startCurrent, nowIso),
    previousEntityTotal: entityWeightIn(startPrevious, startCurrent),
  });
}

// --- §47 Timeline -----------------------------------------------------------

/**
 * Association share by month — the view that makes Current Entity State
 * Replacement visible. Share is of the entity's monthly evidence, so a quiet
 * month does not make every association look weak.
 */
export function timeline(entityId, { months = 36, now = Date.now() } = {}) {
  const since = new Date(now - months * 30.44 * DAY_MS).toISOString();
  const rows = all(
    `SELECT s.association_id, a.canonical_label, a.kind,
            substr(COALESCE(d.published_at, d.group_date), 1, 7) AS month,
            COUNT(DISTINCT s.document_id) AS documents,
            SUM(s.document_evidence_undecayed) AS evidence
       FROM association_document_scores s
       JOIN documents d ON d.id = s.document_id
       JOIN associations a ON a.id = s.association_id
      WHERE s.entity_id = ? AND COALESCE(d.published_at, d.group_date) >= ?
        AND a.status = 'active'
      GROUP BY s.association_id, month
      ORDER BY month`,
    entityId,
    since
  ).filter((r) => r.month);

  const byMonth = new Map();
  for (const r of rows) {
    if (!byMonth.has(r.month)) byMonth.set(r.month, []);
    byMonth.get(r.month).push(r);
  }

  const series = [];
  for (const [month, entries] of [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const total = entries.reduce((a, e) => a + (e.evidence ?? 0), 0);
    series.push({
      month,
      total_evidence: round(total, 4),
      associations: entries
        .map((e) => ({
          association_id: e.association_id,
          label: e.canonical_label,
          documents: e.documents,
          evidence: round(e.evidence ?? 0, 4),
          share: round(safeDiv(e.evidence ?? 0, total, 0), 4),
        }))
        .sort((a, b) => b.evidence - a.evidence),
    });
  }
  return series;
}

/** Persists the monthly rollup so §55's correlation study has a history. */
export function persistMonthlyMetrics(entityId, { now = Date.now() } = {}) {
  const series = timeline(entityId, { months: 120, now });
  return tx(() => {
    let written = 0;
    for (const point of series) {
      for (const a of point.associations) {
        const domains = get(
          `SELECT COUNT(DISTINCT d.root_domain) AS n
             FROM association_document_scores s JOIN documents d ON d.id = s.document_id
            WHERE s.association_id = ? AND substr(COALESCE(d.published_at, d.group_date), 1, 7) = ?`,
          a.association_id,
          point.month
        )?.n ?? 0;
        run(
          `INSERT INTO association_metrics_monthly (entity_id, association_id, month, documents, domains, raw_mentions, evidence_sum, share)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(association_id, month) DO UPDATE SET
             documents = excluded.documents, domains = excluded.domains,
             evidence_sum = excluded.evidence_sum, share = excluded.share`,
          entityId,
          a.association_id,
          point.month,
          a.documents,
          domains,
          a.evidence,
          a.share
        );
        written += 1;
      }
    }
    return { written, months: series.length };
  });
}

// --- SERP scores (read side; capture lives in serp.js) ----------------------

export function googleRetrievalFor(entityId) {
  const snapshot = get(
    `SELECT * FROM serp_snapshots WHERE entity_id = ? AND query_kind = 'entity'
      ORDER BY captured_at DESC LIMIT 1`,
    entityId
  );
  if (!snapshot) return { scores: {}, classified_weight: 0, unclassified_share: null, snapshot_at: null };

  const results = all(
    `SELECT r.id, r.rank FROM serp_results r WHERE r.snapshot_id = ? ORDER BY r.rank`,
    snapshot.id
  );
  const links = all(
    `SELECT ra.serp_result_id, ra.association_id FROM serp_result_associations ra
       JOIN serp_results r ON r.id = ra.serp_result_id WHERE r.snapshot_id = ?`,
    snapshot.id
  );
  const byResult = new Map();
  for (const link of links) {
    if (!byResult.has(link.serp_result_id)) byResult.set(link.serp_result_id, []);
    byResult.get(link.serp_result_id).push(link.association_id);
  }

  const shaped = results.map((r) => ({ rank: r.rank, associationIds: byResult.get(r.id) ?? [] }));
  return { ...googleRetrievalScores(shaped), snapshot_at: snapshot.captured_at };
}

export { freshness, percentileMap, MOMENTUM_ARROWS, monthKey, parseDate };
