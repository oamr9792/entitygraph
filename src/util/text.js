/**
 * Text mechanics for §15 (evidence windows) and §24/§25 (textual proximity).
 *
 * Everything here works on character offsets into one document string. Offsets
 * rather than substrings, because proximity is a distance measurement and a
 * pipeline that loses positions early cannot measure it later.
 */

export const normaliseWhitespace = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Lowercase, strip accents, reduce every run of non-alphanumerics to one
 * space. Used for matching, never for storage or display.
 *
 * `normaliseWithMap` does the same work but also returns, for every character
 * of the normalised string, the offset it came from in the original. Proximity
 * is measured in the original text, so a matcher that loses that mapping can
 * find a mention but cannot say where it is.
 */
export function normaliseForMatch(s) {
  return normaliseWithMap(String(s ?? '')).normalised;
}

const COMBINING = /[̀-ͯ]/g;

export function normaliseWithMap(text) {
  let out = '';
  const map = [];
  let lastWasSpace = true; // leading whitespace is trimmed, so start "in" a space
  for (let i = 0; i < text.length; i += 1) {
    const folded = text[i].normalize('NFKD').replace(COMBINING, '').toLowerCase();
    for (const c of folded) {
      if (/[\p{L}\p{N}]/u.test(c)) {
        out += c;
        map.push(i);
        lastWasSpace = false;
      } else if (!lastWasSpace) {
        out += ' ';
        map.push(i);
        lastWasSpace = true;
      }
    }
  }
  while (out.endsWith(' ')) {
    out = out.slice(0, -1);
    map.pop();
  }
  map.push(text.length); // one past the end, so end offsets resolve
  return { normalised: out, map };
}

/**
 * Canonical key for an association label. Deliberately aggressive: it folds
 * plurals and possessives so "philanthropies" and "philanthropy's" collide
 * before the embedding stage ever runs. It does NOT fold synonyms — that is
 * §19's job and needs evidence, not string surgery.
 */
export function labelKey(s) {
  // Possessives are stripped before normalisation, because normalisation turns
  // the apostrophe into a space and would otherwise leave a stray "s" token.
  const depossessed = String(s ?? '').replace(/['’]s\b/g, '');
  return normaliseForMatch(depossessed)
    .split(' ')
    .map((w) => (w.length > 3 ? w.replace(/ies$/, 'y').replace(/([^s])s$/, '$1') : w))
    .filter(Boolean)
    .join(' ');
}

const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;

/** Tokens with their character offsets, so distances survive downstream. */
export function tokenize(text) {
  const out = [];
  const re = new RegExp(TOKEN_RE);
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length, index: out.length });
  }
  return out;
}

export const tokenCount = (text) => {
  const re = new RegExp(TOKEN_RE);
  let n = 0;
  while (re.exec(text) !== null) n += 1;
  return n;
};

// Abbreviations whose full stop does not end a sentence. Short list on purpose:
// every entry is a case that actually appears in the corpora we read (titles,
// company suffixes, US place names, editorial furniture).
const ABBREV = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'rev', 'hon', 'gov', 'sen', 'rep',
  'inc', 'ltd', 'llc', 'llp', 'plc', 'co', 'corp', 'no', 'vs', 'etc', 'al', 'approx', 'est',
  'u.s', 'u.k', 'e.g', 'i.e', 'a.m', 'p.m',
]);

/**
 * Sentence boundaries with offsets. Not a parser — a heuristic splitter that
 * knows about abbreviations, initials and quoted speech, which is the level of
 * accuracy proximity scoring actually needs.
 */
export function splitSentences(text) {
  const sentences = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;

    // Swallow trailing quotes/brackets so they stay with this sentence.
    let end = i + 1;
    while (end < text.length && /["'”’)\]]/.test(text[end])) end += 1;

    const after = text.slice(end, end + 2);
    const isEnd = end >= text.length || /^\s/.test(after);
    if (!isEnd) continue;

    if (ch === '.') {
      const before = text.slice(Math.max(0, i - 12), i);
      const lastWord = before.match(/[\p{L}.]+$/u)?.[0] || '';
      if (ABBREV.has(lastWord.toLowerCase())) continue;
      // A single capital before the stop is an initial, not a sentence end:
      // "John A. Smith". The case test has to run on the raw word — lowercasing
      // first makes every initial look like an ordinary one-letter word.
      if (/^\p{Lu}$/u.test(lastWord)) continue;
    }

    const body = text.slice(start, end);
    if (body.trim()) sentences.push({ text: body, start, end });
    start = end;
    while (start < text.length && /\s/.test(text[start])) start += 1;
    i = start - 1;
  }
  if (start < text.length && text.slice(start).trim()) {
    sentences.push({ text: text.slice(start), start, end: text.length });
  }
  return sentences;
}

export function splitParagraphs(text) {
  const out = [];
  const re = /\n[ \t]*\n+/g;
  let start = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (text.slice(start, m.index).trim()) out.push({ text: text.slice(start, m.index), start, end: m.index });
    start = m.index + m[0].length;
  }
  if (text.slice(start).trim()) out.push({ text: text.slice(start), start, end: text.length });
  return out;
}

/** Index lookup: which sentence/paragraph does a character offset fall in? */
function indexOfSpan(spans, offset) {
  for (let i = 0; i < spans.length; i += 1) {
    if (offset >= spans[i].start && offset < spans[i].end) return i;
  }
  return spans.length ? spans.length - 1 : -1;
}

/**
 * §25 — the grammatical boundary between two positions.
 *
 * A comma does NOT break a clause here. The strongest association pattern in
 * this corpus is the appositive — "John Smith, founder of ABC Capital" — and
 * treating its comma as a clause break would systematically under-score the
 * clearest evidence we have. Semicolons, colons, dashes and brackets do break.
 */
export function classifyBoundary(text, posA, posB, precomputed = null) {
  const sentences = precomputed?.sentences ?? splitSentences(text);
  const paragraphs = precomputed?.paragraphs ?? splitParagraphs(text);
  const sa = indexOfSpan(sentences, posA);
  const sb = indexOfSpan(sentences, posB);

  if (sa === sb && sa >= 0) {
    const [lo, hi] = posA < posB ? [posA, posB] : [posB, posA];
    const between = text.slice(lo, hi);
    return /[;:—–()[\]|]|--/.test(between) ? 'same_sentence' : 'same_clause';
  }
  if (sa >= 0 && sb >= 0 && Math.abs(sa - sb) === 1) return 'adjacent_sentence';

  const pa = indexOfSpan(paragraphs, posA);
  const pb = indexOfSpan(paragraphs, posB);
  if (pa >= 0 && pa === pb) return 'same_paragraph';
  return 'different_paragraph';
}

/** Token distance between two character offsets (§24). */
export function tokenDistance(text, posA, posB, precomputed = null) {
  const tokens = precomputed?.tokens ?? tokenize(text);
  if (!tokens.length) return Math.abs(posA - posB);
  const nearest = (pos) => {
    let best = 0;
    let bestDist = Infinity;
    for (const t of tokens) {
      const d = pos >= t.start && pos < t.end ? 0 : Math.min(Math.abs(t.start - pos), Math.abs(t.end - pos));
      if (d < bestDist) { bestDist = d; best = t.index; }
      if (d === 0) break;
    }
    return best;
  };
  return Math.abs(nearest(posA) - nearest(posB));
}

/**
 * §15 — the EvidenceWindow. The paragraph containing the entity plus one
 * sentence either side, capped at ±1,000 characters around the mention.
 *
 * The cap is a legal position as much as a technical one: we keep what an
 * analyst needs to audit a score, not a copy of the article.
 */
export function evidenceWindow(text, position, { maxChars = 1000 } = {}) {
  const sentences = splitSentences(text);
  const paragraphs = splitParagraphs(text);
  const si = indexOfSpan(sentences, position);
  const pi = indexOfSpan(paragraphs, position);

  const sentence = si >= 0 ? sentences[si] : null;
  const prev = si > 0 ? sentences[si - 1] : null;
  const next = si >= 0 && si + 1 < sentences.length ? sentences[si + 1] : null;
  const paragraph = pi >= 0 ? paragraphs[pi] : null;

  const lo = Math.max(
    0,
    Math.min(prev?.start ?? Infinity, paragraph?.start ?? Infinity, position - maxChars)
  );
  const hi = Math.min(
    text.length,
    Math.max(next?.end ?? 0, paragraph?.end ?? 0, position + maxChars)
  );
  const clampedLo = Math.max(lo, position - maxChars);
  const clampedHi = Math.min(hi, position + maxChars);

  return {
    text: text.slice(clampedLo, clampedHi),
    offset: clampedLo,
    position,
    relative_position: position - clampedLo,
    sentence: sentence ? normaliseWhitespace(sentence.text) : '',
    previous_sentence: prev ? normaliseWhitespace(prev.text) : '',
    next_sentence: next ? normaliseWhitespace(next.text) : '',
    paragraph: paragraph ? normaliseWhitespace(paragraph.text).slice(0, 2 * maxChars) : '',
  };
}

/**
 * All occurrences of any of `phrases` in `text`, as character offsets.
 * Matching is accent- and case-insensitive and requires word boundaries, so
 * "Smith" does not match inside "Smithsonian".
 */
export function findOccurrences(text, phrases) {
  const { normalised: hay, map } = normaliseWithMap(text);
  const out = [];
  for (const phrase of phrases) {
    const needle = normaliseForMatch(phrase);
    if (!needle) continue;
    let from = 0;
    for (;;) {
      const idx = hay.indexOf(needle, from);
      if (idx < 0) break;
      const beforeOk = idx === 0 || hay[idx - 1] === ' ';
      const afterIdx = idx + needle.length;
      const afterOk = afterIdx >= hay.length || hay[afterIdx] === ' ';
      if (beforeOk && afterOk) {
        out.push({
          phrase,
          normalised: needle,
          start: map[idx] ?? 0,
          end: map[Math.min(afterIdx, map.length - 1)] ?? text.length,
        });
      }
      from = idx + Math.max(1, needle.length);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * §10 — alias variants worth searching for, derived from a person's name.
 * Generated variants are marked as such in the database so a reviewer can tell
 * them apart from names the client actually supplied.
 */
export function generateNameVariants(canonicalName, entityType = 'person') {
  const name = normaliseWhitespace(canonicalName);
  const variants = new Set();
  if (!name) return [];
  if (entityType !== 'person') {
    variants.add(name.replace(/,?\s+(inc|llc|ltd|plc|corp|corporation|company|co)\.?$/i, '').trim());
    return [...variants].filter((v) => v && v !== name);
  }

  const parts = name.split(' ').filter(Boolean);
  if (parts.length >= 3) {
    const [first, ...rest] = parts;
    const last = rest[rest.length - 1];
    const middles = rest.slice(0, -1);
    // "John Andrew Smith" -> "John A. Smith", "John A Smith", "John Smith"
    const initials = middles.map((m) => m[0].toUpperCase());
    variants.add(`${first} ${initials.map((i) => i + '.').join(' ')} ${last}`);
    variants.add(`${first} ${initials.join(' ')} ${last}`);
    variants.add(`${first} ${last}`);
  }
  if (parts.length === 2) {
    const [first, last] = parts;
    // The reverse direction: a two-part name gains its middle-initial forms
    // only if someone supplies the middle name, so we generate the initial-only
    // pattern which is what wire copy tends to use.
    variants.add(`${first[0]}. ${last}`);
  }
  variants.delete(name);
  return [...variants].filter(Boolean);
}

/** Cheap keyword presence test used by the marker-based disambiguator. */
export function containsPhrase(haystackNormalised, phrase) {
  const needle = normaliseForMatch(phrase);
  if (!needle) return false;
  const idx = haystackNormalised.indexOf(needle);
  if (idx < 0) return false;
  const beforeOk = idx === 0 || haystackNormalised[idx - 1] === ' ';
  const after = idx + needle.length;
  const afterOk = after >= haystackNormalised.length || haystackNormalised[after] === ' ';
  return beforeOk && afterOk;
}
