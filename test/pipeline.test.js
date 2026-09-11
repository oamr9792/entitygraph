import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * §73 — the MVP success test, as assertions.
 *
 * The brief lists five criteria for calling the core pipeline reliable:
 * precision on the right entity, traceable evidence, duplicate handling,
 * recency behaviour, and historical/current separation. Each is a test below,
 * run over a corpus built so that a regression in any one of them changes a
 * number this file checks.
 *
 * The pipeline runs against its own database file so a test run cannot touch
 * working data.
 */

const DB_PATH = path.join('data', `test-pipeline-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.PAGE_FETCH_ENABLED = 'false';
process.env.LLM_PROVIDER = 'heuristic';

const { createEntity } = await import('../src/services/identity.js');
const { runPipeline } = await import('../src/jobs/pipeline.js');
const { leaderboard } = await import('../src/services/metrics.js');
const { coverageConfidence } = await import('../src/services/coverage.js');
const { all, db } = await import('../src/db.js');
const { canonicaliseUrl, rootDomain } = await import('../src/util/hash.js');
const { normaliseForMatch } = await import('../src/util/text.js');

const RELEASE =
  'John Smith, founder of ABC Capital, announced a $12 million gift to the XYZ Foundation on Tuesday. ' +
  'The donation funds arts education across New York schools.';

const DOCS = [
  // Fresh philanthropy across independent domains.
  ['nytimes.com', '/a', 'Smith gives $12m', '2026-07-14', RELEASE, 92],
  ['ft.com', '/b', 'Smith philanthropy grows', '2026-06-02',
    'John Smith, founder of ABC Capital, has increased his charitable giving. The New York investor donated to the XYZ Foundation.', 88],
  ['philanthropytoday.org', '/c', 'Profile: Smith', '2026-08-21',
    'New York investor John Smith, founder of ABC Capital, funds arts education and serves on the XYZ Foundation board.', 58],
  // The same wire story on four more domains.
  ['prwire.example', '/d', 'Smith gives $12m', '2026-07-14', RELEASE, 22],
  ['aggregator.example', '/e', 'Smith gives $12m', '2026-07-15', RELEASE, 18],
  ['financedaily.example', '/f', 'Smith gives $12m', '2026-07-15', RELEASE, 20],
  ['bizfeed.example', '/g', 'Smith gives $12m', '2026-07-16', RELEASE, 16],
  // Old, high-volume lawsuit coverage.
  ['reuters.com', '/h', 'Investors sue ABC Capital', '2019-03-11',
    'A lawsuit filed in New York accuses ABC Capital and its founder John Smith of inadequate disclosure.', 91],
  ['nytimes.com', '/i', 'ABC Capital faces lawsuit', '2019-04-02',
    'The lawsuit against ABC Capital names founder John Smith. The New York firm denies wrongdoing.', 92],
  ['lawreporter.example', '/j', 'The ABC Capital litigation', '2019-06-30',
    'The litigation involving John Smith and ABC Capital turns on disclosure. The New York filing is detailed.', 51],
  ['ft.com', '/k', 'Lawsuit dismissed', '2021-02-18',
    'A judge dismissed the lawsuit against ABC Capital and founder John Smith. The New York investor called it meritless.', 88],
  ['localherald.example', '/l', 'Investor named in lawsuit', '2019-05-19',
    'John Smith, the New York investor behind ABC Capital, was named in a lawsuit filed this spring.', 34],
  // A different John Smith.
  ['sportsdesk.example', '/m', 'Smith scores twice', '2026-08-30',
    'John Smith scored twice on Saturday. The footballer has scored eleven times this season.', 55],
  ['sportsdesk.example', '/n', 'Player profile', '2026-07-02',
    'John Smith is a midfielder. The footballer joined the club in 2024.', 55],
];

const candidates = DOCS.map(([domain, pathname, title, date, body, rank]) => {
  const url = `https://${domain}${pathname}`;
  return {
    url,
    canonical_url: canonicaliseUrl(url),
    root_domain: rootDomain(url),
    title,
    snippet: body,
    domain_rank: rank,
    url_rank: Math.max(5, rank - 20),
    published_at: `${date} 09:00:00 +00:00`,
    group_date: `${date} 09:00:00 +00:00`,
    sentiment_negative: /lawsuit|sue/i.test(body) ? 0.85 : 0.05,
    sentiment_positive: /lawsuit|sue/i.test(body) ? 0.05 : 0.5,
    sentiment_neutral: 0.1,
    provider: 'manual',
  };
});

const entityId = createEntity({
  canonical_name: 'John Smith',
  entity_type: 'person',
  identity_markers: {
    organizations: ['ABC Capital'],
    locations: ['New York'],
    occupations: ['investor', 'founder'],
  },
  negative_markers: ['footballer', 'midfielder'],
});

await runPipeline({
  entityId,
  jobId: null,
  options: {
    providers: ['manual'],
    aliases: ['John Smith'],
    urls: candidates,
    skip: ['fetch_evidence_windows', 'run_serp_queries'],
  },
  report: async () => {},
});

const board = leaderboard(entityId);
const byLabel = (needle) => board.associations.find((a) => new RegExp(needle, 'i').test(a.label));

test.after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = DB_PATH + suffix;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

// --- §73 Precision ----------------------------------------------------------

test('§73 precision: documents about a different John Smith are excluded', () => {
  const verdicts = all(
    `SELECT d.root_domain, m.verdict FROM entity_document_matches m
       JOIN documents d ON d.id = m.document_id WHERE m.entity_id = ?`,
    entityId
  );
  const sports = verdicts.filter((v) => v.root_domain === 'sportsdesk.example');
  assert.equal(sports.length, 2);
  assert.ok(sports.every((v) => v.verdict === 'reject'), 'the footballer must not enter the corpus');

  const accepted = verdicts.filter((v) => v.verdict === 'accept');
  assert.equal(accepted.length, DOCS.length - 2);
});

test('§73 precision: no association is the entity itself', () => {
  for (const row of board.associations) {
    assert.ok(
      !normaliseForMatch(row.label).includes('john smith'),
      `"${row.label}" should not be an association of John Smith`
    );
  }
});

// --- §73 Evidence correctness -----------------------------------------------

test('§73 evidence: every association traces to a real supporting text window', () => {
  for (const row of board.associations) {
    const evidence = all(
      `SELECT e.evidence_text, d.snippet, d.title FROM evidence e
         JOIN documents d ON d.id = e.document_id
        WHERE e.association_id = ? AND e.excluded = 0`,
      row.association_id
    );
    assert.ok(evidence.length > 0, `${row.label} has no evidence rows`);
    for (const item of evidence) {
      assert.ok(item.evidence_text.trim().length > 0, `${row.label} has an empty evidence quote`);
      const source = normaliseForMatch([item.title, item.snippet].join(' '));
      assert.ok(
        source.includes(normaliseForMatch(item.evidence_text).slice(0, 40)),
        `${row.label}: evidence quote is not present in its source document`
      );
    }
  }
});

// --- §73 Duplicate handling -------------------------------------------------

test('§73 duplicates: syndicated copies do not dominate association strength', () => {
  const philanthropy = byLabel('philanthropy');
  assert.ok(philanthropy, 'expected a philanthropy association');

  const contributions = all(
    `SELECT d.root_domain, s.independence_weight FROM association_document_scores s
       JOIN documents d ON d.id = s.document_id WHERE s.association_id = ?`,
    philanthropy.association_id
  );
  const syndicated = contributions.filter((c) => /prwire|aggregator|financedaily|bizfeed/.test(c.root_domain));
  assert.ok(syndicated.length >= 3, 'the syndicated copies should be in the corpus');
  const syndicatedWeight = syndicated.reduce((a, c) => a + c.independence_weight, 0);
  assert.ok(
    syndicatedWeight <= 1,
    `four copies of one release contributed ${syndicatedWeight} independent sources; expected at most 1`
  );

  // The independent-source count must be well below the raw document count.
  assert.ok(
    philanthropy.independent_sources < philanthropy.documents,
    'independent sources should be discounted below the raw document count'
  );
});

// --- §73 Recency ------------------------------------------------------------

test('§73 recency: a current association scores far higher currently than historically', () => {
  const philanthropy = byLabel('philanthropy');
  assert.ok(philanthropy.current_pias > philanthropy.historical_pias);
  assert.ok(philanthropy.freshness.evidence_share_under_365d > 0.9);
  assert.ok(philanthropy.current_corpus_share > 0);
});

// --- §73 Historical separation ----------------------------------------------

test('§73 separation: an old high-volume relationship stays strong historically and falls currently', () => {
  const lawsuit = byLabel('lawsuit');
  assert.ok(lawsuit, 'expected a lawsuit association');
  assert.ok(lawsuit.historical_pias > 40, `lawsuit should remain historically strong, got ${lawsuit.historical_pias}`);
  assert.ok(
    lawsuit.current_pias < lawsuit.historical_pias * 0.5,
    `lawsuit current PIAS (${lawsuit.current_pias}) should be materially below historical (${lawsuit.historical_pias})`
  );
  assert.ok(lawsuit.freshness.median_age_days > 365 * 3, 'the supporting documents are years old');
});

test('§73 separation: the historical and current dominant associations differ', () => {
  const historicalTop = board.associations.slice().sort((a, b) => b.historical_pias - a.historical_pias)[0];
  const currentTop = board.associations.slice().sort((a, b) => b.current_pias - a.current_pias)[0];
  assert.equal(historicalTop.label.toLowerCase(), 'lawsuit');
  assert.notEqual(currentTop.association_id, historicalTop.association_id);
});

// --- §43, §70 ---------------------------------------------------------------

test('§43 a strong association can be negative without that changing its strength', () => {
  const lawsuit = byLabel('lawsuit');
  assert.equal(lawsuit.sentiment.label, 'negative');
  assert.ok(lawsuit.pias > 0, 'negative sentiment must not suppress the strength score');
});

test('§70 coverage confidence reports a band and names what is missing', () => {
  const coverage = coverageConfidence(entityId);
  assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(coverage.level));
  assert.equal(coverage.documents_analysed, DOCS.length - 2);
  assert.ok(coverage.criteria.length >= 6);
  assert.ok(
    coverage.warnings.some((w) => /heuristic|LLM/i.test(w)),
    'running without an LLM must be disclosed in the coverage warnings'
  );
});

test('a rescore is deterministic: running it twice changes nothing', async () => {
  const { rescoreEntity } = await import('../src/services/metrics.js');
  rescoreEntity(entityId);
  const first = leaderboard(entityId).associations.map((a) => [a.label, a.pias, a.current_pias]);
  rescoreEntity(entityId);
  const second = leaderboard(entityId).associations.map((a) => [a.label, a.pias, a.current_pias]);
  assert.deepEqual(second, first);
});

/**
 * Regression: a rebuild after a canonicalisation pass used to die on
 * `UNIQUE constraint failed: associations.entity_id, canonical_label, kind`.
 *
 * upsertAssociation looked up with `status != 'merged'` while the UNIQUE index
 * covers every row whatever its status, so re-extracting a label that survived
 * only as a merged row missed the lookup and collided on insert. Since every
 * build canonicalises and every rebuild re-extracts, this broke the second
 * build of any entity — the normal workflow.
 */
test('re-extracting a merged label returns the survivor instead of colliding', async () => {
  const { upsertAssociation } = await import('../src/services/canonicalize.js');
  const { get, run } = await import('../src/db.js');

  const loser = upsertAssociation(entityId, { canonical_label: 'Charitable Giving', kind: 'concept' });
  const winner = upsertAssociation(entityId, { canonical_label: 'Philanthropy', kind: 'concept' });
  assert.notEqual(loser, winner);

  run(
    `UPDATE associations SET status = 'merged', merged_into_id = ? WHERE id = ?`,
    winner,
    loser
  );

  // The exact call the extractor makes on the next build.
  const again = upsertAssociation(entityId, { canonical_label: 'Charitable Giving', kind: 'concept' });
  assert.equal(again, winner, 'evidence for a merged label belongs on the association it was merged into');

  // And a chain of merges resolves to the end of the chain, not one hop along.
  const third = upsertAssociation(entityId, { canonical_label: 'Good Works', kind: 'concept' });
  run(`UPDATE associations SET status = 'merged', merged_into_id = ? WHERE id = ?`, loser, third);
  assert.equal(
    upsertAssociation(entityId, { canonical_label: 'Good Works', kind: 'concept' }),
    winner,
    'a merge chain must resolve to the final survivor'
  );

  // A self-referential pointer must not hang the pipeline.
  const cyclic = upsertAssociation(entityId, { canonical_label: 'Loop Test', kind: 'concept' });
  run(`UPDATE associations SET status = 'merged', merged_into_id = ? WHERE id = ?`, cyclic, cyclic);
  assert.equal(upsertAssociation(entityId, { canonical_label: 'Loop Test', kind: 'concept' }), cyclic);

  assert.ok(get(`SELECT 1 AS ok`), 'database still usable');
});

/**
 * §19 — the containment rule that tightens clustering without over-merging.
 *
 * The danger of merging on containment is that it destroys real distinctions:
 * "youth hockey" is not "hockey", "education philanthropy" is not
 * "philanthropy". The guard is that only *generic type words* may differ — the
 * words that say what form a thing takes rather than which thing it is. These
 * assertions are the boundary of that guard, in both directions.
 */
test('§19 generic type words fold together, narrowing words do not', async () => {
  const { isGenericVariant } = await import('../src/services/canonicalize.js');

  for (const [general, variant] of [
    ['Private Equity', 'Private Equity Funds'],
    ['Private Equity', 'private equity firm'],
    ['Private Equity', 'Private Equity Industry'],
    ['Hockey', 'Hockey Operations'],
  ]) {
    assert.equal(isGenericVariant(general, variant), true, `${variant} should fold into ${general}`);
  }

  for (const [general, narrower] of [
    ['Hockey', 'Youth Hockey'],
    ['Philanthropy', 'Education Philanthropy'],
    ['Investment', 'Sports Investment'],
    ['Capital', 'Blackstreet Capital'],
  ]) {
    assert.equal(isGenericVariant(general, narrower), false, `${narrower} must stay distinct from ${general}`);
  }

  // Direction matters: the longer label never absorbs the shorter one.
  assert.equal(isGenericVariant('Private Equity Funds', 'Private Equity'), false);
});

test('§16 a label that is really a sentence is rejected, not stored as an entity', async () => {
  const { isSentenceLike, upsertAssociation } = await import('../src/services/canonicalize.js');

  assert.equal(
    isSentenceLike('Black Bear Sports Group, Inc. is a privately held company formed by Murry Gunty in 2015'),
    true
  );
  for (const good of [
    'Private Equity',
    'Investment Advisers Act of 1940',
    'U.S. Securities and Exchange Commission',
    'Unregistered broker-dealer activity',
  ]) {
    assert.equal(isSentenceLike(good), false, `${good} is a legitimate label`);
  }

  assert.equal(
    upsertAssociation(entityId, {
      canonical_label: 'Acme Corp is a company that was founded by someone in 1998',
      kind: 'named_entity',
    }),
    null,
    'a sentence must not create an association'
  );
});

/**
 * Regression: a rejected API key used to produce an empty dashboard from a
 * corpus that had already been paid for.
 *
 * `available()` can only see that a key was configured, not that the provider
 * accepts it. With a bad key every call failed, the heuristic fallback never
 * engaged because the provider still looked available, extraction returned
 * nothing for every passage, and the job reported success. Observed in
 * production as 104 calls, 104 failures, $0.00, and a blank screen.
 */
test('a failing LLM provider trips a breaker and falls back rather than failing silently', async () => {
  const llm = await import('../src/providers/llm/index.js');

  llm.resetLlmBreaker();
  const healthy = llm.llmStatus();
  assert.equal(healthy.degraded, false);
  assert.equal(healthy.consecutive_failures, 0);

  for (let i = 0; i < 5; i += 1) llm.noteLlmFailure('anthropic error 401: invalid x-api-key');

  // Asserted on breaker_open rather than , because the test
  // environment deliberately configures no LLM provider — and the breaker's
  // own state is the thing under test, not the interaction with config.
  const degraded = llm.llmStatus();
  assert.equal(degraded.breaker_open, true, 'five consecutive failures must trip the breaker');
  assert.equal(degraded.available, false, 'a provider that cannot answer is not available');
  assert.equal(degraded.fallback, 'heuristic');
  assert.equal(degraded.consecutive_failures, 5);
  assert.match(degraded.last_error, /invalid x-api-key/);
  assert.equal(llm.getLlm(), null, 'work must route to the fallback while the breaker is open');

  // One success clears it, so a transient outage does not disable the provider
  // for the rest of the process.
  llm.noteLlmSuccess();
  assert.equal(llm.llmStatus().breaker_open, false);
  assert.equal(llm.llmStatus().consecutive_failures, 0);
  assert.equal(llm.llmStatus().last_error, null);
});

/**
 * §57–§60 — the action planner, and specifically the case where the honest
 * answer is that a displacement campaign will not work.
 *
 * An association carried by many independent domains, several of them
 * high-authority, stating the relationship directly, is an established fact of
 * the public record. The model's own arithmetic says its share will not move
 * usefully, and a tool that recommended a campaign anyway would be selling
 * work it has already computed to be ineffective. This asserts the planner
 * reaches that conclusion and does not offer displacement alongside it.
 */
test('§57 a well-corroborated association is not offered a displacement campaign', async () => {
  const { run, get } = await import('../src/db.js');
  const { actionPlan } = await import('../src/services/actionplan.js');
  const { upsertAssociation } = await import('../src/services/canonicalize.js');

  const assocId = upsertAssociation(entityId, {
    canonical_label: 'Federal Indictment',
    kind: 'named_entity',
    category: 'legal',
  });

  // Twelve independent domains, four of them national publications, each
  // stating the relationship directly and recently.
  const majors = ['nytimes.com', 'reuters.com', 'bloomberg.com', 'wsj.com'];
  const others = ['lawreview.org', 'courtwatch.com', 'legalnews.net', 'statepress.com',
    'dailyrecord.com', 'cityherald.com', 'newswire.co', 'tribune.com'];
  const domains = [...majors, ...others];

  domains.forEach((domain, i) => {
    run(
      `INSERT INTO domains (root_domain, domain_rank, classification) VALUES (?, ?, ?)
       ON CONFLICT(root_domain) DO UPDATE SET classification = excluded.classification`,
      domain,
      i < majors.length ? 92 : 55,
      i < majors.length ? 'major' : 'ordinary'
    );
    const doc = run(
      `INSERT INTO documents (url, root_domain, published_at, domain_rank) VALUES (?, ?, datetime('now', '-30 days'), ?)`,
      `https://${domain}/indictment-story`,
      domain,
      i < majors.length ? 92 : 55
    );
    const documentId = Number(doc.lastInsertRowid);
    run(
      `INSERT INTO entity_document_matches (entity_id, document_id, entity_confidence, verdict)
       VALUES (?, ?, 0.97, 'accept')`,
      entityId,
      documentId
    );
    run(
      `INSERT INTO evidence (entity_id, association_id, document_id, evidence_text, entity_confidence,
         relationship_confidence, proximity_score, source_reliability, recency_weight, independence_weight,
         evidence_score, published_at, relationship)
       VALUES (?, ?, ?, 'named in the indictment', 0.97, 0.95, 0.9, 0.9, 1.0, 1.0, 0.7, datetime('now', '-30 days'), 'named_in')`,
      entityId,
      assocId,
      documentId
    );
  });

  const { rescoreEntity } = await import('../src/services/metrics.js');
  rescoreEntity(entityId);

  const plan = actionPlan(assocId);
  assert.equal(plan.character.verdict, 'central_and_corroborated', plan.character.reasoning);
  assert.ok(plan.character.major_domains >= 3, 'the major-outlet count is what triggers this');

  const keys = plan.routes.map((r) => r.key);
  assert.ok(keys.includes('not_a_metrics_problem'), 'the planner must say displacement is the wrong instrument');
  assert.ok(!keys.includes('displace'), 'and must not offer a displacement campaign alongside it');

  // The projection must never be dressed up as a prediction about Google.
  assert.match(plan.simulation_disclaimer, /not predictions of Google rankings/i);
});

/**
 * §9 — paired probes, and the query-design gap they close.
 *
 * Searching a name alone returns the provider's own top-relevance slice. For a
 * well-known person that is a small fraction of what the index holds, ordered
 * by something unrelated to the investigation. Observed: a lawyer whose corpus
 * held 750 documents pairing his name with a controversy, of which the
 * name-only search surfaced one.
 *
 * The filter has to survive the whole call chain — provider options through to
 * the request body — or it silently degrades to the name-only search that
 * caused the problem, and nothing about the result looks wrong.
 */
test('§9 a paired probe filter reaches the provider request intact', async () => {
  const dfs = await import('../src/providers/dataforseo.js');

  const filter = dfs.pairedFilter('Epstein');
  assert.deepEqual(filter, [['content_info.snippet', 'like', '%Epstein%']]);
  assert.deepEqual(
    dfs.pairedFilter('Epstein', 'content_info.title'),
    [['content_info.title', 'like', '%Epstein%']]
  );

  // The filter has to survive into the request body. If it is dropped the call
  // degrades to the name-only search that caused the problem, and nothing
  // about the result looks wrong.
  const paired = dfs.contentSearchTask({ keyword: '"Jay Lefkowitz"', filters: filter, limit: 100 });
  assert.equal(paired.keyword, '"Jay Lefkowitz"', 'the name stays an exact phrase');
  assert.deepEqual(paired.filters, filter, 'the pairing filter must reach the request body');

  // And must be absent, not null, when no probe is in play — the API rejects
  // a null filters field rather than ignoring it.
  const plain = dfs.contentSearchTask({ keyword: '"Jay Lefkowitz"' });
  assert.equal('filters' in plain, false);

  assert.equal(dfs.contentSearchTask({ keyword: 'x', limit: 5000 }).limit, 1000, 'limit is capped at the API maximum');
});

// ---------------------------------------------------------------------------
// Google's own association signals, and the chain that used to drop them.
// Regression context: an analyst could see 13 of 67 organic results for a name
// mention a subject, and the tool found one document.
// ---------------------------------------------------------------------------

test('Google related searches, People Also Ask and the knowledge panel are parsed, not discarded', async () => {
  const { parseSerpSignals } = await import('../src/providers/serp-signals.js');
  // Shapes taken from a live DataForSEO response.
  const signals = parseSerpSignals([
    { type: 'organic', title: 'ignored here' },
    { type: 'related_searches', items: ['Jay Lefkowitz, Kirkland', 'Jay Lefkowitz Columbia', 'Jay Lefkowitz net worth'] },
    { type: 'people_also_ask', items: [{ type: 'people_also_ask_element', title: 'Who is Jay Lefkowitz?' }] },
    {
      type: 'knowledge_graph',
      title: 'Jay Lefkowitz',
      subtitle: 'American lawyer',
      description: 'A litigation partner at Kirkland & Ellis.',
      items: [
        { type: 'knowledge_graph_description_item', links: [{ domain: 'en.wikipedia.org' }] },
        { type: 'knowledge_graph_row_item', title: 'Born', text: 'Born : November 20, 1962' },
      ],
    },
  ]);
  assert.deepEqual(signals.related_searches, ['Jay Lefkowitz, Kirkland', 'Jay Lefkowitz Columbia', 'Jay Lefkowitz net worth']);
  assert.deepEqual(signals.people_also_ask, ['Who is Jay Lefkowitz?']);
  assert.equal(signals.knowledge_graph.subtitle, 'American lawyer');
  assert.deepEqual(signals.knowledge_graph.facts, [{ label: 'Born', text: 'Born : November 20, 1962' }]);
  assert.deepEqual(signals.knowledge_graph.sources, ['en.wikipedia.org']);
  assert.deepEqual(parseSerpSignals([]).related_searches, [], 'a page without these blocks is not an error');
});

test('probe terms come from what Google relates to the name, minus the name and the gossip', async () => {
  const { probeTermsFromSignals } = await import('../src/providers/serp-signals.js');
  const terms = probeTermsFromSignals(
    {
      related_searches: [
        'Jay Lefkowitz, Kirkland', 'Jay Lefkowitz Columbia', 'Jay Lefkowitz net worth', 'Jay Lefkowitz wife',
        'Jay lefkowitz ethnicity', 'Jay Lefkowitz religion', 'Jay lefkowitz salary', 'Jay lefkowitz tikvah',
      ],
    },
    ['Jay Lefkowitz', 'Jay P. Lefkowitz']
  );
  assert.deepEqual(terms, ['Kirkland', 'Columbia', 'tikvah']);
  assert.deepEqual(probeTermsFromSignals(null, ['x']), []);
});

test('a Google rank for the name is identity evidence — a prior, never a pass on its own', async () => {
  const { withSerpPrior, serpRankFromRef } = await import('../src/services/disambiguation.js');
  const nameOnly = { confidence: 0.05, verdict: 'reject', matched_alias: 'Jay Lefkowitz', method: 'markers', reasons: [] };

  const top = withSerpPrior(nameOnly, 2);
  assert.equal(top.verdict, 'review', 'a top result with no marker goes to adjudication, not straight in');
  assert.ok(top.reasons.some((r) => r.kind === 'google_rank'));

  const withMarker = withSerpPrior({ ...nameOnly, confidence: 0.41, verdict: 'review' }, 8);
  assert.equal(withMarker.verdict, 'accept', 'one confirming marker plus a first-page rank is enough');

  assert.equal(withSerpPrior(nameOnly, 250), nameOnly, 'no credit beyond the depth we fetch');
  assert.equal(withSerpPrior({ ...nameOnly, matched_alias: null }, 1).verdict, 'reject', 'no name in the text, no identity credit');
  assert.equal(serpRankFromRef('rank:14'), 14);
  assert.equal(serpRankFromRef('probe:Epstein'), null);
});

test('headline surnames link a Google result to a person association — but never the entity’s own surname', async () => {
  const { run, get } = await import('../src/db.js');
  const { upsertAssociation } = await import('../src/services/canonicalize.js');
  const { classifySnapshot } = await import('../src/services/serp.js');

  const own = get(`SELECT canonical_name FROM entities WHERE id = ?`, entityId).canonical_name;
  const ownSurname = own.trim().split(/\s+/).at(-1);

  const epstein = upsertAssociation(entityId, { canonical_label: 'Jeffrey Epstein', kind: 'named_entity', category: 'person' });
  const relative = upsertAssociation(entityId, { canonical_label: `Rachel ${ownSurname}`, kind: 'named_entity', category: 'person' });

  const snap = run(`INSERT INTO serp_snapshots (entity_id, query) VALUES (?, ?)`, entityId, own);
  const snapshotId = Number(snap.lastInsertRowid);
  const result = run(
    `INSERT INTO serp_results (snapshot_id, rank, url, title, description) VALUES (?, 8, ?, ?, ?)`,
    snapshotId,
    'https://www.law.com/example',
    `${own}, Kirkland Partner Who Represented Epstein`,
    `${own} is a lawyer.`
  );
  const resultId = Number(result.lastInsertRowid);

  await classifySnapshot(entityId, snapshotId, { useLlm: false });

  const link = get(`SELECT method FROM serp_result_associations WHERE serp_result_id = ? AND association_id = ?`, resultId, epstein);
  assert.equal(link?.method, 'surname_match', '"Represented Epstein" supports the Jeffrey Epstein association');
  assert.equal(
    get(`SELECT 1 AS hit FROM serp_result_associations WHERE serp_result_id = ? AND association_id = ?`, resultId, relative),
    null,
    'a relative sharing the entity’s surname must not claim every result that names the entity'
  );
});

test('columns added after the first deploy reach an existing database', async () => {
  const { all } = await import('../src/db.js');
  const cols = (t) => all(`PRAGMA table_info(${t})`).map((c) => c.name);
  assert.ok(cols('entities').includes('probe_terms'));
  assert.ok(cols('serp_snapshots').includes('signals'));
});

test('analyst probes get most of the probe budget; related-search probes split the rest', async () => {
  const { allocateProbeBudget } = await import('../src/providers/serp-signals.js');
  assert.deepEqual(allocateProbeBudget({ maxDocuments: 200, explicitCount: 1, autoCount: 3 }), { budget: 80, perExplicit: 60, perAuto: 10 });
  assert.deepEqual(allocateProbeBudget({ maxDocuments: 200, explicitCount: 1, autoCount: 0 }), { budget: 80, perExplicit: 80, perAuto: 0 });
  assert.deepEqual(allocateProbeBudget({ maxDocuments: 200, explicitCount: 0, autoCount: 4 }), { budget: 80, perExplicit: 0, perAuto: 20 });
  const large = allocateProbeBudget({ maxDocuments: 4000, explicitCount: 1, autoCount: 3 });
  assert.ok(large.perExplicit > large.perAuto * 3, 'a named subject is never crowded out by discovery probes');
});
