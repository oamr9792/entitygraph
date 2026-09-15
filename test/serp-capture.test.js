import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * One capture of Google's page per build, and one definition of a position.
 *
 * A build used to request the page three times and to rank documents by a tag
 * written when each document was first created — which could come from another
 * day's page or another query — while the overlay ranked the same URLs by
 * absolute on-page position. These run a real build against a results page
 * with SERP features between the organic results, and a document left over from
 * an earlier capture, and check that every consumer sees the same positions.
 *
 * No network. The results page is placed in the provider cache under the exact
 * key the build asks for, with dummy credentials, so a second request — or a
 * request for a different page — shows up in the usage ledger, not on a bill.
 */

const DB_PATH = path.join('data', `test-serp-capture-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.PAGE_FETCH_ENABLED = 'false';
process.env.LLM_PROVIDER = 'heuristic';
process.env.DATAFORSEO_LOGIN = 'test-login';
process.env.DATAFORSEO_PASSWORD = 'test-password';

const { createEntity } = await import('../src/services/identity.js');
const { runPipeline } = await import('../src/jobs/pipeline.js');
const { ingestCandidates } = await import('../src/services/ingest.js');
const { normaliseCandidate } = await import('../src/providers/corpus/index.js');
const { cacheKey, cachePut } = await import('../src/providers/http-client.js');
const dfs = await import('../src/providers/dataforseo.js');
const { retrievalOverlay, renumberLegacySerpRanks } = await import('../src/services/serp.js');
const { all, get, run, db } = await import('../src/db.js');

test.after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = DB_PATH + suffix;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

// --- The page -----------------------------------------------------------------

const NAME = 'John Smith';
const ORGANIC = [
  ['abccapital.example', '/team/john-smith', 'John Smith — Founder | ABC Capital', 'John Smith, founder of ABC Capital, is a New York investor.'],
  ['nytimes.com', '/2026/smith-gift', 'John Smith gives $12m to the XYZ Foundation', 'John Smith, founder of ABC Capital, announced a gift to the XYZ Foundation.'],
  ['stale.example', '/profile', 'John Smith profile', 'New York investor John Smith founded ABC Capital.'],
  ['ft.com', '/smith-philanthropy', 'Smith philanthropy grows', 'John Smith, the New York investor behind ABC Capital, has increased his giving.'],
  ['philanthropytoday.org', '/profile-smith', 'Profile: John Smith', 'New York investor John Smith, founder of ABC Capital, funds arts education.'],
  ['bloomberg.com', '/smith-abc', 'ABC Capital founder John Smith', 'John Smith founded ABC Capital, a New York investment firm.'],
  ['wsj.com', '/abc-capital', 'Inside ABC Capital', 'ABC Capital, led by founder John Smith, is based in New York.'],
  ['forbes.com', '/john-smith', 'John Smith', 'John Smith is an investor and the founder of ABC Capital in New York.'],
  ['crunchbase.com', '/person/john-smith', 'John Smith - Founder @ ABC Capital', 'John Smith is the founder of ABC Capital, a New York investor.'],
  ['artsjournal.org', '/smith-gift', 'Arts funding from John Smith', 'John Smith, founder of ABC Capital, funds New York arts education.'],
  ['nypost.com', '/smith', 'Investor John Smith', 'New York investor John Smith of ABC Capital spoke on Tuesday.'],
  ['reuters.com', '/abc-capital-smith', 'ABC Capital names John Smith', 'ABC Capital founder John Smith, a New York investor, said on Monday.'],
];

// Features between the organic results, as on a real page: they take on-page
// positions, and they must not move an organic result's rank.
const FEATURE_BEFORE = new Map([[0, 'images'], [1, 'video'], [4, 'local_pack'], [7, 'video']]);

const items = [];
let absolute = 0;
ORGANIC.forEach(([domain, pathname, title, description], index) => {
  if (FEATURE_BEFORE.has(index)) items.push({ type: FEATURE_BEFORE.get(index), rank_group: 1, rank_absolute: ++absolute });
  items.push({
    type: 'organic',
    rank_group: index + 1,
    rank_absolute: ++absolute,
    domain,
    url: `https://${domain}${pathname}`,
    title,
    description,
  });
});
const ABSOLUTE = items.filter((i) => i.type === 'organic').map((i) => i.rank_absolute);

cachePut(
  cacheKey('dataforseo', { endpoint: dfs.SERP_ORGANIC_ENDPOINT, task: dfs.serpOrganicTask(NAME) }),
  'dataforseo',
  { result: [{ items }], cost: 0.01 },
  3600
);

// --- Before the build -------------------------------------------------------------

// A document created by an earlier capture that ranked it #1. It is #3 now.
ingestCandidates([normaliseCandidate({
  url: 'https://stale.example/profile',
  title: 'John Smith profile',
  snippet: 'New York investor John Smith founded ABC Capital.',
  provider: 'google_serp',
  provider_ref: 'rank:1',
}, 'google_serp')]);

// A document an earlier capture ranked #2, which is not on today's page at all.
const OFF_PAGE = 'https://oldpage.example/john-smith';
const manual = [
  { url: OFF_PAGE, title: 'John Smith of ABC Capital', snippet: 'John Smith, founder of ABC Capital, is a New York investor.', provider: 'google_serp', provider_ref: 'rank:2' },
  { url: 'https://nytimes.com/2026/smith-gift', title: 'John Smith gives $12m', snippet: 'John Smith, founder of ABC Capital, announced a gift to the XYZ Foundation.' },
  { url: 'https://localherald.example/smith', title: 'Investor John Smith', snippet: 'John Smith, the New York investor behind ABC Capital, was profiled this week.' },
];
ingestCandidates([normaliseCandidate(manual[0], 'google_serp')]);

const entityId = createEntity({
  canonical_name: NAME,
  entity_type: 'person',
  identity_markers: { organizations: ['ABC Capital'], locations: ['New York'], occupations: ['investor', 'founder'] },
});

const reports = [];
await runPipeline({
  entityId,
  jobId: null,
  options: {
    providers: ['manual'],
    aliases: [NAME],
    urls: manual.map((m) => ({ ...m, provider: 'manual' })),
    autoProbes: false,
    probeTerms: [],
    skipTrends: true,
  },
  report: async (step, status, detail) => { reports.push({ step, status, detail }); },
});

const snapshot = get(`SELECT * FROM serp_snapshots WHERE entity_id = ? AND query_kind = 'entity'`, entityId);
const results = all(`SELECT * FROM serp_results WHERE snapshot_id = ? ORDER BY rank`, snapshot?.id ?? -1);
const docByUrl = (url) => get(`SELECT * FROM documents WHERE url = ?`, url);
const reasonsFor = (documentId) =>
  JSON.parse(get(`SELECT reasons FROM entity_document_matches WHERE entity_id = ? AND document_id = ?`, entityId, documentId)?.reasons ?? '[]');

// --- Tests -------------------------------------------------------------------------

test('a build asks for Google’s page once, and nothing is billed or retried', () => {
  const calls = all(`SELECT * FROM api_usage WHERE entity_id = ? AND endpoint = ?`, entityId, dfs.SERP_ORGANIC_ENDPOINT);
  assert.equal(calls.length, 1, `expected one request for the page, saw ${calls.length}`);
  assert.equal(calls[0].cached, 1);
  assert.equal(all(`SELECT 1 FROM api_usage WHERE provider = 'dataforseo' AND ok = 0`).length, 0, 'no request reached the network');
});

test('the capture is stored once and reused for classification at the end of the build', () => {
  assert.equal(all(`SELECT id FROM serp_snapshots WHERE entity_id = ?`, entityId).length, 1);
  const step = reports.find((r) => r.step === 'run_serp_queries' && r.status === 'done');
  assert.match(step?.detail ?? '', /captured at the start of this build/);
  const links = get(
    `SELECT COUNT(*) AS n FROM serp_result_associations ra JOIN serp_results r ON r.id = ra.serp_result_id WHERE r.snapshot_id = ?`,
    snapshot.id
  ).n;
  assert.ok(links > 0, 'the reused snapshot was classified against this build’s associations');
});

test('every result is linked to its document, including documents this build created', () => {
  assert.equal(results.length, ORGANIC.length);
  assert.deepEqual(results.filter((r) => !r.document_id).map((r) => r.url), []);
  const created = docByUrl('https://abccapital.example/team/john-smith');
  assert.equal(results.find((r) => r.url === created.url).document_id, created.id);
});

test('rank is the organic position everywhere; on-page position is kept only for audit', () => {
  assert.deepEqual(results.map((r) => r.rank), ORGANIC.map((_, i) => i + 1));
  assert.deepEqual(results.map((r) => r.rank_absolute), ABSOLUTE);
  assert.notDeepEqual(ABSOLUTE, ORGANIC.map((_, i) => i + 1), 'the page really does have features between results');

  for (const r of results) {
    const doc = get(`SELECT * FROM documents WHERE id = ?`, r.document_id);
    if (doc.url !== 'https://stale.example/profile' && doc.provider === 'google_serp') {
      assert.equal(doc.provider_ref, `rank:${r.rank}`, `${doc.url} was created with this capture’s position`);
    }
    const prior = reasonsFor(doc.id).find((x) => x.kind === 'google_rank');
    assert.equal(prior?.value, `#${r.rank} on Google for the name`, `${doc.url}: the identity prior uses the snapshot position`);
  }
});

test('a stale provider tag never reaches a decision', () => {
  const stale = docByUrl('https://stale.example/profile');
  assert.equal(stale.provider_ref, 'rank:1', 'the tag from the earlier capture is left as provenance');
  assert.equal(reasonsFor(stale.id).find((x) => x.kind === 'google_rank')?.value, '#3 on Google for the name');

  const offPage = docByUrl(OFF_PAGE);
  assert.ok(get(`SELECT 1 AS y FROM entity_document_matches WHERE entity_id = ? AND document_id = ?`, entityId, offPage.id));
  assert.equal(reasonsFor(offPage.id).some((x) => x.kind === 'google_rank'), false,
    'a page ranked by an older capture, and absent from this one, gets no Google credit');
});

test('§53 weights the first ten organic results, however many features sit between them', () => {
  const overlay = retrievalOverlay(entityId);
  assert.equal(overlay.first_page_results, 10);
  const tenth = overlay.results.find((r) => r.rank === 10);
  assert.ok(tenth, 'the tenth organic result is in the overlay');
  assert.equal(tenth.rank_weight, 0.1, `organic #10 sits at on-page position ${ABSOLUTE[9]} and still counts`);
  assert.equal(overlay.results.find((r) => r.rank === 11).rank_weight, 0);
});

test('snapshots stored with on-page positions are renumbered to organic positions, once', () => {
  const legacy = Number(run(`INSERT INTO serp_snapshots (entity_id, query) VALUES (?, ?)`, entityId, NAME).lastInsertRowid);
  for (const [rank, domain] of [[6, 'c.example'], [2, 'a.example'], [9, 'd.example'], [3, 'b.example']]) {
    run(`INSERT INTO serp_results (snapshot_id, rank, url, root_domain) VALUES (?, ?, ?, ?)`, legacy, rank, `https://${domain}/`, domain);
  }

  assert.equal(renumberLegacySerpRanks(), 1, 'only the legacy snapshot needs renumbering');
  const renumbered = all(`SELECT rank, rank_absolute, root_domain FROM serp_results WHERE snapshot_id = ? ORDER BY rank`, legacy);
  assert.deepEqual(renumbered.map((r) => r.rank), [1, 2, 3, 4]);
  assert.deepEqual(renumbered.map((r) => r.rank_absolute), [2, 3, 6, 9]);
  assert.deepEqual(renumbered.map((r) => r.root_domain), ['a.example', 'b.example', 'c.example', 'd.example']);

  assert.equal(renumberLegacySerpRanks(), 0, 'running it again changes nothing');
  assert.deepEqual(all(`SELECT rank FROM serp_results WHERE snapshot_id = ? ORDER BY rank`, snapshot.id).map((r) => r.rank),
    ORGANIC.map((_, i) => i + 1), 'a snapshot already in organic positions is untouched');
});
