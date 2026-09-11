import { Router, ok, readJson, badRequest, notFound, intParam, serveCsv } from '../http.js';
import { all, get, run } from '../db.js';
import { rescoreEntity } from '../services/metrics.js';
import { mergeAssociations, splitAssociation } from '../services/canonicalize.js';
import { setManualVerdict } from '../services/disambiguation.js';
import { clusterMembers } from '../services/duplicates.js';
import { relatedAssociations, disjointAssociations } from '../services/related.js';
import { diagnoseEmptyEntity } from '../services/diagnosis.js';
import { llmStatus } from '../providers/llm/index.js';
import { listProviders } from '../providers/corpus/index.js';
import '../providers/corpus/providers.js';
import * as dfs from '../providers/dataforseo.js';
import config, { SCORE_DISCLAIMER, MODEL } from '../config.js';

export const evidenceRoutes = new Router();

/**
 * Why an entity's dashboard is empty. Asked by the dashboard itself when it
 * has nothing to draw, so "the build completed and there is nothing here" is
 * never left as a puzzle for the person who paid for it.
 */
evidenceRoutes.get('/api/entities/:id/diagnosis', (req, res, params) => {
  const result = diagnoseEmptyEntity(Number(params.id));
  if (!result) throw notFound('entity not found');
  ok(res, result);
});

/**
 * §17 — what this association travels with, and what carries it.
 *
 * Separate from the evidence route because it answers a different question:
 * not "why does this score what it scores" but "is this actually about the
 * entity, or is it inherited from something else the entity is attached to".
 */
evidenceRoutes.get('/api/associations/:id/related', (req, res, params, url) => {
  const result = relatedAssociations(Number(params.id), {
    limit: intParam(url, 'limit', 25, { min: 1, max: 100 }),
    floor: intParam(url, 'floor', 2, { min: 1, max: 50 }),
  });
  if (!result) throw notFound('association not found');
  ok(res, { ...result, disjoint: disjointAssociations(Number(params.id)) });
});

/**
 * §48 — the evidence explorer. Every column the brief lists is here, because
 * the point of the screen is that a score can be taken apart: if an analyst
 * cannot see why philanthropy scores 86, the number is an assertion.
 */
evidenceRoutes.get('/api/associations/:id/evidence', (req, res, params, url) => {
  const association = get(`SELECT * FROM associations WHERE id = ?`, Number(params.id));
  if (!association) throw notFound('association not found');

  const includeExcluded = url.searchParams.get('include_excluded') === '1';
  const rows = all(
    `SELECT e.*, d.url, d.root_domain, d.title, d.published_at AS doc_published, d.group_date,
            d.duplicate_cluster_id, d.is_cluster_primary, d.fetch_status,
            dom.classification, dom.classification_override, c.kind AS cluster_kind, c.member_count
       FROM evidence e
       JOIN documents d ON d.id = e.document_id
       LEFT JOIN domains dom ON dom.root_domain = d.root_domain
       LEFT JOIN document_duplicate_clusters c ON c.id = d.duplicate_cluster_id
      WHERE e.association_id = ? AND (? = 1 OR e.excluded = 0)
      ORDER BY e.evidence_score DESC
      LIMIT ?`,
    association.id,
    includeExcluded ? 1 : 0,
    intParam(url, 'limit', 200, { min: 1, max: 2000 })
  );

  const shaped = rows.map((r) => ({
    evidence_id: r.id,
    document_id: r.document_id,
    date: r.published_at ?? r.doc_published ?? r.group_date,
    date_is_inferred: !r.doc_published && Boolean(r.group_date),
    source: r.root_domain,
    url: r.url,
    title: r.title,
    evidence_text: r.evidence_text,
    surface_form: r.surface_form,
    relationship: r.relationship,
    entity_confidence: r.entity_confidence,
    relationship_confidence: r.relationship_confidence,
    token_distance: r.token_distance,
    boundary: r.boundary,
    proximity: r.proximity_score,
    source_reliability: r.source_reliability,
    source_classification: r.classification_override ?? r.classification,
    independence_weight: r.independence_weight,
    recency_weight: r.recency_weight,
    mention_cap_weight: r.mention_cap_weight,
    occurrence_index: r.occurrence_index,
    duplicate_cluster_id: r.duplicate_cluster_id,
    duplicate_kind: r.cluster_kind,
    cluster_size: r.member_count,
    is_cluster_primary: Boolean(r.is_cluster_primary),
    sentiment:
      r.sentiment_negative > r.sentiment_positive ? 'negative' : r.sentiment_positive > 0 ? 'positive' : 'neutral',
    weighted_evidence_score: r.evidence_score,
    extractor: r.extractor,
    manually_verified: Boolean(r.manually_verified),
    excluded: Boolean(r.excluded),
    exclusion_reason: r.exclusion_reason,
    fetch_status: r.fetch_status,
  }));

  if (url.searchParams.get('format') === 'csv') {
    return serveCsv(res, `association-${association.id}-evidence.csv`, shaped);
  }

  ok(res, {
    disclaimer: SCORE_DISCLAIMER,
    association,
    surface_forms: all(
      `SELECT surface_form, occurrences FROM association_aliases WHERE association_id = ? ORDER BY occurrences DESC`,
      association.id
    ),
    evidence: shaped,
  });
});

evidenceRoutes.get('/api/clusters/:id', (req, res, params) => {
  ok(res, { members: clusterMembers(Number(params.id)) });
});

/**
 * §74 — the manual QA actions. Every one writes a manual_reviews row as well
 * as making the change, so corrections survive a rescore and can be replayed
 * or audited later.
 */
evidenceRoutes.post('/api/review', async (req, res) => {
  const body = await readJson(req);
  const { action, entity_id: entityId } = body;
  if (!action) throw badRequest('action is required');
  const reviewer = body.reviewer ?? 'analyst';
  let result;

  switch (action) {
    case 'wrong_entity': {
      requireIds(body, ['entity_id', 'document_id']);
      result = setManualVerdict(entityId, body.document_id, 'reject', reviewer);
      run(`UPDATE evidence SET excluded = 1, exclusion_reason = 'wrong entity' WHERE entity_id = ? AND document_id = ?`, entityId, body.document_id);
      break;
    }
    case 'right_entity': {
      requireIds(body, ['entity_id', 'document_id']);
      result = setManualVerdict(entityId, body.document_id, 'accept', reviewer);
      run(`UPDATE evidence SET excluded = 0, exclusion_reason = NULL WHERE entity_id = ? AND document_id = ?`, entityId, body.document_id);
      break;
    }
    case 'exclude_evidence': {
      requireIds(body, ['evidence_id']);
      run(`UPDATE evidence SET excluded = 1, exclusion_reason = ? WHERE id = ?`, body.reason ?? 'excluded by reviewer', body.evidence_id);
      result = { evidence_id: body.evidence_id, excluded: true };
      break;
    }
    case 'include_evidence': {
      requireIds(body, ['evidence_id']);
      run(`UPDATE evidence SET excluded = 0, exclusion_reason = NULL, manually_verified = 1 WHERE id = ?`, body.evidence_id);
      result = { evidence_id: body.evidence_id, excluded: false };
      break;
    }
    case 'exclude_source': {
      requireIds(body, ['entity_id', 'root_domain']);
      run(
        `UPDATE evidence SET excluded = 1, exclusion_reason = 'source excluded'
          WHERE entity_id = ? AND document_id IN (SELECT id FROM documents WHERE root_domain = ?)`,
        entityId,
        body.root_domain
      );
      result = { root_domain: body.root_domain, excluded: true };
      break;
    }
    case 'set_source_tier': {
      requireIds(body, ['root_domain', 'classification']);
      if (!Object.keys(MODEL.reliability.classification).includes(body.classification)) {
        throw badRequest(`classification must be one of ${Object.keys(MODEL.reliability.classification).join(', ')}`);
      }
      run(
        `INSERT INTO domains (root_domain, classification_override) VALUES (?, ?)
         ON CONFLICT(root_domain) DO UPDATE SET classification_override = excluded.classification_override, updated_at = datetime('now')`,
        body.root_domain,
        body.classification
      );
      result = { root_domain: body.root_domain, classification: body.classification };
      break;
    }
    case 'merge_association': {
      requireIds(body, ['target_id', 'source_id']);
      result = mergeAssociations(Number(body.target_id), Number(body.source_id), { reviewer });
      if (result.error) throw badRequest(result.error);
      break;
    }
    case 'split_association': {
      requireIds(body, ['association_id', 'surface_form']);
      result = splitAssociation(Number(body.association_id), body.surface_form, { reviewer });
      if (result.error) throw badRequest(result.error);
      break;
    }
    case 'recategorise': {
      requireIds(body, ['association_id', 'category']);
      run(`UPDATE associations SET category = ?, updated_at = datetime('now') WHERE id = ?`, body.category, body.association_id);
      result = { association_id: body.association_id, category: body.category };
      break;
    }
    case 'exclude_association': {
      requireIds(body, ['association_id']);
      run(`UPDATE associations SET status = 'excluded' WHERE id = ?`, body.association_id);
      result = { association_id: body.association_id, status: 'excluded' };
      break;
    }
    default:
      throw badRequest(`unknown action ${action}`);
  }

  if (entityId) {
    run(
      `INSERT INTO manual_reviews (entity_id, target_kind, target_id, action, payload, reviewer, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      entityId,
      body.target_kind ?? inferTargetKind(action),
      Number(body.document_id ?? body.evidence_id ?? body.association_id ?? 0),
      action,
      JSON.stringify(body),
      reviewer,
      body.note ?? null
    );
    // Corrections change scores, so rescore immediately rather than leaving
    // the dashboard disagreeing with the evidence explorer.
    if (body.rescore !== false) rescoreEntity(entityId);
  }

  ok(res, { action, result });
});

function requireIds(body, fields) {
  for (const field of fields) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      throw badRequest(`${field} is required for this action`);
    }
  }
}

const inferTargetKind = (action) => {
  if (action.includes('association')) return 'association';
  if (action.includes('source')) return 'domain';
  if (action.includes('evidence')) return 'evidence';
  return 'document';
};

/** The manual review queue: §8's 0.40–0.69 band, oldest first. */
evidenceRoutes.get('/api/entities/:id/review-queue', (req, res, params, url) => {
  const entityId = Number(params.id);
  const rows = all(
    `SELECT m.*, d.url, d.root_domain, d.title, d.snippet, d.published_at, d.group_date
       FROM entity_document_matches m JOIN documents d ON d.id = m.document_id
      WHERE m.entity_id = ? AND m.verdict = 'review' AND m.manual_verdict IS NULL
      ORDER BY m.entity_confidence DESC LIMIT ?`,
    entityId,
    intParam(url, 'limit', 50, { min: 1, max: 500 })
  );
  ok(res, {
    queue: rows.map((r) => ({ ...r, reasons: safeParse(r.reasons) })),
    thresholds: MODEL.entityConfidence,
  });
});

evidenceRoutes.get('/api/entities/:id/reviews', (req, res, params) => {
  ok(res, {
    reviews: all(
      `SELECT * FROM manual_reviews WHERE entity_id = ? ORDER BY created_at DESC LIMIT 200`,
      Number(params.id)
    ).map((r) => ({ ...r, payload: safeParse(r.payload) })),
  });
});

const safeParse = (v) => {
  try { return JSON.parse(v); } catch { return v; }
};

// --- Settings ---------------------------------------------------------------

evidenceRoutes.get('/api/settings', async (req, res) => {
  ok(res, {
    disclaimer: SCORE_DISCLAIMER,
    model: MODEL,
    // The system-wide ceilings (§66). Shown as placeholders wherever a
    // per-entity ceiling can be set, so "blank" reads as a value rather than
    // as "no limit".
    limits: config.limits,
    llm: llmStatus(),
    corpus_providers: listProviders(),
    dataforseo_configured: dfs.isConfigured(),
  });
});

evidenceRoutes.get('/api/settings/dataforseo', async (req, res) => {
  if (!dfs.isConfigured()) return ok(res, { configured: false });
  try {
    ok(res, { configured: true, ...(await dfs.ping()) });
  } catch (err) {
    ok(res, { configured: true, ok: false, error: err.message });
  }
});

evidenceRoutes.get('/api/usage', (req, res, params, url) => {
  const entityId = url.searchParams.get('entity_id');
  ok(res, {
    by_provider: all(
      `SELECT provider, endpoint, COUNT(*) AS calls, SUM(cached) AS cached,
              SUM(cost_usd) AS cost_usd, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
              SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures
         FROM api_usage WHERE (? IS NULL OR entity_id = ?)
        GROUP BY provider, endpoint ORDER BY cost_usd DESC`,
      entityId,
      entityId
    ),
    recent_failures: all(
      `SELECT provider, endpoint, detail, created_at FROM api_usage
        WHERE ok = 0 AND (? IS NULL OR entity_id = ?) ORDER BY id DESC LIMIT 20`,
      entityId,
      entityId
    ),
  });
});
