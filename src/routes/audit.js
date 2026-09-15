import { Router, ok, readJson, badRequest, notFound } from '../http.js';
import { requireAuth, audit as record } from '../auth.js';
import { get } from '../db.js';
import { getEntity, identityProfile } from '../services/identity.js';
import {
  createAuditDraft, queueAudit, auditUrl, auditContentDraft, getAudit, listAudits, signOff,
  listAssets, addAsset, setAssetStatus, queueAssetBatch, assetReport,
} from '../services/audit.js';
import { exclusionsFor, suggestAdverse, setPolarity } from '../services/audit-facts.js';

export const auditRoutes = new Router();

// --- Audits (§98–§101) -----------------------------------------------------------------------

auditRoutes.get('/api/entities/:id/audits', (req, res, params) => {
  const entity = getEntity(Number(params.id));
  ok(res, {
    entity: { id: entity.id, canonical_name: entity.canonical_name },
    audits: listAudits(entity.id),
    assets: listAssets(entity.id),
    report: assetReport(entity.id),
  });
});

// Pasted text or a live URL. An audit spends an extraction pass, so who asked is recorded.
auditRoutes.post('/api/entities/:id/audits', async (req, res, params) => {
  const user = requireAuth(req);
  const entity = getEntity(Number(params.id));
  const body = await readJson(req);
  const id = body.url
    ? await auditUrl(entity.id, body.url, { targetUrl: body.target_url || null, assetId: body.asset_id ?? null, user })
    : createAuditDraft({
        entityId: entity.id,
        sourceKind: 'paste',
        text: body.text,
        title: body.title,
        hostDomain: body.host_domain,
        targetUrl: body.target_url,
        user,
      });
  const result = queueAudit(id);
  record(user.id, 'audit.create', { entity_id: entity.id, draft_id: id, source_kind: body.url ? 'url' : 'paste' });
  ok(res, result);
});

auditRoutes.post('/api/content/:id/audit', async (req, res, params) => {
  const user = requireAuth(req);
  const result = await auditContentDraft(Number(params.id), { user });
  record(user.id, 'audit.content_draft', { content_draft_id: Number(params.id), draft_id: result.draft.id });
  ok(res, result);
});

auditRoutes.get('/api/audits/:id', (req, res, params) => {
  ok(res, getAudit(Number(params.id)));
});

auditRoutes.post('/api/audits/:id/rerun', (req, res, params) => {
  const user = requireAuth(req);
  const result = queueAudit(Number(params.id));
  record(user.id, 'audit.rerun', { draft_id: Number(params.id) });
  ok(res, result);
});

auditRoutes.post('/api/audits/:id/signoff', async (req, res, params) => {
  const user = requireAuth(req);
  const body = await readJson(req);
  const result = signOff(Number(params.id), String(body.check_id ?? ''), { reason: body.reason }, user);
  record(user.id, 'audit.signoff', { draft_id: Number(params.id), check_id: body.check_id, reason: body.reason ?? null });
  ok(res, result);
});

// --- Adverse associations (C1, C7) --------------------------------------------------------------

auditRoutes.get('/api/entities/:id/exclusions', (req, res, params) => {
  const entity = getEntity(Number(params.id));
  const profile = identityProfile(entity.id);
  ok(res, { exclusions: exclusionsFor(entity.id, { profile }), suggestions: suggestAdverse(entity.id, profile) });
});

auditRoutes.get('/api/associations/:id/polarity', (req, res, params) => {
  ok(res, { polarity: get(`SELECT * FROM association_polarity WHERE association_id = ?`, Number(params.id)) });
});

auditRoutes.post('/api/associations/:id/polarity', async (req, res, params) => {
  const user = requireAuth(req);
  const body = await readJson(req);
  const association = get(`SELECT id, entity_id FROM associations WHERE id = ?`, Number(params.id));
  if (!association) throw notFound('association not found');
  const polarity = body.polarity ?? null;
  if (polarity !== null && !['adverse', 'favourable'].includes(polarity)) throw badRequest('polarity must be adverse, favourable or null');
  const saved = setPolarity(association.entity_id, association.id, polarity, { reason: body.reason ?? null, user });
  record(user.id, 'association.polarity', { association_id: association.id, polarity, reason: body.reason ?? null });
  ok(res, { polarity: saved });
});

// --- Asset registry (§102) -------------------------------------------------------------------------

auditRoutes.post('/api/entities/:id/assets', async (req, res, params) => {
  const user = requireAuth(req);
  const entity = getEntity(Number(params.id));
  const body = await readJson(req);
  const asset = addAsset(entity.id, { url: body.url, kind: body.kind, label: body.label }, user);
  record(user.id, 'asset.add', { entity_id: entity.id, asset_id: asset.id, url: asset.url });
  ok(res, { asset });
});

auditRoutes.post('/api/assets/:id/status', async (req, res, params) => {
  const user = requireAuth(req);
  const body = await readJson(req);
  const asset = setAssetStatus(Number(params.id), body.status);
  record(user.id, 'asset.status', { asset_id: Number(params.id), status: body.status });
  ok(res, { asset });
});

auditRoutes.post('/api/entities/:id/assets/audit', (req, res, params) => {
  const user = requireAuth(req);
  const entity = getEntity(Number(params.id));
  const job = queueAssetBatch(entity.id);
  record(user.id, 'asset.batch_audit', { entity_id: entity.id, job_id: job.id });
  ok(res, { job });
});
