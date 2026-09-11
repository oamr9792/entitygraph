import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

/**
 * A very small router. Enough for a single-purpose app, and it keeps the whole
 * thing dependency-free.
 */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const names = [];
    const regexSource = pattern
      .replace(/[.+*?^${}()|[\]\\]/g, (m) => '\\' + m)
      .replace(/:([A-Za-z_]\w*)/g, (_, name) => {
        names.push(name);
        return '([^/]+)';
      });
    this.routes.push({ method, regex: new RegExp(`^${regexSource}$`), names, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  match(method, pathname) {
    let pathExists = false;
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      pathExists = true;
      if (route.method !== method) continue;
      const params = {};
      route.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
      return { route, params };
    }
    return pathExists ? { methodMismatch: true } : null;
  }
}

// --- Request helpers --------------------------------------------------------

const MAX_BODY = 16 * 1024 * 1024; // raw SERP and corpus JSON gets imported here

export async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const err = new Error('request body too large');
      err.status = 413;
      err.expose = true;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError('body is not valid JSON', 400);
  }
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function setCookie(res, name, value, opts = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`];
  bits.push(`Path=${opts.path || '/'}`);
  if (opts.maxAge !== undefined) bits.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  bits.push(`SameSite=${opts.sameSite || 'Lax'}`);
  if (opts.httpOnly !== false) bits.push('HttpOnly');
  if (opts.secure) bits.push('Secure');
  const existing = res.getHeader('Set-Cookie');
  const list = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  res.setHeader('Set-Cookie', [...list, bits.join('; ')]);
}

// --- Response helpers -------------------------------------------------------

export function json(res, status, payload) {
  const body = JSON.stringify(payload ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export const ok = (res, payload) => json(res, 200, payload);

export function fail(res, err) {
  const status = err?.status || 500;
  const message = err?.expose || status < 500 ? err.message : 'internal server error';
  if (status >= 500) console.error('[error]', err);
  json(res, status, { error: message, ...(err?.details ? { details: err.details } : {}) });
}

export class HttpError extends Error {
  constructor(message, status = 400, details = null) {
    super(message);
    this.status = status;
    this.expose = true;
    if (details) this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(msg, 400, details);
export const notFound = (msg = 'not found') => new HttpError(msg, 404);

/** Reads and validates a query-string integer, so routes stay uncluttered. */
export function intParam(url, name, dflt, { min = -Infinity, max = Infinity } = {}) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw badRequest(`${name} must be a number`);
  return Math.min(max, Math.max(min, n));
}

// --- Static files -----------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.csv': 'text/csv; charset=utf-8',
};

const PUBLIC_DIR = path.join(ROOT, 'public');

export function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const resolved = path.resolve(path.join(PUBLIC_DIR, rel));
  // Containment check: refuse anything that escapes public/ after resolution.
  if (
    !resolved.startsWith(path.resolve(PUBLIC_DIR) + path.sep) &&
    resolved !== path.resolve(PUBLIC_DIR, 'index.html')
  ) {
    return false;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return false;
  const ext = path.extname(resolved).toLowerCase();
  const body = fs.readFileSync(resolved);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'no-cache',
  });
  res.end(body);
  return true;
}

export function serveIndex(res) {
  const body = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

export function serveCsv(res, filename, rows) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const body =
    [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n') + '\n';
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}
