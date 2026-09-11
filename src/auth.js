import crypto from 'node:crypto';
import config from './config.js';
import { get, run, all } from './db.js';
import { parseCookies, setCookie, HttpError } from './http.js';

/**
 * Authentication.
 *
 * This app holds two things worth protecting: reputation data about real
 * people, and credentials that spend money on every build. An unauthenticated
 * deployment is not "a tool without a login screen", it is an open endpoint
 * that anyone who finds the URL can point at your DataForSEO balance.
 *
 * Single-tenant on purpose. The sibling platform this is adapted from carries
 * organisations, memberships and per-entity grants; none of that earns its
 * complexity here, where the deployment is one firm looking at its own
 * clients. Accounts, sessions and an audit trail of who changed what is the
 * whole model.
 */

const COOKIE = 'eg_session';

// --- Password hashing -------------------------------------------------------
// scrypt with a per-password salt, parameters tuned so one hash costs ~100ms.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(keyB64, 'base64');
  let actual;
  try {
    actual = crypto.scryptSync(password, salt, expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * Length-first, in line with current NIST guidance rather than a
 * character-class obstacle course that pushes people towards Passw0rd!.
 */
export function checkPasswordStrength(password) {
  const problems = [];
  if (typeof password !== 'string' || password.length < 12) problems.push('must be at least 12 characters');
  if (/^\d+$/.test(password || '')) problems.push('cannot be only digits');
  const common = ['password', 'letmein', '12345678', 'qwerty', 'admin', 'welcome', 'changeme', 'entitygraph'];
  if (common.some((c) => (password || '').toLowerCase().includes(c))) {
    problems.push('contains a well-known password fragment');
  }
  return { ok: problems.length === 0, problems };
}

// --- Tokens -----------------------------------------------------------------

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

function sign(value) {
  const mac = crypto.createHmac('sha256', config.sessionSecret).update(String(value)).digest('base64url');
  return `${value}.${mac}`;
}

function unsign(signed) {
  if (typeof signed !== 'string') return null;
  const idx = signed.lastIndexOf('.');
  if (idx < 0) return null;
  const value = signed.slice(0, idx);
  const expected = crypto.createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
  const given = signed.slice(idx + 1);
  if (given.length !== expected.length) return null;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected)) ? value : null;
}

// --- Login throttling -------------------------------------------------------
// In-memory is the right scope: this guards online guessing against one
// instance, and a restart clearing it is not a meaningful weakening.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

const throttleKey = (email, ip) => `${String(email || '').toLowerCase()}|${ip || '-'}`;

function tooManyAttempts(key) {
  const rec = attempts.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

function noteFailure(key) {
  const rec = attempts.get(key);
  if (!rec || Date.now() - rec.first > WINDOW_MS) attempts.set(key, { count: 1, first: Date.now() });
  else rec.count += 1;
}

const clientIp = (req) => {
  if (config.trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? null;
};

// --- Sessions ---------------------------------------------------------------

export function createSession(userId, req) {
  const id = randomToken(32);
  const expires = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000);
  run(
    `INSERT INTO app_session (id, user_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)`,
    id,
    userId,
    expires.toISOString(),
    clientIp(req),
    String(req.headers['user-agent'] || '').slice(0, 300)
  );
  return { id, expires };
}

export const destroySession = (id) => { if (id) run(`DELETE FROM app_session WHERE id = ?`, id); };

export const purgeExpiredSessions = () =>
  run(`DELETE FROM app_session WHERE expires_at < ?`, new Date().toISOString());

/**
 * Resolves the user for a request, or null. Nothing is attached to the request
 * object — handlers hold the user explicitly, so it stays visible in every
 * signature that authorisation is happening at all.
 */
export function authenticate(req) {
  const signed = parseCookies(req)[COOKIE];
  if (!signed) return null;
  const sessionId = unsign(signed);
  if (!sessionId) return null;
  const session = get(`SELECT * FROM app_session WHERE id = ?`, sessionId);
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    destroySession(sessionId);
    return null;
  }
  const user = get(`SELECT * FROM app_user WHERE id = ? AND deleted_at IS NULL`, session.user_id);
  if (!user || user.status !== 'active') return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    must_change_password: !!user.must_change_password,
    sessionId,
  };
}

export function requireAuth(req) {
  const user = authenticate(req);
  if (!user) throw new HttpError('not authenticated', 401);
  return user;
}

export function requireAdmin(req) {
  const user = requireAuth(req);
  if (user.role !== 'admin') throw new HttpError('this action requires an administrator', 403);
  return user;
}

// --- Login / logout ---------------------------------------------------------

export function login(req, res, { email, password }) {
  const ip = clientIp(req);
  const key = throttleKey(email, ip);
  if (tooManyAttempts(key)) throw new HttpError('too many failed attempts, try again in 15 minutes', 429);

  const user = get(`SELECT * FROM app_user WHERE lower(email) = lower(?) AND deleted_at IS NULL`, String(email || '').trim());

  // Same message and roughly the same work whether or not the account exists,
  // so this endpoint cannot be used to enumerate users.
  const passwordOk = user?.password_hash
    ? verifyPassword(password || '', user.password_hash)
    : verifyPassword(password || '', hashPassword('dummy-value-for-timing'));

  if (!user || !passwordOk) {
    noteFailure(key);
    throw new HttpError('invalid email or password', 401);
  }
  if (user.status === 'suspended') throw new HttpError('this account is suspended', 403);

  attempts.delete(key);
  const { id } = createSession(user.id, req);
  setCookie(res, COOKIE, sign(id), {
    maxAge: config.sessionTtlHours * 3600,
    secure: config.isProd,
    sameSite: 'Lax',
  });
  run(`UPDATE app_user SET last_login_at = datetime('now') WHERE id = ?`, user.id);
  audit(user.id, 'auth.login', { ip });
  return authenticate(req) ?? { id: user.id, email: user.email, name: user.name, role: user.role };
}

export function logout(req, res) {
  const user = authenticate(req);
  if (user) {
    destroySession(user.sessionId);
    audit(user.id, 'auth.logout', {});
  }
  setCookie(res, COOKIE, '', { maxAge: 0, secure: config.isProd });
}

export function changePassword(user, { currentPassword, newPassword }) {
  const row = get(`SELECT * FROM app_user WHERE id = ?`, user.id);
  // Someone forced to set a password on first login has nothing to prove yet.
  if (row.password_hash && !row.must_change_password) {
    if (!verifyPassword(currentPassword || '', row.password_hash)) {
      throw new HttpError('current password is incorrect', 401);
    }
  }
  const strength = checkPasswordStrength(newPassword);
  if (!strength.ok) throw new HttpError(`password ${strength.problems.join('; ')}`, 400);

  run(`UPDATE app_user SET password_hash = ?, must_change_password = 0 WHERE id = ?`, hashPassword(newPassword), user.id);
  // A password change should evict anyone holding the old one.
  run(`DELETE FROM app_session WHERE user_id = ? AND id != ?`, user.id, user.sessionId || '');
  audit(user.id, 'auth.password_changed', {});
}

// --- Users ------------------------------------------------------------------

export function listUsers() {
  return all(
    `SELECT id, email, name, role, status, last_login_at, created_at FROM app_user
      WHERE deleted_at IS NULL ORDER BY created_at`
  );
}

export function createUser(actor, { email, name, role = 'analyst' }) {
  const clean = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) throw new HttpError('a valid email address is required', 400);
  if (get(`SELECT id FROM app_user WHERE lower(email) = ?`, clean)) {
    throw new HttpError('a user with that email already exists', 409);
  }
  // Generated once and shown once. Nobody types a password for someone else.
  const password = randomToken(12);
  const res = run(
    `INSERT INTO app_user (email, name, role, password_hash, must_change_password) VALUES (?, ?, ?, ?, 1)`,
    clean,
    String(name || clean).trim(),
    role === 'admin' ? 'admin' : 'analyst',
    hashPassword(password)
  );
  audit(actor.id, 'user.created', { email: clean, role });
  return { id: Number(res.lastInsertRowid), email: clean, temporary_password: password };
}

export function setUserStatus(actor, userId, status) {
  if (Number(userId) === actor.id) throw new HttpError('you cannot change your own status', 400);
  if (!['active', 'suspended'].includes(status)) throw new HttpError('unknown status', 400);
  run(`UPDATE app_user SET status = ? WHERE id = ?`, status, Number(userId));
  if (status === 'suspended') run(`DELETE FROM app_session WHERE user_id = ?`, Number(userId));
  audit(actor.id, 'user.status_changed', { user_id: Number(userId), status });
}

export const activeSessionsFor = (userId) =>
  all(
    `SELECT id, ip, user_agent, created_at, expires_at FROM app_session
      WHERE user_id = ? AND expires_at > datetime('now') ORDER BY created_at DESC`,
    userId
  );

// --- Audit ------------------------------------------------------------------

export function audit(userId, action, detail = {}) {
  run(
    `INSERT INTO audit_log (user_id, action, detail) VALUES (?, ?, ?)`,
    userId ?? null,
    action,
    JSON.stringify(detail ?? {})
  );
}

export const auditTrail = (limit = 100) =>
  all(
    `SELECT a.*, u.email FROM audit_log a LEFT JOIN app_user u ON u.id = a.user_id
      ORDER BY a.id DESC LIMIT ?`,
    limit
  );

/**
 * CSRF. The session cookie is SameSite=Lax, which already blocks cross-site
 * form posts; requiring an explicit header on every mutating request closes
 * the rest, because a browser will not let a cross-origin page set it without
 * a preflight and this server sends no permissive CORS headers.
 */
export function requireCsrf(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  if (req.headers['x-requested-with'] !== 'entitygraph') {
    throw new HttpError('missing X-Requested-With header', 403);
  }
  const origin = req.headers.origin;
  if (!origin) return;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError('bad Origin header', 403);
  }
  if (originHost !== req.headers.host) throw new HttpError('cross-origin request refused', 403);
}

// --- First run --------------------------------------------------------------

/**
 * Creates the first administrator if there are no users yet.
 *
 * A deployment with no way in is useless, and one with a default password is
 * worse than useless. So: take the credentials from the environment when they
 * are supplied, otherwise generate a password, print it once, and force a
 * change at first login. Nothing is ever written to disk in plaintext and the
 * password never appears in the database.
 */
export function bootstrapFirstUser() {
  const existing = get(`SELECT COUNT(*) AS n FROM app_user WHERE deleted_at IS NULL`)?.n ?? 0;
  if (existing > 0) return { created: false, users: existing };

  const email = (config.bootstrap.email || 'admin@localhost').trim().toLowerCase();
  const supplied = config.bootstrap.password;
  const password = supplied || randomToken(12);

  run(
    `INSERT INTO app_user (email, name, role, password_hash, must_change_password) VALUES (?, ?, 'admin', ?, ?)`,
    email,
    config.bootstrap.name || 'Administrator',
    hashPassword(password),
    supplied ? 0 : 1
  );
  audit(null, 'user.bootstrapped', { email });
  return { created: true, email, password: supplied ? null : password };
}

export function reportBootstrap(result) {
  if (!result?.created) return;
  console.log('');
  console.log('  ┌─ First run ────────────────────────────────────────────────');
  console.log(`  │  Sign in as: ${result.email}`);
  if (result.password) {
    console.log(`  │  Password:   ${result.password}`);
    console.log('  │  Shown once. You will be asked to change it on first login.');
  } else {
    console.log('  │  Password:   as set in BOOTSTRAP_ADMIN_PASSWORD');
  }
  console.log('  └────────────────────────────────────────────────────────────');
  console.log('');
}
