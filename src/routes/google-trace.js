import { Router, ok, intParam } from '../http.js';
import { getEntity } from '../services/identity.js';
import { googlePageTrace } from '../services/google-trace.js';

export const googleTraceRoutes = new Router();

googleTraceRoutes.get('/api/entities/:id/google/trace', (req, res, params, url) => {
  const entity = getEntity(Number(params.id));
  ok(res, googlePageTrace(entity.id, { limit: intParam(url, 'limit', 30, { min: 5, max: 100 }) }));
});
