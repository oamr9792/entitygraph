import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * §98–§101 — the content audit against a real corpus. A small built corpus,
 * the fallback extractor and no network: the checks that need an LLM or a
 * host's home page must say they could not judge, not pass.
 */

const DB_PATH = path.join('data', `test-audit-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;
process.env.PAGE_FETCH_ENABLED = 'false';
process.env.LLM_PROVIDER = 'heuristic';

const { createEntity } = await import('../src/services/identity.js');
const { runPipeline } = await import('../src/jobs/pipeline.js');
const { coverageConfidence } = await import('../src/services/coverage.js');
const { all, get, run, db } = await import('../src/db.js');
const { canonicaliseUrl, rootDomain } = await import('../src/util/hash.js');
const { MODEL } = await import('../src/config.js');
const { createAuditDraft, runAudit, signOff, getAudit } = await import('../src/services/audit.js');
const { setPolarity } = await import('../src/services/audit-facts.js');

const RELEASE = 'John Smith, founder of ABC Capital, announced a $12 million gift to the XYZ Foundation on Tuesday. The donation funds arts education across New York schools.';
const DOCS = [
  ['nytimes.com', '/a', 'Smith gives $12m', '2026-07-14', RELEASE],
  ['ft.com', '/b', 'Smith philanthropy grows', '2026-06-02', 'John Smith, founder of ABC Capital, has increased his charitable giving. The New York investor donated to the XYZ Foundation.'],
  ['philanthropytoday.org', '/c', 'Profile: Smith', '2026-08-21', 'New York investor John Smith, founder of ABC Capital, funds arts education and serves on the XYZ Foundation board.'],
  ['prwire.example', '/d', 'Smith gives $12m', '2026-07-14', RELEASE],
  ['reuters.com', '/h', 'Investors sue ABC Capital', '2019-03-11', 'A lawsuit filed in New York accuses ABC Capital and its founder John Smith of inadequate disclosure.'],
  ['nytimes.com', '/i', 'ABC Capital faces lawsuit', '2019-04-02', 'The lawsuit against ABC Capital names founder John Smith. The New York firm denies wrongdoing.'],
  ['lawreporter.example', '/j', 'The ABC Capital litigation', '2019-06-30', 'The litigation involving John Smith and ABC Capital turns on disclosure. The New York filing is detailed.'],
  ['ft.com', '/k', 'Lawsuit dismissed', '2021-02-18', 'A judge dismissed the lawsuit against ABC Capital and founder John Smith. The New York investor called it meritless.'],
  ['localherald.example', '/l', 'Investor named in lawsuit', '2019-05-19', 'John Smith, the New York investor behind ABC Capital, was named in a lawsuit filed this spring.'],
];

const entityId = createEntity({
  canonical_name: 'John Smith',
  entity_type: 'person',
  identity_markers: { organizations: ['ABC Capital'], locations: ['New York'], occupations: ['investor', 'founder'] },
});
await runPipeline({
  entityId,
  jobId: null,
  options: {
    providers: ['manual'],
    aliases: ['John Smith'],
    urls: DOCS.map(([domain, pathname, title, date, body]) => {
      const url = `https://${domain}${pathname}`;
      const negative = /lawsuit|sue|litigation/i.test(body);
      return {
        url, canonical_url: canonicaliseUrl(url), root_domain: rootDomain(url), title, snippet: body,
        domain_rank: 60, url_rank: 40, published_at: `${date} 09:00:00 +00:00`, group_date: `${date} 09:00:00 +00:00`,
        sentiment_negative: negative ? 0.85 : 0.05, sentiment_positive: negative ? 0.05 : 0.5, sentiment_neutral: 0.1, provider: 'manual',
      };
    }),
    skip: ['fetch_evidence_windows', 'run_serp_queries'],
  },
  report: async () => {},
});

run(`INSERT INTO app_user (email, name, role, password_hash) VALUES ('editor@example.com', 'Ed Itor', 'analyst', 'x')`);
const user = get(`SELECT id, name, email FROM app_user WHERE email = 'editor@example.com'`);

const TEXT = `John Smith, founder of ABC Capital, has spent a decade funding arts education in New York.

John Smith serves on the board of the XYZ Foundation, which supports schools across New York. The New York investor gave $12 million to the XYZ Foundation, according to reporting in the Financial Times (https://ft.com/b).

ABC Capital, the firm John Smith founded, invests in growing companies. John Smith said the gift reflects a long commitment to arts education. XYZ Foundation, XYZ Foundation, XYZ Foundation, XYZ Foundation and XYZ Foundation all benefit.

Some readers will remember the lawsuit against ABC Capital, which a judge dismissed. John Smith continues to lead ABC Capital from New York.`;

const floor = MODEL.audit.minCoverageLevel;
const check = (audit, id) => audit.checks.find((c) => c.check_id === id);

test.after(() => {
  MODEL.audit.minCoverageLevel = floor;
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = DB_PATH + suffix;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

test('§98 an audit refuses to run below the coverage floor, and says why', async () => {
  assert.notEqual(coverageConfidence(entityId).level, 'HIGH', 'the fixture corpus is deliberately small');
  MODEL.audit.minCoverageLevel = 'HIGH';
  try {
    const audit = await runAudit(createAuditDraft({ entityId, sourceKind: 'paste', text: TEXT }));
    assert.equal(audit.draft.status, 'refused');
    assert.match(audit.draft.status_detail, /below the HIGH an audit needs/);
    assert.equal(audit.checks.length, 0);
    assert.equal(audit.approval.ready, false);
  } finally {
    MODEL.audit.minCoverageLevel = floor;
  }
});

test('§99 with nothing marked adverse, the exclusion checks cannot be judged rather than passing', async () => {
  MODEL.audit.minCoverageLevel = 'LOW';
  const audit = await runAudit(createAuditDraft({ entityId, sourceKind: 'paste', text: TEXT }));
  assert.equal(audit.draft.status, 'done');
  assert.equal(audit.checks.length, 15);
  assert.equal(check(audit, 'C1').result, 'insufficient');
  assert.equal(check(audit, 'C7').result, 'insufficient');
  // The fallback extractor cannot vouch for claims, and no host means no fit.
  assert.equal(check(audit, 'C2').result, 'insufficient');
  assert.equal(check(audit, 'C14').result, 'insufficient');
  assert.deepEqual(audit.checks.filter((c) => c.blocking).map((c) => c.check_id), ['C1', 'C2', 'C3']);
  // No composite score anywhere.
  assert.ok(!/score/i.test(Object.keys(audit).join(',')));
  assert.equal(audit.approval.ready, false);
});

test('§99 marking an association adverse makes naming it a blocking failure that cannot be signed off', async () => {
  MODEL.audit.minCoverageLevel = 'LOW';
  const lawsuit = all(`SELECT id, canonical_label FROM associations WHERE entity_id = ? AND status = 'active'`, entityId)
    .find((a) => /lawsuit|litigation/i.test(a.canonical_label));
  assert.ok(lawsuit, 'the fixture yields a lawsuit association');
  setPolarity(entityId, lawsuit.id, 'adverse', { reason: 'test' });

  const id = createAuditDraft({ entityId, sourceKind: 'paste', text: TEXT });
  const audit = await runAudit(id);

  const c1 = check(audit, 'C1');
  assert.equal(c1.result, 'fail');
  assert.equal(c1.blocking, true);
  assert.ok(c1.detail.items.some((item) => /the lawsuit against ABC Capital/.test(item)), 'the sentence is quoted as evidence');
  assert.equal(check(audit, 'C7').result === 'insufficient', false, 'overlap is measured once adverse coverage exists');
  assert.ok(audit.approval.open.includes('C1'));
  assert.match(audit.summary, /^One blocking issue/);

  // C8 runs the projection and never reports a Google score.
  const c8 = check(audit, 'C8');
  assert.notEqual(c8.result, 'insufficient', c8.summary);
  assert.ok(c8.detail.associations.every((a) => 'pias_delta' in a && 'current_delta' in a));
  assert.ok(!JSON.stringify(c8.detail).match(/"grs/i));

  // C11 names the mentions that add nothing.
  assert.equal(check(audit, 'C11').result, 'warn');
  assert.ok(check(audit, 'C11').detail.items.some((s) => /XYZ Foundation.*contribute nothing/.test(s)));

  assert.throws(() => signOff(id, 'C1', { reason: 'Named in passing, and the case was dismissed.' }, user), /cannot be signed off/);
  assert.throws(() => signOff(id, 'C11', { reason: 'fine' }, user), /reason/);
  const signed = signOff(id, 'C11', { reason: 'The list of beneficiaries is repeated deliberately.' }, user);
  assert.equal(check(signed, 'C11').signed_off, true);
  assert.equal(check(signed, 'C11').signoff.user_name, 'Ed Itor');

  // A sign-off covers the text it was given for.
  run(`UPDATE audit_draft SET text = ?, text_hash = 'changed' WHERE id = ?`, `${TEXT}\n\nOne more line.`, id);
  assert.equal(check(getAudit(id), 'C11').signed_off, false);
  assert.equal(check(getAudit(id), 'C11').stale, true);
});

test('§99 a generated draft: an unreported "joins", unlinked sources, and revisions that add no facts', async () => {
  MODEL.audit.minCoverageLevel = 'LOW';
  const association = get(`SELECT id FROM associations WHERE entity_id = ? AND canonical_label = 'ABC Capital'`, entityId);
  const doc = get(`SELECT id, url, root_domain FROM documents WHERE url = 'https://ft.com/b'`);
  const facts = [{
    id: 'F1', source: 'evidence', association_id: association.id, url: doc.url, domain: doc.root_domain, document_id: doc.id,
    passage: 'John Smith, founder of ABC Capital, has increased his charitable giving. The New York investor donated to the XYZ Foundation.',
  }];
  const draft = (title, body) => {
    const sentence = body.split('\n\n').find((p) => p.includes('founder'));
    const res = run(
      `INSERT INTO content_drafts (entity_id, association_id, format, mode, title, body, claims, brief) VALUES (?, ?, 'article', 'grow', ?, ?, ?, ?)`,
      entityId, association.id, title, body, JSON.stringify([{ sentence, fact_ids: ['F1'] }]), JSON.stringify({ purpose: 'strengthen', facts })
    );
    return Number(res.lastInsertRowid);
  };
  const audit = async (contentDraftId, title, body) => {
    run(`UPDATE content_drafts SET title = ?, body = ? WHERE id = ?`, title, body, contentDraftId);
    return runAudit(createAuditDraft({ entityId, sourceKind: 'generated', text: `${title}\n\n${body}`, title, contentDraftId }));
  };
  const BODY = 'John Smith, founder of ABC Capital, gives to arts education in New York, as the Financial Times reported.\n\nJohn Smith leads ABC Capital from New York and supports the XYZ Foundation.';

  // An earlier piece already carries these facts.
  const earlier = draft('John Smith of ABC Capital', BODY);
  await audit(earlier, 'John Smith of ABC Capital', BODY);

  const id = draft('John Smith Joins ABC Capital', BODY);
  const first = await audit(id, 'John Smith Joins ABC Capital', BODY);
  const c2 = check(first, 'C2');
  assert.equal(c2.result, 'fail');
  assert.ok(c2.detail.items.some((i) => /“Joins”/.test(i)), c2.summary);
  const c4 = check(first, 'C4');
  assert.equal(c4.result, 'warn');
  assert.deepEqual(c4.detail.unlinked_sources, ['ft.com']);
  assert.equal(check(first, 'C5').result, 'warn', 'every fact is already in the earlier draft');
  assert.equal(check(first, 'C5').detail.revisions_without_new_facts, 0);

  // Reworded and linked, but the same facts.
  const LINKED = BODY.replace('the Financial Times reported', '[the Financial Times](https://ft.com/b) reported');
  const second = await audit(id, 'John Smith, founder of ABC Capital', LINKED);
  assert.notEqual(check(second, 'C2').result, 'fail', check(second, 'C2').summary);
  assert.deepEqual(check(second, 'C4').detail.unlinked_sources, []);
  const c5 = check(second, 'C5');
  assert.equal(c5.detail.revisions_without_new_facts, 1);
  assert.match(c5.summary, /rewriting does not add facts/);
});
