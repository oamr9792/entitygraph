import { Router, ok, readJson, badRequest, notFound, intParam } from '../http.js';
import config from '../config.js';
import {
  login, logout, authenticate, requireAuth, requireAdmin, changePassword,
  listUsers, createUser, setUserStatus, activeSessionsFor, auditTrail, destroySession,
} from '../auth.js';

export const authRoutes = new Router();

/**
 * The one endpoint the client polls to decide whether to show the app or the
 * login screen. Returns 200 with `user: null` rather than 401, because "not
 * signed in" is a normal state on first load, not an error worth logging.
 */
authRoutes.get('/api/me', (req, res) => {
  // The build is public on purpose: it is how anyone — including a deploy
  // check — answers 'which version is running' without signing in first.
  ok(res, { user: authenticate(req), build: config.version });
});

authRoutes.post('/api/auth/login', async (req, res) => {
  const body = await readJson(req);
  const user = login(req, res, { email: body.email, password: body.password });
  ok(res, { user });
});

authRoutes.post('/api/auth/logout', (req, res) => {
  logout(req, res);
  ok(res, { ok: true });
});

authRoutes.post('/api/auth/password', async (req, res) => {
  const user = requireAuth(req);
  const body = await readJson(req);
  if (!body.new_password) throw badRequest('new_password is required');
  changePassword(user, { currentPassword: body.current_password, newPassword: body.new_password });
  ok(res, { ok: true });
});

authRoutes.get('/api/auth/sessions', (req, res) => {
  const user = requireAuth(req);
  ok(res, { sessions: activeSessionsFor(user.id), current: user.sessionId });
});

authRoutes.delete('/api/auth/sessions/:id', (req, res, params) => {
  const user = requireAuth(req);
  const mine = activeSessionsFor(user.id).some((s) => s.id === params.id);
  if (!mine) throw notFound('session not found');
  destroySession(params.id);
  ok(res, { ok: true });
});

// --- User administration ----------------------------------------------------

authRoutes.get('/api/users', (req, res) => {
  requireAdmin(req);
  ok(res, { users: listUsers() });
});

authRoutes.post('/api/users', async (req, res) => {
  const actor = requireAdmin(req);
  const body = await readJson(req);
  // The generated password is returned exactly once, here. It is never stored
  // in plaintext and cannot be retrieved again — a lost one is reset, not
  // looked up.
  ok(res, { user: createUser(actor, { email: body.email, name: body.name, role: body.role }) });
});

authRoutes.post('/api/users/:id/status', async (req, res, params) => {
  const actor = requireAdmin(req);
  const body = await readJson(req);
  setUserStatus(actor, Number(params.id), body.status);
  ok(res, { ok: true });
});

authRoutes.get('/api/audit', (req, res, params, url) => {
  requireAdmin(req);
  ok(res, { entries: auditTrail(intParam(url, 'limit', 100, { min: 1, max: 500 })) });
});
