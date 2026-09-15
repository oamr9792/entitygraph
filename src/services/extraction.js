import { llmJson, getLlm } from '../providers/llm/index.js';
import { evidenceWindow, findOccurrences, normaliseForMatch, splitSentences, normaliseWhitespace } from '../util/text.js';
import { clamp, round } from '../util/stats.js';

/**
 * §16–§18 — association extraction.
 *
 * Two extractors implement the same contract. The LLM one is the real one. The
 * heuristic one exists so that the corpus, disambiguation, duplicate, scoring
 * and dashboard stages can be built, tested and demonstrated without a key —
 * and so a key outage degrades the pipeline instead of stopping it. Which one
 * produced a row is recorded on every piece of evidence, because an analyst
 * reading a leaderboard needs to know which they are looking at.
 */

/** §18 — the initial taxonomy. New categories are allowed; these are seeded. */
export const ASSOCIATION_CATEGORIES = [
  'organization', 'person', 'occupation', 'role', 'industry', 'location', 'education',
  'philanthropy', 'arts_culture', 'sport', 'politics', 'legal', 'controversy', 'event',
  'project', 'award', 'publication', 'interest', 'property', 'financial', 'family', 'other',
];

/**
 * §16's output contract. `evidence` is required and load-bearing: §65 forbids
 * accepting an association without supporting text, and every returned item is
 * checked against the passage before it is stored.
 */
const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['target_entity_confirmed', 'target_confidence', 'associations'],
  properties: {
    target_entity_confirmed: {
      type: 'boolean',
      description: 'True only if this passage is about the target entity described in the identity profile.',
    },
    target_confidence: { type: 'number', description: '0 to 1.' },
    associations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['surface_form', 'canonical_label', 'type', 'kind', 'relationship', 'relationship_confidence', 'sentiment', 'evidence'],
        properties: {
          surface_form: { type: 'string', description: 'Exactly as written in the passage.' },
          canonical_label: { type: 'string', description: 'Normalised label, e.g. "Philanthropy", "XYZ Foundation".' },
          type: { type: 'string', enum: ASSOCIATION_CATEGORIES, description: 'Category from the taxonomy.' },
          kind: {
            type: 'string',
            enum: ['named_entity', 'concept'],
            description: 'named_entity for a specific named organisation, person, place or work. concept for a theme, topic or activity.',
          },
          relationship: {
            type: 'string',
            description: 'Snake_case relation from target to association, e.g. founder_of, board_member, involved_in, accused_of, attended, donated_to, mentioned_with.',
          },
          relationship_confidence: {
            type: 'number',
            description: 'How directly the passage states this relationship. A stated fact about the target is high; incidental co-occurrence in the same paragraph is low.',
          },
          sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
          evidence: { type: 'string', description: 'A verbatim quote from the passage supporting this association.' },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = (profile) =>
  [
    'You extract entity associations from web text for an entity-analysis system.',
    '',
    'Given a passage that mentions a target entity, identify the entities, organisations, people, locations, roles, events, topics and concepts that the passage associates WITH THAT TARGET.',
    '',
    'Rules:',
    '1. Only include an association if the passage supports it. Quote the supporting text verbatim in `evidence`. No quote, no association.',
    '2. Distinguish named entities from concepts. "XYZ Foundation" is a named_entity. "Philanthropy" is a concept. Never merge them, and do not infer one from the other — if the passage says the target sits on a foundation board, that is the foundation, not philanthropy, unless the passage also frames it as charitable work.',
    '3. relationship_confidence reflects how directly the passage ties the association to the target. "X donated to Y" is high. "X attended an event where Y was mentioned" is low. Loose co-occurrence must not score like a stated fact.',
    '4. sentiment describes how the passage frames the association, not whether the association is good news for the target.',
    '5. If the passage is about a different person or organisation with the same name, set target_entity_confirmed to false and return no associations.',
    '6. Do not include the target entity itself as an association.',
    '',
    'TARGET IDENTITY PROFILE',
    JSON.stringify(
      {
        canonical_name: profile.canonical_name,
        entity_type: profile.entity_type,
        aliases: profile.aliases,
        identity_markers: profile.identity_markers,
      },
      null,
      2
    ),
  ].join('\n');

/**
 * §15 — the windows we send for extraction. One per mention of the entity,
 * merged when they overlap so a paragraph with three mentions costs one call
 * rather than three.
 *
 * `secondary` names are further anchors — a person's surname on a page already
 * accepted as about them — used only once every full-name mention has a
 * window, and only when the page names the entity in full at least once.
 */
export function buildWindows(text, aliases, { maxChars = 1000, maxWindows = 6, secondary = [] } = {}) {
  const hits = findOccurrences(text, aliases);
  if (!hits.length) return [];

  const mergeInto = (windows, w, position) => {
    const last = windows[windows.length - 1];
    if (last && w.offset < last.offset + last.text.length) {
      // Overlapping: extend rather than duplicate.
      const end = Math.max(last.offset + last.text.length, w.offset + w.text.length);
      last.text = text.slice(last.offset, end);
      last.mentions.push(position);
      return;
    }
    windows.push({ ...w, mentions: [position] });
  };

  let windows = [];
  for (const hit of hits) {
    mergeInto(windows, evidenceWindow(text, hit.start, { maxChars }), hit.start);
    if (windows.length >= maxWindows) break;
  }
  if (!secondary.length || windows.length >= maxWindows) return windows;

  const inside = (position) => windows.some((w) => position >= w.offset && position < w.offset + w.text.length);
  for (const hit of findOccurrences(text, secondary)) {
    if (windows.length >= maxWindows) break;
    if (inside(hit.start)) continue;
    const added = [...windows, { ...evidenceWindow(text, hit.start, { maxChars }), mentions: [hit.start] }]
      .sort((a, b) => a.offset - b.offset);
    windows = [];
    for (const w of added) mergeInto(windows, { ...w, mentions: undefined }, w.mentions[0]);
    // Merging re-seeds each window's mentions from its first; restore the rest.
    for (const w of windows) {
      w.mentions = added
        .filter((a) => a.offset >= w.offset && a.offset < w.offset + w.text.length)
        .flatMap((a) => a.mentions);
    }
  }
  return windows;
}

/**
 * Anti-hallucination gate (§65). An association whose quoted evidence does not
 * appear in the passage is discarded, and the discard is counted so the job
 * report can show how often it happened.
 */
function evidenceSupported(windowText, quote) {
  if (!quote || quote.length < 8) return false;
  const hay = normaliseForMatch(windowText);
  const needle = normaliseForMatch(quote);
  if (hay.includes(needle)) return true;
  // Allow an elided quote: check that a long run of it is present.
  const words = needle.split(' ');
  if (words.length < 6) return false;
  const head = words.slice(0, Math.ceil(words.length * 0.6)).join(' ');
  return hay.includes(head);
}

export async function extractFromWindow(profile, window, { entityId = null, jobId = null, extraNames = [] } = {}) {
  // The LLM judges identity from the passage itself. The fallback extractor
  // only recognises the entity by name, so a window anchored on a surname
  // needs that surname counted as a name.
  const fallbackProfile = extraNames.length
    ? { ...profile, aliases: [...(profile.aliases ?? []), ...extraNames] }
    : profile;
  const llm = getLlm();
  if (!llm) return heuristicExtract(fallbackProfile, window);

  let res;
  try {
    res = await llmJson(
      {
        system: SYSTEM_PROMPT(profile),
        user: `PASSAGE:\n${window.text}`,
        schema: EXTRACTION_SCHEMA,
        schemaName: 'entity_associations',
        schemaDescription: 'Associations the passage draws between the target entity and other entities or concepts.',
        maxTokens: 4000,
      },
      { entityId, jobId, endpoint: 'extraction' }
    );
  } catch (err) {
    // A budget or quota stop must halt the whole run — falling back to the
    // heuristic there would quietly finish the build at the wrong quality.
    if (err.status === 429) throw err;
    // Anything else: degrade rather than drop the document. A rejected API key
    // used to lose every passage silently, which produced an empty dashboard
    // from a corpus the client had already paid for. Lower-quality evidence,
    // clearly labelled as such, beats no evidence and no explanation.
    return heuristicExtract(fallbackProfile, window);
  }
  if (!res) return heuristicExtract(fallbackProfile, window);

  const data = res.data ?? {};
  const kept = [];
  let discarded = 0;
  for (const a of data.associations ?? []) {
    if (!evidenceSupported(window.text, a.evidence)) { discarded += 1; continue; }
    if (normaliseForMatch(a.canonical_label) === normaliseForMatch(profile.canonical_name)) continue;
    kept.push({
      surface_form: normaliseWhitespace(a.surface_form),
      canonical_label: normaliseWhitespace(a.canonical_label),
      category: ASSOCIATION_CATEGORIES.includes(a.type) ? a.type : 'other',
      kind: a.kind === 'named_entity' ? 'named_entity' : 'concept',
      relationship: a.relationship || 'mentioned_with',
      relationship_confidence: round(clamp(a.relationship_confidence ?? 0.5), 3),
      sentiment: ['positive', 'negative', 'neutral'].includes(a.sentiment) ? a.sentiment : 'neutral',
      evidence: normaliseWhitespace(a.evidence),
    });
  }

  return {
    target_entity_confirmed: Boolean(data.target_entity_confirmed),
    target_confidence: round(clamp(data.target_confidence ?? 0), 3),
    associations: kept,
    discarded_unsupported: discarded,
    extractor: 'llm',
  };
}

// --- Deterministic fallback -------------------------------------------------

/**
 * Concept gazetteer for the heuristic extractor. Each entry maps trigger
 * phrases to a canonical label and category. It is not meant to be complete —
 * it is meant to make the pipeline demonstrably work end to end and to give
 * the canonicalisation stage (§19) real surface-form variety to cluster.
 */
const CONCEPT_GAZETTEER = [
  { label: 'Philanthropy', category: 'philanthropy', triggers: ['philanthropy', 'philanthropic', 'charitable giving', 'charitable activities', 'charity work', 'donation', 'donated', 'gift to', 'foundation grant', 'pledged'] },
  { label: 'Lawsuit', category: 'legal', triggers: ['lawsuit', 'sued', 'litigation', 'court filing', 'complaint against', 'legal action'] },
  { label: 'Investigation', category: 'controversy', triggers: ['investigation', 'investigating', 'probe', 'subpoena', 'inquiry into'] },
  { label: 'Contemporary Art', category: 'arts_culture', triggers: ['contemporary art', 'art collection', 'collector', 'gallery', 'museum', 'art fair'] },
  { label: 'Venture Capital', category: 'financial', triggers: ['venture capital', 'raised a fund', 'limited partners', 'portfolio company', 'seed round', 'series a'] },
  { label: 'Award', category: 'award', triggers: ['award', 'honoured', 'honored', 'prize', 'named to', 'recognised as', 'recognized as'] },
  { label: 'Politics', category: 'politics', triggers: ['campaign donation', 'political donation', 'lobbying', 'endorsed', 'super pac'] },
  { label: 'Education', category: 'education', triggers: ['graduated', 'alumnus', 'alumna', 'mba', 'studied at', 'degree from'] },
  { label: 'Board Membership', category: 'role', triggers: ['board of directors', 'serves on the board', 'board member', 'trustee', 'chairman of'] },
];

const RELATIONSHIP_PATTERNS = [
  { re: /\b(founder|co-founder|founded)\b[^.]{0,30}$/i, relationship: 'founder_of', confidence: 0.95 },
  { re: /\b(chief executive|ceo|president|chairman|managing partner)\b[^.]{0,30}$/i, relationship: 'leads', confidence: 0.93 },
  { re: /\b(serves on the board|board member|trustee|joined the board)\b[^.]{0,30}$/i, relationship: 'board_member', confidence: 0.93 },
  { re: /\b(donated|gave|pledged|contributed)\b[^.]{0,40}$/i, relationship: 'donated_to', confidence: 0.9 },
  { re: /\b(sued|filed suit against|accused|charged)\b[^.]{0,40}$/i, relationship: 'accused_of', confidence: 0.88 },
  { re: /\b(graduated from|studied at|earned)\b[^.]{0,30}$/i, relationship: 'educated_at', confidence: 0.9 },
  { re: /\b(attended|spoke at|appeared at)\b[^.]{0,30}$/i, relationship: 'attended', confidence: 0.4 },
];

const NAME_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'mr', 'mrs', 'ms', 'dr', 'he', 'she', 'they', 'it', 'this', 'that', 'his', 'her', 'their',
]);

const ORG_SUFFIX = /\b(inc|llc|ltd|plc|corp|corporation|company|foundation|institute|university|college|group|partners|capital|holdings|trust|association|society|museum|hospital|bank|fund)\b/i;

/**
 * A deterministic extractor: capitalised phrases become candidate named
 * entities, gazetteer hits become concepts, and a small pattern table assigns
 * the relationship. Lower precision than the LLM by design; every row it
 * writes is marked `extractor: 'heuristic'`.
 */
export function heuristicExtract(profile, window) {
  const text = window.text;
  const aliases = [profile.canonical_name, ...(profile.aliases ?? [])];
  const aliasNormals = new Set(aliases.map((a) => normaliseForMatch(a)));
  const sentences = splitSentences(text);
  const associations = [];
  const seen = new Set();

  for (const sentence of sentences) {
    const s = sentence.text;
    const mentionsTarget = findOccurrences(s, aliases).length > 0;

    // Named entities: runs of capitalised words, minus the target's own names.
    const candidates = s.match(/\b([A-Z][\p{L}&'’.-]*(?:\s+(?:of|and|the|for|de|van|von)?\s*[A-Z][\p{L}&'’.-]*){0,4})/gu) ?? [];
    for (const raw of candidates) {
      const candidate = normaliseWhitespace(raw)
        .replace(/[.,;:]$/, '')
        // A greedy capitalised run swallows the words either side of the name:
        // "Investor John Smith" and "XYZ Foundation John Smith" are artefacts
        // of the match, not associations. Strip a leading article, then reject
        // anything that still contains one of the entity's own names.
        .replace(/^(The|A|An|From|In|At|On|After|Before|Analysis|Interview|Profile|Inside|Regulators)\s+/i, '');
      const key = normaliseForMatch(candidate);
      if (!key || key.length < 4 || seen.has(key)) continue;
      if (aliasNormals.has(key)) continue;
      if ([...aliasNormals].some((alias) => key.includes(alias) || alias.includes(key))) continue;
      if (key.split(' ').every((w) => NAME_STOPWORDS.has(w))) continue;
      // A single capitalised word at the start of a sentence is usually just
      // the sentence starting, not a name.
      const words = candidate.split(' ');
      if (words.length === 1 && s.trimStart().startsWith(candidate) && !ORG_SUFFIX.test(candidate)) continue;
      if (words.length === 1 && !ORG_SUFFIX.test(candidate)) continue;

      const before = s.slice(0, s.indexOf(raw));
      const pattern = RELATIONSHIP_PATTERNS.find((p) => p.re.test(before));
      seen.add(key);
      associations.push({
        surface_form: candidate,
        canonical_label: candidate,
        category: ORG_SUFFIX.test(candidate) ? 'organization' : 'other',
        kind: 'named_entity',
        relationship: pattern?.relationship ?? (mentionsTarget ? 'mentioned_with' : 'co_occurs_with'),
        relationship_confidence: pattern?.confidence ?? (mentionsTarget ? 0.35 : 0.2),
        sentiment: 'neutral',
        evidence: normaliseWhitespace(s),
      });
    }

    // Concepts from the gazetteer.
    const lower = normaliseForMatch(s);
    for (const entry of CONCEPT_GAZETTEER) {
      const trigger = entry.triggers.find((t) => lower.includes(normaliseForMatch(t)));
      if (!trigger) continue;
      const key = 'concept:' + normaliseForMatch(entry.label);
      if (seen.has(key)) continue;
      seen.add(key);
      associations.push({
        surface_form: trigger,
        canonical_label: entry.label,
        category: entry.category,
        kind: 'concept',
        relationship: 'involved_in',
        relationship_confidence: mentionsTarget ? 0.6 : 0.3,
        sentiment: entry.category === 'legal' || entry.category === 'controversy' ? 'negative' : 'neutral',
        evidence: normaliseWhitespace(s),
      });
    }
  }

  return {
    target_entity_confirmed: findOccurrences(text, aliases).length > 0,
    target_confidence: findOccurrences(text, aliases).length > 0 ? 0.6 : 0,
    associations,
    discarded_unsupported: 0,
    extractor: 'heuristic',
  };
}

export { EXTRACTION_SCHEMA, SYSTEM_PROMPT, evidenceSupported };
