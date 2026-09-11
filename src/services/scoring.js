import { MODEL } from '../config.js';
import { clamp, round, sum, normaliseWithin, ageDays, safeDiv } from '../util/stats.js';

/**
 * The scoring model (§24–§41).
 *
 * Everything in this file is a pure function of its arguments and the MODEL
 * parameters. No database, no clock except an injectable `now`, no I/O. That
 * is deliberate: these are the numbers a client will be shown and an analyst
 * will be asked to defend, so they have to be reproducible from the evidence
 * rows alone and testable without a corpus.
 *
 * READ THIS BEFORE CHANGING A NUMBER
 * ----------------------------------
 * None of these weights are Google's. The patents (US10198491B1, US8682913B1,
 * US9830390B2, US9189526B1) describe *which factors* an entity-association
 * system can consider — source reliability, co-occurrence frequency, document
 * counts, recency, popularity, textual proximity, independent corroboration.
 * They do not publish the weights, and Google's live weights are unknowable
 * from outside. What follows is our attempt to approximate those factors from
 * observable web data. The product says so, on every screen, in one sentence
 * held in config.SCORE_DISCLAIMER.
 *
 * One variable from US9830390B2 is deliberately absent: query-sequence
 * behaviour (users who searched X then searched Y). We cannot observe it and
 * §4 forbids inventing it, so `query_behavior_score` stays null everywhere
 * until there is a legitimate observable proxy.
 */

export const QUERY_BEHAVIOR_SCORE = null; // §4 — not observable, not invented.

const model = (overrides) => ({
  ...MODEL,
  ...(overrides || {}),
  proximity: { ...MODEL.proximity, ...(overrides?.proximity || {}) },
  independence: { ...MODEL.independence, ...(overrides?.independence || {}) },
  reliability: { ...MODEL.reliability, ...(overrides?.reliability || {}) },
  recency: { ...MODEL.recency, ...(overrides?.recency || {}) },
  pias: { ...MODEL.pias, ...(overrides?.pias || {}) },
  duplicates: { ...MODEL.duplicates, ...(overrides?.duplicates || {}) },
  momentum: { ...MODEL.momentum, ...(overrides?.momentum || {}) },
});

// --- §25 Proximity ----------------------------------------------------------

/**
 * Blends the continuous token-distance decay with the discrete grammatical
 * boundary score. Neither is sufficient alone: 30 tokens inside one sentence
 * is stronger evidence than 30 tokens across a paragraph break, and "same
 * paragraph" says nothing about whether the mention was 5 tokens away or 300.
 */
export function proximityScore({ tokenDistance = null, boundary = 'same_paragraph' }, overrides) {
  const m = model(overrides);
  const decay =
    tokenDistance === null || !Number.isFinite(tokenDistance)
      ? 0.5
      : Math.exp(-tokenDistance / m.proximity.tokenDecay);
  const boundaryScore = m.proximity.boundary[boundary] ?? m.proximity.boundary.different_paragraph;
  const blend = clamp(m.proximity.blend, 0, 1);
  return round(clamp(blend * decay + (1 - blend) * boundaryScore), 4);
}

// --- §30 Recency ------------------------------------------------------------

/**
 * Continuous half-life decay. Today = 1.00, one half-life = 0.50, and so on.
 *
 * Documents with no publication date are the awkward case: dropping them
 * throws away real evidence, treating them as current inflates every score.
 * They get `undatedWeight`, a deliberate middle value, and the coverage report
 * (§70) tells the user how much of the corpus that affected.
 */
export function recencyWeight(publishedAt, { halfLifeDays, now = Date.now(), undatedWeight = 0.35 } = {}, overrides) {
  const m = model(overrides);
  const halfLife = halfLifeDays ?? m.recency.halfLifeDays;
  const age = ageDays(publishedAt, now);
  if (age === null) return undatedWeight;
  return round(clamp(0.5 ** (age / halfLife), 0, 1), 4);
}

// --- §26 Source reliability -------------------------------------------------

/**
 * Classification from observable signals, used when nobody has classified the
 * domain by hand. Rank thresholds are DataForSEO domain_rank (0–1000 scale,
 * rescaled to 0–100 on ingest), so "major" here means "in the top band of
 * ranked domains", not "we believe this outlet is trustworthy".
 */
export function classifyDomain({ domainRank = null, spamScore = null, isKnownMajor = false } = {}, overrides) {
  const m = model(overrides);
  if (spamScore !== null && spamScore >= m.reliability.spamScoreCutoff) return 'spam';
  if (isKnownMajor) return 'major';
  if (domainRank === null) return 'unknown';
  if (domainRank >= 80) return 'major';
  if (domainRank >= 60) return 'specialist';
  if (domainRank >= 35) return 'ordinary';
  if (domainRank >= 10) return 'blog';
  return 'unknown';
}

/**
 * §26/§27 — the External Source Reliability Proxy. Explicitly NOT Domain
 * Authority and NOT "Google trust": it is a blend of four observable signals,
 * one of which (classification) a human can override.
 */
export function sourceReliability(
  { domainRank = null, urlRank = null, prominence = null, classification = null, spamScore = null, override = null } = {},
  overrides
) {
  const m = model(overrides);
  if (override !== null && override !== undefined) return round(clamp(override), 4);

  const klass = classification || classifyDomain({ domainRank, spamScore }, overrides);
  const classScore = m.reliability.classification[klass] ?? m.reliability.classification.unknown;
  // A spam domain scores zero however good its other signals look. This is the
  // one hard gate in the blend, because §26's spam row is 0, not "low".
  if (klass === 'spam') return 0;

  const w = m.reliability.weights;
  // Missing signals are not treated as zero — that would punish a domain for a
  // gap in our data rather than for anything about the domain. The available
  // weights are renormalised instead.
  const parts = [
    { value: domainRank === null ? null : clamp(domainRank / 100), weight: w.domain_rank },
    { value: urlRank === null ? null : clamp(urlRank / 100), weight: w.url_rank },
    { value: prominence === null ? null : clamp(prominence), weight: w.prominence },
    { value: classScore, weight: w.classification },
  ].filter((p) => p.value !== null);

  const totalWeight = sum(parts.map((p) => p.weight));
  if (!totalWeight) return round(classScore, 4);
  return round(clamp(sum(parts.map((p) => p.value * p.weight)) / totalWeight), 4);
}

// --- §22 Independence -------------------------------------------------------

/**
 * How much a document counts as *new* evidence, given what we have already
 * counted from its duplicate cluster and its domain.
 *
 * `duplicateKind` comes from §21's fingerprinting: 'exact', 'near', or null
 * for an original. `ordinalOnDomain` is 0 for the first document we accept
 * from that root domain for this association, 1 for the second, and so on.
 */
export function independenceWeight(
  { duplicateKind = null, sameDomainAsPrimary = false, ordinalOnDomain = 0 } = {},
  overrides
) {
  const m = model(overrides);
  const w = m.independence;
  if (duplicateKind === 'exact') return w.exact_duplicate;
  if (duplicateKind === 'near') {
    return sameDomainAsPrimary ? w.near_duplicate_same_domain : w.syndicated_other_domain;
  }
  return ordinalOnDomain === 0 ? w.first_unique_on_domain : w.additional_unique_on_domain;
}

// --- §32 Repetition cap -----------------------------------------------------

/** Weight of the nth occurrence of one association inside one document. */
export function mentionWeightAt(occurrenceIndex, overrides) {
  const m = model(overrides);
  return m.mentionCap[occurrenceIndex] ?? 0;
}

/** Total capped weight for a document that mentions the association n times. */
export function cappedMentionWeight(occurrences, overrides) {
  const m = model(overrides);
  let total = 0;
  for (let i = 0; i < occurrences; i += 1) total += m.mentionCap[i] ?? 0;
  return round(total, 4);
}

// --- §31 Per-document evidence score ----------------------------------------

/**
 * EvidenceScore = EntityConfidence × RelationshipConfidence × Proximity
 *               × SourceReliability × Independence × Recency
 *
 * A product, not a sum, because every factor is a veto: a passage about the
 * wrong John Smith, or a syndicated copy we already counted, contributes
 * nothing no matter how good the other five factors are.
 */
export function evidenceScore({
  entityConfidence,
  relationshipConfidence,
  proximity,
  sourceReliability: reliability,
  independence,
  recency,
  mentionWeight = 1,
}) {
  const factors = [
    entityConfidence,
    relationshipConfidence,
    proximity,
    reliability,
    independence,
    recency,
    mentionWeight,
  ];
  if (factors.some((f) => !Number.isFinite(f))) return 0;
  return round(factors.reduce((a, b) => a * b, 1), 6);
}

// --- §33–§37 PIAS -----------------------------------------------------------

/**
 * Raw, un-normalised component values for one association. These are absolute
 * quantities; `composePias` turns a set of them into 0–100 scores relative to
 * the strongest association for the same entity.
 *
 * `docs` is one row per document that supports the association, each carrying
 * the factors already computed by the pipeline.
 */
export function associationComponents(docs, { entityDocumentCount = 0, halfLifeDays = null, now = Date.now() } = {}, overrides) {
  const m = model(overrides);
  const active = docs.filter((d) => !d.excluded);

  const independentSources = sum(active.map((d) => d.independenceWeight ?? 0));
  const corroborationRaw = m.corroborationLog ? Math.log1p(independentSources) : independentSources;

  // §35 — authority-weighted evidence deliberately omits recency and
  // proximity: this component answers "how much credible, independent
  // testimony exists", and mixing time into it would double-count §36.
  const authorityEvidence = sum(
    active.map(
      (d) =>
        (d.entityConfidence ?? 0) *
        (d.relationshipConfidence ?? 0) *
        (d.sourceReliability ?? 0) *
        (d.independenceWeight ?? 0) *
        (d.cappedWeight ?? 1)
    )
  );

  // §36 — recency as a ratio of decayed to undecayed evidence, not as "days
  // since the newest document". One fresh article does not make a stale
  // association current.
  const currentEvidence = sum(
    active.map(
      (d) =>
        (d.evidenceScoreUndecayed ?? 0) *
        recencyWeight(d.publishedAt, { halfLifeDays: halfLifeDays ?? m.recency.halfLifeDays, now }, overrides)
    )
  );
  const historicalEvidence = sum(active.map((d) => d.evidenceScoreUndecayed ?? 0));
  const recencyRatio = safeDiv(currentEvidence, historicalEvidence, 0);

  // §31 minus source/independence: the relationship quality of the testimony.
  const relationshipMass = sum(
    active.map((d) => (d.relationshipConfidence ?? 0) * (d.proximity ?? 0) * (d.independenceWeight ?? 0))
  );
  const relationshipWeightBase = sum(active.map((d) => d.independenceWeight ?? 0));
  const relationshipQuality = safeDiv(relationshipMass, relationshipWeightBase, 0);

  // §37 — corpus share. The denominator is every document confidently about
  // the entity, not every document we retrieved.
  const documents = active.length;
  const corpusShare = safeDiv(documents, entityDocumentCount, 0);

  return {
    documents,
    domains: new Set(active.map((d) => d.rootDomain).filter(Boolean)).size,
    rawMentions: sum(active.map((d) => d.rawMentions ?? 1)),
    independentSources: round(independentSources, 3),
    corroborationRaw: round(corroborationRaw, 4),
    authorityEvidence: round(authorityEvidence, 4),
    currentEvidence: round(currentEvidence, 4),
    historicalEvidence: round(historicalEvidence, 4),
    recencyRatio: round(recencyRatio, 4),
    relationshipQuality: round(relationshipQuality, 4),
    corpusShare: round(corpusShare, 4),
  };
}

/**
 * §33 — turn a set of component bundles into PIAS scores.
 *
 * Each component is normalised against the strongest value across the entity's
 * associations, then weighted. The consequence worth being explicit about:
 * PIAS is a *within-entity ranking*. The top association for a person with 40
 * documents scores near 100 exactly as the top association for a person with
 * 40,000 does. Comparing PIAS across entities is meaningless; Coverage
 * Confidence (§70) is what tells you how much the ranking is worth.
 */
export function composePias(componentsByKey, overrides) {
  const m = model(overrides);
  const keys = Object.keys(componentsByKey);
  const maxOf = (field) => Math.max(0, ...keys.map((k) => componentsByKey[k][field] ?? 0));

  const maxCorroboration = maxOf('corroborationRaw');
  const maxAuthority = maxOf('authorityEvidence');
  const maxRelationship = maxOf('relationshipQuality');
  const maxShare = maxOf('corpusShare');

  const out = {};
  for (const key of keys) {
    const c = componentsByKey[key];
    const parts = {
      corroboration: normaliseWithin(c.corroborationRaw, maxCorroboration),
      authority: normaliseWithin(c.authorityEvidence, maxAuthority),
      // Recency is already a 0–1 ratio with an absolute meaning ("what share of
      // this association's evidence weight is recent"), so it is scaled rather
      // than normalised — an entity whose every association is stale should see
      // low recency across the board, not one association at 100 by default.
      recency: clamp(c.recencyRatio, 0, 1) * 100,
      relationship: normaliseWithin(c.relationshipQuality, maxRelationship),
      corpusShare: normaliseWithin(c.corpusShare, maxShare),
    };
    const score =
      parts.corroboration * m.pias.corroboration +
      parts.authority * m.pias.authority +
      parts.recency * m.pias.recency +
      parts.relationship * m.pias.relationship +
      parts.corpusShare * m.pias.corpusShare;
    out[key] = { pias: round(clamp(score, 0, 100), 1), components: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, round(v, 1)])) };
  }
  return out;
}

// --- §40/§41 Momentum -------------------------------------------------------

/**
 * §41 — relative momentum is the one that matters. If an entity gets ten times
 * the press generally, raw philanthropy mentions rise without philanthropy
 * gaining any relative importance. We report both and bucket on the relative
 * figure whenever both periods have enough corpus to divide by.
 */
export function momentum({ current, previous, currentEntityTotal = null, previousEntityTotal = null }, overrides) {
  const m = model(overrides);
  const raw = previous > 0 ? (current - previous) / previous : current > 0 ? Infinity : 0;

  let relative = null;
  if (currentEntityTotal && previousEntityTotal) {
    const shareNow = safeDiv(current, currentEntityTotal, 0);
    const sharePrev = safeDiv(previous, previousEntityTotal, 0);
    relative = sharePrev > 0 ? shareNow / sharePrev - 1 : shareNow > 0 ? Infinity : 0;
  }

  const basis = relative === null ? raw : relative;
  const t = m.momentum.thresholds;
  let bucket;
  if (!Number.isFinite(basis)) bucket = current > 0 ? 'rapid_up' : 'stable';
  else if (basis >= t.rapid_up) bucket = 'rapid_up';
  else if (basis >= t.up) bucket = 'up';
  else if (basis <= t.rapid_down) bucket = 'rapid_down';
  else if (basis <= t.down) bucket = 'down';
  else bucket = 'stable';

  return {
    raw_change: Number.isFinite(raw) ? round(raw, 4) : null,
    relative_change: relative === null ? null : Number.isFinite(relative) ? round(relative, 4) : null,
    basis: Number.isFinite(basis) ? round(basis, 4) : null,
    bucket,
    arrow: MOMENTUM_ARROWS[bucket],
    label: MOMENTUM_LABELS[bucket],
  };
}

export const MOMENTUM_ARROWS = {
  rapid_up: '↑↑',
  up: '↑',
  stable: '→',
  down: '↓',
  rapid_down: '↓↓',
};

export const MOMENTUM_LABELS = {
  rapid_up: 'rapidly strengthening',
  up: 'strengthening',
  stable: 'stable',
  down: 'weakening',
  rapid_down: 'rapidly weakening',
};

// --- §38 Conditional and Jaccard -------------------------------------------

/**
 * Corpus Conditional Score and Corpus Jaccard Score. Both are properties of
 * the corpus we observed, which is why the names say Corpus. They are not
 * Google scores and the labels must not be shortened in the UI.
 */
export function conditionalScores({ coOccurrence, entityDocuments, associationDocuments }) {
  const conditional = safeDiv(coOccurrence, entityDocuments, null);
  const denom = entityDocuments + (associationDocuments ?? 0) - coOccurrence;
  const jaccard = associationDocuments ? safeDiv(coOccurrence, denom, null) : null;
  // Six decimal places, not four: a Jaccard score against a large N(A) is
  // legitimately in the third or fourth place, and rounding it to 0.049 throws
  // away most of what distinguishes two associations.
  return {
    corpus_conditional_score: conditional === null ? null : round(conditional, 6),
    corpus_jaccard_score: jaccard === null ? null : round(jaccard, 6),
  };
}

// --- §53 Google Retrieval Score ---------------------------------------------

/** Rank weight: #1 = 1.00 down to #10 = 0.10, and 0 beyond the first page. */
export function rankWeight(rank, overrides) {
  const m = model(overrides);
  return m.serpRankWeights[rank - 1] ?? 0;
}

/**
 * §52/§53 — how much of the entity's first page carries each association.
 * `results` is [{ rank, associationIds: [] }].
 *
 * Each association receives the full weight of every result that carries it,
 * as §53 specifies ("for each association, sum its result weights"), expressed
 * as a share of the page's total rank weight. GRS therefore answers "what
 * fraction of Google's first page, by position, carries this association", and
 * the scores do not sum to 100: a result about a lawyer and his former client
 * carries both, fully.
 *
 * An earlier version divided each result's weight among the associations it
 * carried. First-page results carry around nine each, so an association on 13
 * of 67 results — two of them in the top ten — scored 2.7, beside a Google panel
 * showing it plainly. The division was not in the brief.
 *
 * Unclassified results stay in the denominator, since a result we could not
 * connect to anything does not carry the association, and their share is
 * returned so the UI can say how much of the page went unexplained.
 */
export function googleRetrievalScores(results, overrides) {
  const weights = new Map();
  let classifiedWeight = 0;
  let totalWeight = 0;

  for (const r of results) {
    const w = rankWeight(r.rank, overrides);
    if (w <= 0) continue;
    totalWeight += w;
    // A result linked to the same association twice still carries it once.
    const ids = [...new Set(r.associationIds ?? [])];
    if (!ids.length) continue;
    classifiedWeight += w;
    for (const id of ids) weights.set(id, (weights.get(id) ?? 0) + w);
  }

  const scores = {};
  for (const [id, weight] of weights) {
    scores[id] = {
      weight: round(weight, 4),
      grs: round(safeDiv(weight, totalWeight, 0) * 100, 1),
    };
  }
  return {
    scores,
    classified_weight: round(classifiedWeight, 4),
    total_weight: round(totalWeight, 4),
    unclassified_share: round(safeDiv(totalWeight - classifiedWeight, totalWeight, 0), 4),
  };
}

// --- §43 Sentiment ----------------------------------------------------------

/**
 * §43 — sentiment is reported beside association strength and never inside it.
 * An association can be strong and negative; folding the two together destroys
 * the distinction the whole product exists to make.
 */
export function aggregateSentiment(docs) {
  const active = docs.filter((d) => !d.excluded);
  const weight = sum(active.map((d) => d.independenceWeight ?? 1));
  if (!weight) return { positive: null, negative: null, neutral: null, label: 'unknown' };
  const w = (field) => round(safeDiv(sum(active.map((d) => (d[field] ?? 0) * (d.independenceWeight ?? 1))), weight, 0), 4);
  const positive = w('sentimentPositive');
  const negative = w('sentimentNegative');
  const neutral = w('sentimentNeutral');
  const label = negative > 0.5 ? 'negative' : positive > 0.5 ? 'positive' : 'mixed/neutral';
  return { positive, negative, neutral, label };
}
