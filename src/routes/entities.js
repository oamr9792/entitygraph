import { Router, ok, readJson, badRequest, notFound, intParam } from '../http.js';
import { all, get, run } from '../db.js';
import { createEntity, identityProfile, addAlias, addMarker, searchQueries, getEntity } from '../services/identity.js';
import { enqueue, listJobs, getJob, cancelJob } from '../jobs/queue.js';
import { spendForEntity } from '../providers/http-client.js';

export const entityRoutes = new Router();

entityRoutes.get('/api/entities', (req, res) => {
  const rows = all(
    `SELECT e.*,
            (SELECT COUNT(*) FROM entity_document_matches m WHERE m.entity_id = e.id AND m.verdict = 'accept') AS documents,
            (SELECT COUNT(*) FROM associations a WHERE a.entity_id = e.id AND a.status = 'active') AS associations,
            (SELECT status FROM crawl_jobs j WHERE j.entity_id = e.id AND j.kind = 'full_build' ORDER BY j.id DESC LIMIT 1) AS last_job_status,
            (SELECT step FROM crawl_jobs j WHERE j.entity_id = e.id AND j.kind = 'full_build' ORDER BY j.id DESC LIMIT 1) AS last_job_step,
            (SELECT steps_done FROM crawl_jobs j WHERE j.entity_id = e.id AND j.kind = 'full_build' ORDER BY j.id DESC LIMIT 1) AS last_job_steps_done,
            (SELECT steps_total FROM crawl_jobs j WHERE j.entity_id = e.id AND j.kind = 'full_build' ORDER BY j.id DESC LIMIT 1) AS last_job_steps_total,
            (SELECT error FROM crawl_jobs j WHERE j.entity_id = e.id AND j.kind = 'full_build' ORDER BY j.id DESC LIMIT 1) AS last_job_error
       FROM entities e WHERE e.deleted_at IS NULL ORDER BY e.created_at DESC`
  );
  ok(res, { entities: rows.map((e) => ({ ...e, spend: spendForEntity(e.id) })) });
});

entityRoutes.post('/api/entities', async (req, res) => {
  const body = await readJson(req);
  if (!body.canonical_name) throw badRequest('canonical_name is required');
  const id = createEntity(body);
  const profile = identityProfile(id);
  const job = body.build === false ? null : enqueue(id, 'full_build', body.options ?? {});
  ok(res, { entity_id: id, profile, job });
});

entityRoutes.get('/api/entities/:id', (req, res, params) => {
  const entity = getEntity(Number(params.id));
  ok(res, {
    entity,
    profile: identityProfile(entity.id),
    search_queries: searchQueries(entity.id),
    spend: spendForEntity(entity.id),
    jobs: listJobs(entity.id, 5),
  });
});

entityRoutes.patch('/api/entities/:id', async (req, res, params) => {
  const entity = getEntity(Number(params.id));
  const body = await readJson(req);
  const fields = ['canonical_name', 'description', 'wikidata_qid', 'wikipedia_url', 'max_documents', 'max_api_cost_usd'];
  // Probe terms arrive as an array and are stored as JSON, so they are handled
  // separately from the scalar fields above.
  if (Array.isArray(body.probe_terms)) {
    const terms = body.probe_terms.map((t) => String(t).trim()).filter(Boolean).slice(0, 25);
    run(`UPDATE entities SET probe_terms = ? WHERE id = ?`, JSON.stringify(terms), entity.id);
  }
  for (const field of fields) {
    if (field in body) run(`UPDATE entities SET ${field} = ? WHERE id = ?`, body[field], entity.id);
  }
  if (body.model_overrides) {
    run(`UPDATE entities SET model_overrides = ? WHERE id = ?`, JSON.stringify(body.model_overrides), entity.id);
  }
  run(`UPDATE entities SET updated_at = datetime('now') WHERE id = ?`, entity.id);
  ok(res, { entity: getEntity(entity.id), profile: identityProfile(entity.id) });
});

entityRoutes.delete('/api/entities/:id', (req, res, params) => {
  const entity = getEntity(Number(params.id));
  run(`UPDATE entities SET deleted_at = datetime('now') WHERE id = ?`, entity.id);
  ok(res, { deleted: entity.id });
});

entityRoutes.post('/api/entities/:id/aliases', async (req, res, params) => {
  const entity = getEntity(Number(params.id));
  const body = await readJson(req);
  if (!body.alias) throw badRequest('alias is required');
  addAlias(entity.id, body.alias, 'user', body.searchable !== false);
  ok(res, { profile: identityProfile(entity.id) });
});

entityRoutes.post('/api/entities/:id/markers', async (req, res, params) => {
  const entity = getEntity(Number(params.id));
  const body = await readJson(req);
  if (!body.kind || !body.value) throw badRequest('kind and value are required');
  addMarker(entity.id, body.kind, body.value, {
    weight: body.weight ?? null,
    polarity: body.polarity === -1 ? -1 : 1,
    source: 'user',
  });
  ok(res, { profile: identityProfile(entity.id) });
});

entityRoutes.delete('/api/entities/:id/markers/:markerId', (req, res, params) => {
  const entity = getEntity(Number(params.id));
  run(`DELETE FROM entity_identity_markers WHERE id = ? AND entity_id = ?`, Number(params.markerId), entity.id);
  ok(res, { profile: identityProfile(entity.id) });
});

// --- Jobs -------------------------------------------------------------------

entityRoutes.post('/api/entities/:id/build', async (req, res, params) => {
  const entity = getEntity(Number(params.id));
  const body = await readJson(req);
  ok(res, { job: enqueue(entity.id, body.kind ?? 'full_build', body.options ?? {}) });
});

entityRoutes.get('/api/jobs', (req, res, params, url) => {
  const entityId = url.searchParams.get('entity_id');
  ok(res, { jobs: listJobs(entityId ? Number(entityId) : null, intParam(url, 'limit', 25, { min: 1, max: 100 }), url.searchParams.get('kind')) });
});

entityRoutes.get('/api/jobs/:id', (req, res, params) => {
  const job = getJob(Number(params.id));
  if (!job) throw notFound(`job ${params.id} not found`);
  ok(res, { job });
});

entityRoutes.post('/api/jobs/:id/cancel', (req, res, params) => {
  const job = cancelJob(Number(params.id));
  if (!job) throw notFound(`job ${params.id} not found`);
  ok(res, { job });
});
