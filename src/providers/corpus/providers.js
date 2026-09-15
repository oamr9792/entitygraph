import config from '../../config.js';
import { registerProvider, normaliseCandidate } from './index.js';
import * as dfs from '../dataforseo.js';
import { request } from '../http-client.js';
import { canonicaliseUrl, rootDomain } from '../../util/hash.js';

/**
 * The four providers named in §12. Each declares its historical reach honestly,
 * because Coverage Confidence (§70) reports it and an optimistic answer here
 * turns into an overstated confidence rating downstream.
 */

// --- DataForSEO -------------------------------------------------------------

export const DataForSEOProvider = registerProvider({
  name: 'dataforseo',
  available: () => dfs.isConfigured(),
  describe: () => ({
    name: 'dataforseo',
    kind: 'citation_index',
    historical_coverage: 'Deep but uneven. Publication dates are missing on a large minority of items; group_date substitutes.',
    notes: 'Primary discovery corpus (§9). Paginates to the provider depth limit.',
  }),
  async search(query, options = {}) {
    const res = await dfs.contentSearchAll(query, {
      searchMode: options.searchMode ?? 'as_is',
      pageSize: options.pageSize ?? 100,
      maxDocuments: options.maxDocuments ?? 1000,
      filters: options.filters ?? null,
      entityId: options.entityId,
      jobId: options.jobId,
      force: options.force,
      onPage: options.onPage,
    });
    return { items: res.items, total_count: res.total_count, stop_reason: res.stop_reason, provider: 'dataforseo' };
  },
});

// --- Google SERP ------------------------------------------------------------

/**
 * §12/§13 — the SERP as a corpus provider is a *different use* of the SERP
 * from the overlay in §52. Here it contributes documents; there it measures
 * retrieval. Documents discovered this way are still tagged with their
 * provider, so the §14 distinction survives ingestion.
 */
export const GoogleSERPProvider = registerProvider({
  name: 'google_serp',
  available: () => dfs.isConfigured(),
  describe: () => ({
    name: 'google_serp',
    kind: 'search_results',
    historical_coverage: 'None. A SERP is a snapshot of what ranks today.',
    notes: 'Contributes prominent documents the citation index may rank poorly.',
  }),
  async search(query, options = {}) {
    const serp = await dfs.serpOrganic(String(query).replace(/^"|"$/g, ""), {
      depth: options.depth ?? 100,
      location: options.location,
      language: options.language,
      entityId: options.entityId,
      jobId: options.jobId,
      force: options.force,
    });
    return {
      items: serpCandidates(serp),
      total_count: serp.results.length,
      stop_reason: 'exhausted',
      provider: 'google_serp',
    };
  },
});

/**
 * A Google results page as document candidates, one per organic result.
 *
 * `provider_ref` records the organic position at the capture that first created
 * the document. It is provenance, not a live rank: an existing document keeps
 * the tag it was created with, so ranks are always read from a stored snapshot.
 */
export function serpCandidates(serp) {
  return (serp?.results ?? [])
    .map((r) => normaliseCandidate({
      url: r.url,
      root_domain: r.root_domain,
      title: r.title,
      snippet: r.description,
      provider: 'google_serp',
      provider_ref: `rank:${r.rank}`,
    }, 'google_serp'))
    .filter(Boolean);
}

// --- Common Crawl -----------------------------------------------------------

const CC_INDEX_LIST = 'https://index.commoncrawl.org/collinfo.json';

/**
 * §12 — Common Crawl's URL index is free and needs no key, which makes it the
 * natural historical extension. Its limitation is structural and worth stating
 * plainly: it is a *URL* index, not a text index. You cannot ask it "which
 * pages mention John Smith"; you can ask "which pages exist under this domain,
 * and when did they first appear". So it runs in domain mode — given domains
 * the other providers surfaced, it recovers earlier captures of those sites.
 */
export const CommonCrawlProvider = registerProvider({
  name: 'commoncrawl',
  available: () => true,
  describe: () => ({
    name: 'commoncrawl',
    kind: 'url_index',
    historical_coverage: 'Monthly crawls from 2013 onward, sampled rather than exhaustive.',
    notes: 'Domain mode only — it indexes URLs, not text, so it extends history for domains other providers found.',
  }),
  async search(query, options = {}) {
    const domains = options.domains ?? [];
    if (!domains.length) {
      return { items: [], total_count: 0, stop_reason: 'no_domains', provider: 'commoncrawl' };
    }
    const collections = await request('commoncrawl', CC_INDEX_LIST, { headers: { 'user-agent': config.pageFetchUserAgent } });
    const indexes = (collections ?? []).slice(0, options.crawls ?? 2);
    const items = [];
    for (const index of indexes) {
      for (const domain of domains.slice(0, options.maxDomains ?? 20)) {
        const url = `${index['cdx-api']}?url=${encodeURIComponent(domain + '/*')}&output=json&limit=${options.perDomain ?? 50}`;
        try {
          const text = await request('commoncrawl', url, {
            headers: { 'user-agent': config.pageFetchUserAgent, accept: 'application/json' },
          });
          const lines = typeof text === 'string' ? text.split('\n') : (text?._raw ?? '').split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            let row;
            try { row = JSON.parse(line); } catch { continue; }
            if (!row.url || row.status !== '200') continue;
            items.push({
              url: row.url,
              canonical_url: canonicaliseUrl(row.url),
              root_domain: rootDomain(row.url),
              published_at: cdxTimestampToIso(row.timestamp),
              provider: 'commoncrawl',
              provider_ref: index.id,
            });
          }
        } catch {
          // One unavailable crawl index is not a failed ingest.
        }
      }
    }
    return { items, total_count: items.length, stop_reason: 'exhausted', provider: 'commoncrawl' };
  },
});

function cdxTimestampToIso(ts) {
  if (!ts || String(ts).length < 8) return null;
  const s = String(ts);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

// --- Manual URLs ------------------------------------------------------------

/**
 * §12 — an analyst pasting URLs they know matter. Also the import path for
 * licensed archives: hand it rows, it normalises them like any other provider.
 */
export const ManualURLProvider = registerProvider({
  name: 'manual',
  available: () => true,
  describe: () => ({
    name: 'manual',
    kind: 'manual',
    historical_coverage: 'Whatever the analyst supplies.',
    notes: 'Accepts pasted URLs or imported rows from a licensed archive.',
  }),
  async search(_query, options = {}) {
    const rows = options.urls ?? [];
    return {
      items: rows
        .map((r) => (typeof r === 'string' ? { url: r } : r))
        .filter((r) => r.url)
        .map((r) => ({
          ...r,
          canonical_url: canonicaliseUrl(r.url),
          root_domain: r.root_domain ?? rootDomain(r.url),
          provider: 'manual',
        })),
      total_count: rows.length,
      stop_reason: 'exhausted',
      provider: 'manual',
    };
  },
});
