import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { METRICS, BANDS, BAND_ORDER, DISCLAIMERS, NOTICES, AUDIT_CHECKS, AUDIT_CHECK_ORDER } from '../src/copy/metrics.js';
import { MODEL, SCORE_DISCLAIMER } from '../src/config.js';
import { bandFor } from '../src/services/scoring.js';

/**
 * §89 — the copy registry is complete, not aspirational.
 *
 * These tests read the screen code itself. A metric rendered without a
 * registry entry, a raw abbreviation typed into a template, or a definition
 * written somewhere other than the registry fails the build.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function screenFiles() {
  const views = fs.readdirSync(path.join(ROOT, 'public', 'views')).map((f) => path.join('public', 'views', f));
  const lib = fs.readdirSync(path.join(ROOT, 'public', 'lib')).map((f) => path.join('public', 'lib', f));
  return ['public/app.js', ...views, ...lib].filter((f) => f.endsWith('.js'));
}

const source = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Comments are where abbreviations and section numbers legitimately live.
// Strings containing "://" are protected from the line-comment strip.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

const oneSentence = (text) => {
  const trimmed = String(text ?? '').trim();
  if (!/[.!?]$/.test(trimmed)) return false;
  return (trimmed.match(/[.!?](\s|$)/g) ?? []).length === 1;
};

test('§89 every registry entry is complete and fits a two-sentence tooltip', () => {
  const keys = Object.keys(METRICS);
  assert.ok(keys.length >= 25, 'the registry covers the metrics the screens actually show');
  for (const key of keys) {
    const entry = METRICS[key];
    for (const field of ['plain', 'advanced', 'what', 'look']) {
      assert.equal(typeof entry[field], 'string', `${key}.${field} must be a string`);
      assert.ok(entry[field].trim(), `${key}.${field} must not be empty`);
    }
    assert.ok(oneSentence(entry.what), `${key}.what must be exactly one sentence: "${entry.what}"`);
    assert.ok(oneSentence(entry.look), `${key}.look must be exactly one sentence: "${entry.look}"`);
  }
});

test('§89 registry identifiers are the ones MODEL uses', () => {
  for (const [key, entry] of Object.entries(METRICS)) {
    if (entry.model === undefined) continue;
    assert.ok(entry.model in MODEL, `${key}.model names "${entry.model}", which is not a key of MODEL`);
  }
});

test('§97 no plain label implies a Google-internal measure', () => {
  for (const [key, entry] of Object.entries(METRICS)) {
    if (!/google/i.test(entry.plain)) continue;
    assert.doesNotMatch(
      entry.plain,
      /\b(score|rank|ranking|index|internal|knowledge graph|association)\b/i,
      `${key}.plain "${entry.plain}" reads as a measure Google computes`
    );
  }
});

test('§89 every metric a screen references has a registry entry', () => {
  const reference = /(?:metricLabel|scoreWithBasis|term|labelText|metric)\(\s*'([a-z0-9_]+)'|metric:\s*'([a-z0-9_]+)'|'data-metric':\s*'([a-z0-9_]+)'/g;
  const referenced = new Map();
  for (const file of screenFiles()) {
    const code = stripComments(source(file));
    for (const match of code.matchAll(reference)) {
      const key = match[1] ?? match[2] ?? match[3];
      if (!referenced.has(key)) referenced.set(key, file);
    }
  }
  for (const [key, file] of referenced) {
    assert.ok(key in METRICS, `${file} renders metric "${key}", which has no entry in src/copy/metrics.js`);
  }
  // Guards against the test passing vacuously because nothing uses the helpers.
  for (const required of [
    'pias', 'current_pias', 'historical_pias', 'google_retrieval_score', 'momentum',
    'current_corpus_share', 'coverage_confidence', 'entity_confidence', 'independence_weight',
  ]) {
    assert.ok(referenced.has(required), `no screen renders "${required}" through the registry`);
  }
});

test('§89 no screen types a metric abbreviation — labels come from the registry', () => {
  const abbreviation = /(['"`])(?:(?!\1)[^\\\n]|\\.)*\b(PIAS|CES|HAS|GRS|ACS)\b(?:(?!\1)[^\\\n]|\\.)*\1/g;
  const offences = [];
  for (const file of screenFiles()) {
    const code = stripComments(source(file));
    for (const match of code.matchAll(abbreviation)) offences.push(`${file}: ${match[0].slice(0, 80)}`);
  }
  assert.deepEqual(offences, [], `metric abbreviations typed into screen code:\n${offences.join('\n')}`);
});

test('§96 disclaimers are single-sourced', () => {
  assert.equal(SCORE_DISCLAIMER, DISCLAIMERS.external_estimate, 'config re-exports the registry wording');
  const offences = [];
  for (const file of screenFiles()) {
    const code = stripComments(source(file));
    if (/This is an external estimate of entity-association strength/.test(code)) offences.push(file);
    if (/Bands compare associations within/.test(code)) offences.push(file);
  }
  assert.deepEqual(offences, [], 'a disclaimer was typed into a screen instead of read from the registry');
  for (const key of ['external_estimate', 'source_reliability', 'query_behavior', 'bands', 'simulation']) {
    assert.ok(DISCLAIMERS[key], `DISCLAIMERS.${key} is required by §96`);
  }
});

test('§95 bands have thresholds in MODEL and copy in the registry', () => {
  assert.deepEqual(Object.keys(BANDS).sort(), [...BAND_ORDER].sort());
  assert.ok(MODEL.bands.dominant > MODEL.bands.strong && MODEL.bands.strong > MODEL.bands.present);
  assert.equal(bandFor(100), 'dominant');
  assert.equal(bandFor(MODEL.bands.dominant), 'dominant');
  assert.equal(bandFor(MODEL.bands.dominant - 0.1), 'strong');
  assert.equal(bandFor(MODEL.bands.present - 0.1), 'marginal');
  assert.equal(bandFor(null), null);
});

test('§95 any screen that shows a band also shows the band note', () => {
  for (const file of screenFiles()) {
    if (file.endsWith('metrics-ui.js')) continue;
    const code = stripComments(source(file));
    if (code.includes('bandChip(')) {
      assert.ok(code.includes('bandNote('), `${file} shows bands without the within-client note`);
    }
  }
});

test('§94 the momentum floor is tunable in MODEL and every notice renders', () => {
  assert.ok(Number.isInteger(MODEL.momentum.minDocuments) && MODEL.momentum.minDocuments > 0);
  assert.match(NOTICES.low_coverage({ documents: 143 }), /143 documents/);
  assert.match(NOTICES.dates_inferred({ inferred: 12, total: 40 }), /12 of 40/);
  assert.match(NOTICES.heuristic_rows({ heuristic: 3, total: 9 }), /3 of 9/);
  for (const key of ['momentum_floor', 'no_llm_key', 'no_google']) assert.ok(NOTICES[key]().length > 10);
});

test('§101 every audit check has a plain name, one sentence on what it measures, and one line on what to do', () => {
  assert.deepEqual(AUDIT_CHECK_ORDER, Array.from({ length: 15 }, (_, i) => `C${i + 1}`));
  for (const id of AUDIT_CHECK_ORDER) {
    const check = AUDIT_CHECKS[id];
    assert.ok(check.name && check.what && check.act, `${id} is complete`);
    assert.ok(oneSentence(check.what), `${id}.what must be exactly one sentence`);
    assert.doesNotMatch(`${check.name} ${check.what} ${check.act}`, /\b(PIAS|CES|HAS|GRS|ACS)\b/, `${id} uses plain words`);
  }
  for (const id of [...MODEL.audit.blockingChecks, ...MODEL.audit.unsignable, ...MODEL.audit.approvalOnly]) {
    assert.ok(AUDIT_CHECKS[id], `MODEL.audit names ${id}, which the registry defines`);
  }
});
