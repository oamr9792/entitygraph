import test from 'node:test';
import assert from 'node:assert/strict';

import {
  proximityScore, recencyWeight, sourceReliability, classifyDomain, independenceWeight,
  cappedMentionWeight, mentionWeightAt, evidenceScore, associationComponents, composePias,
  momentum, conditionalScores, rankWeight, googleRetrievalScores, aggregateSentiment,
  QUERY_BEHAVIOR_SCORE,
} from '../src/services/scoring.js';
import { assignIndependence } from '../src/services/duplicates.js';
import {
  splitSentences, classifyBoundary, tokenDistance, findOccurrences, evidenceWindow,
  generateNameVariants, labelKey, normaliseForMatch,
} from '../src/util/text.js';
import { simhash, hammingDistance, minhash, minhashSimilarity, canonicaliseUrl, rootDomain } from '../src/util/hash.js';
import { parseDate, normaliseDate, ageDays, median, correlation } from '../src/util/stats.js';
import { evidenceSupported, heuristicExtract, buildWindows } from '../src/services/extraction.js';

/**
 * The scoring model is the product. These tests pin the behaviours the brief
 * specifies numerically (§22, §25, §30, §31, §32, §53) and the behaviours it
 * specifies as rules (§4, §17, §43, §65), so a refactor cannot quietly change
 * what a client is shown.
 */

// --- §24, §25 Proximity -----------------------------------------------------

test('§25 proximity: an appositive scores far above a distant paragraph mention', () => {
  const close = proximityScore({ tokenDistance: 4, boundary: 'same_clause' });
  const far = proximityScore({ tokenDistance: 900, boundary: 'different_paragraph' });
  assert.ok(close > 0.9, `expected close proximity > 0.9, got ${close}`);
  assert.ok(far < 0.15, `expected distant proximity < 0.15, got ${far}`);
  assert.ok(close > far * 6);
});

test('§25 proximity: the boundary matters at equal token distance', () => {
  const sameSentence = proximityScore({ tokenDistance: 30, boundary: 'same_sentence' });
  const acrossParagraph = proximityScore({ tokenDistance: 30, boundary: 'different_paragraph' });
  assert.ok(sameSentence > acrossParagraph);
});

test('§25 proximity: an unmeasurable distance does not score as if it were adjacent', () => {
  const unknown = proximityScore({ tokenDistance: null, boundary: 'same_paragraph' });
  const adjacent = proximityScore({ tokenDistance: 2, boundary: 'same_clause' });
  assert.ok(unknown < adjacent);
});

// --- §30 Recency ------------------------------------------------------------

test('§30 recency: the half-life curve matches the brief exactly', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const at = (iso) => recencyWeight(iso, { halfLifeDays: 365, now });
  assert.equal(at('2026-01-01T00:00:00Z'), 1);
  assert.ok(Math.abs(at('2025-01-01T00:00:00Z') - 0.5) < 0.01);
  assert.ok(Math.abs(at('2024-01-01T00:00:00Z') - 0.25) < 0.01);
  assert.ok(Math.abs(at('2023-01-01T00:00:00Z') - 0.125) < 0.01);
});

test('§30 recency: switching the half-life changes the curve, not the evidence', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const oneYearOld = '2025-01-01T00:00:00Z';
  assert.ok(recencyWeight(oneYearOld, { halfLifeDays: 180, now }) < 0.3);
  assert.ok(recencyWeight(oneYearOld, { halfLifeDays: 730, now }) > 0.65);
});

test('recency: an undated document gets a middle weight rather than being dropped or treated as current', () => {
  const undated = recencyWeight(null, { halfLifeDays: 365 });
  assert.ok(undated > 0 && undated < 1, `expected a middle weight, got ${undated}`);
});

// --- §26 Source reliability -------------------------------------------------

test('§26 reliability: spam scores zero regardless of its other signals', () => {
  assert.equal(sourceReliability({ domainRank: 95, urlRank: 90, prominence: 1, spamScore: 80 }), 0);
});

test('§26 reliability: missing signals are renormalised, not counted as zero', () => {
  const sparse = sourceReliability({ domainRank: 60 });
  const zeroed = sourceReliability({ domainRank: 60, urlRank: 0, prominence: 0 });
  assert.ok(sparse > zeroed, 'a domain with unmeasured signals must not be punished for our data gap');
});

test('§26 reliability: a human override wins outright', () => {
  assert.equal(sourceReliability({ domainRank: 5, spamScore: 90, override: 0.9 }), 0.9);
});

test('§26 classification bands follow domain rank, with spam taking precedence', () => {
  assert.equal(classifyDomain({ domainRank: 92 }), 'major');
  assert.equal(classifyDomain({ domainRank: 65 }), 'specialist');
  assert.equal(classifyDomain({ domainRank: 40 }), 'ordinary');
  assert.equal(classifyDomain({ domainRank: 15 }), 'blog');
  assert.equal(classifyDomain({ domainRank: null }), 'unknown');
  assert.equal(classifyDomain({ domainRank: 92, spamScore: 75 }), 'spam');
});

// --- §22 Independence -------------------------------------------------------

test('§22 independence: all five cases carry the documented weights', () => {
  assert.equal(independenceWeight({}), 1.0);
  assert.equal(independenceWeight({ ordinalOnDomain: 1 }), 0.35);
  assert.equal(independenceWeight({ duplicateKind: 'near' }), 0.2);
  assert.equal(independenceWeight({ duplicateKind: 'near', sameDomainAsPrimary: true }), 0.05);
  assert.equal(independenceWeight({ duplicateKind: 'exact' }), 0);
});

test('§22 independence: a syndicated press release collapses to roughly one source', () => {
  const cluster = 7;
  const docs = [
    { id: 1, root_domain: 'origin.example', duplicate_cluster_id: cluster, is_cluster_primary: 1, cluster_kind: 'exact', source_reliability: 0.5 },
    ...[2, 3, 4, 5].map((id) => ({
      id, root_domain: `syndicator${id}.example`, duplicate_cluster_id: cluster,
      is_cluster_primary: 0, cluster_kind: 'exact', source_reliability: 0.4,
    })),
  ];
  const weights = assignIndependence(docs);
  const total = [...weights.values()].reduce((a, w) => a + w.weight, 0);
  assert.equal(total, 1, `five copies of one story should count once, got ${total}`);
});

test('§22 independence: separate articles on one domain are discounted but not erased', () => {
  const docs = [1, 2, 3].map((id) => ({
    id, root_domain: 'journal.example', duplicate_cluster_id: null, is_cluster_primary: 1, source_reliability: 0.6,
  }));
  const weights = [...assignIndependence(docs).values()].map((w) => w.weight);
  assert.deepEqual(weights.sort(), [0.35, 0.35, 1].sort());
});

test('§22 independence: the strongest document on a domain takes the full weight', () => {
  const docs = [
    { id: 1, root_domain: 'journal.example', is_cluster_primary: 1, source_reliability: 0.2 },
    { id: 2, root_domain: 'journal.example', is_cluster_primary: 1, source_reliability: 0.9 },
  ];
  const weights = assignIndependence(docs);
  assert.equal(weights.get(2).weight, 1, 'the higher-reliability document should be the one counted in full');
  assert.equal(weights.get(1).weight, 0.35);
});

// --- §32 Repetition cap -----------------------------------------------------

test('§32 mention cap: ten mentions in one document are not ten documents', () => {
  assert.equal(cappedMentionWeight(1), 1);
  assert.equal(cappedMentionWeight(2), 1.2);
  assert.equal(cappedMentionWeight(3), 1.3);
  assert.equal(cappedMentionWeight(10), 1.3);
  assert.equal(mentionWeightAt(3), 0);
});

// --- §31 Evidence score -----------------------------------------------------

test('§31 evidence score is the product of its six factors', () => {
  const score = evidenceScore({
    entityConfidence: 0.98, relationshipConfidence: 0.92, proximity: 0.95,
    sourceReliability: 0.88, independence: 1.0, recency: 0.91,
  });
  assert.ok(Math.abs(score - 0.98 * 0.92 * 0.95 * 0.88 * 1.0 * 0.91) < 1e-6);
});

test('§31 evidence score: any factor at zero vetoes the evidence', () => {
  const base = { entityConfidence: 0.9, relationshipConfidence: 0.9, proximity: 0.9, sourceReliability: 0.9, independence: 0.9, recency: 0.9 };
  for (const factor of Object.keys(base)) {
    assert.equal(evidenceScore({ ...base, [factor]: 0 }), 0, `${factor} at zero must veto`);
  }
});

// --- §33–§37 PIAS -----------------------------------------------------------

const doc = (over = {}) => ({
  rootDomain: 'a.example', rawMentions: 1, cappedWeight: 1, entityConfidence: 0.95,
  relationshipConfidence: 0.9, proximity: 0.9, sourceReliability: 0.8, independenceWeight: 1,
  evidenceScoreUndecayed: 0.6, publishedAt: '2026-01-01T00:00:00Z', excluded: false, ...over,
});

test('§34 corroboration is log-scaled so volume cannot simply buy the top spot', () => {
  const few = associationComponents(Array.from({ length: 10 }, (_, i) => doc({ rootDomain: `d${i}.example` })), { entityDocumentCount: 100 });
  const many = associationComponents(Array.from({ length: 500 }, (_, i) => doc({ rootDomain: `e${i}.example` })), { entityDocumentCount: 100 });
  assert.ok(many.corroborationRaw / few.corroborationRaw < 3, 'a 50x document count must not be a 50x corroboration score');
});

test('§36 recency ratio separates a current association from a stale one', () => {
  const now = Date.parse('2026-09-01T00:00:00Z');
  const fresh = associationComponents([doc({ publishedAt: '2026-08-01T00:00:00Z' })], { entityDocumentCount: 10, now });
  const stale = associationComponents([doc({ publishedAt: '2019-01-01T00:00:00Z' })], { entityDocumentCount: 10, now });
  assert.ok(fresh.recencyRatio > 0.9);
  assert.ok(stale.recencyRatio < 0.05);
});

test('§33 PIAS: components are normalised within the entity and the weights sum to 100', () => {
  const strong = associationComponents(
    Array.from({ length: 20 }, (_, i) => doc({ rootDomain: `s${i}.example`, publishedAt: '2026-08-01T00:00:00Z' })),
    { entityDocumentCount: 25, now: Date.parse('2026-09-01T00:00:00Z') }
  );
  const weak = associationComponents([doc({ publishedAt: '2026-08-01T00:00:00Z' })], {
    entityDocumentCount: 25, now: Date.parse('2026-09-01T00:00:00Z'),
  });
  const composed = composePias({ strong, weak });
  assert.ok(composed.strong.pias > composed.weak.pias);
  assert.ok(composed.strong.pias <= 100 && composed.weak.pias >= 0);
  // The strongest association tops out near 100 because every component is
  // normalised against it — PIAS ranks within an entity, it does not grade.
  assert.ok(composed.strong.pias > 90, `expected the leader near 100, got ${composed.strong.pias}`);
});

test('§37 corpus share is documents-with-association over documents-about-entity', () => {
  const components = associationComponents(Array.from({ length: 28 }, (_, i) => doc({ rootDomain: `x${i}.example` })), { entityDocumentCount: 100 });
  assert.equal(components.corpusShare, 0.28);
});

// --- §40, §41 Momentum ------------------------------------------------------

test('§40 momentum buckets follow the documented thresholds', () => {
  assert.equal(momentum({ current: 30, previous: 10 }).bucket, 'rapid_up');
  assert.equal(momentum({ current: 15, previous: 10 }).bucket, 'up');
  assert.equal(momentum({ current: 10, previous: 10 }).bucket, 'stable');
  assert.equal(momentum({ current: 7, previous: 10 }).bucket, 'down');
  assert.equal(momentum({ current: 3, previous: 10 }).bucket, 'rapid_down');
});

test('§41 momentum: ten times the coverage does not make every association stronger', () => {
  // Raw mentions rise 10x, but so does the entity's total coverage: the
  // association has not gained relative importance and must not read as growth.
  const result = momentum({ current: 100, previous: 10, currentEntityTotal: 1000, previousEntityTotal: 100 });
  assert.equal(result.bucket, 'stable');
  assert.ok(result.raw_change > 8, 'the raw change is still reported honestly');
  assert.equal(result.relative_change, 0);
});

test('§41 momentum: a share gain against flat coverage reads as growth', () => {
  const result = momentum({ current: 27, previous: 8, currentEntityTotal: 100, previousEntityTotal: 100 });
  assert.equal(result.bucket, 'rapid_up');
});

// --- §38 Conditional --------------------------------------------------------

test('§38 conditional and Jaccard scores, and Jaccard is null when N(A) is unknown', () => {
  const known = conditionalScores({ coOccurrence: 280, entityDocuments: 1000, associationDocuments: 5000 });
  assert.equal(known.corpus_conditional_score, 0.28);
  assert.ok(Math.abs(known.corpus_jaccard_score - 280 / (1000 + 5000 - 280)) < 1e-6);
  const unknown = conditionalScores({ coOccurrence: 280, entityDocuments: 1000, associationDocuments: null });
  assert.equal(unknown.corpus_jaccard_score, null, 'an unmeasured denominator must not be guessed');
});

// --- §52, §53 SERP ----------------------------------------------------------

test('§53 rank weights run 1.00 to 0.10 and stop at the first page', () => {
  assert.equal(rankWeight(1), 1);
  assert.equal(rankWeight(10), 0.1);
  assert.equal(rankWeight(11), 0);
  assert.equal(rankWeight(83), 0);
});

test('§53 retrieval score: one result supporting two associations splits its weight', () => {
  const out = googleRetrievalScores([
    { rank: 1, associationIds: [1, 2] },
    { rank: 2, associationIds: [1] },
  ]);
  assert.equal(out.scores[1].weight, 0.5 + 0.9);
  assert.equal(out.scores[2].weight, 0.5);
  assert.ok(Math.abs(out.scores[1].grs + out.scores[2].grs - 100) < 0.1, 'shares must sum to 100');
});

test('§53 retrieval score: unclassified results are reported, not silently ignored', () => {
  const out = googleRetrievalScores([
    { rank: 1, associationIds: [1] },
    { rank: 2, associationIds: [] },
  ]);
  assert.equal(out.classified_weight, 1);
  assert.ok(out.unclassified_share > 0.4, 'the unexplained share of the page must surface');
  assert.equal(out.scores[1].grs, 100, 'GRS is a share of what we could classify');
});

// --- §43 Sentiment ----------------------------------------------------------

test('§43 sentiment is aggregated separately and never folded into strength', () => {
  const docs = [
    doc({ sentimentPositive: 0.05, sentimentNegative: 0.9, sentimentNeutral: 0.05 }),
    doc({ sentimentPositive: 0.05, sentimentNegative: 0.9, sentimentNeutral: 0.05, rootDomain: 'b.example' }),
  ];
  const sentiment = aggregateSentiment(docs);
  assert.equal(sentiment.label, 'negative');
  const components = associationComponents(docs, { entityDocumentCount: 10 });
  const positiveVersion = associationComponents(
    docs.map((d) => ({ ...d, sentimentNegative: 0, sentimentPositive: 0.9 })),
    { entityDocumentCount: 10 }
  );
  assert.deepEqual(
    { ...components, }, { ...positiveVersion },
    'flipping sentiment must not change a single strength component'
  );
});

// --- §4 ---------------------------------------------------------------------

test('§4 the unobservable query-behaviour variable is null, never estimated', () => {
  assert.equal(QUERY_BEHAVIOR_SCORE, null);
});

// --- Text mechanics ---------------------------------------------------------

test('sentence splitting survives titles, initials and abbreviations', () => {
  const text = 'Mr. Smith met Dr. Jones at ABC Capital Inc. on Monday. John A. Smith spoke next. It ended.';
  assert.equal(splitSentences(text).length, 3);
});

test('§24 token distance and boundary classification', () => {
  const text = 'John Smith, founder of ABC Capital, spoke. Later the XYZ Foundation replied.\n\nA new paragraph mentions Harvard University.';
  const [name] = findOccurrences(text, ['John Smith']);
  const [abc] = findOccurrences(text, ['ABC Capital']);
  const [xyz] = findOccurrences(text, ['XYZ Foundation']);
  const [harvard] = findOccurrences(text, ['Harvard University']);
  assert.equal(classifyBoundary(text, name.start, abc.start), 'same_clause');
  assert.equal(classifyBoundary(text, name.start, xyz.start), 'adjacent_sentence');
  assert.equal(classifyBoundary(text, name.start, harvard.start), 'different_paragraph');
  assert.ok(tokenDistance(text, name.start, abc.start) < tokenDistance(text, name.start, harvard.start));
});

test('occurrence matching is accent-insensitive and respects word boundaries', () => {
  const text = 'José Álvarez runs the Smithsonian, not Smith.';
  assert.equal(findOccurrences(text, ['Jose Alvarez']).length, 1);
  assert.equal(findOccurrences(text, ['Smith']).length, 1, '"Smith" must not match inside "Smithsonian"');
});

test('§15 the evidence window keeps the sentence, its neighbours and a bounded paragraph', () => {
  const text = 'One. Two mentions John Smith here. Three follows.\n\nA later paragraph.';
  const [hit] = findOccurrences(text, ['John Smith']);
  const window = evidenceWindow(text, hit.start, { maxChars: 1000 });
  assert.match(window.sentence, /John Smith/);
  assert.match(window.previous_sentence, /One/);
  assert.match(window.next_sentence, /Three/);
});

test('§10 alias variants cover the middle-initial forms wire copy uses', () => {
  const variants = generateNameVariants('John Andrew Smith');
  assert.ok(variants.includes('John A. Smith'));
  assert.ok(variants.includes('John Smith'));
});

test('§19 label normalisation folds plurals and possessives but not synonyms', () => {
  assert.equal(labelKey('Philanthropies'), labelKey('philanthropy'));
  assert.equal(labelKey("Philanthropy's"), labelKey('philanthropy'));
  assert.notEqual(labelKey('charitable giving'), labelKey('philanthropy'));
});

// --- §21 Fingerprinting -----------------------------------------------------

test('§21 near-duplicate detection separates a re-run wire story from unrelated copy', () => {
  const original = 'John Smith, founder of ABC Capital, announced a gift to the XYZ Foundation supporting arts education in New York schools.';
  const syndicated = original + ' (Reuters)';
  const unrelated = 'Municipal water infrastructure funding in Ohio faces a shortfall in the state budget this year.';
  assert.ok(hammingDistance(simhash(original), simhash(syndicated)) < 13);
  assert.ok(hammingDistance(simhash(original), simhash(unrelated)) > 20);
  assert.ok(minhashSimilarity(minhash(original), minhash(syndicated)) > 0.8);
  assert.ok(minhashSimilarity(minhash(original), minhash(unrelated)) < 0.2);
});

test('§21 URL canonicalisation collapses tracking parameters, AMP and www', () => {
  assert.equal(
    canonicaliseUrl('https://www.Example.com/story?utm_source=x&id=7#top'),
    canonicaliseUrl('https://example.com/story?id=7')
  );
  assert.equal(rootDomain('https://news.bbc.co.uk/story'), 'bbc.co.uk');
  assert.equal(rootDomain('https://www.nytimes.com/x'), 'nytimes.com');
});

// --- Dates ------------------------------------------------------------------

test('DataForSEO date strings parse, including the space before the offset', () => {
  assert.equal(normaliseDate('2026-07-14 09:00:00 +00:00'), '2026-07-14T09:00:00.000Z');
  assert.equal(parseDate('garbage'), null);
  assert.equal(parseDate(null), null);
  assert.equal(parseDate('2099-01-01'), null, 'a future publication date is a CMS artefact, not information');
});

test('median, age and correlation helpers', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
  assert.ok(ageDays('2026-01-01T00:00:00Z', Date.parse('2026-01-11T00:00:00Z')) === 10);
  assert.equal(correlation([1, 2, 3], [2, 4, 6]), 1);
  assert.equal(correlation([1], [2]), null, 'two points are not a correlation');
});

// --- §65 Extraction guards --------------------------------------------------

test('§65 an association whose quote is not in the passage is discarded', () => {
  const passage = 'John Smith, founder of ABC Capital, donated to the XYZ Foundation.';
  assert.ok(evidenceSupported(passage, 'founder of ABC Capital'));
  assert.ok(!evidenceSupported(passage, 'John Smith was indicted for fraud in Chicago'));
  assert.ok(!evidenceSupported(passage, ''), 'an empty quote is not evidence');
});

test('§17 the fallback extractor keeps named entities and concepts apart', () => {
  const profile = { canonical_name: 'John Smith', aliases: [], entity_type: 'person', identity_markers: {} };
  const text = 'John Smith, founder of ABC Capital, increased his charitable giving and joined the XYZ Foundation board.';
  const [window] = buildWindows(text, ['John Smith']);
  const out = heuristicExtract(profile, window);
  const kinds = new Map(out.associations.map((a) => [a.canonical_label, a.kind]));
  assert.equal(kinds.get('ABC Capital'), 'named_entity');
  assert.equal(kinds.get('Philanthropy'), 'concept');
  assert.ok(!out.associations.some((a) => normaliseForMatch(a.canonical_label).includes('john smith')),
    'the entity itself is never one of its own associations');
});
