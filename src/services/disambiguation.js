import { MODEL } from '../config.js';
import { run, get } from '../db.js';
import { clamp, round } from '../util/stats.js';
import { findOccurrences, classifyBoundary, splitSentences, splitParagraphs, normaliseWithMap } from '../util/text.js';
import { rootDomain } from '../util/hash.js';
import { llmJson } from '../providers/llm/index.js';

/**
 * §6, §8 — entity disambiguation.
 *
 * This is the component the brief calls one of the most important, and the
 * reason is arithmetic: counting every "John Smith" on the web produces a
 * confident, precise, entirely wrong picture. Everything downstream inherits
 * whatever this gets wrong.
 *
 * The model is a noisy-OR over identity markers. Each marker found near a name
 * mention is independent evidence that this document concerns our John Smith;
 * evidence accumulates towards 1.0 without ever reaching it, and a bare name
 * with no supporting marker scores near zero rather than near a half. That
 * asymmetry is the whole point — the null hypothesis for a common name is
 * "different person", and the document has to earn its way out of it.
 *
 * The weights reproduce §8's worked examples closely (0.97 against a stated
 * 0.99, 0.74 against 0.75, 0.05 against 0.02). They are calibration targets,
 * not measurements, and all three land in the same accept/review/reject band
 * the brief puts them in.
 */

// How much a marker's evidence is discounted by its distance from the name.
const BOUNDARY_FACTOR = {
  same_clause: 1.0,
  same_sentence: 0.95,
  adjacent_sentence: 0.8,
  same_paragraph: 0.6,
  different_paragraph: 0.35,
};

// A single marker can never carry a document on its own past this.
const MAX_SINGLE_MARKER = 0.97;

const NAME_MATCH_BASE = {
  canonical: 0.05,
  user: 0.05,
  generated: 0.04,
  partial: 0.02,
};

/**
 * Scores one document against one identity profile.
 *
 * `text` should be everything we have: title, snippet and body if fetched.
 * More text means more chances to find a marker, which is why §15's page
 * fetch materially raises confidence on the documents that matter.
 */
export function scoreDocument(profile, { url = null, title = '', snippet = '', body = '' } = {}, overrides = null) {
  const thresholds = { ...MODEL.entityConfidence, ...(overrides?.entityConfidence || {}) };
  const text = [title, snippet, body].filter(Boolean).join('\n\n');
  const reasons = [];

  // A document on a known URL is not a disambiguation problem. It is the
  // entity's own site, or a profile page we were told about.
  const docDomain = rootDomain(url);
  const urlMarkers = profile.markers.filter((m) => m.kind === 'url' && m.polarity === 1);
  if (docDomain && urlMarkers.some((m) => m.value === docDomain)) {
    return {
      confidence: 0.98,
      verdict: 'accept',
      matched_alias: profile.canonical_name,
      method: 'known_url',
      reasons: [{ kind: 'url', value: docDomain, contribution: 0.98 }],
    };
  }

  if (!text.trim()) {
    return { confidence: 0, verdict: 'reject', matched_alias: null, method: 'markers', reasons: [{ kind: 'empty', value: 'no text' }] };
  }

  const aliases = [profile.canonical_name, ...(profile.aliases ?? [])];
  const nameHits = findOccurrences(text, aliases);
  if (!nameHits.length) {
    return {
      confidence: 0,
      verdict: 'reject',
      matched_alias: null,
      method: 'markers',
      reasons: [{ kind: 'name', value: 'no alias occurs in the retrieved text' }],
    };
  }

  const precomputed = { sentences: splitSentences(text), paragraphs: splitParagraphs(text) };
  const matchedAlias = nameHits[0].phrase;
  const origin =
    matchedAlias === profile.canonical_name
      ? 'canonical'
      : (profile.aliases ?? []).includes(matchedAlias)
        ? 'user'
        : 'generated';
  let base = NAME_MATCH_BASE[origin] ?? NAME_MATCH_BASE.partial;
  reasons.push({ kind: 'name', value: matchedAlias, contribution: base });

  // Noisy-OR accumulation. `remaining` is the probability mass still assigned
  // to "this is a different person"; every marker takes a bite out of it.
  let remaining = 1 - base;

  for (const marker of profile.markers) {
    if (marker.kind === 'url') continue;
    const hits = findOccurrences(text, [marker.value]);
    if (!hits.length) continue;

    // Use the closest co-occurrence: the strongest placement of this marker
    // relative to any mention of the name.
    let bestFactor = 0;
    let bestBoundary = null;
    for (const hit of hits) {
      for (const name of nameHits) {
        const boundary = classifyBoundary(text, name.start, hit.start, precomputed);
        const factor = BOUNDARY_FACTOR[boundary] ?? 0.35;
        if (factor > bestFactor) { bestFactor = factor; bestBoundary = boundary; }
      }
    }

    const strength = clamp((marker.weight ?? 0.4) * bestFactor, 0, MAX_SINGLE_MARKER);
    if (marker.polarity === -1) {
      // A negative marker pushes the other way: it multiplies the accumulated
      // confidence down rather than eating into `remaining`.
      const penalty = clamp(strength, 0, 0.95);
      remaining = clamp(remaining + (1 - remaining) * penalty, 0, 1);
      reasons.push({ kind: marker.kind, value: marker.value, boundary: bestBoundary, contribution: -round(penalty, 3), negative: true });
      continue;
    }

    remaining *= 1 - strength;
    reasons.push({ kind: marker.kind, value: marker.value, boundary: bestBoundary, contribution: round(strength, 3) });
  }

  const confidence = round(clamp(1 - remaining), 3);
  return {
    confidence,
    verdict: verdictFor(confidence, thresholds),
    matched_alias: matchedAlias,
    method: 'markers',
    reasons,
  };
}

export function verdictFor(confidence, thresholds = MODEL.entityConfidence) {
  if (confidence >= thresholds.accept) return 'accept';
  if (confidence >= thresholds.review) return 'review';
  return 'reject';
}

/**
 * §66 Pass 4 — the expensive adjudication, run only on the review band. Asking
 * an LLM about every document would cost a fortune and add nothing for the
 * documents the markers already settled.
 */
const ADJUDICATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['same_entity', 'confidence', 'reasoning'],
  properties: {
    same_entity: { type: 'boolean', description: 'True only if the passage concerns the target person/organisation.' },
    confidence: { type: 'number', description: 'Confidence in that judgement, 0 to 1.' },
    reasoning: { type: 'string', description: 'One sentence citing the specific detail that decided it.' },
  },
};

export async function adjudicate(profile, doc, { entityId = null, jobId = null } = {}) {
  const system = [
    'You decide whether a passage of web text refers to one specific entity.',
    'You are given an identity profile and a passage. Judge only identity — not sentiment, not importance.',
    'A shared name is not evidence. Require a concrete corroborating detail: employer, role, location, affiliation, a named associate, or an explicit reference to a known URL.',
    'If the passage names the entity but supplies no corroborating detail, answer false with low confidence.',
    '',
    'IDENTITY PROFILE',
    JSON.stringify(
      {
        canonical_name: profile.canonical_name,
        entity_type: profile.entity_type,
        aliases: profile.aliases,
        identity_markers: profile.identity_markers,
        negative_markers: profile.negative_markers,
        known_urls: profile.known_urls,
      },
      null,
      2
    ),
  ].join('\n');

  const user = [
    `URL: ${doc.url ?? 'unknown'}`,
    `TITLE: ${doc.title ?? ''}`,
    '',
    'PASSAGE:',
    (doc.body || doc.snippet || '').slice(0, 6000),
  ].join('\n');

  const res = await llmJson(
    { system, user, schema: ADJUDICATION_SCHEMA, schemaName: 'entity_identity_judgement', maxTokens: 500 },
    { entityId, jobId, endpoint: 'disambiguation' }
  );
  if (!res) return null;

  const { same_entity: same, confidence, reasoning } = res.data;
  // Map the judgement back onto the 0–1 scale the rest of the system uses: a
  // confident yes lands in accept, a confident no lands in reject, and an
  // unsure answer stays in the review band for a human.
  const scaled = same ? 0.7 + 0.29 * clamp(confidence) : 0.39 * (1 - clamp(confidence));
  return {
    confidence: round(clamp(scaled), 3),
    verdict: verdictFor(round(clamp(scaled), 3)),
    method: 'llm',
    reasons: [{ kind: 'llm', value: reasoning, contribution: same ? confidence : -confidence }],
  };
}

// --- Persistence ------------------------------------------------------------

export function saveMatch(entityId, documentId, result) {
  run(
    `INSERT INTO entity_document_matches (entity_id, document_id, entity_confidence, verdict, method, matched_alias, reasons)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity_id, document_id) DO UPDATE SET
       entity_confidence = excluded.entity_confidence,
       verdict = excluded.verdict,
       method = excluded.method,
       matched_alias = excluded.matched_alias,
       reasons = excluded.reasons`,
    entityId,
    documentId,
    result.confidence,
    result.verdict,
    result.method,
    result.matched_alias ?? null,
    JSON.stringify(result.reasons ?? [])
  );
}

/** A human verdict overrides the model and is never recomputed away (§74). */
export function setManualVerdict(entityId, documentId, verdict, reviewer = 'analyst') {
  run(
    `UPDATE entity_document_matches
        SET manual_verdict = ?, verdict = ?, method = 'manual', reviewed_by = ?, reviewed_at = datetime('now')
      WHERE entity_id = ? AND document_id = ?`,
    verdict,
    verdict,
    reviewer,
    entityId,
    documentId
  );
  return get(`SELECT * FROM entity_document_matches WHERE entity_id = ? AND document_id = ?`, entityId, documentId);
}

/**
 * The confidence with which we believe the corpus is about the right entity.
 * Feeds Coverage Confidence (§71) and is reported as a distribution, not a
 * single number, because "1,200 accepted, 900 in review" and "2,100 accepted"
 * are very different situations.
 */
export function disambiguationSummary(entityId) {
  const rows = get(
    `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN verdict = 'accept' THEN 1 ELSE 0 END) AS accepted,
        SUM(CASE WHEN verdict = 'review' THEN 1 ELSE 0 END) AS review,
        SUM(CASE WHEN verdict = 'reject' THEN 1 ELSE 0 END) AS rejected,
        AVG(CASE WHEN verdict = 'accept' THEN entity_confidence END) AS mean_accepted_confidence
       FROM entity_document_matches WHERE entity_id = ?`,
    entityId
  ) ?? {};
  const total = rows.total ?? 0;
  return {
    total,
    accepted: rows.accepted ?? 0,
    review: rows.review ?? 0,
    rejected: rows.rejected ?? 0,
    accept_rate: total ? round((rows.accepted ?? 0) / total, 3) : null,
    mean_accepted_confidence: rows.mean_accepted_confidence ? round(rows.mean_accepted_confidence, 3) : null,
  };
}

export { BOUNDARY_FACTOR, NAME_MATCH_BASE, normaliseWithMap };

/**
 * Credit for having been returned by Google for the entity's own name.
 *
 * A page in the organic results for the exact name query has already been
 * through the most thorough disambiguation available — Google's — and ranked
 * for that name. Scoring it like any other page that merely contains the name
 * (0.05 before markers) threw that away. A two-line Google description rarely
 * mentions an employer or a city, so the very pages people see when they search
 * the name were rejected as a different person.
 *
 * A prior, not a pass. Rank-weighted, and never enough on its own to accept a
 * document: for a common name Google's first page mixes several people. Alone,
 * a top-ten result lands in the review band, where the LLM adjudication decides
 * it; combined with one confirming marker, it is accepted.
 */
const SERP_PRIOR = [
  { maxRank: 3, strength: 0.6 },
  { maxRank: 10, strength: 0.5 },
  { maxRank: 30, strength: 0.35 },
  { maxRank: 100, strength: 0.2 },
];

export const serpRankFromRef = (providerRef) => {
  const match = /^rank:(\d+)$/.exec(String(providerRef ?? ''));
  return match ? Number(match[1]) : null;
};

export function withSerpPrior(result, rank, thresholds = MODEL.entityConfidence) {
  if (!result || !rank || result.method === 'known_url') return result;
  // No alias in the text means Google returned the page for some other reason —
  // a surname-only list, a disambiguation page — and its rank says nothing
  // about identity.
  if (!result.matched_alias) return result;
  const tier = SERP_PRIOR.find((t) => rank <= t.maxRank);
  if (!tier) return result;

  const confidence = round(clamp(1 - (1 - result.confidence) * (1 - tier.strength)), 3);
  return {
    ...result,
    confidence,
    verdict: verdictFor(confidence, thresholds),
    reasons: [
      ...(result.reasons ?? []),
      { kind: 'google_rank', value: `#${rank} on Google for the name`, contribution: tier.strength },
    ],
  };
}
