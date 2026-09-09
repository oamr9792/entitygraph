import config, { MODEL } from '../config.js';
import { all, get, run, setSetting } from '../db.js';
import { identityProfile, searchQueries } from '../services/identity.js';
import { searchAcross } from '../providers/corpus/index.js';
import '../providers/corpus/providers.js'; // registers the four providers
import * as dfs from '../providers/dataforseo.js';
import { ingestCandidates, recordVersion } from '../services/ingest.js';
import { fetchPageText, storeBody, mapPool } from '../services/fetch.js';
import { scoreDocument, adjudicate, saveMatch } from '../services/disambiguation.js';
import { buildWindows, extractFromWindow } from '../services/extraction.js';
import { upsertAssociation, recordSurfaceForm, canonicaliseAssociations, applyDefaultHierarchy } from '../services/canonicalize.js';
import { fingerprintDocument, clusterDocuments } from '../services/duplicates.js';
import { rescoreEntity, persistMonthlyMetrics, leaderboard } from '../services/metrics.js';
import { captureEntitySerp, classifySnapshot, associationQueries, captureAssociationSerp } from '../services/serp.js';
import { coverageConfidence } from '../services/coverage.js';
import { generateAlerts, storeSnapshot } from '../services/alerts.js';
import { contentHash } from '../util/hash.js';
import { findOccurrences, classifyBoundary, tokenDistance, splitSentences, splitParagraphs, normaliseWhitespace } from '../util/text.js';
import { spendForEntity } from '../providers/http-client.js';

/**
 * §67 — the job pipeline.
 *
 * Each step is a named async function taking a context and reporting progress.
 * They run in order, they are individually restartable, and each one records
 * what it did so a half-finished build can be read rather than guessed at.
 *
 * §66's four passes map onto these steps: cheap candidate extraction (fetch
 * citations), entity disambiguation (markers, then LLM only for the uncertain
 * band), association extraction only on accepted documents, and expensive
 * validation only where it changes an outcome.
 */

export const STEPS = [
  'build_identity_profile',
  'fetch_entity_citations',
  'fetch_corpus_history',
  'fetch_evidence_windows',
  'entity_disambiguation',
  'extract_associations',
  'canonicalise_associations',
  'detect_duplicates',
  'calculate_document_scores',
  'calculate_association_scores',
  'run_serp_queries',
  'generate_dashboard',
];

export async function runPipeline(ctx) {
  const { entityId, report } = ctx;
  const entity = get(`SELECT * FROM entities WHERE id = ?`, entityId);
  if (!entity) throw new Error(`entity ${entityId} not found`);
  run(`UPDATE entities SET status = 'building' WHERE id = ?`, entityId);

  const state = {
    entity,
    profile: null,
    documentIds: [],
    accepted: [],
    counts: {},
    options: ctx.options ?? {},
  };

  try {
    for (const step of STEPS) {
      if (ctx.shouldStop?.()) {
        await report(step, 'skipped', 'job cancelled');
        break;
      }
      if (state.options.skip?.includes(step)) {
        await report(step, 'skipped', 'skipped by request');
        continue;
      }
      await report(step, 'running');
      const detail = await HANDLERS[step](state, ctx);
      await report(step, 'done', detail);
    }
    run(`UPDATE entities SET status = 'ready', updated_at = datetime('now') WHERE id = ?`, entityId);
    return state.counts;
  } catch (err) {
    run(`UPDATE entities SET status = 'error' WHERE id = ?`, entityId);
    throw err;
  }
}

const HANDLERS = {
  async build_identity_profile(state) {
    state.profile = identityProfile(state.entity.id);
    const markers = state.profile.markers.filter((m) => m.polarity === 1).length;
    state.counts.aliases = state.profile.aliases.length + 1;
    state.counts.markers = markers;
    if (!markers) {
      return `${state.counts.aliases} names, no identity markers — disambiguation will reject almost everything. Add markers before relying on this build.`;
    }
    return `${state.counts.aliases} names, ${markers} identity markers`;
  },

  /**
   * §9, §10 — query the citation corpus for every searchable alias and merge.
   * Aliases are queried as exact phrases; the provider treats a quoted keyword
   * as a phrase match, which is what stops "John Smith" matching "John" and
   * "Smith" in unrelated positions.
   */
  async fetch_entity_citations(state, ctx) {
    const entityId = state.entity.id;
    const maxDocuments = state.entity.max_documents ?? config.limits.maxDocuments;
    const aliases = state.options.aliases ?? searchQueries(entityId);
    const providers = state.options.providers ?? ['dataforseo'];
    const queried = [];
    let stopReason = 'exhausted';
    let totalAvailable = 0;
    const collected = [];

    for (const alias of aliases) {
      if (collected.length >= maxDocuments) { stopReason = 'max_documents'; break; }
      const remaining = maxDocuments - collected.length;
      const { items, report } = await searchAcross(providers, `"${alias}"`, {
        maxDocuments: remaining,
        pageSize: state.options.pageSize ?? 100,
        entityId,
        jobId: ctx.jobId,
        searchMode: state.options.searchMode ?? 'as_is',
        force: state.options.force,
        urls: state.options.urls,
        onPage: ctx.heartbeat,
      });
      queried.push(alias);
      collected.push(...items);
      for (const r of report) {
        if (r.total_count) totalAvailable = Math.max(totalAvailable, r.total_count);
        if (r.stop_reason && r.stop_reason !== 'exhausted') stopReason = r.stop_reason;
        if (!r.ok && r.provider === 'dataforseo') throw new Error(`corpus provider failed: ${r.error}`);
      }
    }

    const ingested = ingestCandidates(collected);
    state.documentIds = ingested.ids;
    state.counts.documents_seen = collected.length;
    state.counts.documents_new = ingested.created;

    // Recorded for §70/§71: coverage cannot be reported honestly without
    // knowing which aliases ran and why ingestion stopped.
    setSetting(`ingest:${entityId}`, {
      queried_aliases: queried,
      stop_reason: stopReason,
      total_available: totalAvailable,
      collected: collected.length,
      unique: ingested.total,
      at: new Date().toISOString(),
    });

    return `${collected.length} citations over ${queried.length} alias queries → ${ingested.total} unique documents (${ingested.created} new); stopped: ${stopReason}`;
  },

  /**
   * §11 — the corpus's own history, from Phrase Trends.
   *
   * This is a different measurement from our document counts and it matters
   * for exactly one reason: it tells us how much of the entity's citation
   * history the provider actually has. Our timeline can only show months we
   * retrieved documents for; this shows the months that exist. The difference
   * between the two is what §11 means by "historical availability limitations
   * must be displayed to users".
   *
   * Both search modes are stored (§11): as_is counts citations, one_per_domain
   * counts domains, and the ratio between them is a direct read on how much of
   * a period's volume is one site repeating itself.
   */
  async fetch_corpus_history(state, ctx) {
    if (!dfs.isConfigured()) return 'skipped — DataForSEO not configured';
    if (state.options.skipTrends) return 'skipped by request';
    const entity = state.entity;
    const dateFrom = state.options.trendsFrom ?? '2018-01-01';
    const series = {};

    for (const searchMode of ['as_is', 'one_per_domain']) {
      try {
        series[searchMode] = await dfs.phraseTrends(`"${entity.canonical_name}"`, {
          dateFrom,
          dateGroup: 'month',
          searchMode,
          entityId: entity.id,
          jobId: ctx.jobId,
          force: state.options.force,
        });
      } catch (err) {
        series[searchMode] = { error: err.message };
      }
    }

    const asIs = Array.isArray(series.as_is) ? series.as_is : [];
    const complete = asIs.filter((p) => !p.partial);
    setSetting(`trends:${entity.id}`, {
      date_from: dateFrom,
      fetched_at: new Date().toISOString(),
      as_is: asIs,
      one_per_domain: Array.isArray(series.one_per_domain) ? series.one_per_domain : [],
      earliest_month: complete[0]?.date ?? null,
      total_citations: complete.reduce((a, p) => a + (p.total_count ?? 0), 0),
    });

    if (!complete.length) return 'no trend data returned';
    return `${complete.length} complete months from ${String(complete[0].date).slice(0, 7)}; ${complete.reduce((a, p) => a + (p.total_count ?? 0), 0).toLocaleString()} citations in the provider's index`;
  },

  /**
   * §15 — page context. Fetching every document would be slow and rude, so
   * this fetches the documents most likely to change a score: the ones whose
   * snippet already suggests a real mention, ordered by domain authority.
   */
  async fetch_evidence_windows(state, ctx) {
    if (!config.pageFetchEnabled) return 'page fetching disabled';
    const limit = state.options.fetchLimit ?? 150;
    const docs = all(
      `SELECT * FROM documents
        WHERE id IN (${state.documentIds.map(() => '?').join(',') || 'NULL'})
          AND fetch_status = 'snippet_only'
        ORDER BY domain_rank DESC NULLS LAST, prominence DESC
        LIMIT ?`,
      ...state.documentIds,
      limit
    );

    let fetched = 0;
    let failed = 0;
    let fallbacks = 0;
    // The DataForSEO content-parsing fallback is a billed call. Letting it fire
    // on every unreachable page turns a free failure into a paid one, hundreds
    // of times over, for documents that already have a usable snippet. Spend it
    // on the best-ranked documents and let the rest fall back to the snippet.
    const fallbackBudget = state.options.fallbackBudget ?? 25;

    await mapPool(docs, state.options.fetchConcurrency ?? 8, async (doc) => {
      if (ctx.shouldStop?.()) return;
      const allowProviderFallback = fallbacks < fallbackBudget;
      if (allowProviderFallback) fallbacks += 1;
      const res = await fetchPageText(doc.url, {
        entityId: state.entity.id,
        jobId: ctx.jobId,
        allowProviderFallback,
      });
      if (res.ok) {
        const stored = storeBody(doc.id, res.text);
        recordVersion(doc.id, { contentHash: contentHash(stored), bodyChars: stored.length, publishedAt: doc.published_at });
        fetched += 1;
      } else {
        run(`UPDATE documents SET fetch_status = ? WHERE id = ?`, res.status, doc.id);
        failed += 1;
      }
      await ctx.heartbeat?.({ step: 'fetch_evidence_windows', fetched, failed, of: docs.length });
    });

    state.counts.fetched = fetched;
    return `${fetched} pages fetched, ${failed} unavailable, ${state.documentIds.length - docs.length} left on snippet only`;
  },

  /** §8 — markers first, LLM adjudication only for the review band (§66). */
  async entity_disambiguation(state, ctx) {
    const profile = state.profile;
    const docs = all(
      `SELECT * FROM documents WHERE id IN (${state.documentIds.map(() => '?').join(',') || 'NULL'})`,
      ...state.documentIds
    );
    let accepted = 0;
    let review = 0;
    let rejected = 0;
    let adjudicated = 0;
    const adjudicationBudget = state.options.adjudicationBudget ?? 60;

    for (const doc of docs) {
      if (ctx.shouldStop?.()) break;
      let result = scoreDocument(profile, {
        url: doc.url,
        title: doc.title ?? doc.main_title,
        snippet: doc.snippet,
        body: doc.body_text,
      });

      if (result.verdict === 'review' && adjudicated < adjudicationBudget) {
        try {
          const verdict = await adjudicate(profile, {
            url: doc.url,
            title: doc.title,
            snippet: doc.snippet,
            body: doc.body_text,
          }, { entityId: state.entity.id, jobId: ctx.jobId });
          if (verdict) { result = { ...verdict, matched_alias: result.matched_alias }; adjudicated += 1; }
        } catch {
          // Leave the marker verdict standing; the document stays in review.
        }
      }

      saveMatch(state.entity.id, doc.id, result);
      if (result.verdict === 'accept') accepted += 1;
      else if (result.verdict === 'review') review += 1;
      else rejected += 1;
    }

    state.counts.accepted = accepted;
    state.counts.review = review;
    state.counts.rejected = rejected;
    if (!accepted) {
      return `0 of ${docs.length} documents accepted — every candidate failed identity checks. Check the identity markers.`;
    }
    return `${accepted} accepted, ${review} to review, ${rejected} rejected (${adjudicated} adjudicated by LLM)`;
  },

  /**
   * §16 — association extraction, only on documents that passed §8.
   *
   * Token distance and grammatical boundary are computed here, from the real
   * text, and stored on the evidence row. Scoring never re-reads the document.
   */
  async extract_associations(state, ctx) {
    const profile = state.profile;
    const aliases = [profile.canonical_name, ...profile.aliases];
    const docs = all(
      `SELECT d.*, m.entity_confidence FROM documents d
         JOIN entity_document_matches m ON m.document_id = d.id
        WHERE m.entity_id = ? AND m.verdict = 'accept'
        ORDER BY d.domain_rank DESC NULLS LAST`,
      state.entity.id
    );

    let associationsFound = 0;
    let evidenceRows = 0;
    let discarded = 0;
    let processed = 0;

    // Documents are independent: each deletes and rewrites only its own
    // evidence rows. Windows within a document stay sequential, because their
    // order is what assigns occurrence_index and therefore drives §32's
    // repetition cap. Concurrency is modest — this is the step that spends
    // money, and a provider rate-limit error costs more than it saves.
    await mapPool(docs, state.options.extractConcurrency ?? 5, async (doc) => {
      if (ctx.shouldStop?.()) return;
      const text = [doc.title, doc.snippet, doc.body_text].filter(Boolean).join('\n\n');
      const windows = buildWindows(text, aliases, { maxWindows: state.options.windowsPerDocument ?? 3 });
      if (!windows.length) return;

      run(`DELETE FROM evidence WHERE entity_id = ? AND document_id = ? AND manually_verified = 0`, state.entity.id, doc.id);
      const perAssociationCount = new Map();

      for (const window of windows) {
        let extraction;
        try {
          extraction = await extractFromWindow(profile, window, { entityId: state.entity.id, jobId: ctx.jobId });
        } catch (err) {
          if (err.status === 429) throw err; // a budget stop must halt the run
          continue;
        }
        discarded += extraction.discarded_unsupported ?? 0;
        if (!extraction.target_entity_confirmed) continue;

        const windowSentences = splitSentences(window.text);
        const windowParagraphs = splitParagraphs(window.text);

        for (const association of extraction.associations) {
          const associationId = upsertAssociation(state.entity.id, {
            canonical_label: association.canonical_label,
            kind: association.kind,
            category: association.category,
          });
          if (!associationId) continue;
          recordSurfaceForm(associationId, association.surface_form);
          associationsFound += 1;

          // Measure §24's distance between the nearest name mention and the
          // nearest mention of the association, inside this window.
          const nameHits = findOccurrences(window.text, aliases);
          const assocHits = findOccurrences(window.text, [association.surface_form, association.canonical_label]);
          let bestDistance = null;
          let bestBoundary = 'same_paragraph';
          for (const n of nameHits) {
            for (const a of assocHits) {
              const distance = tokenDistance(window.text, n.start, a.start, {});
              if (bestDistance === null || distance < bestDistance) {
                bestDistance = distance;
                bestBoundary = classifyBoundary(window.text, n.start, a.start, {
                  sentences: windowSentences,
                  paragraphs: windowParagraphs,
                });
              }
            }
          }

          const index = perAssociationCount.get(associationId) ?? 0;
          perAssociationCount.set(associationId, index + 1);

          run(
            `INSERT INTO evidence
               (entity_id, association_id, document_id, surface_form, relationship, evidence_text, occurrence_index,
                entity_confidence, relationship_confidence, token_distance, boundary, proximity_score,
                sentiment_positive, sentiment_negative, sentiment_neutral, source_reliability, recency_weight,
                independence_weight, evidence_score, published_at, extractor)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, 1, 1, 0, ?, ?)`,
            state.entity.id,
            associationId,
            doc.id,
            association.surface_form,
            association.relationship,
            normaliseWhitespace(association.evidence).slice(0, 2000),
            index,
            doc.entity_confidence,
            association.relationship_confidence,
            bestDistance,
            bestBoundary,
            association.sentiment === 'positive' ? 1 : 0,
            association.sentiment === 'negative' ? 1 : 0,
            association.sentiment === 'neutral' ? 1 : 0,
            doc.published_at ?? doc.group_date ?? null,
            extraction.extractor
          );
          evidenceRows += 1;
        }
      }

      // Every document, not every tenth. A build that is working steadily and
      // one that has hung look identical when the counter only moves ten at a
      // time — and a user watching a frozen number will cancel a healthy run,
      // which is exactly what happened.
      processed += 1;
      await ctx.heartbeat?.({ step: 'extract_associations', processed, of: docs.length, evidenceRows });
    });

    state.counts.evidence = evidenceRows;
    return `${evidenceRows} evidence rows from ${processed} documents${discarded ? `; ${discarded} unsupported associations discarded` : ''}`;
  },

  async canonicalise_associations(state, ctx) {
    const res = await canonicaliseAssociations(state.entity.id, { entityJobId: ctx.jobId });
    const hierarchy = applyDefaultHierarchy(state.entity.id);
    const remaining = get(
      `SELECT COUNT(*) AS n FROM associations WHERE entity_id = ? AND status = 'active'`,
      state.entity.id
    )?.n ?? 0;
    state.counts.associations = remaining;
    return `${remaining} associations after merging ${res.merged.length} pairs (${res.suggested.length} suggested, unmerged); ${hierarchy.linked} hierarchy links`;
  },

  async detect_duplicates(state) {
    const docs = all(
      `SELECT d.* FROM documents d JOIN entity_document_matches m ON m.document_id = d.id
        WHERE m.entity_id = ? AND m.verdict = 'accept'`,
      state.entity.id
    );
    for (const doc of docs) fingerprintDocument(doc.id, doc);
    const res = clusterDocuments(state.entity.id);
    state.counts.duplicate_clusters = res.clusters;
    return `${res.documents} documents fingerprinted, ${res.clusters} duplicate clusters found`;
  },

  async calculate_document_scores(state) {
    const res = rescoreEntity(state.entity.id);
    return `${res.rescored} evidence rows scored across ${res.associations} associations`;
  },

  async calculate_association_scores(state) {
    const res = persistMonthlyMetrics(state.entity.id);
    const board = leaderboard(state.entity.id);
    state.counts.top = board?.associations?.slice(0, 3).map((a) => `${a.label} ${a.pias}`) ?? [];
    return `${res.written} monthly metric rows over ${res.months} months; top: ${state.counts.top.join(', ') || 'none'}`;
  },

  /** §13 — the SERP dataset, captured separately and never merged with the corpus. */
  async run_serp_queries(state, ctx) {
    if (!dfs.isConfigured()) return 'skipped — DataForSEO not configured';
    if (state.options.skipSerp) return 'skipped by request';
    const entity = state.entity;
    const snapshot = await captureEntitySerp(entity.id, entity.canonical_name, {
      depth: state.options.serpDepth ?? 100,
      location: state.options.location,
      language: state.options.language,
      jobId: ctx.jobId,
      force: state.options.force,
    });
    const classified = await classifySnapshot(entity.id, snapshot.snapshot_id, { jobId: ctx.jobId });

    let associationSerps = 0;
    if (state.options.associationSerps) {
      for (const q of associationQueries(entity.id, { limit: state.options.associationSerpLimit ?? 5 })) {
        if (ctx.shouldStop?.()) break;
        await captureAssociationSerp(entity.id, q.association_id, q.query, { jobId: ctx.jobId, depth: 100 });
        associationSerps += 1;
      }
    }

    return `entity SERP: ${snapshot.results} results, ${classified.classified} association links, ${classified.unclassified} unclassified${associationSerps ? `; ${associationSerps} association SERPs` : ''}`;
  },

  async generate_dashboard(state) {
    const coverage = coverageConfidence(state.entity.id);
    const alerts = generateAlerts(state.entity.id);
    const snapshot = storeSnapshot(state.entity.id, { coverage });
    const spend = spendForEntity(state.entity.id);
    state.counts.coverage = coverage?.level;
    state.counts.spend_usd = spend.costUsd;
    return `coverage ${coverage?.level}; ${alerts.length} alerts; snapshot #${snapshot?.snapshot_id}; spend $${spend.costUsd.toFixed(4)}`;
  },
};

export { MODEL };
