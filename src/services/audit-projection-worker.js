import { parentPort, workerData } from 'node:worker_threads';

/**
 * §99 C8 — score a draft as if it were a member of the corpus, then throw the
 * corpus away.
 *
 * Runs in a worker because it is several seconds of synchronous work: rescore
 * the entity and read its leaderboard twice, once as it is and once with the
 * draft added as an accepted document. Both runs happen inside transactions
 * that are always rolled back, at the same `now`, so the difference is the
 * draft and not the passage of time since the last rescore.
 */

const { rolledBack, run } = await import('../db.js');
const { rescoreEntity, leaderboard } = await import('./metrics.js');
const { upsertAssociation } = await import('./canonicalize.js');
const { upsertDocument } = await import('./ingest.js');

const { entityId, text, title, hostDomain, associations, now } = workerData;

const snapshot = () =>
  (leaderboard(entityId, { now })?.associations ?? []).map((a) => [
    a.association_id,
    { label: a.label, pias: a.pias, current_pias: a.current_pias },
  ]);

const baseline = rolledBack(() => {
  rescoreEntity(entityId, { now });
  return snapshot();
});

const projected = rolledBack(() => {
  const domain = hostDomain || 'audit-projection.invalid';
  // Every column explicit: node:sqlite refuses to bind undefined.
  const { id: documentId } = upsertDocument({
    url: `https://${domain}/__entitygraph_audit_projection/${now}`,
    root_domain: domain,
    title: title ?? null,
    main_title: null,
    previous_heading: null,
    semantic_location: null,
    page_type: null,
    language: null,
    country: null,
    snippet: text.slice(0, 500),
    url_rank: null,
    domain_rank: null,
    spam_score: null,
    content_quality: null,
    prominence_raw: null,
    sentiment_positive: null,
    sentiment_negative: null,
    sentiment_neutral: null,
    provider: 'audit_projection',
    provider_ref: null,
    published_at: new Date(now).toISOString(),
    group_date: null,
    fetched_at: null,
  });
  run(
    `UPDATE documents SET body_text = ?, body_chars = ?, fetch_status = 'fetched' WHERE id = ?`,
    text.slice(0, 60000),
    Math.min(text.length, 60000),
    documentId
  );
  run(
    `INSERT INTO entity_document_matches (entity_id, document_id, entity_confidence, verdict, method)
     VALUES (?, ?, 0.95, 'accept', 'audit_projection')`,
    entityId,
    documentId
  );

  const occurrences = new Map();
  for (const a of associations) {
    const associationId = upsertAssociation(entityId, { canonical_label: a.canonical_label, kind: a.kind, category: a.category });
    if (!associationId) continue;
    const index = occurrences.get(associationId) ?? 0;
    occurrences.set(associationId, index + 1);
    run(
      `INSERT INTO evidence
         (entity_id, association_id, document_id, surface_form, relationship, evidence_text, occurrence_index,
          entity_confidence, relationship_confidence, token_distance, boundary, proximity_score,
          sentiment_positive, sentiment_negative, sentiment_neutral, source_reliability, recency_weight,
          independence_weight, evidence_score, published_at, extractor)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0.95, ?, ?, ?, 0, ?, ?, ?, 0, 1, 1, 0, ?, ?)`,
      entityId,
      associationId,
      documentId,
      a.surface_form ?? a.canonical_label,
      a.relationship ?? 'mentioned_with',
      a.evidence ?? a.canonical_label,
      index,
      a.relationship_confidence ?? 0.5,
      a.token_distance ?? null,
      a.boundary ?? 'same_paragraph',
      a.sentiment === 'positive' ? 1 : 0,
      a.sentiment === 'negative' ? 1 : 0,
      a.sentiment === 'positive' || a.sentiment === 'negative' ? 0 : 1,
      new Date(now).toISOString(),
      a.extractor ?? 'llm'
    );
  }

  rescoreEntity(entityId, { now });
  return snapshot();
});

parentPort.postMessage({ baseline, projected });
