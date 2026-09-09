import crypto from 'node:crypto';
import config from '../config.js';
import { get, run } from '../db.js';
import { HttpError } from '../http.js';

/**
 * Every outbound call goes through here, so throttling, backoff, caching and
 * cost accounting cannot be forgotten by an individual provider module.
 *
 * §66's cost ceilings are only real if there is one place that counts. Content
 * Analysis pagination over a common name can run to hundreds of calls, and
 * "we forgot to cache that one" is a bill, not an untidiness.
 */

export class ProviderError extends Error {
  constructor(message, { status = 502, provider, retryable = false, body } = {}) {
    super(message);
    this.status = status;
    this.expose = true;
    this.provider = provider;
    this.retryable = retryable;
    this.body = body;
  }
}

// --- Cache ------------------------------------------------------------------

export const cacheKey = (provider, payload) =>
  `${provider}:${crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 40)}`;

export function cacheGet(key) {
  const row = get(`SELECT * FROM api_cache WHERE cache_key = ?`, key);
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    run(`DELETE FROM api_cache WHERE cache_key = ?`, key);
    return null;
  }
  try {
    return { payload: JSON.parse(row.payload), fetched_at: row.fetched_at };
  } catch {
    return null;
  }
}

export function cachePut(key, provider, payload, ttlSeconds = config.providerCacheTtlS) {
  run(
    `INSERT INTO api_cache (cache_key, provider, payload, expires_at)
     VALUES (?, ?, ?, datetime('now', ?))
     ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload,
       fetched_at = datetime('now'), expires_at = excluded.expires_at`,
    key,
    provider,
    JSON.stringify(payload),
    `+${Math.max(1, Math.floor(ttlSeconds))} seconds`
  );
}

// --- Usage and ceilings (§66) ----------------------------------------------

export function recordUsage({ provider, endpoint, entityId = null, jobId = null, costUsd = 0, tokensIn = 0, tokensOut = 0, cached = false, ok = true, detail = null }) {
  run(
    `INSERT INTO api_usage (provider, endpoint, entity_id, job_id, cost_usd, tokens_in, tokens_out, cached, ok, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    provider,
    endpoint,
    entityId,
    jobId,
    costUsd,
    tokensIn,
    tokensOut,
    cached ? 1 : 0,
    ok ? 1 : 0,
    detail ? String(detail).slice(0, 500) : null
  );
}

export function spendForEntity(entityId) {
  const row = get(
    `SELECT COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens
       FROM api_usage WHERE entity_id = ?`,
    entityId
  );
  return { costUsd: row?.cost ?? 0, tokens: row?.tokens ?? 0 };
}

/**
 * Throws when a call would take an entity past its ceiling. Checked before the
 * call rather than after, because §66's limits exist to prevent spend, not to
 * report it.
 */
export function assertWithinBudget(entityId, { maxApiCostUsd = null, maxLlmTokens = null } = {}) {
  if (!entityId) return;
  const limitCost = maxApiCostUsd ?? config.limits.maxApiCostUsd;
  const limitTokens = maxLlmTokens ?? config.limits.maxLlmTokens;
  const spend = spendForEntity(entityId);
  if (limitCost !== null && spend.costUsd >= limitCost) {
    throw new HttpError(
      `Cost ceiling reached for this entity: $${spend.costUsd.toFixed(2)} of $${Number(limitCost).toFixed(2)}. Raise MAX_API_COST_USD or the entity's own limit to continue.`,
      429,
      { scope: 'cost', spent: spend.costUsd, limit: limitCost }
    );
  }
  if (limitTokens !== null && spend.tokens >= limitTokens) {
    throw new HttpError(
      `LLM token ceiling reached for this entity: ${spend.tokens} of ${limitTokens}.`,
      429,
      { scope: 'tokens', spent: spend.tokens, limit: limitTokens }
    );
  }
}

// --- Rate limiting and requests ---------------------------------------------

const lastCallAt = new Map();
// Page fetches are spaced per host by services/fetch.js, which is where
// politeness actually belongs; a large global gap here would serialise the
// concurrent pool against unrelated domains for no benefit.
const MIN_GAP_MS = { dataforseo: 250, anthropic: 120, openai: 120, commoncrawl: 500, page: 50, generic: 100 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function throttle(provider) {
  const gap = MIN_GAP_MS[provider] ?? MIN_GAP_MS.generic;
  const last = lastCallAt.get(provider) ?? 0;
  const wait = last + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt.set(provider, Date.now());
}

/**
 * One request with timeout, throttling and bounded exponential backoff.
 * Retries only on 429/5xx and network failures — retrying a 400 spends money
 * twice for the same answer.
 */
export async function request(provider, url, options = {}, { retries = 3, timeoutMs } = {}) {
  let attempt = 0;
  let lastErr;

  while (attempt <= retries) {
    await throttle(provider);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? config.httpTimeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);

      if (res.status === 429 || res.status >= 500) {
        const body = await res.text().catch(() => '');
        lastErr = new ProviderError(`${provider} returned ${res.status}`, {
          status: res.status === 429 ? 429 : 502,
          provider,
          retryable: true,
          body: body.slice(0, 500),
        });
        const retryAfter = Number(res.headers.get('retry-after'));
        const backoff =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : Math.min(30000, 500 * 2 ** attempt) + Math.random() * 250;
        attempt += 1;
        if (attempt > retries) break;
        await sleep(backoff);
        continue;
      }

      const text = await res.text();
      let parsed;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { _raw: text };
      }

      if (!res.ok) {
        throw new ProviderError(
          `${provider} error ${res.status}: ${
            typeof parsed?.error === 'string'
              ? parsed.error
              : parsed?.error?.message || parsed?.status_message || String(text).slice(0, 200)
          }`,
          { status: res.status < 500 ? 400 : 502, provider, body: parsed }
        );
      }
      return parsed;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof ProviderError && !err.retryable) throw err;
      // "fetch failed" alone is useless — the actionable detail is in err.cause
      // (ENOTFOUND, ECONNREFUSED, a TLS chain error).
      const cause = err?.cause;
      const detail = cause ? [cause.code, cause.message].filter(Boolean).join(': ') : null;
      lastErr =
        err.name === 'AbortError'
          ? new ProviderError(`${provider} request timed out`, { provider, retryable: true, status: 504 })
          : err instanceof ProviderError
            ? err
            : new ProviderError(`${provider} request failed: ${err.message}${detail ? ` (${detail})` : ''}`, {
                provider,
                retryable: true,
                body: detail ? { cause: detail } : undefined,
              });
      attempt += 1;
      if (attempt > retries) break;
      await sleep(Math.min(30000, 500 * 2 ** attempt) + Math.random() * 250);
    }
  }
  throw lastErr ?? new ProviderError(`${provider} request failed`, { provider });
}

/**
 * The wrapper every billable provider call should use: cache lookup, budget
 * check, request, usage accounting, cache store.
 */
export async function billedRequest({ provider, endpoint, entityId = null, jobId = null, key, ttl, force = false, limits, fn }) {
  const ck = cacheKey(provider, key);
  if (!force) {
    const hit = cacheGet(ck);
    if (hit) {
      recordUsage({ provider, endpoint, entityId, jobId, cached: true });
      return { ...hit.payload, _cached: true, _fetched_at: hit.fetched_at };
    }
  }
  assertWithinBudget(entityId, limits);
  try {
    const payload = await fn();
    recordUsage({
      provider,
      endpoint,
      entityId,
      jobId,
      costUsd: payload?.cost ?? 0,
      tokensIn: payload?.tokens_in ?? 0,
      tokensOut: payload?.tokens_out ?? 0,
    });
    cachePut(ck, provider, payload, ttl);
    return payload;
  } catch (err) {
    recordUsage({ provider, endpoint, entityId, jobId, ok: false, detail: err.message });
    throw err;
  }
}
