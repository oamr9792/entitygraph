import test from 'node:test';
import assert from 'node:assert/strict';

import {
  countIndependent, sourceClassFor, highestClass, candidatePersonNames, subjectShare, repetitionWaste, wasteSentence,
  attributionLoad, extractLinks, linkPlacement, hostFit, personSchema, regulatedProfile, signoffRule, groupChecks,
  summarySentence,
} from '../src/services/audit-rules.js';

/**
 * §99 — the audit's rules on their own, using the kind of text the checks were
 * written for: an advisor profile that spends two paragraphs on colleagues.
 */

test('C4 counts syndicated copies, same-site pages and shared owners as one source each', () => {
  const result = countIndependent([
    { root_domain: 'a.com' },
    { root_domain: 'a.com' },
    { duplicate_cluster_id: 5, root_domain: 'b.com' },
    { duplicate_cluster_id: 5, root_domain: 'c.com' },
    { owner_key: 'gannett', root_domain: 'd.com' },
    { owner_key: 'gannett', root_domain: 'e.com' },
  ]);
  assert.equal(result.attributions, 6);
  assert.equal(result.independent, 3);
});

test('C6 ranks a register above the press, and the client’s own site at the bottom', () => {
  assert.equal(sourceClassFor('sec.gov'), 'statutory_register');
  assert.equal(sourceClassFor('brokercheck.finra.org'), 'statutory_register');
  assert.equal(sourceClassFor('columbia.edu'), 'academic_institutional');
  assert.equal(sourceClassFor('linkedin.com'), 'self_asserted');
  assert.equal(sourceClassFor('fischmanazar.com', { ownDomains: ['fischmanazar.com'] }), 'self_asserted');
  assert.equal(sourceClassFor('nytimes.com'), 'press_other');
  assert.equal(highestClass(['linkedin.com', 'nytimes.com', 'sec.gov']), 'statutory_register');
});

const PROFILE = [
  'Solomon Tobal is a financial advisor in Fort Lee. He works with families on retirement planning. Tobal joined the practice in 2019.',
  'The practice is led by Alexander Fischman and Shalom Azar. Alexander Fischman founded the group in 2004. Shalom Azar leads client service.',
].join('\n\n');
const CLIENT = ['Solomon Tobal', 'Tobal'];

test('C10 finds the people a profile is really about, and the paragraphs spent on them', () => {
  const others = candidatePersonNames(PROFILE, { clientNames: CLIENT });
  assert.deepEqual(others.sort(), ['Alexander Fischman', 'Shalom Azar']);

  const share = subjectShare(PROFILE, { clientNames: CLIENT, otherNames: others });
  assert.equal(share.sentences, 6);
  assert.equal(share.client, 3, 'a sentence that opens with "He" belongs to the previous subject');
  assert.equal(share.share, 0.5);
  assert.deepEqual(share.others.map((o) => o.name).sort(), ['Alexander Fischman', 'Shalom Azar']);
  assert.equal(share.paragraphs_about_others.length, 1);
  assert.equal(share.paragraphs_about_others[0].index, 1);
});

test('C11 reports mentions past the cap as wasted space, in words', () => {
  const text = Array.from({ length: 5 }, () => 'Tobal works at Wells Fargo Advisors.').join(' ');
  const [waste] = repetitionWaste(text, [{ label: 'Wells Fargo Advisors', terms: [] }]);
  assert.deepEqual(waste, { label: 'Wells Fargo Advisors', mentions: 5, counted: 3, wasted: 2 });
  assert.equal(
    wasteSentence(waste),
    '“Wells Fargo Advisors” appears 5 times. The cap values the first three at 1.0, +0.2, +0.1, so mentions four and five contribute nothing.'
  );
});

test('C12 counts sentences spent on the source rather than the client', () => {
  const load = attributionLoad('According to the profile, Tobal advises families. The article states that he joined in 2019. Tobal holds a CFP designation.');
  assert.equal(load.sentences, 3);
  assert.equal(load.attributed.length, 2);
  assert.ok(load.attributed[1].reasons.includes('source is the subject'));
  assert.equal(attributionLoad('Shore News reports that Tobal joined.', { sourceNames: ['Shore News'] }).attributed.length, 1);
});

test('C13 tells body links from navigation and footers, and finds the client’s property', () => {
  const html = '<html><body><nav><a href="https://fischmanazar.com/">Home</a></nav><article><p>Read <a href="https://www.fischmanazar.com/team/tobal">his profile</a>.</p>'
    + '<p><a href="https://nytimes.com/x">source</a></p></article><footer class="site-footer"><a href="/contact">Contact</a><a href="https://fischmanazar.com/contact">Firm</a></footer></body></html>';
  const links = extractLinks({ html, baseUrl: 'https://news.example/post' });
  assert.deepEqual(links.map((l) => [l.domain, l.location]), [
    ['fischmanazar.com', 'boilerplate'],
    ['fischmanazar.com', 'body'],
    ['nytimes.com', 'body'],
    ['fischmanazar.com', 'boilerplate'],
  ], 'the relative footer link to the host itself is not outbound');
  const placement = linkPlacement(links, { targetDomains: ['fischmanazar.com'] });
  assert.equal(placement.target_links, 3);
  assert.equal(placement.target_in_body, 1);
  assert.equal(placement.only_sources, false);

  const sourcesOnly = linkPlacement(extractLinks({ text: 'See [the report](https://nytimes.com/x) and https://wsj.com/y.' }), { targetDomains: ['fischmanazar.com'] });
  assert.equal(sourcesOnly.outbound, 2);
  assert.equal(sourcesOnly.only_sources, true);
});

test('C14 sees a shore-town news site as a poor fit for a Fort Lee advisor', () => {
  const markers = { locations: ['Fort Lee', 'New Jersey'], occupations: ['financial advisor'], organizations: ['Fischman Azar Group'] };
  assert.equal(hostFit('Asbury Park news, events and local businesses on the Jersey Shore.', markers).fits, false);
  const bergen = hostFit('Business news for Bergen County and Fort Lee, for financial professionals.', markers);
  assert.equal(bergen.fits, true);
  assert.deepEqual(bergen.geo, ['Fort Lee']);
});

test('C15 reads Person markup, including inside a graph', () => {
  const html = '<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":"Person","name":"Solomon Tobal","sameAs":["https://www.linkedin.com/in/tobal"]}]}</script><script type="application/ld+json">{bad json</script>';
  const schema = personSchema(html);
  assert.equal(schema.persons.length, 1);
  assert.deepEqual(schema.persons[0].sameAs, ['https://www.linkedin.com/in/tobal']);
  assert.equal(schema.errors, 1);
});

test('C3 recognises a regulator registration, and flags an occupation that suggests one', () => {
  const profile = regulatedProfile([
    { kind: 'registration', value: '1234567', polarity: 1 },
    { kind: 'other', value: 'FINRA CRD 7654321', polarity: 1 },
    { kind: 'other', value: 'Harbour', polarity: 1 },
    { kind: 'occupation', value: 'financial advisor', polarity: 1 },
  ]);
  assert.deepEqual(profile.registrations, ['1234567', 'FINRA CRD 7654321']);
  assert.deepEqual(profile.occupation_hints, ['financial advisor']);
});

test('§101 sign-off: never for C1 or C2, approval only for C3, a reason for everything else', () => {
  assert.equal(signoffRule('C1', 'fail').allowed, false);
  assert.equal(signoffRule('C2', 'fail').allowed, false);
  assert.deepEqual(signoffRule('C3', 'fail'), { allowed: true, reasonRequired: false, approval: true });
  assert.deepEqual(signoffRule('C9', 'warn'), { allowed: true, reasonRequired: true, approval: false });
  assert.equal(signoffRule('C4', 'pass').allowed, false);
});

test('§101 the summary is a sentence, not a score', () => {
  const checks = [
    { check_id: 'C1', result: 'fail', blocking: 1 },
    { check_id: 'C2', result: 'fail', blocking: 1 },
    { check_id: 'C4', result: 'warn', blocking: 0 },
    { check_id: 'C9', result: 'fail', blocking: 0 },
    { check_id: 'C11', result: 'warn', blocking: 0 },
    { check_id: 'C5', result: 'warn', blocking: 0, value: 0 },
    { check_id: 'C7', result: 'insufficient', blocking: 0 },
    { check_id: 'C12', result: 'warn', blocking: 0, signed_off: true },
  ];
  const groups = groupChecks(checks);
  assert.deepEqual(groups.blocking.map((c) => c.check_id), ['C1', 'C2']);
  assert.equal(groups.warnings.length, 4, 'a signed-off warning no longer counts');
  assert.equal(
    summarySentence(checks),
    'Two blocking issues, four warnings. One check could not be judged. This piece adds a URL and nothing else: it states no facts that the corpus and your live assets do not already hold.'
  );
  assert.equal(summarySentence([{ check_id: 'C4', result: 'pass' }]), 'No blocking issues and no warnings.');
});
