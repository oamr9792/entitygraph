import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FORMATS, FORMAT_ORDER, strategyFor, strengthenStrategy, avoidTermsFor, usableAliases, targetCoverage,
  verbatimOverlaps, outlineFor, unverifiedQuotes, withoutQuotes, chunkPassages, SOURCE_RELATIONS, cleanPageTitle,
  detectBylineClient, quotationStats,
} from '../src/services/content-checks.js';

/**
 * The content builder's rules. The checks a draft must pass before approval
 * now belong to the content audit (§99, test/audit-rules.test.js); these pin
 * what the builder itself decides and the text measurements the audit reuses.
 */

const route = (key) => ({ key, title: key });

test('every format is ordered, described and has an outline', () => {
  assert.deepEqual([...FORMAT_ORDER].sort(), Object.keys(FORMATS).sort());
  for (const key of FORMAT_ORDER) {
    assert.ok(FORMATS[key].label && FORMATS[key].where && FORMATS[key].length, key);
    assert.ok(outlineFor(key, { entityName: 'Jane Smith', grow: [{ label: 'Harbour Capital' }] }).length >= 3, key);
  }
});

test('the plan decides what content is recommended', () => {
  assert.equal(strategyFor({ routes: [route('challenge_accuracy'), route('displace')] }).recommended[0], 'correction_request');
  assert.equal(strategyFor({ routes: [route('displace')] }).recommended[0], 'article');
  assert.deepEqual(strategyFor({ routes: [route('retrieval_gap')] }).recommended, ['profile', 'faq']);
  assert.deepEqual(strategyFor({ routes: [route('let_it_decay')] }).recommended, ['profile', 'article']);
});

test('a possibly misattributed association blocks content until the identity is checked', () => {
  const s = strategyFor({ routes: [route('verify_identity'), route('displace')] });
  assert.equal(s.blocked, true);
  assert.equal(s.notices[0].level, 'block');
});

test('a carried association points at the association carrying it', () => {
  const s = strategyFor({ routes: [route('address_carrier')], carried_by: [{ association_id: 9, label: 'Plea Deal' }] });
  assert.equal(s.notices[0].association_id, 9);
  assert.match(s.notices[0].text, /Plea Deal/);
});

test('terms to avoid include aliases and a person’s surname, never the client’s own name', () => {
  const avoid = avoidTermsFor({
    label: 'Jeffrey Epstein', kind: 'named_entity', category: 'person', aliases: ['Epstein', 'J. Epstein'], entityName: 'Jay Lefkowitz', carriers: ['Epstein Plea Deal'],
  });
  const terms = avoid.map((a) => a.term.toLowerCase());
  assert.ok(terms.includes('jeffrey epstein'));
  assert.ok(terms.includes('epstein'));
  assert.equal(avoid.find((a) => a.term === 'Epstein Plea Deal').severity, 'warn');
  const shared = avoidTermsFor({ label: 'Anna Lefkowitz', kind: 'named_entity', category: 'person', entityName: 'Jay Lefkowitz' });
  assert.ok(!shared.some((a) => a.term.toLowerCase() === 'lefkowitz'), 'the client’s own surname is not banned');
});

test('extraction fragments that contain the client’s name are not treated as names for an association', () => {
  const kept = usableAliases(
    ['Epstein', 'Epstein’s attorney Jay Lefkowitz', 'defence lawyer, Jay Lefkowitz', 'Epstein assembled a team of prominent criminal defense attorneys'],
    { entityName: 'Jay Lefkowitz', label: 'Jeffrey Epstein' }
  );
  assert.deepEqual(kept, ['Epstein']);
  assert.deepEqual(usableAliases(['Anna Lefkowitz'], { entityName: 'Jay Lefkowitz', label: 'Anna R. Lefkowitz' }), ['Anna Lefkowitz']);
});

test('a positive association is strengthened, not displaced', () => {
  const s = strengthenStrategy({ association: { label: 'Columbia Law School' }, routes: [route('displace')] });
  assert.equal(s.reasons[0].route, 'strengthen');
  assert.ok(!s.recommended.includes('correction_request'));
  assert.equal(strengthenStrategy({ association: { label: 'x' }, routes: [route('verify_identity')] }).blocked, true);
});

const facts = [
  { id: 'F1', source: 'evidence', passage: 'Jay Lefkowitz is a partner at Kirkland and Ellis where he leads the firm’s appellate and constitutional litigation practice in New York.' },
  { id: 'P1', source: 'identity', passage: 'Jay Lefkowitz: organization — Kirkland & Ellis' },
];
const target = { association_id: 1, label: 'Columbia Law School', terms: ['Columbia Law'] };
const names = ['Jay Lefkowitz', 'Lefkowitz'];

test('copying a publisher’s run of words is detected, but not from the client’s own profile', () => {
  const copied = 'Lefkowitz is a partner at Kirkland and Ellis where he leads the firm’s appellate and constitutional litigation practice.';
  assert.equal(verbatimOverlaps(copied, facts).length, 1);
  assert.equal(verbatimOverlaps(copied, facts.filter((f) => f.source === 'identity')).length, 0);
});

test('target coverage reads a draft the way the scoring reads a page', () => {
  const [strong] = targetCoverage({
    title: 'Jay Lefkowitz on teaching at Columbia Law School',
    body: 'Jay Lefkowitz is an adjunct professor at Columbia Law School.\n\nHis seminar at Columbia Law covers appellate practice.',
  }, [target], { names, cap: 3 });
  assert.equal(strong.mentions, 3);
  assert.equal(strong.counted, 3);
  assert.equal(strong.beside_name, true);
  assert.equal(strong.in_title, true);
  assert.equal(strong.in_opening, true);

  const [weak] = targetCoverage({ title: 'A career in law', body: 'He has had a long career.\n\nSeparately, Columbia Law School runs an appellate clinic.' }, [target], { names, cap: 3 });
  assert.equal(weak.beside_name, false);
  assert.equal(weak.in_opening, false);
});

test('only the first association ticked is the main one', () => {
  const targets = [{ association_id: 1, label: 'Columbia Law School', terms: [] }, { association_id: 2, label: 'Kirkland & Ellis', terms: [] }];
  const coverage = targetCoverage({ title: 'Jay Lefkowitz at Columbia Law School', body: 'Later, Jay Lefkowitz became a partner at Kirkland & Ellis.' }, targets, { names });
  assert.deepEqual(coverage.map((t) => t.primary), [true, false]);
});

// --- Analysis of a page ------------------------------------------------------

const release = [
  { id: 'S1', source: 'page', passage: 'Harbour Capital today announced that Jane Smith will lead its new infrastructure fund. “This fund reflects twenty years of work in public-private partnerships,” said Jane Smith.' },
];

test('an analysis is a recommended format whenever content can displace or strengthen', () => {
  assert.equal(FORMATS.source_analysis.requiresSource, true);
  assert.ok(strategyFor({ routes: [route('displace')] }).recommended.includes('source_analysis'));
  assert.ok(strengthenStrategy({ association: { label: 'x' }, routes: [] }).recommended.includes('source_analysis'));
  assert.ok(outlineFor('source_analysis', { entityName: 'Jane Smith', grow: [{ label: 'Harbour Capital' }] }).some((o) => /original/.test(o)));
});

test('a quotation copied exactly from the page passes; an invented or altered one is caught', () => {
  assert.deepEqual(unverifiedQuotes('Smith said the fund “reflects twenty years of work in public-private partnerships.”', release), []);
  assert.deepEqual(unverifiedQuotes('“This fund reflects twenty years … in public-private partnerships,” she said.', release), []);
  assert.equal(unverifiedQuotes('“This fund is the best in the country,” said Jane Smith.', release).length, 1);
  assert.equal(unverifiedQuotes('“We are thrilled to lead this,” said Jane Smith [CONFIRM: quote approved by the client].', release).length, 0);
  assert.equal(unverifiedQuotes('She calls it a “new chapter”.', release).length, 0);
});

test('quoting the page is not copying it; reusing its sentences unquoted is', () => {
  const quoted = 'Jane Smith said “This fund reflects twenty years of work in public-private partnerships.”';
  assert.equal(verbatimOverlaps(withoutQuotes(quoted), release).length, 0);
  const lifted = 'Harbour Capital today announced that Jane Smith will lead its new infrastructure fund, a notable step.';
  assert.equal(verbatimOverlaps(withoutQuotes(lifted), release)[0].fact_id, 'S1');
});

test('quotation share and length are measured in words', () => {
  const quote = 'This fund reflects twenty years of work in public-private partnerships';
  const heavy = quotationStats(`Jane Smith said “${quote},” and repeated “${quote}.” She leads it.`);
  assert.ok(heavy.share > 0.25);
  assert.equal(quotationStats(`“${'word '.repeat(60).trim()}”`).longest, 60);
});

test('a page is split into citable passages without cutting sentences', () => {
  const para = (n) => `Paragraph ${n} explains one part of the announcement in some detail, with enough words to count.`;
  const text = [para(1), para(2), 'Home', para(3), `${'A long sentence about the fund and its goals. '.repeat(30)}`].join('\n\n');
  const chunks = chunkPassages(text, { maxChars: 300 });
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.length <= 600));
  assert.ok(chunks.every((c) => /[.!?]$/.test(c.trim())));
  assert.equal(chunkPassages(text, { maxChars: 300, maxChunks: 2 }).length, 2);
  assert.deepEqual(chunkPassages(''), []);
});

test('a rewrite weaves the associations into one story instead of a section for each', () => {
  const grow = ['Kirkland & Ellis', 'New York', 'Litigation', 'White House', 'George W. Bush'].map((label) => ({ label }));
  for (const relation of Object.keys(SOURCE_RELATIONS)) {
    const outline = outlineFor('source_analysis', { entityName: 'Jay Lefkowitz', grow, relation });
    assert.ok(outline.length <= 7, relation);
    assert.ok(!outline.some((o) => /^Context:/.test(o)), relation);
    assert.ok(outline[0].includes('Kirkland & Ellis'), relation);
  }
  assert.ok(outlineFor('source_analysis', { entityName: 'Jay Lefkowitz', grow, relation: 'by' }).some((o) => /argues/.test(o)));
  assert.ok(outlineFor('source_analysis', { entityName: 'Jay Lefkowitz', grow, relation: 'about' }).some((o) => /credited by name to the original/.test(o)));
});

test('the original article’s title and byline are read sensibly', () => {
  assert.equal(cleanPageTitle('One moment, please...', 'Jay Lefkowitz: My Jewish Journey\nMore text follows here.'), 'Jay Lefkowitz: My Jewish Journey');
  assert.equal(cleanPageTitle('Just a moment...', ''), null);
  assert.equal(cleanPageTitle('Why school choice matters | WSJ', ''), 'Why school choice matters | WSJ');
  const clientNames = ['Jay Lefkowitz', 'Jay P. Lefkowitz'];
  assert.equal(detectBylineClient({ html: '<meta name="author" content="Jay P. Lefkowitz">', names: clientNames }), true);
  assert.equal(detectBylineClient({ text: 'Why school choice matters\nBy Jay Lefkowitz\nMarch 3, 2024\nThe case for choice.', names: clientNames }), true);
  assert.equal(detectBylineClient({ text: 'The firm, represented by Jay Lefkowitz, won the appeal.', names: clientNames }), false);
  assert.equal(detectBylineClient({ text: 'By Jane Doe\nJay Lefkowitz spoke at the event.', names: clientNames }), false);
});
