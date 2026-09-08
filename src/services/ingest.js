import { get, run, tx } from '../db.js';
import { canonicaliseUrl, rootDomain } from '../util/hash.js';
import { classifyDomain } from './scoring.js';
import { normaliseDate } from '../util/stats.js';

/**
 * Corpus ingestion. Turns normalised DocumentCandidates into rows.
 *
 * §10's rule is enforced here rather than at the provider: the same URL found
 * under three different alias searches is one document. Deduplication is on
 * canonical URL, so tracking parameters and AMP variants collapse too.
 */

export function upsertDomain(rootDomainName, { domainRank = null, spamScore = null } = {}) {
  if (!rootDomainName) return null;
  const existing = get(`SELECT * FROM domains WHERE root_domain = ?`, rootDomainName);
  const classification = classifyDomain({ domainRank, spamScore });

  if (existing) {
    // Never overwrite a human classification, and only improve on nulls.
    run(
      `UPDATE domains SET
         domain_rank = COALESCE(?, domain_rank),
         spam_score = COALESCE(?, spam_score),
         classification = CASE WHEN classification_override IS NOT NULL THEN classification ELSE ? END,
         updated_at = datetime('now')
       WHERE id = ?`,
      domainRank,
      spamScore,
      classification,
      existing.id
    );
    return existing.id;
  }

  const res = run(
    `INSERT INTO domains (root_domain, domain_rank, spam_score, classification) VALUES (?, ?, ?, ?)`,
    rootDomainName,
    domainRank,
    spamScore,
    classification
  );
  return Number(res.lastInsertRowid);
}

/**
 * Inserts or enriches one document. Returns { id, created }.
 *
 * On a repeat sighting, fields are filled in but never overwritten with nulls:
 * a document first seen through a SERP (title only) and later through the
 * citation index (ranks, sentiment, dates) should end up with both.
 */
export function upsertDocument(rawCandidate) {
  // Dates are normalised to ISO here and nowhere else. SQLite compares dates
  // as text, so a corpus holding two date formats compares them wrongly at
  // exactly the window boundaries the product is built to measure.
  const candidate = {
    ...rawCandidate,
    published_at: normaliseDate(rawCandidate.published_at),
    group_date: normaliseDate(rawCandidate.group_date),
    fetched_at: normaliseDate(rawCandidate.fetched_at),
  };
  const url = candidate.url;
  const canonical = candidate.canonical_url ?? canonicaliseUrl(url);
  const root = candidate.root_domain ?? rootDomain(url);
  const domainId = upsertDomain(root, {
    domainRank: candidate.domain_rank,
    spamScore: candidate.spam_score,
  });

  const existing =
    get(`SELECT * FROM documents WHERE url = ?`, url) ??
    (canonical ? get(`SELECT * FROM documents WHERE canonical_url = ?`, canonical) : null);

  if (existing) {
    run(
      `UPDATE documents SET
         domain_id = COALESCE(domain_id, ?),
         root_domain = COALESCE(root_domain, ?),
         title = COALESCE(title, ?),
         main_title = COALESCE(main_title, ?),
         previous_heading = COALESCE(previous_heading, ?),
         semantic_location = COALESCE(semantic_location, ?),
         page_type = COALESCE(page_type, ?),
         language = COALESCE(language, ?),
         country = COALESCE(country, ?),
         snippet = COALESCE(snippet, ?),
         url_rank = COALESCE(url_rank, ?),
         domain_rank = COALESCE(domain_rank, ?),
         spam_score = COALESCE(?, spam_score),
         content_quality = COALESCE(content_quality, ?),
         prominence = COALESCE(prominence, ?),
         sentiment_positive = COALESCE(sentiment_positive, ?),
         sentiment_negative = COALESCE(sentiment_negative, ?),
         sentiment_neutral = COALESCE(sentiment_neutral, ?),
         published_at = COALESCE(published_at, ?),
         group_date = COALESCE(group_date, ?),
         fetched_at = COALESCE(fetched_at, ?)
       WHERE id = ?`,
      domainId,
      root,
      candidate.title,
      candidate.main_title,
      candidate.previous_heading,
      candidate.semantic_location,
      candidate.page_type,
      candidate.language,
      candidate.country,
      candidate.snippet,
      candidate.url_rank,
      candidate.domain_rank,
      candidate.spam_score,
      candidate.content_quality,
      candidate.prominence_raw,
      candidate.sentiment_positive,
      candidate.sentiment_negative,
      candidate.sentiment_neutral,
      candidate.published_at,
      candidate.group_date,
      candidate.fetched_at,
      existing.id
    );
    return { id: existing.id, created: false };
  }

  const res = run(
    `INSERT INTO documents
       (url, canonical_url, domain_id, root_domain, title, main_title, previous_heading, semantic_location,
        page_type, language, country, snippet, url_rank, domain_rank, spam_score, content_quality, prominence,
        sentiment_positive, sentiment_negative, sentiment_neutral, published_at, group_date, fetched_at,
        provider, provider_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    url,
    canonical,
    domainId,
    root,
    candidate.title,
    candidate.main_title,
    candidate.previous_heading,
    candidate.semantic_location,
    candidate.page_type,
    candidate.language,
    candidate.country,
    candidate.snippet,
    candidate.url_rank,
    candidate.domain_rank,
    candidate.spam_score,
    candidate.content_quality,
    candidate.prominence_raw,
    candidate.sentiment_positive,
    candidate.sentiment_negative,
    candidate.sentiment_neutral,
    candidate.published_at,
    candidate.group_date,
    candidate.fetched_at,
    candidate.provider ?? 'unknown',
    candidate.provider_ref ?? null
  );
  return { id: Number(res.lastInsertRowid), created: true };
}

export function ingestCandidates(candidates) {
  return tx(() => {
    let created = 0;
    let enriched = 0;
    const ids = [];
    for (const candidate of candidates) {
      if (!candidate?.url) continue;
      const res = upsertDocument(candidate);
      ids.push(res.id);
      if (res.created) created += 1;
      else enriched += 1;
    }
    return { created, enriched, ids, total: ids.length };
  });
}

/** §12 — a new body hash for a URL we have seen before is a new version. */
export function recordVersion(documentId, { contentHash, bodyChars, publishedAt }) {
  const latest = get(
    `SELECT content_hash FROM document_versions WHERE document_id = ? ORDER BY observed_at DESC LIMIT 1`,
    documentId
  );
  if (latest?.content_hash === contentHash) return { changed: false };
  run(
    `INSERT INTO document_versions (document_id, content_hash, body_chars, published_at) VALUES (?, ?, ?, ?)`,
    documentId,
    contentHash,
    bodyChars ?? null,
    publishedAt ?? null
  );
  return { changed: true, first: !latest };
}
