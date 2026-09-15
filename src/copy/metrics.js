/**
 * §89 — the copy registry.
 *
 * The single definition of every user-facing term. Imported by the server
 * (disclaimers, notices) and served unchanged to the browser at
 * /copy/metrics.js, so the two can never drift. This file must stay pure: no
 * imports, no Node APIs, nothing a browser cannot load.
 *
 * Rules, enforced by test/copy.test.js:
 *   - every metric a screen renders has an entry here;
 *   - `what` and `look` are one sentence each, so a tooltip is two at most;
 *   - `model`, where given, names a real key of MODEL, so copy and model share
 *     identifiers;
 *   - no plain label implies a Google-internal measure (§97).
 *
 * Write a definition here once, and nowhere else in the app.
 */

const n = (v) => Number(v ?? 0).toLocaleString('en-GB');

export const METRICS = Object.freeze({
  // --- Association strength ------------------------------------------------
  pias: {
    plain: 'Association strength',
    advanced: 'PIAS',
    model: 'pias',
    basis: 'sources',
    what: 'How strongly the web links this client to this topic, compared with everything else it links them to.',
    look: 'Look at the top five, because that is what the web thinks this client is about.',
    caveat: '100 is always their strongest association, so a score cannot be compared between clients. This is our estimate, not a Google score.',
  },
  current_pias: {
    plain: 'Strength now',
    advanced: 'CES',
    model: 'currentWindowDays',
    basis: 'sources',
    what: 'Association strength counting only recent coverage.',
    look: 'This is what they are known for today.',
  },
  historical_pias: {
    plain: 'Strength before',
    advanced: 'HAS',
    model: 'currentWindowDays',
    basis: 'sources',
    what: 'Association strength counting only older coverage.',
    look: 'This is what they used to be known for.',
  },
  strength_change: {
    plain: 'Rising or fading',
    advanced: 'CES vs HAS',
    what: 'The difference between strength now and strength before.',
    look: 'High before and low now means it is fading on its own, and the reverse means it is growing.',
  },
  band: {
    plain: 'Band',
    advanced: 'Band',
    model: 'bands',
    what: 'A plain grouping of association strength into dominant, strong, present or marginal.',
    look: 'Use it to read one client’s list quickly, never to compare two clients.',
  },

  // --- Share and movement --------------------------------------------------
  current_corpus_share: {
    plain: 'Share of coverage',
    advanced: 'ACS',
    what: 'Out of all the recent pages about this client, the share that mention this topic.',
    look: 'A high strength built on a small share is one loud story rather than a broad pattern.',
  },
  corpus_share: {
    plain: 'Share of coverage, all time',
    advanced: 'Corpus share',
    what: 'Out of all the pages about this client, the share that mention this topic.',
    look: 'Compare it with the recent share to see whether the topic is taking up more or less of the conversation.',
  },
  momentum: {
    plain: 'Recent movement',
    advanced: 'AM',
    model: 'momentum',
    what: 'Whether this topic grew or shrank in the latest period compared with the one before.',
    look: 'Treat it as noise when the period holds only a handful of pages, which is why low-volume periods show a dash.',
  },
  recent_evidence_share: {
    plain: 'Recent share of evidence',
    advanced: 'Evidence under 365 days',
    what: 'How much of this topic’s weighted evidence is less than a year old.',
    look: 'A low figure on a strong topic means its strength is mostly historical.',
  },

  // --- Google --------------------------------------------------------------
  google_retrieval_score: {
    plain: 'What Google shows',
    advanced: 'GRS',
    model: 'serpRankWeights',
    basis: 'results',
    what: 'How much of Google’s first page, weighted by position, carries this topic.',
    look: 'Compare it with association strength, because a big gap means the web and Google disagree.',
    caveat: 'Observed from Google’s current results for the name. It is not predicted, and it is not a score Google publishes.',
  },
  retrieval_gap: {
    plain: 'Web versus Google',
    advanced: 'Retrieval gap',
    what: 'What Google shows minus the share of recent coverage that carries this topic.',
    look: 'Positive means Google shows it more than the recent web does, and negative means Google has not caught up.',
  },
  organic_results: {
    plain: 'Google results',
    advanced: 'Organic results',
    what: 'How many of Google’s results for the name carry this topic.',
    look: 'A topic on many results but none near the top is present on Google without being prominent.',
  },
  top10_results: {
    plain: 'On the first page',
    advanced: 'Top 10',
    what: 'How many of Google’s top ten results for the name carry this topic.',
    look: 'This is what most searchers actually see.',
  },
  best_rank: {
    plain: 'Highest position',
    advanced: 'Best rank',
    what: 'The highest position on Google at which a result carries this topic.',
    look: 'Positions one to three are seen by almost everyone who searches the name.',
  },

  // --- Evidence base -------------------------------------------------------
  documents: {
    plain: 'Pages',
    advanced: 'Documents',
    what: 'Pages we accepted as being about this client that mention this topic.',
    look: 'Every score rests on these, so a high score on very few pages deserves suspicion.',
  },
  current_documents: {
    plain: 'Recent pages',
    advanced: 'Current-window documents',
    model: 'currentWindowDays',
    what: 'Pages from the recent period that mention this topic.',
    look: 'Strength now rests on these, so a strong current score on a handful of pages is fragile.',
  },
  shared_documents: {
    plain: 'Pages in common',
    advanced: 'Shared documents',
    what: 'Pages that mention both topics.',
    look: 'The more pages they share, the more the two topics are one story.',
  },
  domains: {
    plain: 'Websites',
    advanced: 'Domains',
    what: 'The number of different websites those pages came from.',
    look: 'Many pages from few websites is one outlet repeating itself.',
  },
  independent_sources: {
    plain: 'Independent sources',
    advanced: 'Independent sources',
    model: 'independence',
    what: 'The number of pages left after copies and repeats on the same site are discounted.',
    look: 'When this is far below the page count, much of the coverage is the same story republished.',
  },
  independence_weight: {
    plain: 'Repeat discount',
    advanced: 'Independence weight',
    model: 'independence',
    what: 'Forty copies of one press release count as one source, not forty.',
    look: 'If a score collapses when you look at independent sources, it was built on syndication.',
  },
  duplicate_cluster: {
    plain: 'Copies',
    advanced: 'Duplicate cluster',
    model: 'duplicates',
    what: 'Pages that are the same story published in more than one place.',
    look: 'Only the original counts in full, so a large cluster explains a score that looks bigger than it is.',
  },
  median_age: {
    plain: 'Typical age',
    advanced: 'Median age',
    what: 'How old the middle page about this topic is.',
    look: 'Years old means the topic is historical, and months old means it is live.',
  },
  sentiment: {
    plain: 'Tone',
    advanced: 'Sentiment',
    what: 'Whether coverage of this topic reads as positive, negative or mixed.',
    look: 'Tone is reported beside strength and never changes it, so a strong negative topic stays strong.',
  },

  // --- Per-page factors ----------------------------------------------------
  entity_confidence: {
    plain: 'Is this the right person',
    advanced: 'Disambiguation confidence',
    model: 'entityConfidence',
    what: 'How sure we are that a page is about your client rather than someone with the same name.',
    look: 'Anything in the middle band needs a human, and that is what the review queue is for.',
  },
  source_reliability: {
    plain: 'Source reliability',
    advanced: 'Source rel.',
    model: 'reliability',
    what: 'Our estimate of how established a website is, from signals we can observe.',
    look: 'It is not Domain Authority, so use it to compare sources within this report only.',
  },
  relationship_confidence: {
    plain: 'How directly stated',
    advanced: 'Rel. conf.',
    what: 'How directly the page ties this topic to your client.',
    look: 'Low values are passing mentions, which count for much less than a stated fact.',
  },
  proximity: {
    plain: 'How close in the text',
    advanced: 'Proximity',
    model: 'proximity',
    what: 'How near the topic sits to your client’s name on the page.',
    look: 'The same sentence counts far more than a mention several paragraphs away.',
  },
  recency_weight: {
    plain: 'Recency',
    advanced: 'Recency weight',
    model: 'recency',
    what: 'How much a page still counts given its age.',
    look: 'A page loses half its weight every half-life, so old coverage fades unless it is repeated.',
  },
  evidence_score: {
    plain: 'Weighted evidence',
    advanced: 'Evidence score',
    what: 'How much one page contributes after every discount is applied.',
    look: 'A page near zero was discounted for being old, a copy, off-topic or about someone else.',
  },
  extractor: {
    plain: 'Read by',
    advanced: 'Extractor',
    what: 'Whether an LLM or the fallback pattern-matcher read this page.',
    look: 'Rows marked fallback are less accurate and some of their labels will be junk.',
  },
  google_position: {
    plain: 'Position on Google',
    advanced: 'SERP position',
    what: 'Where this page appears in Google’s results for the client’s name, if it appears at all.',
    look: 'Evidence from pages Google shows for the name is what searchers actually read.',
  },

  // --- Co-occurrence -------------------------------------------------------
  lift: {
    plain: 'More than chance',
    advanced: 'Lift',
    what: 'How much more often two topics appear on the same page than chance would give.',
    look: 'Well above one means they travel together, and zero means they never meet.',
  },
  share_of_this: {
    plain: 'Share of these pages',
    advanced: '% of these',
    what: 'Out of this topic’s pages, the share that also carry the other topic.',
    look: 'When this is high and the reverse is low, this topic is riding on the other one.',
  },
  share_of_other: {
    plain: 'Share of those pages',
    advanced: '% of those',
    what: 'Out of the other topic’s pages, the share that also carry this one.',
    look: 'Read it against the share of these pages to see which topic carries which.',
  },

  // --- Action plan diagnostics ---------------------------------------------
  high_authority_domains: {
    plain: 'Major websites',
    advanced: 'High-authority domains',
    model: 'reliability',
    what: 'How many of the websites behind this topic are established national or specialist publications.',
    look: 'Several major outlets stating something directly make it part of the public record.',
  },
  direct_statement_share: {
    plain: 'Stated directly',
    advanced: 'Direct-relationship share',
    what: 'The share of passages that state the link outright rather than in passing.',
    look: 'Mostly passing mentions means the link is loose, even when it is frequent.',
  },
  top_domain_share: {
    plain: 'On one website',
    advanced: 'Top-domain share',
    what: 'The share of this topic’s evidence that comes from its single biggest website.',
    look: 'A high figure means one outlet is carrying the story.',
  },
  weight_remaining: {
    plain: 'Weight left',
    advanced: 'Weight remaining',
    model: 'recency',
    what: 'How much of today’s recency weight this topic would keep by that date with no new coverage.',
    look: 'A steep fall means the topic is fading without anyone doing anything.',
  },

  // --- Trust ---------------------------------------------------------------
  coverage_confidence: {
    plain: 'How much to trust this',
    advanced: 'Coverage confidence',
    what: 'How many pages we found about this client, and how well dated they are.',
    look: 'Low confidence means the ranking is a guess, so fix coverage before acting on it.',
  },
  owned_excluded: {
    plain: 'What others say',
    advanced: 'Owned-excluded view',
    status: 'planned',
    what: 'The same scores with everything you published subtracted.',
    look: 'The gap between the two is what your campaign actually changed.',
  },
});

/** §95 — plain bands for association strength. Thresholds live in MODEL.bands. */
export const BAND_ORDER = Object.freeze(['dominant', 'strong', 'present', 'marginal']);
export const BANDS = Object.freeze({
  dominant: { plain: 'Dominant', what: 'Among the strongest things the web links them to.' },
  strong: { plain: 'Strong', what: 'Clearly and repeatedly linked to them.' },
  present: { plain: 'Present', what: 'Linked to them, but not a defining association.' },
  marginal: { plain: 'Marginal', what: 'A weak or occasional link.' },
});

/** Verbatim disclaimers (§3, §27, §4, §57, §95). Rendered from here and nowhere else. */
export const DISCLAIMERS = Object.freeze({
  external_estimate:
    'This is an external estimate of entity-association strength. It does not expose Google’s internal Knowledge Graph or ranking scores.',
  source_reliability:
    'Source reliability is our blend of observable signals such as domain rank and prominence. It is not Domain Authority, and it is not a measure of how much Google trusts a site.',
  query_behavior:
    'Google’s patents describe using what people search for next as a signal. That behaviour cannot be observed from outside Google, so query_behavior_score is permanently empty in this tool rather than estimated.',
  bands:
    'Bands compare associations within this one client. They do not compare clients.',
  simulation:
    'These projections describe this tool’s own association metric under the stated assumptions. They are not predictions of Google rankings, and no part of this model can see Google’s retrieval.',
  content:
    'Drafts are built only from sourced passages and your own notes, and a person must check and approve each one before it is used. New content does not remove existing coverage; it changes what else is said about the client.',
  content_disclosure:
    'Publish under the client’s own name or clearly attributed to them. Never present it as independent reporting, a review, or someone else’s testimony.',
  content_optimisation:
    'These targets follow this tool’s own scoring model, which approximates factors described in Google patents. They are not a guarantee of how Google will treat the page.',
});

/** §94 — the specific messages for weak and empty states. */
export const NOTICES = Object.freeze({
  low_coverage: ({ documents }) =>
    `We found ${n(documents)} documents. That is not enough to rank associations reliably. Import more URLs or widen the corpus before acting on this.`,
  momentum_floor: () => 'Too few documents this period to measure movement.',
  no_llm_key: () => 'Running without an LLM key. Associations are less accurate and some labels will be junk.',
  heuristic_rows: ({ heuristic, total }) =>
    `${n(heuristic)} of ${n(total)} evidence rows were read by the fallback extractor instead of an LLM. Those associations are less accurate and some labels will be junk.`,
  dates_inferred: ({ inferred, total }) =>
    `${n(inferred)} of ${n(total)} documents were dated by inference, not by the publisher. Recent-versus-historical splits are approximate.`,
  no_google: () =>
    'No SERP data yet. Association strength is what the web says; it does not tell you what Google shows.',
});
