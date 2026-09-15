import { MODEL } from '../config.js';
import { all, get, run } from '../db.js';
import { buildWindows, extractFromWindow } from './extraction.js';
import { avoidTermsFor } from './content-checks.js';
import { surnameAnchor } from './serp-coverage.js';
import { countIndependent } from './audit-rules.js';
import { canonicaliseUrl, rootDomain } from '../util/hash.js';
import {
  classifyBoundary, findOccurrences, labelKey, normaliseForMatch, normaliseWhitespace, splitParagraphs, splitSentences, tokenDistance,
} from '../util/text.js';

/**
 * §99 — what an audit knows about a text before any check runs: the claims it
 * makes, whether the corpus can stand behind each one, and what counts as
 * adverse for the client.
 */

export function clientNames(profile) {
  const surname = surnameAnchor(profile);
  return [...new Set([profile.canonical_name, ...(profile.aliases ?? []), ...(surname ? [surname] : [])].filter(Boolean))];
}

/** Domains the client controls: known URL markers and owned assets. */
export function ownDomains(entityId, profile) {
  const markers = (profile.markers ?? []).filter((m) => m.kind === 'url' && m.polarity !== -1).map((m) => m.value);
  const owned = all(`SELECT host_domain FROM content_assets WHERE entity_id = ? AND kind = 'owned'`, entityId).map((a) => a.host_domain);
  return [...new Set([...markers, ...owned].filter(Boolean).map((d) => d.toLowerCase().replace(/^www\./, '')))];
}

// --- Adverse associations ---------------------------------------------------------------

/**
 * The exclusion set for C1 and C7: associations an analyst has marked adverse,
 * plus the one a generated draft was written to displace. Tone is not used —
 * it is too noisy to decide what a client can never be linked with.
 */
export function exclusionsFor(entityId, { profile, contentDraft = null } = {}) {
  const rows = all(
    `SELECT a.id, a.canonical_label, a.kind, a.category, 'analyst' AS source
       FROM association_polarity p JOIN associations a ON a.id = p.association_id
      WHERE p.entity_id = ? AND p.polarity = 'adverse'`,
    entityId
  );
  if (contentDraft?.purpose === 'displace' && !rows.some((r) => r.id === contentDraft.association_id)) {
    const displaced = get(`SELECT id, canonical_label, kind, category, 'displaced' AS source FROM associations WHERE id = ?`, contentDraft.association_id);
    if (displaced) rows.push(displaced);
  }
  return rows.map((r) => {
    const aliases = all(`SELECT surface_form FROM association_aliases WHERE association_id = ?`, r.id).map((x) => x.surface_form);
    const terms = avoidTermsFor({ label: r.canonical_label, kind: r.kind, category: r.category, aliases, entityName: profile.canonical_name })
      .filter((t) => t.severity === 'block' && t.term.length >= MODEL.audit.exclusion.minTermChars)
      .map((t) => t.term);
    return { association_id: r.id, label: r.canonical_label, kind: r.kind, category: r.category, source: r.source, terms };
  });
}

/** Candidates an analyst may want to mark adverse: mostly negative, well evidenced, not an identity marker. */
export function suggestAdverse(entityId, profile, { limit = 10 } = {}) {
  const markerKeys = new Set((profile.markers ?? []).map((m) => labelKey(m.value)));
  return all(
    `SELECT a.id AS association_id, a.canonical_label AS label, a.kind, a.category,
            AVG(e.sentiment_negative) AS negative_share, COUNT(DISTINCT e.document_id) AS documents
       FROM evidence e JOIN associations a ON a.id = e.association_id
      WHERE e.entity_id = ? AND e.excluded = 0 AND a.status = 'active'
        AND a.id NOT IN (SELECT association_id FROM association_polarity WHERE entity_id = ?)
      GROUP BY a.id
     HAVING documents >= 5 AND negative_share >= 0.45
      ORDER BY documents DESC
      LIMIT ?`,
    entityId,
    entityId,
    limit * 2
  )
    .filter((s) => !markerKeys.has(labelKey(s.label)))
    .slice(0, limit)
    .map((s) => ({ ...s, negative_share: Math.round(s.negative_share * 100) / 100 }));
}

export function setPolarity(entityId, associationId, polarity, { reason = null, user = null } = {}) {
  if (!polarity) {
    run(`DELETE FROM association_polarity WHERE association_id = ? AND entity_id = ?`, associationId, entityId);
    return null;
  }
  run(
    `INSERT INTO association_polarity (association_id, entity_id, polarity, reason, set_by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(association_id) DO UPDATE SET polarity = excluded.polarity, reason = excluded.reason,
       set_by = excluded.set_by, set_at = datetime('now')`,
    associationId,
    entityId,
    polarity,
    reason,
    user?.id ?? null
  );
  return get(`SELECT * FROM association_polarity WHERE association_id = ?`, associationId);
}

// --- Support in the corpus --------------------------------------------------------------------

/** Accepted documents holding evidence for an association, with what C4 needs to count independence. */
export function supportDocs(associationId, { excludeUrls = [] } = {}) {
  const excluded = new Set(excludeUrls.filter(Boolean).map((u) => canonicaliseUrl(u)));
  return all(
    `SELECT DISTINCT d.id AS document_id, d.url, d.canonical_url, d.root_domain, d.duplicate_cluster_id, dom.owner_key
       FROM evidence e
       JOIN documents d ON d.id = e.document_id
       JOIN entity_document_matches m ON m.document_id = d.id AND m.entity_id = e.entity_id AND m.verdict = 'accept'
       LEFT JOIN domains dom ON dom.root_domain = d.root_domain
      WHERE e.association_id = ? AND e.excluded = 0`,
    associationId
  ).filter((d) => !excluded.has(d.canonical_url ?? canonicaliseUrl(d.url)));
}

function associationResolver(entityId) {
  const rows = all(`SELECT id, canonical_label, kind, category, status, merged_into_id FROM associations WHERE entity_id = ?`, entityId);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byKey = new Map();
  for (const r of rows) if (!byKey.has(labelKey(r.canonical_label)) || r.status === 'active') byKey.set(labelKey(r.canonical_label), r);
  for (const alias of all(
    `SELECT x.association_id, x.surface_form FROM association_aliases x JOIN associations a ON a.id = x.association_id WHERE a.entity_id = ?`,
    entityId
  )) {
    const key = labelKey(alias.surface_form);
    if (!byKey.has(key)) byKey.set(key, byId.get(alias.association_id));
  }
  return (label) => {
    let hit = byKey.get(labelKey(label)) ?? null;
    for (let hops = 0; hit?.status === 'merged' && hit.merged_into_id && hops < 5; hops += 1) hit = byId.get(hit.merged_into_id) ?? null;
    return hit?.status === 'active' ? hit : null;
  };
}

// --- Extraction ---------------------------------------------------------------------------------------

function sentenceAround(text, quote) {
  const sentences = splitSentences(text);
  const needle = normaliseWhitespace(quote ?? '').slice(0, 60);
  const at = needle ? text.indexOf(needle) : -1;
  const hit = at >= 0 ? sentences.find((s) => at >= s.start && at < s.end) : null;
  return normaliseWhitespace(hit?.text ?? quote ?? '').slice(0, 600);
}

/**
 * §99 C2's extraction pass: the same extractor the corpus uses, over windows
 * around the client's name, each claim resolved against the corpus. The
 * factors are kept per row, as they are for corpus evidence.
 */
export async function extractFacts({ entityId, profile, text, excludeUrls = [], jobId = null }) {
  const names = clientNames(profile);
  const surname = surnameAnchor(profile);
  const aliases = [profile.canonical_name, ...(profile.aliases ?? [])];
  const windows = buildWindows(text, aliases, {
    maxWindows: MODEL.audit.extraction.maxWindows,
    secondary: surname ? [surname] : [],
  });
  const resolve = associationResolver(entityId);
  const extractors = new Set();
  const seen = new Set();
  const facts = [];

  for (const window of windows) {
    let extraction;
    try {
      extraction = await extractFromWindow(profile, window, { entityId, jobId, extraNames: surname ? [surname] : [] });
    } catch (err) {
      if (err.status === 429) throw err;
      continue;
    }
    extractors.add(extraction.extractor);
    if (!extraction.target_entity_confirmed) continue;
    const sentences = splitSentences(window.text);
    const paragraphs = splitParagraphs(window.text);

    for (const a of extraction.associations) {
      const sentence = sentenceAround(window.text, a.evidence);
      const key = `${labelKey(a.canonical_label)}|${a.relationship}|${normaliseForMatch(sentence)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      let distance = null;
      let boundary = 'same_paragraph';
      for (const n of findOccurrences(window.text, names)) {
        for (const hit of findOccurrences(window.text, [a.surface_form, a.canonical_label])) {
          const d = tokenDistance(window.text, n.start, hit.start, {});
          if (distance === null || d < distance) {
            distance = d;
            boundary = classifyBoundary(window.text, n.start, hit.start, { sentences, paragraphs });
          }
        }
      }

      const association = resolve(a.canonical_label) ?? resolve(a.surface_form);
      const docs = association ? supportDocs(association.id, { excludeUrls }) : [];
      const resolved = docs.length >= MODEL.audit.support.minSources;
      facts.push({
        association_id: association?.id ?? null,
        extracted_claim: a.canonical_label,
        relationship: a.relationship,
        kind: a.kind,
        category: a.category,
        sentence,
        surface_form: a.surface_form,
        evidence: a.evidence,
        relationship_confidence: a.relationship_confidence,
        sentiment: a.sentiment,
        token_distance: distance,
        boundary,
        resolution: resolved ? 'resolved' : 'unsupported',
        sources: docs.length,
        independent_sources: countIndependent(docs).independent,
        extractor: extraction.extractor,
        support: docs,
      });
    }
  }

  const extractor = !windows.length ? 'none' : extractors.has('llm') && extractors.size === 1 ? 'llm' : extractors.has('heuristic') ? 'heuristic' : 'llm';
  return { extractor, windows: windows.length, facts };
}

/** Stored facts for unchanged text, with their corpus support looked up again (the corpus may have grown). */
export function storedFacts(draftId, textHash, { excludeUrls = [] } = {}) {
  const rows = all(`SELECT * FROM audit_draft_fact WHERE draft_id = ? AND text_hash = ? ORDER BY id`, draftId, textHash);
  return rows.map((row) => {
    const docs = row.association_id ? supportDocs(row.association_id, { excludeUrls }) : [];
    const resolved = docs.length >= MODEL.audit.support.minSources;
    return {
      ...row,
      resolution: resolved ? 'resolved' : 'unsupported',
      sources: docs.length,
      independent_sources: countIndependent(docs).independent,
      support: docs,
    };
  });
}

export { rootDomain };
