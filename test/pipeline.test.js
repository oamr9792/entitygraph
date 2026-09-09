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
