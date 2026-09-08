import { canonicaliseUrl, rootDomain } from '../../util/hash.js';

/**
 * §12 — the CorpusProvider interface.
 *
 * No commercial crawl reproduces Google's historical index, so the corpus is
 * explicitly pluggable. A provider is anything with:
 *
 *   name        string
 *   available() boolean — configured and usable right now
 *   describe()  { name, kind, historical_coverage, notes }
 *   search(query, options) -> { items: DocumentCandidate[], total_count,
 *                               stop_reason, provider }
 *
 * Every provider returns the same normalised DocumentCandidate, so the rest of
 * the pipeline never learns where a document came from — except in the one
 * place it must: coverage reporting (§70), which names its sources.
 */

export const DOCUMENT_CANDIDATE_FIELDS = [
  'url', 'canonical_url', 'root_domain', 'title', 'main_title', 'previous_heading',
  'semantic_location', 'page_type', 'language', 'country', 'snippet', 'body_text',
  'url_rank', 'domain_rank', 'spam_score', 'content_quality', 'prominence_raw',
  'sentiment_positive', 'sentiment_negative', 'sentiment_neutral',
  'published_at', 'group_date', 'fetched_at', 'provider', 'provider_ref',
];

/** Fills defaults and derives url fields. Providers may skip anything optional. */
export function normaliseCandidate(raw, provider) {
  if (!raw?.url) return null;
  const out = {};
  for (const field of DOCUMENT_CANDIDATE_FIELDS) out[field] = raw[field] ?? null;
  out.url = String(raw.url).trim();
  out.canonical_url = raw.canonical_url ?? canonicaliseUrl(out.url);
  out.root_domain = raw.root_domain ?? rootDomain(out.url);
  out.provider = raw.provider ?? provider ?? 'unknown';
  return out;
}

const registry = new Map();

export function registerProvider(provider) {
  registry.set(provider.name, provider);
  return provider;
}

export const getProvider = (name) => registry.get(name) ?? null;

export const listProviders = () =>
  [...registry.values()].map((p) => ({ ...p.describe(), available: p.available() }));

/**
 * Runs a query across several providers and merges by canonical URL (§10: do
 * not count duplicate URLs twice). The first provider to return a URL owns the
 * row; later providers only fill in fields the first one left null, so a
 * provider with richer metadata can enrich without overwriting.
 */
export async function searchAcross(providerNames, query, options = {}) {
  const merged = new Map();
  const report = [];

  for (const name of providerNames) {
    const provider = registry.get(name);
    if (!provider) { report.push({ provider: name, ok: false, error: 'unknown provider' }); continue; }
    if (!provider.available()) { report.push({ provider: name, ok: false, error: 'not configured' }); continue; }
    try {
      const res = await provider.search(query, options);
      let added = 0;
      for (const item of res.items) {
        const candidate = normaliseCandidate(item, name);
        if (!candidate) continue;
        const key = candidate.canonical_url || candidate.url;
        const existing = merged.get(key);
        if (!existing) {
          merged.set(key, candidate);
          added += 1;
        } else {
          for (const field of DOCUMENT_CANDIDATE_FIELDS) {
            if (existing[field] === null && candidate[field] !== null) existing[field] = candidate[field];
          }
        }
      }
      report.push({
        provider: name,
        ok: true,
        returned: res.items.length,
        added,
        total_count: res.total_count ?? null,
        stop_reason: res.stop_reason ?? null,
      });
    } catch (err) {
      report.push({ provider: name, ok: false, error: err.message });
    }
  }

  return { items: [...merged.values()], report };
}
