import config from '../config.js';
import { get, run } from '../db.js';
import { request } from '../providers/http-client.js';
import * as dfs from '../providers/dataforseo.js';
import { rootDomain } from '../util/hash.js';

/**
 * §15 — page context acquisition.
 *
 * Snippets are enough for a first pass. High-confidence scoring wants the
 * surrounding text, so this fetches it where we are allowed to: robots.txt is
 * honoured, an identifying user agent is sent, and only a bounded amount of
 * text is kept (§15 again — we store the evidence window, not the article).
 *
 * When a direct fetch is refused, DataForSEO has usually already crawled the
 * page and its parsed content is the fallback.
 */

const MAX_HTML_BYTES = 3 * 1024 * 1024;
const ROBOTS_TTL_MS = 6 * 60 * 60 * 1000;
const robotsCache = new Map();

/**
 * Minimal robots.txt evaluation: the most specific matching group wins between
 * our token and '*', and Allow beats Disallow at equal specificity, which is
 * the behaviour the major crawlers implement.
 */
async function robotsAllows(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  const origin = parsed.origin;
  const cached = robotsCache.get(origin);
  let rules = cached && Date.now() - cached.at < ROBOTS_TTL_MS ? cached.rules : null;

  if (!rules) {
    rules = { allow: [], disallow: [] };
    try {
      const res = await fetch(`${origin}/robots.txt`, {
        headers: { 'user-agent': config.pageFetchUserAgent },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const text = (await res.text()).slice(0, 200000);
        let applies = false;
        for (const raw of text.split(/\r?\n/)) {
          const line = raw.split('#')[0].trim();
          if (!line) continue;
          const [field, ...rest] = line.split(':');
          const value = rest.join(':').trim();
          const key = field.trim().toLowerCase();
          if (key === 'user-agent') {
            const agent = value.toLowerCase();
            applies = agent === '*' || config.pageFetchUserAgent.toLowerCase().includes(agent);
          } else if (applies && (key === 'allow' || key === 'disallow') && value) {
            rules[key].push(value);
          }
        }
      }
    } catch {
      // No robots.txt, or it could not be read: the convention is that
      // crawling is permitted. We still identify ourselves and rate-limit.
    }
    robotsCache.set(origin, { at: Date.now(), rules });
  }

  const path = parsed.pathname + parsed.search;
  const longestMatch = (patterns) =>
    patterns.filter((p) => path.startsWith(p.replace(/\*$/, ''))).reduce((a, b) => (b.length > a.length ? b : a), '');
  const allow = longestMatch(rules.allow);
  const disallow = longestMatch(rules.disallow);
  if (!disallow) return true;
  return allow.length >= disallow.length;
}

/**
 * HTML to readable text. Deliberately simple: drop the furniture, keep the
 * block elements that carry prose, preserve paragraph breaks because §25's
 * boundary scoring depends on them.
 */
export function extractText(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|noscript|svg|iframe|form|nav|aside|footer|header)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  // Block-level tags become paragraph breaks so sentence/paragraph boundaries
  // survive the conversion.
  s = s.replace(/<\/(p|div|section|article|li|h[1-6]|blockquote|tr|br)\s*\/?>/gi, '\n\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t ]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', eacute: 'é', egrave: 'è',
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

const safeCodePoint = (n) => {
  try { return String.fromCodePoint(n); } catch { return ''; }
};

/**
 * Fetches one page and returns its text, or a reason why not. Never throws for
 * an unreachable page: a document we could not fetch still scores from its
 * snippet, and a pipeline that dies on one 403 is useless at corpus scale.
 */
export async function fetchPageText(url, { entityId = null, jobId = null, allowProviderFallback = true } = {}) {
  if (!config.pageFetchEnabled) return { ok: false, status: 'skipped', reason: 'page fetching disabled' };

  try {
    if (!(await robotsAllows(url))) {
      const viaProvider = allowProviderFallback ? await providerFallback(url, entityId, jobId) : null;
      return viaProvider ?? { ok: false, status: 'blocked', reason: 'robots.txt disallows this path' };
    }
  } catch {
    // Robots evaluation failing is not a reason to refuse the fetch.
  }

  try {
    const res = await request(
      'page',
      url,
      {
        redirect: 'follow',
        headers: {
          'user-agent': config.pageFetchUserAgent,
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'en',
        },
      },
      { retries: 1, timeoutMs: 20000 }
    );
    // request() parses JSON; HTML comes back in _raw.
    const html = typeof res === 'string' ? res : (res?._raw ?? '');
    if (!html || html.length > MAX_HTML_BYTES) {
      const viaProvider = allowProviderFallback ? await providerFallback(url, entityId, jobId) : null;
      return viaProvider ?? { ok: false, status: 'failed', reason: 'empty or oversized response' };
    }
    const text = extractText(html);
    if (text.length < 200) {
      const viaProvider = allowProviderFallback ? await providerFallback(url, entityId, jobId) : null;
      if (viaProvider) return viaProvider;
    }
    return { ok: true, status: 'fetched', text, source: 'direct' };
  } catch (err) {
    const viaProvider = allowProviderFallback ? await providerFallback(url, entityId, jobId) : null;
    return viaProvider ?? { ok: false, status: 'failed', reason: err.message };
  }
}

async function providerFallback(url, entityId, jobId) {
  if (!dfs.isConfigured()) return null;
  try {
    const parsed = await dfs.contentParsing(url, { entityId, jobId });
    if (parsed?.text && parsed.text.length > 200) {
      return { ok: true, status: 'fetched', text: parsed.text, source: 'dataforseo_content_parsing' };
    }
  } catch {
    // The fallback is best-effort by definition.
  }
  return null;
}

/**
 * §15 — how much of a document we keep. The window builder needs enough text
 * around each mention; storing the whole article would be both wasteful and,
 * for copyrighted material, wrong.
 */
export const MAX_STORED_BODY_CHARS = 60000;

export function storeBody(documentId, text, { status = 'fetched' } = {}) {
  const trimmed = (text ?? '').slice(0, MAX_STORED_BODY_CHARS);
  run(
    `UPDATE documents SET body_text = ?, body_chars = ?, fetch_status = ?, fetched_at = COALESCE(fetched_at, datetime('now'))
      WHERE id = ?`,
    trimmed || null,
    trimmed.length,
    status,
    documentId
  );
  return trimmed;
}

export const domainOf = rootDomain;
export const getDocument = (id) => get(`SELECT * FROM documents WHERE id = ?`, id);
