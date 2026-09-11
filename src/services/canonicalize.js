import { all, get, run, tx } from '../db.js';
import { labelKey, normaliseWhitespace } from '../util/text.js';
import { round } from '../util/stats.js';
import { embed, cosine, storeEmbedding, loadEmbeddings, embeddingModelName } from '../providers/embeddings/index.js';
import { llmJson, getLlm } from '../providers/llm/index.js';
import config from '../config.js';

/**
 * §19, §20 — association canonicalisation and hierarchy.
 *
 * "philanthropy", "philanthropic work", "charitable giving", "charity work"
 * are one association wearing four coats. Clustering them is what turns a long
 * tail of near-synonyms into a leaderboard row with real evidence behind it.
 *
 * The rule §19 states and this module enforces: **do not merge simply because
 * embeddings are similar**. Similarity only nominates a pair. A merge requires
 * either exact key equality after normalisation, or an explicit confirmation —
 * from the LLM, or from a human. With no LLM configured, similar-but-unproven
 * pairs are recorded as suggestions and left unmerged, which is the safe
 * failure: an unmerged pair understates a score, a wrong merge invents one.
 */

// Cosine above which a pair is worth confirming. The local hashing embedder is
// weak, so its threshold is lower — it is a shortlister, not a judge.
const SHORTLIST_THRESHOLD = () => (config.embeddings.provider === 'openai' ? 0.82 : 0.3);

/**
 * Words that describe what *kind of thing* something is, rather than which
 * thing it is. "Private equity" and "private equity funds" name one concept;
 * the second just says what form it takes.
 *
 * This list is the whole safety mechanism for containment merging, so it stays
 * narrow on purpose. "Youth hockey" must never fold into "hockey" and
 * "education philanthropy" must never fold into "philanthropy" — those extra
 * words restrict the meaning. These do not.
 */
const GENERIC_TYPE_WORDS = new Set([
  'activity', 'activities', 'business', 'businesses', 'company', 'companies',
  'firm', 'firms', 'fund', 'funds', 'group', 'industry', 'industries',
  'management', 'market', 'markets', 'operation', 'operations', 'practice',
  'sector', 'sectors', 'service', 'services', 'space', 'work', 'works',
  'investing', 'investment', 'investments',
]);

/**
 * True when `longer` is `shorter` plus nothing but generic type words — in
 * either position, so "private equity fund" and "fund of private equity" both
 * reduce. Order of the shared tokens must be preserved; an anagram is not a
 * variant.
 */
export function isGenericVariant(shorter, longer) {
  const a = labelKey(shorter).split(' ').filter(Boolean);
  const b = labelKey(longer).split(' ').filter(Boolean);
  if (!a.length || b.length <= a.length) return false;

  // Walk b, consuming a's tokens in order; every unconsumed token must be
  // generic.
  let ai = 0;
  const leftovers = [];
  for (const token of b) {
    if (ai < a.length && token === a[ai]) ai += 1;
    else leftovers.push(token);
  }
  if (ai !== a.length) return false;
  return leftovers.length > 0 && leftovers.every((t) => GENERIC_TYPE_WORDS.has(t));
}

// An extracted "entity" that runs to a full clause is a failed extraction, not
// a name. These are rejected at the door rather than cluttering the graph and
// the merge shortlist — the evidence text still holds the sentence.
const MAX_LABEL_TOKENS = 8;
const CLAUSE_MARKERS = /\b(is|was|are|were|has|have|had|formed by|owned by|founded by|which|that|who)\b/i;

export function isSentenceLike(label) {
  const text = normaliseWhitespace(label);
  if (!text) return true;
  const tokens = text.split(' ').filter(Boolean);
  if (tokens.length > MAX_LABEL_TOKENS) return true;
  // A clause marker only condemns a label that is also long enough to be a
  // sentence; "Investment Advisers Act of 1940" contains none of them, and
  // something like "Who's Who" should survive on length.
  return tokens.length >= 5 && CLAUSE_MARKERS.test(text);
}

export function upsertAssociation(entityId, { canonical_label, kind, category = 'other' }) {
  const label = normaliseWhitespace(canonical_label);
  if (!label) return null;
  if (isSentenceLike(label)) return null;
  const key = labelKey(label);

  // Match on the normalised key rather than the literal label, so
  // "Philanthropies" and "philanthropy" land on the same row without any
  // clustering pass at all.
  //
  // Merged rows are searched too, and deliberately so. The UNIQUE index covers
  // every row whatever its status, so skipping merged ones does not avoid a
  // collision — it guarantees one. A rebuild after a canonicalisation pass
  // re-extracts a label that now survives only as a merged row, the lookup
  // misses it, and the insert fails. Following the merge instead is also the
  // right answer semantically: that label was judged to be this other thing,
  // so its evidence belongs on the survivor.
  const existing = all(
    `SELECT * FROM associations WHERE entity_id = ? AND kind = ?`,
    entityId,
    kind
  ).find((a) => labelKey(a.canonical_label) === key);

  if (existing) {
    const target = resolveMergeTarget(existing);
    if (target.category === 'other' && category !== 'other') {
      run(`UPDATE associations SET category = ?, updated_at = datetime('now') WHERE id = ?`, category, target.id);
    }
    return target.id;
  }

  // ON CONFLICT rather than a bare INSERT: two labels can normalise to
  // different keys and still be byte-identical after whitespace normalisation,
  // and this path runs from a concurrent pool. A collision here should return
  // the existing row, not kill the build.
  run(
    `INSERT INTO associations (entity_id, canonical_label, kind, category) VALUES (?, ?, ?, ?)
     ON CONFLICT(entity_id, canonical_label, kind)
     DO UPDATE SET updated_at = datetime('now')`,
    entityId,
    label,
    kind,
    category
  );
  const row = get(
    `SELECT * FROM associations WHERE entity_id = ? AND canonical_label = ? AND kind = ?`,
    entityId,
    label,
    kind
  );
  return row ? resolveMergeTarget(row).id : null;
}

/**
 * Follows merged_into_id to the surviving association. Merges can chain when
 * A is merged into B and B is later merged into C, so this walks rather than
 * dereferencing once, with a visited set because a mis-set pointer must not
 * hang the pipeline.
 */
function resolveMergeTarget(association) {
  let current = association;
  const seen = new Set([current.id]);
  while (current.status === 'merged' && current.merged_into_id) {
    if (seen.has(current.merged_into_id)) break;
    const next = get(`SELECT * FROM associations WHERE id = ?`, current.merged_into_id);
    if (!next) break;
    seen.add(next.id);
    current = next;
  }
  return current;
}

export function recordSurfaceForm(associationId, surfaceForm) {
  const clean = normaliseWhitespace(surfaceForm);
  if (!clean) return;
  run(
    `INSERT INTO association_aliases (association_id, surface_form, occurrences) VALUES (?, ?, 1)
     ON CONFLICT(association_id, surface_form) DO UPDATE SET occurrences = occurrences + 1`,
    associationId,
    clean
  );
}

/** Moves everything from `sourceId` onto `targetId` and tombstones the source. */
export function mergeAssociations(targetId, sourceId, { reviewer = null } = {}) {
  if (targetId === sourceId) return { merged: false };
  const target = get(`SELECT * FROM associations WHERE id = ?`, targetId);
  const source = get(`SELECT * FROM associations WHERE id = ?`, sourceId);
  if (!target || !source) return { merged: false, error: 'association not found' };
  if (target.kind !== source.kind) {
    // §17 again: a named entity and a concept are never the same association,
    // however similar their labels look.
    return { merged: false, error: 'refusing to merge a named_entity with a concept' };
  }

  return tx(() => {
    run(`UPDATE evidence SET association_id = ? WHERE association_id = ?`, targetId, sourceId);
    // A document may now have rows for both sides; collapse them.
    run(
      `UPDATE OR REPLACE association_document_scores SET association_id = ? WHERE association_id = ?`,
      targetId,
      sourceId
    );
    run(`UPDATE OR IGNORE association_aliases SET association_id = ? WHERE association_id = ?`, targetId, sourceId);
    run(`DELETE FROM association_aliases WHERE association_id = ?`, sourceId);
    run(
      `INSERT INTO association_aliases (association_id, surface_form, occurrences) VALUES (?, ?, 1)
       ON CONFLICT(association_id, surface_form) DO UPDATE SET occurrences = occurrences + 1`,
      targetId,
      source.canonical_label
    );
    run(`UPDATE OR IGNORE serp_result_associations SET association_id = ? WHERE association_id = ?`, targetId, sourceId);
    run(`UPDATE associations SET status = 'merged', merged_into_id = ?, updated_at = datetime('now') WHERE id = ?`, targetId, sourceId);
    if (reviewer) {
      run(
        `INSERT INTO manual_reviews (entity_id, target_kind, target_id, action, payload, reviewer)
         VALUES (?, 'association', ?, 'merge', ?, ?)`,
        target.entity_id,
        sourceId,
        JSON.stringify({ merged_into: targetId, label: source.canonical_label }),
        reviewer
      );
    }
    return { merged: true, target_id: targetId, source_id: sourceId };
  });
}

/** Splits a surface form back out into its own association (§74). */
export function splitAssociation(associationId, surfaceForm, { reviewer = 'analyst' } = {}) {
  const source = get(`SELECT * FROM associations WHERE id = ?`, associationId);
  if (!source) return { split: false, error: 'association not found' };
  const newId = upsertAssociation(source.entity_id, {
    canonical_label: surfaceForm,
    kind: source.kind,
    category: source.category,
  });
  if (!newId || newId === associationId) return { split: false, error: 'that surface form is already its own association' };

  return tx(() => {
    run(`UPDATE evidence SET association_id = ? WHERE association_id = ? AND surface_form = ?`, newId, associationId, surfaceForm);
    run(`DELETE FROM association_aliases WHERE association_id = ? AND surface_form = ?`, associationId, surfaceForm);
    run(
      `INSERT INTO manual_reviews (entity_id, target_kind, target_id, action, payload, reviewer)
       VALUES (?, 'association', ?, 'split', ?, ?)`,
      source.entity_id,
      associationId,
      JSON.stringify({ surface_form: surfaceForm, new_association_id: newId }),
      reviewer
    );
    return { split: true, new_association_id: newId };
  });
}

// --- Clustering pass --------------------------------------------------------

const CLUSTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['same_association', 'confidence', 'preferred_label', 'reasoning'],
  properties: {
    same_association: { type: 'boolean' },
    confidence: { type: 'number' },
    preferred_label: { type: 'string', description: 'The label to keep if they are the same.' },
    reasoning: { type: 'string' },
  },
};

/**
 * §19's pipeline: embeddings, cosine similarity, LLM cluster confirmation.
 *
 * Returns both what it merged and what it only suggested, because the QA
 * screen needs to show an analyst the pairs the model would not commit to.
 */
export async function canonicaliseAssociations(entityId, { entityJobId = null, confirm = true, maxPairs = 400 } = {}) {
  // Retire failed extractions before clustering. A label that is really a
  // sentence cannot be merged with anything sensibly, and it pollutes the
  // embedding shortlist that the expensive pass works from. Excluded rather
  // than deleted: the evidence stays, and a human can reverse it.
  const retired = [];
  for (const a of all(`SELECT * FROM associations WHERE entity_id = ? AND status = 'active'`, entityId)) {
    if (!isSentenceLike(a.canonical_label)) continue;
    run(`UPDATE associations SET status = 'excluded', updated_at = datetime('now') WHERE id = ?`, a.id);
    retired.push(a.canonical_label);
  }

  // Deterministic pass: fold "private equity funds" into "private equity"
  // before spending anything on embeddings or judgement calls. Shortest label
  // wins, so the survivor is the general form rather than whichever happened to
  // be extracted first.
  const genericMerges = [];
  const byKind = new Map();
  for (const a of all(`SELECT * FROM associations WHERE entity_id = ? AND status = 'active'`, entityId)) {
    if (!byKind.has(a.kind)) byKind.set(a.kind, []);
    byKind.get(a.kind).push(a);
  }
  for (const group of byKind.values()) {
    group.sort((x, y) => labelKey(x.canonical_label).length - labelKey(y.canonical_label).length);
    const absorbed = new Set();
    for (let i = 0; i < group.length; i += 1) {
      if (absorbed.has(group[i].id)) continue;
      for (let j = i + 1; j < group.length; j += 1) {
        if (absorbed.has(group[j].id)) continue;
        if (!isGenericVariant(group[i].canonical_label, group[j].canonical_label)) continue;
        const res = mergeAssociations(group[i].id, group[j].id);
        if (res.merged) {
          genericMerges.push({ kept: group[i].canonical_label, dropped: group[j].canonical_label, method: 'generic_variant' });
          absorbed.add(group[j].id);
        }
      }
    }
  }

  const associations = all(
    `SELECT * FROM associations WHERE entity_id = ? AND status = 'active' ORDER BY id`,
    entityId
  );
  if (associations.length < 2) {
    return { merged: genericMerges, suggested: [], compared: 0, retired };
  }

  // Embed the label plus its recorded surface forms: "Philanthropy" alone is a
  // thin string, but "Philanthropy / charitable giving / charity work" carries
  // much more of what the corpus actually said.
  const texts = associations.map((a) => {
    const forms = all(`SELECT surface_form FROM association_aliases WHERE association_id = ? LIMIT 8`, a.id)
      .map((r) => r.surface_form)
      .join(' / ');
    return forms ? `${a.canonical_label} / ${forms}` : a.canonical_label;
  });
  const vectors = await embed(texts);
  associations.forEach((a, i) => storeEmbedding('association', a.id, vectors[i]));

  const threshold = SHORTLIST_THRESHOLD();
  const pairs = [];
  for (let i = 0; i < associations.length; i += 1) {
    for (let j = i + 1; j < associations.length; j += 1) {
      // §17 — never nominate a named_entity/concept pair.
      if (associations[i].kind !== associations[j].kind) continue;
      const score = cosine(vectors[i], vectors[j]);
      if (score >= threshold) pairs.push({ a: associations[i], b: associations[j], similarity: round(score, 3) });
    }
  }
  pairs.sort((x, y) => y.similarity - x.similarity);

  const merged = [...genericMerges];
  const suggested = [];
  // Maps an absorbed association to its survivor, so a chain can keep going:
  // when A absorbs B and C is later judged the same as B, C should be compared
  // against A rather than silently dropped. The old code skipped any pair
  // touching an already-merged row, which capped consolidation at one merge per
  // association and left obvious duplicates behind.
  const absorbedInto = new Map();
  const survivor = (association) => {
    let current = association;
    const seen = new Set([current.id]);
    while (absorbedInto.has(current.id)) {
      const next = absorbedInto.get(current.id);
      if (seen.has(next.id)) break;
      seen.add(next.id);
      current = next;
    }
    return current;
  };
  const llm = getLlm();

  for (const raw of pairs.slice(0, maxPairs)) {
    const pair = { ...raw, a: survivor(raw.a), b: survivor(raw.b) };
    if (pair.a.id === pair.b.id) continue;

    if (labelKey(pair.a.canonical_label) === labelKey(pair.b.canonical_label)) {
      const res = mergeAssociations(pair.a.id, pair.b.id);
      if (res.merged) { merged.push({ ...pair, method: 'normalised_label' }); absorbedInto.set(pair.b.id, pair.a); }
      continue;
    }

    if (!llm || !confirm) {
      suggested.push({ ...pair, method: 'embedding_shortlist', reason: llm ? 'confirmation disabled' : 'no LLM configured' });
      continue;
    }

    const verdict = await llmJson(
      {
        system:
          'You decide whether two association labels extracted from web text refer to the same underlying association for one entity.\n' +
          'Answer true only if a reader would consider them the same thing. Related-but-distinct is false: "Philanthropy" and "Education Philanthropy" are different (one is narrower), "Philanthropy" and "charitable giving" are the same.\n' +
          'Two distinct named organisations are never the same, however similar their names.',
        user: `A: ${pair.a.canonical_label} (kind: ${pair.a.kind}, surface forms: ${texts[associations.indexOf(pair.a)]})\nB: ${pair.b.canonical_label} (kind: ${pair.b.kind}, surface forms: ${texts[associations.indexOf(pair.b)]})`,
        schema: CLUSTER_SCHEMA,
        schemaName: 'association_cluster_judgement',
        maxTokens: 400,
      },
      { entityId, jobId: entityJobId, endpoint: 'canonicalisation' }
    );

    if (verdict?.data?.same_association && verdict.data.confidence >= 0.7) {
      const preferred = normaliseWhitespace(verdict.data.preferred_label);
      const keep = labelKey(preferred) === labelKey(pair.b.canonical_label) ? pair.b : pair.a;
      const drop = keep.id === pair.a.id ? pair.b : pair.a;
      const res = mergeAssociations(keep.id, drop.id);
      if (res.merged) {
        merged.push({ ...pair, method: 'llm_confirmed', kept: keep.canonical_label, confidence: verdict.data.confidence });
        absorbedInto.set(drop.id, keep);
      }
    } else {
      suggested.push({
        ...pair,
        method: 'llm_rejected',
        reason: verdict?.data?.reasoning ?? 'not confirmed',
      });
    }
  }

  // `retired` belongs on both return paths. The early one carried it and this
  // one did not, so any caller reading it got undefined whenever the function
  // did its normal work — the shape of a result should not depend on which
  // branch produced it.
  return { merged, suggested, retired, compared: pairs.length, embedding_model: embeddingModelName() };
}

// --- Hierarchy (§20) --------------------------------------------------------

/**
 * Seed hierarchy. Concept trees are stable enough that a handful of defaults
 * saves an LLM call per entity and makes the drill-down useful on day one.
 */
const DEFAULT_HIERARCHY = [
  ['Arts & Culture', ['Contemporary Art', 'Museum Patronage', 'Collecting', 'Art Collection']],
  ['Philanthropy', ['Education Philanthropy', 'Arts Philanthropy', 'Medical Philanthropy', 'Charitable Foundation']],
  ['Legal', ['Lawsuit', 'Litigation', 'Settlement', 'Regulatory Action']],
  ['Controversy', ['Investigation', 'Allegation', 'Criticism']],
];

export function applyDefaultHierarchy(entityId) {
  const associations = all(`SELECT * FROM associations WHERE entity_id = ? AND status = 'active'`, entityId);
  const byKey = new Map(associations.map((a) => [labelKey(a.canonical_label), a]));
  let linked = 0;

  for (const [parentLabel, children] of DEFAULT_HIERARCHY) {
    const presentChildren = children.map((c) => byKey.get(labelKey(c))).filter(Boolean);
    if (!presentChildren.length) continue;
    let parent = byKey.get(labelKey(parentLabel));
    if (!parent) {
      // Only create the parent when at least two of its children exist:
      // inventing a parent for a single child adds a level and no information.
      if (presentChildren.length < 2) continue;
      const id = upsertAssociation(entityId, { canonical_label: parentLabel, kind: 'concept', category: 'other' });
      parent = get(`SELECT * FROM associations WHERE id = ?`, id);
      byKey.set(labelKey(parentLabel), parent);
    }
    for (const child of presentChildren) {
      if (child.id === parent.id) continue;
      run(`UPDATE associations SET parent_id = ? WHERE id = ? AND parent_id IS NULL`, parent.id, child.id);
      run(
        `INSERT INTO association_hierarchy (parent_id, child_id, relation, source) VALUES (?, ?, 'narrower', 'default')
         ON CONFLICT(parent_id, child_id, relation) DO NOTHING`,
        parent.id,
        child.id
      );
      linked += 1;
    }
  }
  return { linked };
}

export function hierarchyFor(entityId) {
  const associations = all(
    `SELECT id, canonical_label, kind, category, parent_id FROM associations
      WHERE entity_id = ? AND status = 'active'`,
    entityId
  );
  const byId = new Map(associations.map((a) => [a.id, { ...a, children: [] }]));
  const roots = [];
  for (const a of byId.values()) {
    if (a.parent_id && byId.has(a.parent_id)) byId.get(a.parent_id).children.push(a);
    else roots.push(a);
  }
  return roots;
}

export { loadEmbeddings };
