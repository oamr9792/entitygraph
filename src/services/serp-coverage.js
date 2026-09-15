import { normaliseForMatch } from '../util/text.js';

/**
 * How thoroughly Google's own result pages for the client's name are read, and
 * how to explain where each one ended up.
 *
 * Kept free of the database so the rules can be tested on their own. The
 * pipeline applies them; the trace screen reports against them.
 */

// A page shorter than this has usually come back as a cookie wall, a login
// shell or a script-rendered page with no text — not the page Google indexed.
export const MIN_READABLE_CHARS = 1500;

// Passages read per page, by Google position. Everything else keeps the
// pipeline's default.
export const SERP_WINDOW_BUDGET = [
  { maxRank: 20, windows: 8 },
  { maxRank: 100, windows: 5 },
];

export function windowsForRank(rank, fallback = 3) {
  if (!rank) return fallback;
  const tier = SERP_WINDOW_BUDGET.find((t) => rank <= t.maxRank);
  return tier ? Math.max(tier.windows, fallback) : fallback;
}

/** True when a page has not yet been read well enough to extract from. */
export function needsFullRead(doc) {
  if (!doc) return false;
  if (['snippet_only', 'blocked', 'failed', 'skipped'].includes(doc.fetch_status)) return true;
  return (doc.body_chars ?? 0) < MIN_READABLE_CHARS;
}

const SUFFIXES = /^(jr|sr|ii|iii|iv|phd|md|esq|kc|qc|cbe|obe|mbe)$/i;

/**
 * The surname a profile page uses after naming someone in full once. Only for
 * people, and only when it is long enough not to match ordinary words.
 */
export function surnameAnchor(profile) {
  if (!profile || profile.entity_type !== 'person') return null;
  const tokens = String(profile.canonical_name ?? '')
    .split(/\s+/)
    .map((t) => t.replace(/[.,]/g, ''))
    .filter(Boolean);
  while (tokens.length > 2 && SUFFIXES.test(tokens.at(-1))) tokens.pop();
  if (tokens.length < 2) return null;
  const surname = tokens.at(-1);
  return normaliseForMatch(surname).length >= 4 ? surname : null;
}

export function describeRead(doc) {
  if (!doc) return null;
  if (doc.fetch_status === 'blocked') return 'blocked — Google’s description only';
  if (doc.fetch_status === 'failed') return 'could not be fetched — Google’s description only';
  if (doc.fetch_status === 'snippet_only' || !doc.body_chars) return 'not fetched — Google’s description only';
  const chars = Number(doc.body_chars).toLocaleString('en-GB');
  return doc.body_chars < MIN_READABLE_CHARS ? `short page (${chars} characters)` : `full page (${chars} characters)`;
}

const parseReasons = (reasons) => {
  if (Array.isArray(reasons)) return reasons;
  try { return JSON.parse(reasons ?? '[]'); } catch { return []; }
};

export function rejectionReason(match) {
  const reasons = parseReasons(match?.reasons);
  const llm = reasons.find((r) => r.kind === 'llm');
  if (llm?.value) return `Rejected as a different person: ${llm.value}`;
  if (reasons.some((r) => r.kind === 'name' && /no alias/.test(String(r.value)))) {
    return 'Rejected: the page never names the client, so Google matched something else — often a different person with the same surname.';
  }
  if (reasons.some((r) => r.kind === 'empty')) return 'Rejected: no text at all was retrieved for it.';
  return `Rejected: identity confidence ${Number(match?.entity_confidence ?? 0).toFixed(2)}, with no confirming detail such as employer, role or city found on the page.`;
}

export const STAGE_ORDER = ['evidence', 'fallback_only', 'no_evidence', 'not_read', 'in_review', 'rejected', 'not_checked', 'not_collected'];

/** Where one Google result ended up, in words someone can act on. */
export function traceStage({ doc = null, match = null, evidence = { rows: 0, heuristic: 0 } } = {}) {
  if (!doc) return { stage: 'not_collected', text: 'Not collected: the build never added this page to the corpus.' };
  if (!match) {
    return { stage: 'not_checked', text: 'Collected, but never checked against the identity profile. The build may have stopped before that step.' };
  }
  if (match.verdict === 'reject') return { stage: 'rejected', text: rejectionReason(match) };
  if (match.verdict === 'review') {
    return { stage: 'in_review', text: 'Waiting for someone to confirm it is the same person. Until then it counts for nothing.' };
  }
  const rows = evidence?.rows ?? 0;
  const heuristic = evidence?.heuristic ?? 0;
  if (!rows) {
    return needsFullRead(doc)
      ? { stage: 'not_read', text: `Accepted, but the page itself was not read (${describeRead(doc)}), and the description alone gave nothing to extract.` }
      : { stage: 'no_evidence', text: 'Accepted and read, but nothing was extracted near the client’s name.' };
  }
  if (heuristic >= rows) {
    return { stage: 'fallback_only', text: `${rows} evidence rows, all from the fallback extractor, which is less accurate.` };
  }
  return { stage: 'evidence', text: `${rows} evidence rows${heuristic ? `, ${heuristic} of them from the fallback extractor` : ''}.` };
}
