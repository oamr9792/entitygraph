import { all, get } from '../db.js';
import { canonicaliseUrl } from '../util/hash.js';
import { traceStage, describeRead, needsFullRead, STAGE_ORDER } from './serp-coverage.js';

/**
 * Google's results for the client's name, each traced through the build:
 * collected, identity-checked, read, extracted. The question it answers is the
 * one an analyst asks when a page they can see on Google is missing from the
 * evidence — which step lost it, and why.
 */

const DOC_SQL = `SELECT id, url, fetch_status, body_chars, provider, provider_ref FROM documents`;

export function googlePageTrace(entityId, { limit = 30 } = {}) {
  const snapshot = get(
    `SELECT id, query, captured_at FROM serp_snapshots
      WHERE entity_id = ? AND query_kind = 'entity' ORDER BY captured_at DESC LIMIT 1`,
    entityId
  );
  if (!snapshot) {
    return {
      available: false,
      reason: 'No Google snapshot for this client yet. Build, or capture Google results from the Google overlay.',
    };
  }

  const results = all(
    `SELECT rank, url, root_domain, title, document_id FROM serp_results WHERE snapshot_id = ? ORDER BY rank LIMIT ?`,
    snapshot.id,
    limit
  );

  const rows = results.map((r) => {
    const doc = r.document_id
      ? get(`${DOC_SQL} WHERE id = ?`, r.document_id)
      : get(`${DOC_SQL} WHERE url = ? OR canonical_url = ?`, r.url, canonicaliseUrl(r.url));
    const match = doc
      ? get(
          `SELECT verdict, entity_confidence, method, reasons, manual_verdict FROM entity_document_matches
            WHERE entity_id = ? AND document_id = ?`,
          entityId,
          doc.id
        )
      : null;
    const evidence = doc
      ? get(
          `SELECT COUNT(*) AS rows, COALESCE(SUM(CASE WHEN extractor = 'heuristic' THEN 1 ELSE 0 END), 0) AS heuristic
             FROM evidence WHERE entity_id = ? AND document_id = ? AND excluded = 0`,
          entityId,
          doc.id
        )
      : { rows: 0, heuristic: 0 };
    const associations = doc && evidence.rows
      ? all(
          `SELECT a.id AS association_id, a.canonical_label AS label
             FROM evidence e JOIN associations a ON a.id = e.association_id
            WHERE e.entity_id = ? AND e.document_id = ? AND e.excluded = 0 AND a.status = 'active'
            GROUP BY a.id ORDER BY MAX(e.evidence_score) DESC LIMIT 5`,
          entityId,
          doc.id
        )
      : [];
    const { stage, text } = traceStage({ doc, match, evidence });

    return {
      rank: r.rank,
      url: r.url,
      domain: r.root_domain,
      title: r.title,
      document_id: doc?.id ?? null,
      read: describeRead(doc),
      fully_read: doc ? !needsFullRead(doc) : false,
      verdict: match?.verdict ?? null,
      confidence: match?.entity_confidence ?? null,
      manual: Boolean(match?.manual_verdict),
      evidence_rows: evidence.rows,
      fallback_rows: evidence.heuristic,
      associations,
      stage,
      explanation: text,
    };
  });

  const counts = Object.fromEntries(STAGE_ORDER.map((s) => [s, rows.filter((r) => r.stage === s).length]));
  const top = rows.filter((r) => r.rank <= 10);
  return {
    available: true,
    snapshot: { id: snapshot.id, query: snapshot.query, captured_at: snapshot.captured_at },
    results: rows,
    counts,
    top_ten: top.length,
    top_ten_with_evidence: top.filter((r) => r.stage === 'evidence' || r.stage === 'fallback_only').length,
  };
}
