import http from 'node:http';
import config, { SCORE_DISCLAIMER } from './src/config.js';
import { installTrustStore } from './src/tls-trust.js';
import { Router, fail, json, serveStatic, serveIndex } from './src/http.js';
import { recoverOrphanedJobs } from './src/jobs/queue.js';
import { llmStatus } from './src/providers/llm/index.js';
import * as dfs from './src/providers/dataforseo.js';

import { requireAuth, requireCsrf, bootstrapFirstUser, reportBootstrap, purgeExpiredSessions } from './src/auth.js';

import { authRoutes } from './src/routes/auth.js';
import { entityRoutes } from './src/routes/entities.js';
import { analysisRoutes } from './src/routes/analysis.js';
import { evidenceRoutes } from './src/routes/evidence.js';
import { googleRoutes } from './src/routes/google.js';
import { summaryRoutes } from './src/routes/summary.js';

const router = new Router();
for (const group of [authRoutes, entityRoutes, analysisRoutes, evidenceRoutes, googleRoutes, summaryRoutes]) {
  router.routes.push(...group.routes);
}

// The only endpoints reachable without a session. Deliberately an allow-list.
const PUBLIC_ROUTES = new Set(['/api/me', '/api/auth/login', '/api/auth/logout']);

// Before anything can make an outbound call: pick up any locally-installed CA
// certificates. TLS-inspecting antivirus and corporate proxies re-sign HTTPS
// with their own CA, which the OS trusts but Node only sees if
// NODE_EXTRA_CA_CERTS was set before the process started. Loading them here
// means the app works regardless of how it was launched.
const trust = installTrustStore(config.extraCaCerts);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  // Strict: this app holds API credentials and loads nothing from anywhere
  // else. No CDN, no font host, no analytics.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
  );

  try {
    if (pathname.startsWith('/api/')) {
      requireCsrf(req);
      // Everything is closed by default. The exceptions are the endpoints the
      // login screen itself needs — a deny-list here would eventually leak a
      // route someone forgot to add to it.
      if (!PUBLIC_ROUTES.has(pathname)) requireAuth(req);
      const match = router.match(req.method, pathname);
      if (!match) return json(res, 404, { error: `no route for ${req.method} ${pathname}` });
      if (match.methodMismatch) return json(res, 405, { error: `${req.method} not allowed on ${pathname}` });
      return await match.route.handler(req, res, match.params, url);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'method not allowed' });
    }
    if (serveStatic(req, res, pathname)) return;
    if (!pathname.includes('.')) return serveIndex(res);
    return json(res, 404, { error: 'not found' });
  } catch (err) {
    return fail(res, err);
  }
});

server.listen(config.port, config.host, () => {
  const llm = llmStatus();
  console.log('');
  console.log('  EntityGraph — Entity Association Intelligence');
  console.log(`  http://${config.host}:${config.port}`);
  console.log(`  env: ${config.env}   build: ${config.version.commit}   db: ${config.dbPath}`);
  console.log('');
  console.log(`  corpus:     ${dfs.isConfigured() ? 'DataForSEO configured' : 'DataForSEO NOT configured — set DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD in .env'}`);
  console.log(
    `  extraction: ${llm.available ? `${llm.configured_provider} (${llm.model})` : `no LLM key — falling back to the deterministic heuristic extractor`}`
  );
  console.log(`  ceilings:   ${config.limits.maxDocuments} documents, $${config.limits.maxApiCostUsd} per entity`);
  if (trust.applied) {
    for (const { file, certificates } of trust.added) {
      console.log(`  tls:        trusting ${certificates} local CA certificate(s) from ${file}`);
    }
  } else if (trust.added?.length) {
    console.warn(`  tls:        found local CA certificates but could not install them: ${trust.reason}`);
  }
  console.log('');
  console.log(`  ${SCORE_DISCLAIMER}`);
  console.log('');
  purgeExpiredSessions();
  reportBootstrap(bootstrapFirstUser());
  const recovered = recoverOrphanedJobs();
  if (recovered) console.log(`  [jobs] marked ${recovered} interrupted job(s) as failed`);
});

const shutdown = (signal) => {
  console.log(`\n${signal} — shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export default server;
