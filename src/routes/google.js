import { Router, ok, notFound } from '../http.js';
import { get } from '../db.js';
import { googleView } from '../services/google-signals.js';

export const googleRoutes = new Router();

/**
 * §52 — what Google associates with the entity, surface by surface. Kept on its
 * own route, apart from the corpus scores, because §14 requires the two views
 * to stay separate and the gap between them is the finding.
 */
googleRoutes.get('/api/entities/:id/google', (req, res, params) => {
  const entity = get(`SELECT id FROM entities WHERE id = ? AND deleted_at IS NULL`, Number(params.id));
  if (!entity) throw notFound('entity not found');
  ok(res, googleView(entity.id));
});
