import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_READABLE_CHARS, windowsForRank, needsFullRead, surnameAnchor, describeRead, rejectionReason, traceStage,
} from '../src/services/serp-coverage.js';
import { buildWindows } from '../src/services/extraction.js';

/**
 * Google's own result pages for the client's name are the pages people actually
 * read. These pin the rules that make sure they are read properly, and that
 * explain where each one went when it is missing from the evidence.
 */

test('Google result pages get more passages read, the top twenty most of all', () => {
  assert.equal(windowsForRank(1), 8);
  assert.equal(windowsForRank(20), 8);
  assert.equal(windowsForRank(45), 5);
  assert.equal(windowsForRank(null), 3, 'pages not on Google keep the default');
  assert.equal(windowsForRank(250), 3);
  assert.equal(windowsForRank(5, 10), 10, 'never fewer than the configured default');
});

test('a Google result counts as unread until real page text has been stored', () => {
  for (const status of ['snippet_only', 'blocked', 'failed', 'skipped']) {
    assert.equal(needsFullRead({ fetch_status: status, body_chars: 50000 }), true, status);
  }
  assert.equal(needsFullRead({ fetch_status: 'fetched', body_chars: 142 }), true, 'a cookie wall is not a read');
  assert.equal(needsFullRead({ fetch_status: 'fetched', body_chars: MIN_READABLE_CHARS }), false);
  assert.match(describeRead({ fetch_status: 'fetched', body_chars: 142 }), /short page/);
  assert.match(describeRead({ fetch_status: 'blocked' }), /description only/);
});

test('the surname anchor is for people, ignores suffixes, and skips short names', () => {
  assert.equal(surnameAnchor({ entity_type: 'person', canonical_name: 'Jay Lefkowitz' }), 'Lefkowitz');
  assert.equal(surnameAnchor({ entity_type: 'person', canonical_name: 'Martin Luther King Jr.' }), 'King');
  assert.equal(surnameAnchor({ entity_type: 'person', canonical_name: 'Wei Li' }), null, 'too short to anchor safely');
  assert.equal(surnameAnchor({ entity_type: 'organization', canonical_name: 'Harbour Capital' }), null);
  assert.equal(surnameAnchor({ entity_type: 'person', canonical_name: 'Madonna' }), null);
});

test('a page that names someone once and uses the surname after is read beyond the first mention', () => {
  const filler = 'The court heard arguments on procedure and the record for most of the morning session. '.repeat(30);
  const text = `Jay Lefkowitz is a partner at the firm. ${filler} Lefkowitz later argued before the Supreme Court on behalf of a generic drug maker.`;

  const nameOnly = buildWindows(text, ['Jay Lefkowitz'], { maxWindows: 8 });
  assert.equal(nameOnly.length, 1);
  assert.ok(!nameOnly.some((w) => w.text.includes('Supreme Court')), 'the full-name window never reaches the later passage');

  const anchored = buildWindows(text, ['Jay Lefkowitz'], { maxWindows: 8, secondary: ['Lefkowitz'] });
  assert.equal(anchored.length, 2);
  assert.ok(anchored.some((w) => w.text.includes('Supreme Court')));
  assert.ok(anchored[0].offset < anchored[1].offset, 'windows stay in document order');

  assert.deepEqual(buildWindows('Lefkowitz argued.', ['Jay Lefkowitz'], { secondary: ['Lefkowitz'] }), [],
    'a page that never names the client in full is not read on the surname alone');
  assert.equal(buildWindows(text, ['Jay Lefkowitz'], { maxWindows: 1, secondary: ['Lefkowitz'] }).length, 1,
    'the window budget still holds');
});

test('every lost Google result is explained by the step that lost it', () => {
  assert.equal(traceStage({}).stage, 'not_collected');
  assert.equal(traceStage({ doc: { id: 1 } }).stage, 'not_checked');
  assert.equal(traceStage({ doc: { id: 1 }, match: { verdict: 'review' } }).stage, 'in_review');

  const unread = traceStage({ doc: { id: 1, fetch_status: 'blocked' }, match: { verdict: 'accept' }, evidence: { rows: 0, heuristic: 0 } });
  assert.equal(unread.stage, 'not_read');
  assert.match(unread.text, /blocked/);

  assert.equal(traceStage({ doc: { id: 1, fetch_status: 'fetched', body_chars: 9000 }, match: { verdict: 'accept' }, evidence: { rows: 0 } }).stage, 'no_evidence');
  assert.equal(traceStage({ doc: { id: 1, fetch_status: 'fetched', body_chars: 9000 }, match: { verdict: 'accept' }, evidence: { rows: 4, heuristic: 4 } }).stage, 'fallback_only');
  assert.equal(traceStage({ doc: { id: 1, fetch_status: 'fetched', body_chars: 9000 }, match: { verdict: 'accept' }, evidence: { rows: 4, heuristic: 1 } }).stage, 'evidence');
});

test('a rejection says why, in words', () => {
  assert.match(rejectionReason({ reasons: JSON.stringify([{ kind: 'llm', value: 'This Jay Lefkowitz works at Hilton.' }]) }), /Hilton/);
  assert.match(rejectionReason({ reasons: [{ kind: 'name', value: 'no alias occurs in the retrieved text' }] }), /never names the client/);
  assert.match(rejectionReason({ entity_confidence: 0.383, reasons: [{ kind: 'name', value: 'Jay Lefkowitz' }] }), /0\.38/);
});
