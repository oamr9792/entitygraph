import { findOccurrences, normaliseForMatch, splitSentences } from '../util/text.js';

/**
 * The content builder's rules, kept free of the database so they can be tested
 * on their own.
 *
 * Everything the builder may write follows from the action plan, and every draft
 * is checked for the failures a reviewer would look for first: naming the
 * association the piece exists to displace, stating something no source
 * supports, lifting a publisher's sentences — and, the other way round, failing
 * to carry the associations the piece is meant to strengthen.
 */

export const FORMATS = Object.freeze({
  profile: {
    label: 'Profile or about page',
    where: 'The client’s own site, or a professional directory profile in their name.',
    length: '400–700 words',
    mode: 'grow',
    requiresNotes: false,
  },
  article: {
    label: 'Bylined article',
    where: 'A publication not already in the corpus, under the client’s own byline.',
    length: '700–1,100 words',
    mode: 'grow',
    requiresNotes: false,
  },
  faq: {
    label: 'Q&A page',
    where: 'The client’s own site.',
    length: '6–10 questions',
    mode: 'grow',
    requiresNotes: false,
  },
  press_release: {
    label: 'Announcement',
    where: 'The client’s newsroom or a wire service. Only for real, current news, which you supply in the notes.',
    length: '350–600 words',
    mode: 'grow',
    requiresNotes: true,
  },
  social_post: {
    label: 'LinkedIn post',
    where: 'The client’s own profile.',
    length: '120–220 words',
    mode: 'grow',
    requiresNotes: false,
  },
  correction_request: {
    label: 'Correction request',
    where: 'Sent privately to the editor of one publication.',
    length: '250–450 words',
    mode: 'correct',
    requiresNotes: true,
  },
});

export const FORMAT_ORDER = ['profile', 'article', 'faq', 'press_release', 'social_post', 'correction_request'];

// Which formats each action-plan route actually calls for, and why.
const ROUTE_FORMATS = {
  challenge_accuracy: {
    formats: ['correction_request'],
    why: 'The evidence sits on very few domains. If the underlying claim is wrong, a correction at the source removes what the other pages repeat.',
  },
  retrieval_gap: {
    formats: ['profile', 'faq'],
    why: 'Google shows this more than the recent web carries it, so the pages that rank for the name are the constraint. Owned pages written for the name compete for those positions.',
  },
  displace: {
    formats: ['article', 'profile', 'press_release', 'social_post'],
    why: 'Its share falls only if more is published about the client that does not carry it, on domains not already in the corpus.',
  },
  not_a_metrics_problem: {
    formats: ['profile', 'article'],
    why: 'This is established in the public record, and content will not remove it. The realistic aim is that what else is true about the client ranks alongside it. A correction request applies only where coverage is factually wrong.',
  },
};

/** What the action plan says content can and cannot do for this association. */
export function strategyFor(plan) {
  const routes = plan?.routes ?? [];
  const keys = new Set(routes.map((r) => r.key));
  const notices = [];

  if (keys.has('verify_identity')) {
    notices.push({
      level: 'block',
      key: 'verify_identity',
      text: 'The pages behind this association may not be about this client. Fix the identity first: content written from misattributed evidence repeats someone else’s story.',
    });
  }
  if (keys.has('address_carrier')) {
    const carrier = plan.carried_by?.[0] ?? null;
    notices.push({
      level: 'warn',
      key: 'address_carrier',
      text: `This association rides along with ${carrier?.label ?? 'another association'}. Content aimed at it directly will have little effect; check that association’s plan first.`,
      association_id: carrier?.association_id ?? null,
    });
  }
  if (keys.has('let_it_decay')) {
    notices.push({
      level: 'warn',
      key: 'let_it_decay',
      text: 'It is already fading on its own. Measure again before paying for placements.',
    });
  }

  const recommended = [];
  const reasons = [];
  for (const route of routes) {
    const mapping = ROUTE_FORMATS[route.key];
    if (!mapping) continue;
    reasons.push({ route: route.key, title: route.title, why: mapping.why, formats: mapping.formats });
    for (const format of mapping.formats) if (!recommended.includes(format)) recommended.push(format);
  }
  if (!recommended.length) recommended.push('profile', 'article');

  return { blocked: keys.has('verify_identity'), notices, recommended, reasons };
}

/** Content for an association the client wants more of, rather than less. */
export function strengthenStrategy(plan) {
  const base = strategyFor(plan);
  const formats = ['article', 'profile', 'faq', 'social_post', 'press_release'];
  return {
    blocked: base.blocked,
    notices: base.notices.filter((n) => n.key === 'verify_identity'),
    recommended: formats,
    reasons: [{
      route: 'strengthen',
      title: `Strengthen ${plan?.association?.label ?? 'this association'}`,
      why: 'Every new page that states this relationship directly, beside the client’s name, adds evidence for it. Pages on sites not already in the corpus count in full.',
      formats,
    }],
  };
}

/**
 * Surface forms worth treating as names for an association. Extraction records
 * sentence fragments as surface forms too — "defence lawyer, Jay Lefkowitz" —
 * and a fragment containing the client's own name is not another name for the
 * association; banning or targeting it would misfire on the client's name.
 */
export function usableAliases(aliases, { entityName = '', label = '' } = {}) {
  const own = new Set(normaliseForMatch(entityName).split(' ').filter((t) => t.length >= 3));
  const labelKey = normaliseForMatch(label);
  const labelNamesClient = labelKey.split(' ').some((w) => own.has(w));
  const seen = new Set([labelKey]);
  const out = [];
  for (const alias of aliases ?? []) {
    const key = normaliseForMatch(alias);
    if (!key || seen.has(key)) continue;
    const words = key.split(' ');
    if (words.length > 5) continue;
    if (!labelNamesClient && words.some((w) => own.has(w))) continue;
    seen.add(key);
    out.push(String(alias).trim());
  }
  return out;
}

/**
 * The words a displacement piece must not contain. A new page that names the
 * association adds to it rather than diluting it, and headlines name people by
 * surname, so the surname counts too.
 */
export function avoidTermsFor({ label, kind = null, category = null, aliases = [], entityName = '', carriers = [] }) {
  const own = new Set(normaliseForMatch(entityName).split(' ').filter(Boolean));
  const terms = new Map();
  const add = (term, reason, severity) => {
    const text = String(term ?? '').trim();
    const key = normaliseForMatch(text);
    if (!key || key.length < 3 || terms.has(key) || own.has(key)) return;
    terms.set(key, { term: text, reason, severity });
  };

  add(label, 'it is the association this content exists to displace', 'block');
  for (const alias of usableAliases(aliases, { entityName, label })) {
    add(alias, 'it is another form of the same association', 'block');
  }
  if (kind === 'named_entity' && category === 'person') {
    const surname = normaliseForMatch(label).split(' ').filter(Boolean).at(-1);
    if (surname && surname.length >= 4) add(surname, 'headlines name people by surname', 'block');
  }
  for (const carrier of carriers) {
    add(carrier, 'it travels with the displaced association, so naming it tends to bring that back', 'warn');
  }
  return [...terms.values()];
}

/** Runs of `n` consecutive words shared with a source passage. */
export function verbatimOverlaps(text, facts, n = 12) {
  const words = normaliseForMatch(text).split(' ').filter(Boolean);
  if (words.length < n) return [];
  const shingles = new Set();
  for (let i = 0; i + n <= words.length; i += 1) shingles.add(words.slice(i, i + n).join(' '));

  const overlaps = [];
  for (const fact of facts) {
    const source = normaliseForMatch(fact.passage ?? '').split(' ').filter(Boolean);
    for (let i = 0; i + n <= source.length; i += 1) {
      const run = source.slice(i, i + n).join(' ');
      if (shingles.has(run)) {
        overlaps.push({ fact_id: fact.id, excerpt: run });
        break;
      }
    }
  }
  return overlaps;
}

const shorten = (s, max = 110) => {
  const text = String(s ?? '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const sentencesOf = (body) =>
  (splitSentences(body ?? '') ?? []).map((s) => (typeof s === 'string' ? s : s?.text ?? '')).filter(Boolean);

/**
 * How well a draft carries each association it is meant to strengthen, read
 * the way this tool's scoring reads a page: whether it is mentioned, how many
 * mentions count under the repetition cap, whether it sits in a sentence with
 * the client's name, and whether it leads the piece.
 */
export function targetCoverage({ title = '', body = '' } = {}, targets = [], { names = [], cap = 3 } = {}) {
  const opening = String(body ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !/^#/.test(p)) ?? '';
  const units = [title ?? '', ...sentencesOf(body)].filter(Boolean);

  return targets.map((target) => {
    const terms = [target.label, ...(target.terms ?? [])];
    const starts = new Set(findOccurrences(`${title ?? ''}\n${body ?? ''}`, terms).map((hit) => hit.start));
    const mentions = starts.size;
    return {
      association_id: target.association_id,
      label: target.label,
      mentions,
      counted: Math.min(mentions, cap),
      cap,
      beside_name: units.some((u) => findOccurrences(u, terms).length && findOccurrences(u, names).length),
      in_title: findOccurrences(title ?? '', terms).length > 0,
      in_opening: findOccurrences(opening, terms).length > 0,
    };
  });
}

/**
 * Checks a draft before a person may approve it. Blocking issues stop approval;
 * warnings are shown but do not.
 */
export function checkDraft(
  { title = '', body = '', claims = [] } = {},
  { avoid = [], facts = [], mode = 'grow', targets = [], names = [], cap = 3 } = {}
) {
  const issues = [];
  const text = `${title ?? ''}\n${body ?? ''}`;

  if (mode === 'grow') {
    for (const entry of avoid) {
      const hits = findOccurrences(text, [entry.term]).length;
      if (!hits) continue;
      issues.push({
        kind: 'avoid_term',
        severity: entry.severity,
        term: entry.term,
        text: `Mentions “${entry.term}” ${hits} time${hits === 1 ? '' : 's'}; ${entry.reason}.`,
      });
    }
  }

  const known = new Set(facts.map((f) => f.id));
  for (const claim of claims ?? []) {
    const ids = claim.fact_ids ?? [];
    if (ids.length && ids.every((id) => known.has(id))) continue;
    issues.push({
      kind: 'unsupported_claim',
      severity: 'block',
      sentence: claim.sentence,
      text: `Not tied to a sourced fact: “${shorten(claim.sentence)}”`,
    });
  }

  // A figure is the claim most likely to be invented and least likely to be
  // caught by a reader, so any sentence with a number must be a cited one.
  const cited = (claims ?? []).map((c) => normaliseForMatch(c.sentence)).filter(Boolean);
  for (const sentence of sentencesOf(body)) {
    if (!/\d/.test(sentence) || /\[CONFIRM:/i.test(sentence)) continue;
    const normalised = normaliseForMatch(sentence);
    if (!normalised || cited.some((c) => normalised.includes(c) || c.includes(normalised))) continue;
    issues.push({
      kind: 'uncited_figure',
      severity: 'warn',
      sentence,
      text: `Contains a figure with no cited fact: “${shorten(sentence)}”`,
    });
  }

  // A correction request is expected to quote the passage it disputes.
  if (mode === 'grow') {
    for (const overlap of verbatimOverlaps(body, facts.filter((f) => f.source === 'evidence'))) {
      issues.push({
        kind: 'verbatim',
        severity: 'block',
        fact_id: overlap.fact_id,
        text: `Copies a run of words from ${overlap.fact_id}: “${overlap.excerpt}…”. Rewrite it in your own words.`,
      });
    }
  }

  for (const placeholder of String(body ?? '').match(/\[CONFIRM:[^\]]*\]/gi) ?? []) {
    issues.push({ kind: 'placeholder', severity: 'block', text: `Needs confirming before use: ${placeholder}` });
  }

  const coverage = mode === 'grow' ? targetCoverage({ title, body }, targets, { names, cap }) : [];
  for (const t of coverage) {
    if (!t.mentions) {
      issues.push({ kind: 'target_missing', severity: 'block', text: `Never mentions ${t.label}, which this piece exists to strengthen.` });
      continue;
    }
    if (!t.beside_name) {
      issues.push({
        kind: 'target_not_beside_name',
        severity: 'warn',
        text: `${t.label} never appears in a sentence with the client’s name. Same-sentence mentions count for far more than distant ones.`,
      });
    }
    if (!t.in_title && !t.in_opening) {
      issues.push({ kind: 'target_not_leading', severity: 'warn', text: `${t.label} is not in the title or the opening paragraph.` });
    }
    if (t.mentions > cap * 2) {
      issues.push({
        kind: 'target_repeated',
        severity: 'warn',
        text: `Mentions ${t.label} ${t.mentions} times. Only the first ${cap} count, and repetition reads as spam.`,
      });
    }
  }

  const blocking = issues.filter((i) => i.severity === 'block').length;
  return {
    ok: blocking === 0,
    blocking,
    warnings: issues.length - blocking,
    issues,
    targets: coverage,
    checked_at: new Date().toISOString(),
  };
}

/** The structure a writer works to, with or without a generated draft. */
export function outlineFor(format, { entityName = 'The client', grow = [] } = {}) {
  const labels = grow.map((g) => g.label);
  switch (format) {
    case 'profile':
      return [
        `Title and opening: ${entityName} and ${labels[0] ?? 'their current role'}, stated directly`,
        'Current role and organisation',
        ...labels.map((l) => `${l}: what the sourced facts establish, in sentences that name ${entityName}`),
        'Closing: current focus, and where to find more',
      ];
    case 'article':
      return [
        `Headline and standfirst on a subject ${entityName} can speak to with authority${labels[0] ? `, carrying ${labels[0]}` : ''}`,
        labels[0] ? `The argument, grounded in ${labels[0]}` : 'The argument',
        ...labels.slice(1).map((l) => `Supporting section: ${l}`),
        `Author line: ${entityName}, current role${labels[0] ? `, and their connection to ${labels[0]}` : ''}`,
      ];
    case 'faq':
      return [
        `Who is ${entityName}?`,
        ...labels.map((l) => `What is ${entityName}’s connection to ${l}?`),
        'Where can I find out more?',
      ];
    case 'press_release':
      return [
        'Headline: the news, as supplied in your notes',
        'First paragraph: who, what, when, where',
        ...labels.map((l) => `Context: ${entityName} and ${l}`),
        'Quote from the client, supplied or approved by them',
        `About ${entityName}`,
        'Media contact',
      ];
    case 'social_post':
      return ['Opening line', ...labels.slice(0, 2).map((l) => `One or two sentences on ${l}`), 'Close'];
    case 'correction_request':
      return [
        'To the editor: identify the article by headline, date and URL',
        'Quote the specific passage at issue',
        'State what is inaccurate and what is correct, from your notes',
        'Material the publisher can check',
        'Ask for a correction or clarification; give contact details',
      ];
    default:
      return [];
  }
}
