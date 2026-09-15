import { Router, ok, readJson } from '../http.js';
import { requireAuth, audit } from '../auth.js';
import { getEntity } from '../services/identity.js';
import { contentBrief, createDraft, generateInto, getDraft, listDrafts, updateDraft, fixDraft, undoFix } from '../services/content.js';
import { readSource, listSources } from '../services/content-source.js';

export const contentRoutes = new Router();

const ids = (value) => (value ?? '').split(',').map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0);

contentRoutes.get('/api/associations/:id/content-brief', (req, res, params, url) => {
  ok(res, contentBrief(Number(params.id), {
    format: url.searchParams.get('format'),
    growIds: url.searchParams.has('grow') ? ids(url.searchParams.get('grow')) : null,
    sourceDocumentId: url.searchParams.get('document'),
    purpose: url.searchParams.get('purpose'),
    sourceId: url.searchParams.get('source'),
    relation: url.searchParams.get('relation'),
  }));
});

contentRoutes.get('/api/entities/:id/content-sources', (req, res, params) => {
  const entity = getEntity(Number(params.id));
  ok(res, { sources: listSources(entity.id) });
});

// Reading a page can fall back to a billed DataForSEO call, so who asked is recorded.
contentRoutes.post('/api/entities/:id/content-sources', async (req, res, params) => {
  const user = requireAuth(req);
  const entity = getEntity(Number(params.id));
  const body = await readJson(req);
  const source = await readSource(entity.id, body.url, user);
  audit(user.id, 'content.read_source', { entity_id: entity.id, source_id: source.id, url: source.url });
  ok(res, { source });
});

// Generation spends money, so who asked for it is recorded.
contentRoutes.post('/api/associations/:id/content', async (req, res, params) => {
  const user = requireAuth(req);
  const body = await readJson(req);
  const result = await createDraft(Number(params.id), body, user);
  audit(user.id, 'content.create', { draft_id: result.draft.id, association_id: Number(params.id), format: result.draft.format });
  ok(res, result);
});

contentRoutes.get('/api/entities/:id/content', (req, res, params) => {
  const entity = getEntity(Number(params.id));
  ok(res, { entity: { id: entity.id, canonical_name: entity.canonical_name }, drafts: listDrafts(entity.id) });
});

contentRoutes.get('/api/content/:id', (req, res, params) => {
  ok(res, getDraft(Number(params.id)));
});

contentRoutes.patch('/api/content/:id', async (req, res, params) => {
  const user = requireAuth(req);
  const body = await readJson(req);
  const result = updateDraft(Number(params.id), body, user);
  if (body.status) audit(user.id, `content.${body.status}`, { draft_id: Number(params.id) });
  ok(res, result);
});

contentRoutes.post('/api/content/:id/generate', async (req, res, params) => {
  const user = requireAuth(req);
  await generateInto(Number(params.id));
  audit(user.id, 'content.generate', { draft_id: Number(params.id) });
  ok(res, getDraft(Number(params.id)));
});

// An AI revision spends money and replaces text, so both are recorded.
contentRoutes.post('/api/content/:id/fix', async (req, res, params) => {
  const user = requireAuth(req);
  const body = await readJson(req);
  const result = await fixDraft(Number(params.id), body);
  audit(user.id, 'content.fix', {
    draft_id: Number(params.id),
    issues: body.all_blocking ? 'all_blocking' : body.issues,
    changed: result.fix.changed,
  });
  ok(res, result);
});

contentRoutes.post('/api/content/:id/undo', async (req, res, params) => {
  const user = requireAuth(req);
  const result = undoFix(Number(params.id));
  audit(user.id, 'content.undo_fix', { draft_id: Number(params.id) });
  ok(res, result);
});
