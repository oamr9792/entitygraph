import { Router, ok, readJson, badRequest, notFound, intParam, serveCsv } from '../http.js';
import { all, get } from '../db.js';
import { SCORE_DISCLAIMER, MODEL } from '../config.js';
import { getEntity } from '../services/identity.js';
import { leaderboard, timeline, rescoreEntity, momentumFor } from '../services/metrics.js';
import { entityState, compareAssociations, oldVsCurrent, gaps, narrative } from '../services/insights.js';
import { coverageConfidence } from '../services/coverage.js';
import { retrievalOverlay, retrievalGap, captureEntitySerp, classifySnapshot } from '../services/serp.js';
import { listAlerts, acknowledgeAlert, snapshotSeries, storeSnapshot } from '../services/alerts.js';
import { hierarchyFor } from '../services/canonicalize.js';

export const analysisRoutes = new Router();

/**
 * §49 — the global time control. Every read route accepts the same window
 * parameters and applies them the same way, so the control genuinely governs
 * the whole screen rather than each panel interpreting it differently.
 */
function windowOptions(url) {
  const windowDays = url.searchParams.get('window');
  const halfLife = url.searchParams.get('half_life');
  const cutoff = url.searchParams.get('cutoff');
  const allowed = MODEL.recency.allowedHalfLives;
  if (halfLife && !allowed.includes(Number(halfLife))) {
    throw badRequest(`half_life must be one of ${allowed.join(', ')}`);
  }
  return {
    windowDays: windowDays && windowDays !== 'all' ? Number(windowDays) : null,
    halfLifeDays: halfLife ? Number(halfLife) : null,
    cutoff: cutoff || null,
  };
}

/** The §44 dashboard: state header, leaderboard, coverage and the §75 summary. */
analysisRoutes.get('/api/entities/:id/dashboard', (req, res, params, url) => {
  const entity = getEntity(Number(params.id));
  const options = windowOptions(url);
  const board = leaderboard(entity.id, options);
  const coverage = coverageConfidence(entity.id);
  ok(res, {
    disclaimer: SCORE_DISCLAIMER,
    state: entityState(entity.id),
    leaderboard: board,
    coverage,
    narrative: narrative(entity.id, { coverage }),
    hierarchy: hierarchyFor(entity.id),
    alerts: listAlerts(entity.id, { limit: 10 }),
  });
});

analysisRoutes.get('/api/entities/:id/leaderboard', (req, res, params, url) => {
  const entity = getEntity(Number(params.id));
  const board = leaderboard(entity.id, windowOptions(url));
  if (url.searchParams.get('format') === 'csv') {
    return serveCsv(
      res,
      `${entity.canonical_name.replace(/\W+/g, '-').toLowerCase()}-associations.csv`,
      board.associations.map((a) => ({
        association: a.label,
        kind: a.kind,
        category: a.category,
        pias: a.pias,
        current_pias: a.current_pias,
        historical_pias: a.historical_pias,
        google_retrieval_score: a.google_retrieval_score,
        documents: a.documents,
        domains: a.domains,
        independent_sources: a.independent_sources,
        raw_mentions: a.raw_mentions,
        corpus_share: a.corpus_share,
        current_corpus_share: a.current_corpus_share,
        median_age: a.freshness.median_age,
        latest_mention: a.freshness.latest_mention_age,
        momentum: a.momentum.arrow,
        momentum_change: a.momentum.basis,
        sentiment: a.sentiment.label,
      }))
    );
  }
  ok(res, { disclaimer: SCORE_DISCLAIMER, ...board });
});

analysisRoutes.get('/api/entities/:id/timeline', (req, res, params, url) => {
  const entity = getEntity(Number(params.id));
  ok(res, { timeline: timeline(entity.id, { months: intParam(url, 'months', 36, { min: 3, max: 240 }) }) });
});

/** §46 — the graph view's data. Node size and edge thickness come from PIAS. */
analysisRoutes.get('/api/entities/:id/graph', (req, res, params, url) => {
  const entity = getEntity(Number(params.id));
  const board = leaderboard(entity.id, windowOptions(url));
  const limit = intParam(url, 'limit', 25, { min: 5, max: 100 });
  const rows = board.associations.slice(0, limit);
  ok(res, {
    center: { id: `entity:${entity.id}`, label: entity.canonical_name, type: 'entity' },
    nodes: rows.map((a) => ({
      id: `assoc:${a.association_id}`,
      association_id: a.association_id,
      label: a.label,
      kind: a.kind,
      category: a.category,
      size: a.pias,
      current: a.current_pias,
      sentiment: a.sentiment.label,
      parent_id: a.parent_id ? `assoc:${a.parent_id}` : null,
    })),
    edges: rows.map((a) => ({
      source: `entity:${entity.id}`,
      target: `assoc:${a.association_id}`,
      pias: a.pias,
      current_pias: a.current_pias,
      sentiment: a.sentiment.label,
      documents: a.documents,
    })),
  });
});

/** §50 — historical state versus current state at a chosen cutoff. */
analysisRoutes.get('/api/entities/:id/old-vs-current', (req, res, params, url) => {
  const entity = getEntity(Number(params.id));
  ok(res, oldVsCurrent(entity.id, { cutoff: url.searchParams.get('cutoff') || null }));
});

/** §51 — the competition view. */
analysisRoutes.get('/api/entities/:id/compare', (req, res, params, url) => {
  const entity = getEntity(Number(params.id));
  const ids = (url.searchParams.get('associations') ?? '').split(',').filter(Boolean).map(Number);
  if (ids.length < 2) throw badRequest('pass ?associations=id,id');
  ok(res, compareAssociations(entity.id, ids, windowOptions(url)));
});

/** §59, §60 — gap finder and campaign priorities. */
analysisRoutes.get('/api/entities/:id/gaps', (req, res, params, url) => {
  const entity = getEntity(Number(params.id));
  ok(res, gaps(entity.id, windowOptions(url)));
});

analysisRoutes.get('/api/entities/:id/coverage', (req, res, params) => {
  const entity = getEntity(Number(params.id));
  ok(res, coverageConfidence(entity.id));
});

// --- SERP (§13, §52) --------------------------------------------------------

analysisRoutes.get('/api/entities/:id/serp', (req, res, params, url) => {
  const entity = getEntity(Number(params.id));
  const overlay = retrievalOverlay(entity.id, {
    snapshotId: url.searchParams.get('snapshot') ? Number(url.searchParams.get('snapshot')) : null,
  });
  if (!overlay) return ok(res, { overlay: null, note: 'No SERP snapshot captured for this entity yet.' });
  const board = leaderboard(entity.id, {});
  ok(res, {
    overlay,
    gap: retrievalGap(entity.id, board.associations),
    snapshots: all(
      `SELECT id, query, query_kind, captured_at, depth FROM serp_snapshots WHERE entity_id = ? ORDER BY captured_at DESC LIMIT 20`,
      entity.id
    ),
  });
});

analysisRoutes.post('/api/entities/:id/serp', async (req, res, params) => {
  const entity = getEntity(Number(params.id));
  const body = await readJson(req);
  const snapshot = await captureEntitySerp(entity.id, body.query ?? entity.canonical_name, {
    depth: body.depth ?? 100,
    location: body.location,
    language: body.language,
    force: body.force,
  });
  const classified = await classifySnapshot(entity.id, snapshot.snapshot_id, { useLlm: body.use_llm !== false });
  ok(res, { snapshot, classified, overlay: retrievalOverlay(entity.id) });
});

// --- Snapshots, alerts, rescore ---------------------------------------------

analysisRoutes.get('/api/entities/:id/snapshots', (req, res, params) => {
  const entity = getEntity(Number(params.id));
  ok(res, snapshotSeries(entity.id));
});

analysisRoutes.post('/api/entities/:id/snapshots', (req, res, params) => {
  const entity = getEntity(Number(params.id));
  const coverage = coverageConfidence(entity.id);
  ok(res, storeSnapshot(entity.id, { coverage }));
});

analysisRoutes.get('/api/entities/:id/alerts', (req, res, params, url) => {
  const entity = getEntity(Number(params.id));
  ok(res, { alerts: listAlerts(entity.id, { includeAcknowledged: url.searchParams.get('all') === '1' }) });
});

analysisRoutes.post('/api/alerts/:id/acknowledge', (req, res, params) => {
  acknowledgeAlert(Number(params.id));
  ok(res, { acknowledged: Number(params.id) });
});

/**
 * §30/§56 — rescore with different model parameters. Because every factor is
 * stored per evidence row, this is a recomputation rather than a rebuild: no
 * provider calls, no cost, seconds not hours.
 */
analysisRoutes.post('/api/entities/:id/rescore', async (req, res, params) => {
  const entity = getEntity(Number(params.id));
  const body = await readJson(req);
  const result = rescoreEntity(entity.id, { halfLifeDays: body.half_life_days ?? null });
  ok(res, { ...result, leaderboard: leaderboard(entity.id, { halfLifeDays: body.half_life_days ?? null }) });
});

analysisRoutes.get('/api/associations/:id/momentum', (req, res, params) => {
  const association = get(`SELECT * FROM associations WHERE id = ?`, Number(params.id));
  if (!association) throw notFound('association not found');
  ok(res, momentumFor(association.entity_id, association.id));
});
