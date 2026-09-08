import { run, get, all } from '../src/db.js';
import { createEntity, identityProfile } from '../src/services/identity.js';
import { runPipeline } from '../src/jobs/pipeline.js';
import { leaderboard } from '../src/services/metrics.js';
import { coverageConfidence } from '../src/services/coverage.js';
import { entityState, narrative, gaps, compareAssociations, oldVsCurrent } from '../src/services/insights.js';
import { classifySnapshot, retrievalOverlay, retrievalGap } from '../src/services/serp.js';
import { canonicaliseUrl, rootDomain } from '../src/util/hash.js';

/**
 * A synthetic end-to-end run. No API keys, no spend, no network.
 *
 * The corpus below is built to exercise the parts of the model that are easy
 * to get wrong and hard to see: a press release syndicated across four
 * domains, three separate articles on one domain, a stale high-volume lawsuit
 * story, a fresh low-volume philanthropy story, and three documents about a
 * different John Smith entirely. If the numbers at the end look right, those
 * five mechanisms are working.
 */

const DOMAIN_RANKS = {
  'nytimes.com': 92, 'ft.com': 88, 'bloomberg.com': 90, 'forbes.com': 78, 'reuters.com': 91,
  'artnews.com': 62, 'philanthropytoday.org': 58, 'citybusinessjournal.com': 46,
  'prwire.example': 22, 'newsaggregator.example': 18, 'financedaily.example': 20, 'bizfeed.example': 16,
  'localherald.example': 34, 'sportsdesk.example': 55, 'lawreporter.example': 51, 'johnsmith.com': 30,
};

const RELEASE_BODY =
  'John Smith, founder of ABC Capital, announced a $12 million gift to the XYZ Foundation on Tuesday. ' +
  'The donation will fund arts education programmes across New York public schools. ' +
  '"Access to the arts changed my own life," said Smith, who has served on the XYZ Foundation board since 2023.';

const DOCS = [
  // --- Current philanthropy: the story that should dominate the current state
  ['nytimes.com', '/2026/07/14/arts/smith-foundation-gift.html', 'Investor John Smith gives $12m to arts education', '2026-07-14',
    RELEASE_BODY + ' The gift is among the largest to the foundation in a decade.'],
  ['ft.com', '/content/smith-philanthropy-2026', 'ABC Capital founder steps up philanthropic giving', '2026-06-02',
    'John Smith, founder of ABC Capital, has increased his charitable giving sharply over the past year. ' +
    'The New York investor donated to the XYZ Foundation and two education charities, according to filings.'],
  ['philanthropytoday.org', '/features/smith-profile', 'Profile: the quiet philanthropy of John Smith', '2026-08-21',
    'New York investor John Smith has become one of the more active funders of arts education in the city. ' +
    'Smith, founder of ABC Capital, serves on the board of the XYZ Foundation and funds museum access programmes.'],
  ['forbes.com', '/sites/giving/2026/05/30/smith-charitable-activities', 'John Smith’s charitable activities expand', '2026-05-30',
    'The charitable activities of John Smith, the ABC Capital founder, now span three foundations. ' +
    'His charity work in New York focuses on education and contemporary art.'],
  ['bloomberg.com', '/news/articles/2026-09-01/smith-gift', 'Smith commits further funding to XYZ Foundation', '2026-09-01',
    'John Smith, founder of ABC Capital, pledged additional funding to the XYZ Foundation this week. ' +
    'The New York investor has now given more than $30 million to the foundation.'],

  // --- The same press release, syndicated. Should collapse to ~one source.
  ['prwire.example', '/releases/abc-capital-gift', 'ABC Capital founder announces $12m gift', '2026-07-14', RELEASE_BODY],
  ['newsaggregator.example', '/finance/abc-capital-gift', 'ABC Capital founder announces $12m gift', '2026-07-15', RELEASE_BODY],
  ['financedaily.example', '/wire/abc-capital-gift', 'ABC Capital founder announces $12m gift', '2026-07-15', RELEASE_BODY],
  ['bizfeed.example', '/story/abc-capital-gift', 'ABC Capital founder announces $12m gift', '2026-07-16', RELEASE_BODY],

  // --- Three separate articles on one domain: the second and third are
  //     genuinely new reporting, and should count for less than the first.
  ['citybusinessjournal.com', '/2026/abc-capital-fund-close', 'ABC Capital closes fourth fund', '2026-04-11',
    'ABC Capital, founded by John Smith, has closed its fourth fund at $600 million. The New York firm invests in early-stage software.'],
  ['citybusinessjournal.com', '/2026/smith-interview', 'Interview: John Smith on the next decade', '2026-06-18',
    'John Smith, founder of ABC Capital, discusses venture capital, philanthropy and his contemporary art collection.'],
  ['citybusinessjournal.com', '/2026/abc-capital-hires', 'ABC Capital hires three partners', '2026-08-02',
    'ABC Capital, the New York firm founded by investor John Smith, has hired three partners.'],

  // --- Contemporary art: small but current
  ['artnews.com', '/market/smith-collection-2026', 'Inside John Smith’s contemporary art collection', '2026-08-05',
    'The investor John Smith, founder of ABC Capital, has quietly assembled a significant contemporary art collection. ' +
    'Smith is a trustee of two New York museums and lends frequently.'],
  ['artnews.com', '/news/smith-museum-gift', 'Smith funds new museum wing', '2026-03-22',
    'John Smith of ABC Capital has donated to a New York museum expansion. The gift supports contemporary art acquisitions.'],

  // --- The historical lawsuit: high volume, old, and mostly stale
  ['reuters.com', '/legal/abc-capital-suit-2019', 'Investors sue ABC Capital over fund disclosures', '2019-03-11',
    'A lawsuit filed in New York accuses ABC Capital and its founder John Smith of inadequate disclosure to investors. ' +
    'The complaint against the firm seeks damages.'],
  ['nytimes.com', '/2019/04/02/business/abc-capital-lawsuit.html', 'ABC Capital faces investor lawsuit', '2019-04-02',
    'The lawsuit against ABC Capital names founder John Smith. The New York firm denies wrongdoing.'],
  ['lawreporter.example', '/cases/abc-capital-2019', 'Analysis: the ABC Capital litigation', '2019-06-30',
    'The litigation involving John Smith and ABC Capital turns on disclosure obligations. The New York court filing is detailed.'],
  ['ft.com', '/content/abc-capital-suit-dismissed', 'Court dismisses ABC Capital lawsuit', '2021-02-18',
    'A judge dismissed the lawsuit against ABC Capital and founder John Smith. The New York investor called the claims meritless.'],
  ['bloomberg.com', '/news/articles/2020-11-04/abc-capital-investigation', 'Regulators open inquiry into ABC Capital', '2020-11-04',
    'Regulators have opened an investigation into ABC Capital, the New York firm founded by John Smith.'],
  ['localherald.example', '/2019/smith-lawsuit', 'Local investor named in lawsuit', '2019-05-19',
    'John Smith, the New York investor behind ABC Capital, has been named in a lawsuit filed this spring.'],

  // --- Harvard: old, moderate
  ['forbes.com', '/sites/profiles/2018/smith-harvard', 'From Harvard to ABC Capital', '2018-09-12',
    'John Smith graduated from Harvard University before founding ABC Capital in New York.'],

  // --- A different John Smith entirely. Must be rejected.
  ['sportsdesk.example', '/match/report-2026-08-30', 'John Smith scores twice in derby win', '2026-08-30',
    'John Smith scored twice on Saturday as the visitors won 3-1. The footballer has now scored eleven times this season.'],
  ['sportsdesk.example', '/player/john-smith', 'John Smith — player profile', '2026-07-02',
    'John Smith is a midfielder. The footballer joined the club in 2024.'],
  ['localherald.example', '/obituaries/john-smith', 'Obituary: John Smith, teacher', '2025-12-01',
    'John Smith, a teacher for forty years, has died aged 88. He taught mathematics in the county for four decades.'],

  // --- The entity's own site
  ['johnsmith.com', '/about', 'About John Smith', '2026-01-15',
    'John Smith is the founder of ABC Capital, a New York venture firm, and a trustee of the XYZ Foundation.'],
];

function buildCandidates() {
  return DOCS.map(([domain, path, title, date, body]) => {
    const url = `https://${domain}${path}`;
    return {
      url,
      canonical_url: canonicaliseUrl(url),
      root_domain: rootDomain(url),
      title,
      main_title: title,
      snippet: body,
      domain_rank: DOMAIN_RANKS[domain] ?? 25,
      url_rank: Math.max(5, (DOMAIN_RANKS[domain] ?? 25) - 20),
      content_quality: 85,
      prominence_raw: 1000000 - DOCS.findIndex((d) => d[1] === path) * 1000,
      sentiment_positive: /lawsuit|investigation|sue/i.test(body) ? 0.05 : 0.45,
      sentiment_negative: /lawsuit|investigation|sue/i.test(body) ? 0.8 : 0.08,
      sentiment_neutral: 0.2,
      published_at: `${date} 09:00:00 +00:00`,
      group_date: `${date} 09:00:00 +00:00`,
      provider: 'manual',
    };
  });
}

/** A synthetic first page, so the §52 overlay and §53 GRS can be demonstrated. */
const SERP = [
  [1, 'https://johnsmith.com/about', 'About John Smith — ABC Capital'],
  [2, 'https://en.wikipedia.org/wiki/John_Smith_(investor)', 'John Smith (investor) - Wikipedia'],
  [3, 'https://reuters.com/legal/abc-capital-suit-2019', 'Investors sue ABC Capital over fund disclosures'],
  [4, 'https://www.linkedin.com/in/johnsmith', 'John Smith - Founder, ABC Capital | LinkedIn'],
  [5, 'https://nytimes.com/2019/04/02/business/abc-capital-lawsuit.html', 'ABC Capital faces investor lawsuit'],
  [6, 'https://citybusinessjournal.com/2026/abc-capital-fund-close', 'ABC Capital closes fourth fund'],
  [7, 'https://lawreporter.example/cases/abc-capital-2019', 'Analysis: the ABC Capital litigation'],
  [8, 'https://philanthropytoday.org/features/smith-profile', 'Profile: the quiet philanthropy of John Smith'],
  [9, 'https://crunchbase.com/person/john-smith', 'John Smith - ABC Capital | Crunchbase'],
  [10, 'https://artnews.com/market/smith-collection-2026', 'Inside John Smith’s contemporary art collection'],
];

function seedSerp(entityId) {
  const res = run(
    `INSERT INTO serp_snapshots (entity_id, query, query_kind, depth, item_types) VALUES (?, 'John Smith', 'entity', 100, '["organic"]')`,
    entityId
  );
  const snapshotId = Number(res.lastInsertRowid);
  for (const [rank, url, title] of SERP) {
    const canonical = canonicaliseUrl(url);
    const doc = get(`SELECT id FROM documents WHERE canonical_url = ? OR url = ?`, canonical, url);
    run(
      `INSERT INTO serp_results (snapshot_id, rank, url, root_domain, title, document_id) VALUES (?, ?, ?, ?, ?, ?)`,
      snapshotId,
      rank,
      url,
      rootDomain(url),
      title,
      doc?.id ?? null
    );
  }
  return snapshotId;
}

// --- Output helpers ---------------------------------------------------------

const pad = (v, n) => String(v ?? '').padEnd(n);
const padStart = (v, n) => String(v ?? '').padStart(n);
const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
const rule = (n = 108) => console.log('─'.repeat(n));

async function main() {
  const existing = get(`SELECT id FROM entities WHERE canonical_name = 'John Smith' AND deleted_at IS NULL`);
  if (existing) {
    console.log(`Removing previous demo entity #${existing.id}…`);
    run(`DELETE FROM entities WHERE id = ?`, existing.id);
  }

  const entityId = createEntity({
    canonical_name: 'John Smith',
    entity_type: 'person',
    aliases: ['John A. Smith'],
    identity_markers: {
      organizations: ['ABC Capital'],
      locations: ['New York'],
      occupations: ['investor', 'founder'],
      educations: ['Harvard University'],
    },
    known_urls: ['https://johnsmith.com'],
    negative_markers: ['footballer', 'midfielder'],
  });

  console.log(`\nEntity #${entityId} — John Smith, founder of ABC Capital, New York\n`);

  await runPipeline({
    entityId,
    jobId: null,
    options: {
      providers: ['manual'],
      aliases: ['John Smith'],
      urls: buildCandidates(),
      skip: ['fetch_evidence_windows', 'run_serp_queries'],
    },
    report: async (step, status, detail) => {
      if (status === 'done') console.log(`  ✓ ${pad(step, 30)} ${detail ?? ''}`);
      else if (status === 'skipped') console.log(`  – ${pad(step, 30)} skipped`);
    },
  });

  // The SERP layer, seeded rather than fetched.
  const snapshotId = seedSerp(entityId);
  const classified = await classifySnapshot(entityId, snapshotId, { useLlm: false });
  console.log(`  ✓ ${pad('serp_overlay (seeded)', 30)} ${classified.classified} association links, ${classified.unclassified} unclassified`);

  // --- §44 ------------------------------------------------------------------
  const state = entityState(entityId);
  console.log('\n');
  rule();
  console.log(`CURRENT ENTITY STATE — ${state.entity.canonical_name.toUpperCase()}`);
  rule();
  console.log(`  Historical dominant association   ${state.historical_dominant.label} (${state.historical_dominant.score})`);
  console.log(`  Current dominant association      ${state.current_dominant.label} (${state.current_dominant.score})`);
  console.log(`  Fastest-growing association       ${state.fastest_growing?.label ?? '—'} ${state.fastest_growing?.change ?? ''} ${state.fastest_growing?.arrow ?? ''}`);
  console.log(`  Most recent major association     ${state.most_recent?.label ?? '—'} (${state.most_recent?.age ?? '—'} ago)`);
  console.log(`  Current-state change              ${state.state_change ? `${state.state_change.points} points` : 'no prior snapshot yet'}`);

  // --- §45 ------------------------------------------------------------------
  const board = leaderboard(entityId);
  console.log('\n');
  rule();
  console.log('ASSOCIATION LEADERBOARD');
  rule();
  console.log(
    `  ${pad('Association', 22)}${padStart('PIAS', 5)}${padStart('Curr', 6)}${padStart('Hist', 6)}${padStart('Docs', 6)}${padStart('Dom', 5)}${padStart('Ind', 6)}${padStart('Share', 7)}${padStart('CurShr', 8)}${padStart('MedAge', 9)}  ${pad('Mom', 4)}${pad('Sentiment', 14)}${padStart('GRS', 5)}`
  );
  rule();
  for (const a of board.associations.slice(0, 14)) {
    console.log(
      `  ${pad(a.label, 22)}${padStart(a.pias, 5)}${padStart(a.current_pias, 6)}${padStart(a.historical_pias, 6)}${padStart(a.documents, 6)}${padStart(a.domains, 5)}${padStart(a.independent_sources, 6)}${padStart(pct(a.corpus_share), 7)}${padStart(pct(a.current_corpus_share), 8)}${padStart(a.freshness.median_age ?? '—', 9)}  ${pad(a.momentum.arrow, 4)}${pad(a.sentiment.label, 14)}${padStart(a.google_retrieval_score ?? '—', 5)}`
    );
  }
  rule();
  console.log(`  ${board.entity_documents} accepted documents; ${board.current_entity_documents} in the current 12 months.`);

  // --- §21/§22 --------------------------------------------------------------
  const clusters = all(
    `SELECT c.id, c.kind, c.member_count, d.root_domain AS primary_domain
       FROM document_duplicate_clusters c JOIN documents d ON d.id = c.primary_document_id`
  );
  console.log('\n');
  rule();
  console.log('DUPLICATE / SYNDICATION HANDLING (§21, §22)');
  rule();
  for (const c of clusters) {
    const members = all(
      `SELECT d.root_domain, d.is_cluster_primary, s.independence_weight
         FROM documents d LEFT JOIN association_document_scores s ON s.document_id = d.id
        WHERE d.duplicate_cluster_id = ? GROUP BY d.id`,
      c.id
    );
    console.log(`  cluster #${c.id} (${c.kind}, ${c.member_count} members, original: ${c.primary_domain})`);
    for (const m of members) {
      console.log(`      ${pad(m.root_domain, 30)} ${m.is_cluster_primary ? 'original ' : 'duplicate'}  independence weight ${m.independence_weight ?? '—'}`);
    }
  }
  const cbj = all(
    `SELECT d.url, s.independence_weight FROM documents d
       JOIN association_document_scores s ON s.document_id = d.id
       JOIN associations a ON a.id = s.association_id
      WHERE d.root_domain = 'citybusinessjournal.com' AND a.canonical_label = 'ABC Capital'`
  );
  if (cbj.length) {
    console.log('\n  Three separate articles on one domain (ABC Capital):');
    for (const r of cbj) console.log(`      ${pad(r.url.replace('https://citybusinessjournal.com', ''), 30)} independence weight ${r.independence_weight}`);
  }

  // --- §8 -------------------------------------------------------------------
  const rejected = all(
    `SELECT d.root_domain, d.title, m.entity_confidence, m.verdict
       FROM entity_document_matches m JOIN documents d ON d.id = m.document_id
      WHERE m.entity_id = ? AND m.verdict != 'accept' ORDER BY m.entity_confidence DESC`,
    entityId
  );
  console.log('\n');
  rule();
  console.log('ENTITY DISAMBIGUATION — documents not counted (§8)');
  rule();
  for (const r of rejected) {
    console.log(`  ${padStart(r.entity_confidence, 6)}  ${pad(r.verdict, 8)}  ${pad(r.root_domain, 24)} ${r.title}`);
  }

  // --- §50 ------------------------------------------------------------------
  const split = oldVsCurrent(entityId, { cutoff: '2024-01-01' });
  console.log('\n');
  rule();
  console.log('OLD VS CURRENT (cutoff 1 January 2024) — §50');
  rule();
  console.log(`  ${pad('HISTORICAL', 40)}CURRENT`);
  const maxRows = Math.max(split.historical.length, split.current.length);
  for (let i = 0; i < Math.min(maxRows, 6); i += 1) {
    const h = split.historical[i];
    const c = split.current[i];
    console.log(`  ${pad(h ? `${h.label} ${h.score}` : '', 40)}${c ? `${c.label} ${c.score}` : ''}`);
  }

  // --- §51 ------------------------------------------------------------------
  const lawsuit = board.associations.find((a) => /lawsuit/i.test(a.label));
  const philanthropy = board.associations.find((a) => /philanthropy/i.test(a.label));
  if (lawsuit && philanthropy) {
    const comparison = compareAssociations(entityId, [lawsuit.association_id, philanthropy.association_id]);
    console.log('\n');
    rule();
    console.log(`ASSOCIATION COMPETITION — ${comparison.associations.map((a) => a.label).join(' vs ')} (§51)`);
    rule();
    for (const row of comparison.rows) {
      console.log(`  ${pad(row.metric, 32)}${row.values.map((v) => padStart(v, 18)).join('')}`);
    }
  }

  // --- §52/§53 --------------------------------------------------------------
  const overlay = retrievalOverlay(entityId);
  console.log('\n');
  rule();
  console.log('GOOGLE SERP OVERLAY (§52) AND RETRIEVAL SCORE (§53)');
  rule();
  for (const r of overlay.results.slice(0, 10)) {
    console.log(`  #${padStart(r.rank, 2)}  w=${r.rank_weight.toFixed(2)}  ${pad(r.root_domain, 26)} ${r.associations.map((a) => a.label).join(', ') || '(unclassified)'}`);
  }
  console.log(`\n  Google Retrieval Score (share of classified first-page weight):`);
  for (const s of overlay.scores) console.log(`      ${pad(s.label, 24)} ${padStart(s.google_retrieval_score, 5)}`);
  console.log(`  Unclassified first-page weight: ${pct(overlay.unclassified_share)}`);

  const gap = retrievalGap(entityId, board.associations);
  console.log('\n  Corpus vs Google (§77):');
  console.log(`  ${pad('Association', 24)}${padStart('CurrPIAS', 10)}${padStart('HistPIAS', 10)}${padStart('CurrMass', 10)}${padStart('Google', 8)}${padStart('Gap', 8)}`);
  for (const r of gap.rows.slice(0, 6)) {
    console.log(`  ${pad(r.label, 24)}${padStart(r.current_pias, 10)}${padStart(r.historical_pias, 10)}${padStart(`${r.current_association_share_pct}%`, 10)}${padStart(r.google_retrieval_score, 8)}${padStart(r.gap > 0 ? `+${r.gap}` : r.gap, 8)}`);
  }

  // --- §70 / §75 ------------------------------------------------------------
  const coverage = coverageConfidence(entityId);
  console.log('\n');
  rule();
  console.log(`COVERAGE CONFIDENCE — ${coverage.level} (§70)`);
  rule();
  for (const c of coverage.criteria) {
    console.log(`  ${c.met ? '●' : c.partial ? '◐' : '○'} ${pad(c.key, 22)} ${c.detail}`);
  }
  for (const w of coverage.warnings) console.log(`  ! ${w}`);

  const story = narrative(entityId, { coverage });
  console.log('\n');
  rule();
  console.log('WRITTEN SUMMARY (§75)');
  rule();
  console.log(story.text.split('\n\n').map((s) => `  ${s}`).join('\n\n'));

  const priorities = gaps(entityId).priorities;
  console.log('\n');
  rule();
  console.log('CAMPAIGN PRIORITIES (§60)');
  rule();
  for (const [bucket, rows] of Object.entries(priorities)) {
    if (!rows.length) continue;
    console.log(`  ${bucket.toUpperCase()}: ${rows.map((r) => r.label).join(', ')}`);
  }
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
