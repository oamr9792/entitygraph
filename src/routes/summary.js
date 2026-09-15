import { Router, ok, notFound } from '../http.js';
import { entitySummary, weakStates } from '../services/summary.js';

export const summaryRoutes = new Router();

/** §91 — the data behind the one-screen summary. Sentences are written in the browser from the copy registry. */
summaryRoutes.get('/api/entities/:id/summary', (req, res, params) => {
  const summary = entitySummary(Number(params.id));
  if (!summary) throw notFound('entity not found');
  ok(res, summary);
});

/** §94 — the weak states every entity screen checks before it shows a number. */
summaryRoutes.get('/api/entities/:id/weak-states', (req, res, params) => {
  const states = weakStates(Number(params.id));
  if (!states) throw notFound('entity not found');
  ok(res, states);
});
