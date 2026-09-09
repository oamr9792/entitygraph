import config from '../config.js';
import { billedRequest, request, ProviderError } from './http-client.js';
import { canonicaliseUrl, rootDomain } from '../util/hash.js';

/**
 * DataForSEO v3 — the primary discovery corpus (§9).
 *
 * Every endpoint is POST with an array-of-tasks body returning
 * { status_code, cost, tasks: [{ status_code, result: [...] }] }. `rawCall`
 * unwraps that once so callers deal in results, not envelopes.
 *
 * Field mappings below were checked against live responses. Two of them are
 * load-bearing and surprising enough to call out:
 *
 *  - `date_published` is frequently absent on Content Analysis items. Roughly
 *    half of a typical corpus has only `group_date`. We keep both, use
 *    published_at ?? group_date for scoring, and record which was used so
 *    Coverage Confidence (§70) can report how much of the corpus was dated by
 *    inference rather than by the publisher.
 *
 *  - `url_rank` and `domain_rank` are on a 0–1000 scale, not 0–100. They are
 *    divided by 10 on ingest so everything downstream sees one scale.
 */
const ENDPOINTS = {
  content_search: '/v3/content_analysis/search/live',
  content_summary: '/v3/content_analysis/summary/live',
  phrase_trends: '/v3/content_analysis/phrase_trends/live',
  serp_organic: '/v3/serp/google/organic/live/advanced',
  content_parsing: '/v3/on_page/content_parsing/live',
  instant_pages: '/v3/on_page/instant_pages',
  bulk_spam_score: '/v3/backlinks/bulk_spam_score/live',
  user_data: '/v3/appendix/user_data',
};

const BASE = 'https://api.dataforseo.com';

function authHeader() {
  const cred = config.dataforseo;
  if (!cred) {
    throw new ProviderError(
      'DataForSEO credentials are not configured. Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD in .env — the password is the API password from app.dataforseo.com/api-access, not your account login password.',
      { provider: 'dataforseo', status: 412 }
    );
  }
  return 'Basic ' + Buffer.from(`${cred.login}:${cred.password}`).toString('base64');
}

export const isConfigured = () => Boolean(config.dataforseo);

export async function rawCall(endpoint, tasks, { method = 'POST' } = {}) {
  const body = await request('dataforseo', BASE + endpoint, {
    method,
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(Array.isArray(tasks) ? tasks : [tasks]) } : {}),
  });

  if (body?.status_code && body.status_code !== 20000) {
    throw new ProviderError(`DataForSEO: ${body.status_message} (${body.status_code})`, {
      provider: 'dataforseo',
      status: body.status_code === 40200 ? 402 : 400,
      body,
    });
  }
  const task = body?.tasks?.[0];
  if (!task) throw new ProviderError('DataForSEO returned no task', { provider: 'dataforseo', body });
  if (task.status_code !== 20000) {
    throw new ProviderError(`DataForSEO task: ${task.status_message} (${task.status_code})`, {
      provider: 'dataforseo',
      status: 400,
      body: task,
    });
  }
  return { result: task.result ?? [], cost: body.cost ?? task.cost ?? 0 };
}

function call(endpoint, task, { entityId = null, jobId = null, force = false, ttl } = {}) {
  return billedRequest({
    provider: 'dataforseo',
    endpoint,
    entityId,
    jobId,
    key: { endpoint, task },
    ttl,
    force,
    fn: () => rawCall(endpoint, task),
  });
}

// --- §9 Content Analysis: the discovery corpus ------------------------------

const scale1000 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(100, v / 10)) : null);

/**
 * Normalises one Content Analysis item into a DocumentCandidate (§12).
 * Providers differ; everything downstream sees this shape and only this shape.
 */
export function toDocumentCandidate(item, { provider = 'dataforseo' } = {}) {
  const info = item.content_info ?? {};
  const conn = info.connotation_types ?? {};
  const url = item.url;
  if (!url) return null;
  return {
    url,
    canonical_url: canonicaliseUrl(url),
    root_domain: item.main_domain || rootDomain(item.domain || url),
    title: info.title ?? null,
    main_title: info.main_title ?? null,
    previous_heading: info.previous_title ?? info.previous_heading ?? null,
    semantic_location: info.semantic_location ?? null,
    page_type: Array.isArray(item.page_types) ? item.page_types[0] ?? null : item.page_types ?? null,
    language: info.language ?? item.language ?? null,
    country: item.country ?? null,
    snippet: info.snippet ?? null,
    url_rank: scale1000(item.url_rank),
    domain_rank: scale1000(item.domain_rank),
    spam_score: null, // Content Analysis does not carry it; enriched separately.
    content_quality: Number.isFinite(info.content_quality_score) ? info.content_quality_score : null,
    // Raw relevance score. Unbounded, so it is normalised to a percentile
    // within the entity's own corpus at scoring time, not here.
    prominence_raw: Number.isFinite(item.score) ? item.score : null,
    sentiment_positive: Number.isFinite(conn.positive) ? conn.positive : null,
    sentiment_negative: Number.isFinite(conn.negative) ? conn.negative : null,
    sentiment_neutral: Number.isFinite(conn.neutral) ? conn.neutral : null,
    published_at: info.date_published ?? item.date_published ?? null,
    group_date: info.group_date ?? null,
    fetched_at: item.fetch_time ?? null,
    provider,
    provider_ref: item.type ?? null,
  };
}

/**
 * §9 — one page of citation results. `keyword` should already be quoted for an
 * exact-phrase match ("John Smith"); quoting is the caller's decision because
 * alias searches (§10) sometimes want the unquoted form.
 */
export async function contentSearch(keyword, { searchMode = 'as_is', limit = 100, offset = 0, filters = null, entityId, jobId, force } = {}) {
  const task = {
    keyword,
    search_mode: searchMode,
    limit: Math.min(1000, limit),
    offset,
    ...(filters ? { filters } : {}),
  };
  const { result, cost } = await call(ENDPOINTS.content_search, task, { entityId, jobId, force });
  const page = result?.[0] ?? {};
  return {
    total_count: page.total_count ?? 0,
    items: (page.items ?? []).map((i) => toDocumentCandidate(i)).filter(Boolean),
    offset,
    cost,
  };
}

/**
 * §9 — pagination until the corpus is exhausted, a document ceiling is hit, or
 * the caller's budget check throws. Returns what it managed to collect plus
 * why it stopped, because "we stopped early" is information the Coverage
 * Confidence panel has to show (§70/§71).
 */
export async function contentSearchAll(keyword, { searchMode = 'as_is', pageSize = 100, maxDocuments = 1000, entityId, jobId, force, onPage = null } = {}) {
  const items = [];
  let offset = 0;
  let total = 0;
  let reason = 'exhausted';

  for (;;) {
    let page;
    try {
      page = await contentSearch(keyword, { searchMode, limit: pageSize, offset, entityId, jobId, force });
    } catch (err) {
      // A budget or quota stop is a normal outcome of a deliberately bounded
      // crawl, not a failure of the crawl.
      if (err.status === 429 || err.status === 402) {
        reason = err.status === 402 ? 'provider_balance' : 'budget';
        break;
      }
      throw err;
    }
    total = page.total_count || total;
    items.push(...page.items);
    if (onPage) await onPage({ offset, received: page.items.length, total, collected: items.length });

    if (!page.items.length) { reason = 'exhausted'; break; }
    if (items.length >= maxDocuments) { reason = 'max_documents'; break; }
    offset += page.items.length;
    if (offset >= total) { reason = 'exhausted'; break; }
    // The API caps how deep the offset can go on a single keyword.
    if (offset >= 10000) { reason = 'provider_depth_limit'; break; }
  }

  return { items: items.slice(0, maxDocuments), total_count: total, stop_reason: reason, requested: offset };
}

export async function contentSummary(keyword, { entityId, jobId, force } = {}) {
  const { result } = await call(ENDPOINTS.content_summary, { keyword }, { entityId, jobId, force });
  const r = result?.[0] ?? {};
  return {
    total_count: r.total_count ?? 0,
    rank: r.rank ?? null,
    top_domains: r.top_domains ?? [],
    sentiment_connotations: r.sentiment_connotations ?? null,
    connotation_types: r.connotation_types ?? null,
    page_types: r.page_types ?? null,
    countries: r.countries ?? null,
    languages: r.languages ?? null,
  };
}

/**
 * §11 — citation counts over time.
 *
 * Two things the caller must know about the result:
 *
 *  1. The current period is always partial. The index lags by days, so the
 *     month in progress reports a fraction of its eventual count. It is
 *     flagged `partial` and momentum (§40) must exclude it, or every entity
 *     looks like it is collapsing on the 3rd of the month.
 *
 *  2. `search_mode: one_per_domain` gives the one-per-domain series the brief
 *     asks for. VERIFY against docs if this ever starts returning identical
 *     numbers to as_is — the parameter is accepted on search, and the trends
 *     endpoint has historically shared its filter surface.
 */
export async function phraseTrends(keyword, { dateFrom, dateTo = null, dateGroup = 'month', searchMode = 'as_is', internalListLimit = 10, entityId, jobId, force } = {}) {
  const task = {
    keyword,
    date_from: dateFrom,
    ...(dateTo ? { date_to: dateTo } : {}),
    date_group: dateGroup,
    search_mode: searchMode,
    internal_list_limit: internalListLimit,
  };
  const { result } = await call(ENDPOINTS.phrase_trends, task, { entityId, jobId, force });
  // Unlike search and summary, phrase_trends returns the periods directly in
  // `result` rather than nesting them under `result[0].items`. Reading it the
  // usual way silently yields an empty series — which looks exactly like "this
  // entity has no history" rather than like a parsing bug, so it is worth the
  // comment.
  const items = Array.isArray(result?.[0]?.items) ? result[0].items : (result ?? []);
  const periodStart = currentPeriodStart(dateGroup);
  return items.map((i) => ({
    date: i.date,
    total_count: i.total_count ?? 0,
    rank: i.rank ?? null,
    top_domains: i.top_domains ?? [],
    connotation_types: i.connotation_types ?? null,
    sentiment_connotations: i.sentiment_connotations ?? null,
    page_types: i.page_types ?? null,
    countries: i.countries ?? null,
    languages: i.languages ?? null,
    partial: String(i.date ?? '').slice(0, 10) >= periodStart,
    search_mode: searchMode,
  }));
}

function currentPeriodStart(dateGroup) {
  const now = new Date();
  if (dateGroup === 'month') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  if (dateGroup === 'week') {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }
  return now.toISOString().slice(0, 10);
}

// --- §13 SERP layer ---------------------------------------------------------

/**
 * §13/§52 — Google organic results, kept strictly separate from the corpus.
 * This answers "what is Google retrieving", which is a different question from
 * "what does the web say", and conflating the two is the mistake §14 exists to
 * prevent.
 */
export async function serpOrganic(keyword, { depth = 100, location = 'United States', language = 'en', device = 'desktop', entityId, jobId, force } = {}) {
  const task = {
    keyword,
    location_name: location,
    language_code: language,
    depth,
    device,
    os: 'windows',
  };
  const { result } = await call(ENDPOINTS.serp_organic, task, { entityId, jobId, force });
  const page = result?.[0] ?? {};
  const items = page.items ?? [];
  const organic = items.filter((i) => i.type === 'organic');
  return {
    keyword,
    location,
    language,
    device,
    depth,
    item_types: [...new Set(items.map((i) => i.type))],
    knowledge_graph: items.find((i) => i.type === 'knowledge_graph') ?? null,
    results: organic.map((i) => ({
      rank: i.rank_absolute ?? i.rank_group,
      url: i.url,
      root_domain: rootDomain(i.domain || i.url),
      title: i.title ?? null,
      description: i.description ?? i.snippet ?? null,
      is_featured_snippet: Boolean(i.is_featured_snippet),
    })),
  };
}

// --- §15 Page context -------------------------------------------------------

/**
 * Fallback for §15 when a direct fetch is blocked. DataForSEO has already
 * crawled these pages, so this is usually the cheaper and more reliable route
 * for the sites that reject unknown user agents.
 */
export async function contentParsing(url, { entityId, jobId, force } = {}) {
  const { result } = await call(ENDPOINTS.content_parsing, { url }, { entityId, jobId, force });
  const content = result?.[0]?.items?.[0]?.page_content;
  if (!content) return null;
  const blocks = [];
  const collect = (section) => {
    if (!section) return;
    for (const part of Array.isArray(section) ? section : [section]) {
      for (const key of ['primary_content', 'secondary_content']) {
        if (part?.[key]) blocks.push(...part[key].map((p) => p.text).filter(Boolean));
      }
    }
  };
  collect(content.header);
  collect(content.main_topic);
  collect(content.secondary_topic);
  collect(content.footer);
  return { url, text: blocks.join('\n\n').trim() };
}

/** §26 — spam score, which Content Analysis does not carry. Up to 1,000 targets. */
export async function bulkSpamScore(domains, { entityId, jobId, force } = {}) {
  if (!domains.length) return new Map();
  const { result } = await call(
    ENDPOINTS.bulk_spam_score,
    { targets: domains.slice(0, 1000) },
    { entityId, jobId, force }
  );
  const out = new Map();
  for (const item of result?.[0]?.items ?? []) {
    if (item.target) out.set(item.target, item.spam_score ?? null);
  }
  return out;
}

/** Cheap connectivity and balance probe for the settings screen. */
export async function ping() {
  const body = await request('dataforseo', BASE + ENDPOINTS.user_data, {
    method: 'GET',
    headers: { Authorization: authHeader() },
  });
  const data = body?.tasks?.[0]?.result?.[0];
  if (!data) throw new ProviderError('DataForSEO did not return account data', { provider: 'dataforseo' });
  return { login: data.login, balance: data.money?.balance, currency: 'USD', limits: data.rates?.limits_ttl ?? null };
}

export { ENDPOINTS };
