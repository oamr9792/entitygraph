import { MODEL } from '../config.js';
import { findOccurrences, normaliseForMatch, splitParagraphs, splitSentences } from '../util/text.js';
import { quotationStats } from './content-checks.js';

/**
 * §99 — the content audit's rules, free of the database so each can be tested
 * on its own. The engine (audit.js) gathers the data; these decide what it
 * means. Nothing here produces a composite score, and nothing rewrites text.
 */

const cfg = () => MODEL.audit;

export const sentencesOf = (text) =>
  splitSentences(String(text ?? '')).map((s) => ({ ...s, text: s.text.trim() })).filter((s) => s.text);

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
export const numberWord = (n) => (Number.isInteger(n) && n >= 0 && n <= 10 ? WORDS[n] : String(n));
const plural = (n, one, many) => `${numberWord(n)} ${n === 1 ? one : many}`;
const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// --- C4 / C6: sources -----------------------------------------------------------

/**
 * The unit of independence (§22): copies in one duplicate cluster are one
 * source, pages on one site are one source, and sites with a shared owner are
 * one source.
 */
export function independenceKey({ duplicate_cluster_id: cluster = null, owner_key: owner = null, root_domain: domain = null, name = null } = {}) {
  if (cluster) return `cluster:${cluster}`;
  if (owner) return `owner:${owner}`;
  if (domain) return `domain:${domain}`;
  return name ? `name:${normaliseForMatch(name)}` : null;
}

/** "N attributions across M independent sources", with the clusters behind M. */
export function countIndependent(attributions = []) {
  const clusters = new Map();
  for (const a of attributions) {
    const key = independenceKey(a);
    if (!key) continue;
    if (!clusters.has(key)) clusters.set(key, { key, label: a.root_domain ?? a.name ?? key, attributions: 0 });
    clusters.get(key).attributions += 1;
  }
  const list = [...clusters.values()].sort((a, b) => b.attributions - a.attributions);
  return { attributions: attributions.length, independent: list.length, clusters: list };
}

const CLASS_ORDER = ['statutory_register', 'professional_body', 'academic_institutional', 'press_other', 'self_asserted'];
export const VERIFIABLE_CLASSES = new Set(['statutory_register', 'professional_body', 'academic_institutional']);

export function sourceClassFor(domain, { ownDomains = [], classes = cfg().verifiability.classes } = {}) {
  const d = String(domain ?? '').toLowerCase();
  if (!d) return 'press_other';
  if (ownDomains.some((own) => own && (d === own || d.endsWith(`.${own}`)))) return 'self_asserted';
  for (const cls of ['statutory_register', 'professional_body', 'academic_institutional', 'self_asserted']) {
    if ((classes[cls] ?? []).some((pattern) => new RegExp(pattern, 'i').test(d))) return cls;
  }
  return 'press_other';
}

/** The best class among a fact's sources: a register beats a newspaper beats the client's own site. */
export function highestClass(domains, options) {
  const found = domains.map((d) => sourceClassFor(d, options));
  return CLASS_ORDER.find((cls) => found.includes(cls)) ?? null;
}

// --- C10: subject share -----------------------------------------------------------

const PRONOUN_START = /^\s*(?:he|she|his|her|him|they|their)\b/i;
const NOT_A_NAME_START = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'for', 'new', 'fort', 'mount', 'saint', 'san', 'los', 'las', 'north', 'south', 'east', 'west', 'united', 'when', 'after', 'before', 'during', 'as', 'with', 'from']);
const ORG_WORDS = /\b(?:group|llc|inc|ltd|llp|plc|advisors?|advisers?|partners|capital|bank|university|college|school|foundation|institute|association|society|company|corporation|firm|fund|trust|council|committee|court|house|times|journal|news|post|daily|magazine|network|agency|department|office|center|centre|management|financial|services|street|avenue|road|county|city|state)\b/i;

/**
 * Title-case names that look like people: two or three capitalised words, not
 * an organisation, not a place the caller already knows, not the client.
 */
export function candidatePersonNames(text, { clientNames = [], knownNonPeople = [] } = {}) {
  const clientTokens = new Set(clientNames.flatMap((n) => normaliseForMatch(n).split(' ')).filter((t) => t.length > 2));
  const nonPeople = knownNonPeople.map((n) => normaliseForMatch(n)).filter(Boolean);
  const names = new Map();
  for (const m of String(text ?? '').matchAll(/\b([A-Z][a-z’'-]+(?:\s+[A-Z]\.)?(?:\s+[A-Z][a-z’'-]+){1,2})\b/g)) {
    const name = m[1];
    const key = normaliseForMatch(name);
    const tokens = key.split(' ');
    if (ORG_WORDS.test(name) || NOT_A_NAME_START.has(tokens[0])) continue;
    if (tokens.some((t) => clientTokens.has(t))) continue;
    if (nonPeople.some((np) => np === key || np.includes(key))) continue;
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  return [...names.keys()];
}

/**
 * Who each sentence is about: the person named nearest its start, or — for a
 * sentence that opens with a pronoun — whoever the previous sentence was about.
 */
export function subjectShare(text, { clientNames = [], otherNames = [] } = {}) {
  const paragraphs = splitParagraphs(String(text ?? ''));
  const perSentence = [];
  let previous = null;
  paragraphs.forEach((paragraph, paragraphIndex) => {
    for (const sentence of sentencesOf(paragraph.text)) {
      const client = findOccurrences(sentence.text, clientNames)[0];
      let subject = client ? { who: 'client', at: client.start } : null;
      for (const name of otherNames) {
        const hit = findOccurrences(sentence.text, [name])[0];
        if (hit && (!subject || hit.start < subject.at)) subject = { who: name, at: hit.start };
      }
      if (PRONOUN_START.test(sentence.text) && previous && (!subject || subject.at > 40)) subject = { who: previous, at: 0 };
      if (subject) previous = subject.who;
      perSentence.push({ paragraph: paragraphIndex, text: sentence.text, subject: subject?.who ?? null });
    }
  });

  const withSubject = perSentence.filter((s) => s.subject);
  const clientCount = withSubject.filter((s) => s.subject === 'client').length;
  const others = new Map();
  for (const s of withSubject) if (s.subject !== 'client') others.set(s.subject, (others.get(s.subject) ?? 0) + 1);

  const aboutOthers = paragraphs
    .map((p, index) => {
      const inParagraph = withSubject.filter((s) => s.paragraph === index);
      const mine = inParagraph.filter((s) => s.subject === 'client').length;
      const theirs = inParagraph.length - mine;
      const names = [...new Set(inParagraph.filter((s) => s.subject !== 'client').map((s) => s.subject))];
      return { index, sentences: inParagraph.length, client: mine, others: theirs, names, excerpt: p.text.trim().slice(0, 160) };
    })
    .filter((p) => p.sentences >= 2 && p.others > p.client);

  return {
    sentences: withSubject.length,
    client: clientCount,
    share: withSubject.length ? clientCount / withSubject.length : null,
    others: [...others.entries()]
      .map(([name, count]) => ({ name, sentences: count, share: count / withSubject.length }))
      .sort((a, b) => b.sentences - a.sentences),
    paragraphs_about_others: aboutOthers,
  };
}

// --- C11: repetition waste ----------------------------------------------------------

/** Mentions past the cap, per phrase. `phrases` is [{ label, terms }]. */
export function repetitionWaste(text, phrases = [], cap = MODEL.mentionCap) {
  return phrases
    .map(({ label, terms = [] }) => {
      const mentions = new Set(findOccurrences(String(text ?? ''), [label, ...terms]).map((h) => h.start)).size;
      return { label, mentions, counted: Math.min(mentions, cap.length), wasted: Math.max(0, mentions - cap.length) };
    })
    .filter((p) => p.mentions > 0)
    .sort((a, b) => b.wasted - a.wasted || b.mentions - a.mentions);
}

export function wasteSentence({ label, mentions, wasted }, cap = MODEL.mentionCap) {
  const values = cap.map((v, i) => (i === 0 ? v.toFixed(1) : `+${v}`)).join(', ');
  const first = numberWord(cap.length + 1);
  const last = numberWord(mentions);
  const which = wasted === 1 ? `mention ${first} contributes` : `mentions ${first} ${wasted > 2 ? 'to' : 'and'} ${last} contribute`;
  return `“${label}” appears ${mentions} times. The cap values the first ${numberWord(cap.length)} at ${values}, so ${which} nothing.`;
}

// --- C12: attribution load --------------------------------------------------------------

export function attributionLoad(text, { sourceNames = [], rules = cfg().attribution } = {}) {
  const constructions = rules.patterns.map((p) => new RegExp(p, 'i'));
  const subjects = rules.sourceSubjects.map((p) => new RegExp(p, 'i'));
  const names = sourceNames.map((n) => normaliseForMatch(n)).filter((n) => n.length > 2);
  const sentences = sentencesOf(text);
  const attributed = [];
  for (const s of sentences) {
    const start = normaliseForMatch(s.text);
    const reasons = [];
    if (constructions.some((r) => r.test(s.text))) reasons.push('attribution');
    if (subjects.some((r) => r.test(s.text)) || names.some((n) => start.startsWith(n))) reasons.push('source is the subject');
    if (reasons.length) attributed.push({ sentence: s.text, reasons });
  }
  return {
    sentences: sentences.length,
    attributed,
    load: sentences.length ? attributed.length / sentences.length : 0,
    quotation: quotationStats(text),
  };
}

// --- C13: links ------------------------------------------------------------------------------

const BOILERPLATE_TAG = /^(?:nav|header|footer|aside)$/i;
const BOILERPLATE_ATTR = /\b(?:sidebar|footer|author|bio|byline|related|share|social|menu|nav|widget|comment|newsletter|subscribe|breadcrumb)\b/i;

function boilerplateRanges(html) {
  const ranges = [];
  const open = /<([a-z][a-z0-9]*)\b([^>]*)>/gi;
  for (const m of html.matchAll(open)) {
    const [, tag, attrs] = m;
    const attrText = /(?:class|id|role)\s*=\s*["']([^"']*)["']/gi;
    const labels = [...attrs.matchAll(attrText)].map((a) => a[1]).join(' ');
    if (!BOILERPLATE_TAG.test(tag) && !BOILERPLATE_ATTR.test(labels)) continue;
    // Find the matching close, counting nested tags of the same name.
    const scan = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
    scan.lastIndex = m.index + m[0].length;
    let depth = 1;
    let end = html.length;
    for (let t = scan.exec(html); t; t = scan.exec(html)) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) { end = t.index; break; }
    }
    ranges.push([m.index, end]);
  }
  return ranges;
}

const hostOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
};

/** Outbound links with where they sit: body or boilerplate, and how far down (0 = top). */
export function extractLinks({ html = null, text = '', baseUrl = null } = {}) {
  const links = [];
  if (html) {
    const bodyStart = html.search(/<body\b/i);
    const start = bodyStart >= 0 ? bodyStart : 0;
    const span = Math.max(1, html.length - start);
    const ranges = boilerplateRanges(html);
    for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      let href;
      try { href = new URL(m[1], baseUrl ?? undefined).href; } catch { continue; }
      if (!/^https?:/i.test(href)) continue;
      links.push({
        href,
        domain: hostOf(href),
        anchor: m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120),
        location: ranges.some(([a, b]) => m.index >= a && m.index < b) ? 'boilerplate' : 'body',
        position: Math.max(0, Math.min(1, (m.index - start) / span)),
      });
    }
  } else {
    const body = String(text ?? '');
    for (const m of body.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
      links.push({ href: m[2], domain: hostOf(m[2]), anchor: m[1], location: 'body', position: m.index / Math.max(1, body.length) });
    }
    // Bare URLs, skipping the ones already inside a Markdown link.
    for (const m of body.matchAll(/(?<!\]\()https?:\/\/[^\s<>()"']+/g)) {
      const href = m[0].replace(/[.,;:!?]+$/, '');
      links.push({ href, domain: hostOf(href), anchor: href, location: 'body', position: m.index / Math.max(1, body.length) });
    }
    links.sort((a, b) => a.position - b.position);
  }
  const external = baseUrl ? hostOf(baseUrl) : null;
  return links.filter((l) => l.domain && l.domain !== external);
}

const matchesDomain = (domain, targets) => targets.some((t) => t && (domain === t || domain.endsWith(`.${t}`)));

export function linkPlacement(links, { targetDomains = [], lateShare = cfg().links.lateShare } = {}) {
  const target = links.filter((l) => matchesDomain(l.domain, targetDomains));
  const inBody = target.filter((l) => l.location === 'body');
  const first = inBody.sort((a, b) => a.position - b.position)[0] ?? null;
  return {
    outbound: links.length,
    target_links: target.length,
    target_in_body: inBody.length,
    first_target_position: first?.position ?? null,
    late: first ? first.position > lateShare : false,
    only_sources: links.length > 0 && target.length === 0,
  };
}

// --- C14: host fit ----------------------------------------------------------------------------------

/** Which of the client's places and subjects the host site's own description shares. */
export function hostFit(profileText, { locations = [], occupations = [], organizations = [] } = {}) {
  const text = String(profileText ?? '');
  const found = (terms) => [...new Set(terms.filter((t) => t && findOccurrences(text, [t]).length))];
  const occupationWords = occupations.flatMap((o) => normaliseForMatch(o).split(' ')).filter((w) => w.length >= 5);
  const geo = found(locations);
  const topic = [...found(occupationWords), ...found(organizations)];
  return { geo, topic, fits: geo.length > 0 || topic.length > 0 };
}

// --- C15: structured data ------------------------------------------------------------------------------

export function personSchema(html) {
  const persons = [];
  let errors = 0;
  for (const m of String(html ?? '').matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { errors += 1; continue; }
    const nodes = [];
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      nodes.push(node);
      if (node['@graph']) walk(node['@graph']);
    };
    walk(data);
    for (const node of nodes) {
      const types = [].concat(node['@type'] ?? []);
      if (!types.includes('Person')) continue;
      persons.push({
        name: node.name ?? null,
        sameAs: [].concat(node.sameAs ?? []).filter((s) => typeof s === 'string'),
        identifier: node.identifier ?? null,
        url: node.url ?? null,
      });
    }
  }
  return { persons, errors };
}

// --- C3: regulated person -------------------------------------------------------------------------------------

export function regulatedProfile(markers = [], rules = cfg().regulated) {
  const registration = new RegExp(rules.registrationPattern, 'i');
  const occupation = new RegExp(rules.occupationPattern, 'i');
  const positive = markers.filter((m) => m.polarity !== -1);
  return {
    registrations: positive.filter((m) => m.kind === 'registration' || (m.kind === 'other' && registration.test(m.value))).map((m) => m.value),
    occupation_hints: positive.filter((m) => m.kind === 'occupation' && occupation.test(m.value)).map((m) => m.value),
  };
}

// --- C2 and C4: events and links in generated text ---------------------------------------------------------------

// News verbs. A profile of someone in a role is not a report that they just took it.
const EVENT_PATTERNS = [
  { stem: 'join', re: /\b(?:joins|joined|joining)\b/i },
  { stem: 'appoint', re: /\b(?:appoints|appointed)\b/i },
  { stem: 'hire', re: /\b(?:hires|hired)\b/i },
  { stem: 'promot', re: /\b(?:promotes|promoted)\b/i },
  { stem: 'launch', re: /\b(?:launches|launched)\b/i },
  { stem: 'announc', re: /\b(?:announces|announced)\b/i },
  { stem: 'welcom', re: /\b(?:welcomes|welcomed)\b/i },
  { stem: 'named', re: /\b(?:named (?:as|to)|has been named)\b/i },
];

/**
 * Event verbs in the headline or opening that no fact reports. The opening is
 * the first two paragraphs (standfirst and first paragraph); a Markdown H1
 * counts as the headline.
 */
export function unsupportedEvents(title, body, passages = []) {
  const paragraphs = String(body ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const headings = paragraphs.filter((p) => /^#\s/.test(p)).map((p) => ({ text: p.replace(/^#\s+/, '') }));
  const opening = paragraphs.filter((p) => !/^#{1,6}\s/.test(p)).slice(0, 2).flatMap((p) => sentencesOf(p));
  const places = [...(title ? [{ text: String(title) }] : []), ...headings, ...opening];
  const support = passages.filter(Boolean).join('\n');
  const out = new Map();
  for (const place of places) {
    for (const event of EVENT_PATTERNS) {
      const match = place.text.match(event.re);
      if (match && !new RegExp(`\\b${event.stem}`, 'i').test(support)) {
        out.set(`${match[0].toLowerCase()}|${place.text}`, { verb: match[0], sentence: place.text.trim() });
      }
    }
  }
  return [...out.values()];
}

const bareUrl = (u) => String(u ?? '').trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();

/** Whether a source is linked from the text: the same page, or another page on the same site. */
export function isLinked(url, links = []) {
  if (!url) return false;
  const target = bareUrl(url);
  const host = target.split('/')[0];
  return links.some((l) => {
    const href = bareUrl(l.href);
    return href === target || href.split('/')[0] === host;
  });
}

// --- §101: sign-off and presentation ---------------------------------------------------------------------------

export function signoffRule(checkId, result, rules = cfg()) {
  if (rules.unsignable.includes(checkId)) {
    return { allowed: false, why: 'This check cannot be signed off. The text has to change.' };
  }
  if (!['fail', 'warn'].includes(result)) return { allowed: false, why: 'Nothing to sign off.' };
  if (rules.approvalOnly.includes(checkId)) return { allowed: true, reasonRequired: false, approval: true };
  return { allowed: true, reasonRequired: true, approval: false };
}

/** Blocking failures, then warnings, then what could not be judged, then passes. */
export function groupChecks(checks) {
  const groups = { blocking: [], warnings: [], unjudged: [], passed: [] };
  for (const c of checks) {
    if (c.signed_off) groups.passed.push(c);
    else if (c.result === 'fail' && c.blocking) groups.blocking.push(c);
    else if (c.result === 'fail' || c.result === 'warn') groups.warnings.push(c);
    else if (c.result === 'insufficient') groups.unjudged.push(c);
    else groups.passed.push(c);
  }
  return groups;
}

/** §101 — a sentence, not a score. */
export function summarySentence(checks) {
  const { blocking, warnings, unjudged } = groupChecks(checks);
  const counts = [];
  if (blocking.length) counts.push(plural(blocking.length, 'blocking issue', 'blocking issues'));
  if (warnings.length) counts.push(plural(warnings.length, 'warning', 'warnings'));
  let first = counts.length ? `${capitalise(counts.join(', '))}.` : 'No blocking issues and no warnings.';
  if (unjudged.length) first += ` ${capitalise(plural(unjudged.length, 'check', 'checks'))} could not be judged.`;
  const novelty = checks.find((c) => c.check_id === 'C5');
  const zeroNew = novelty && novelty.result !== 'insufficient' && Number(novelty.value) === 0;
  return zeroNew ? `${first} This piece adds a URL and nothing else: it states no facts that the corpus and your live assets do not already hold.` : first;
}
