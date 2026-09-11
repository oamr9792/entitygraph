import { all, get } from '../db.js';
import { round, safeDiv } from '../util/stats.js';

/**
 * Association-to-association co-occurrence (§17, §38).
 *
 * The brief is explicit that the graph may later infer XYZ Foundation →
 * philanthropy, but must not collapse the two. This is that inference, kept
 * as a separate read rather than folded into the scores: which associations
 * travel together in this entity's corpus, and — more usefully — which ones
 * appear to arrive *because* of another.
 *
 * The question it exists to answer is the one an ORM analyst actually asks:
 * "this association is weak in the corpus but prominent on Google — where is
 * it coming from?" An association that never appears without a second one is
 * not an independent fact about the person; it is inherited from the thing it
 * travels with, and attacking it directly will not work.
 *
 * Three numbers per pair, and the asymmetry between the first two is the whole
 * point:
 *
 *   share_of_this   P(other | this) — how often the other shows up in this
 *                   association's documents. High means this one rarely
 *                   appears alone.
 *   share_of_other  P(this | other) — the reverse. Low, when share_of_this is
 *                   high, means this association is a *subset* of the other's
 *                   footprint: it is carried by it.
 *   lift            How much more often they co-occur than chance would give.
 *                   Above 1 is attraction, below 1 avoidance, and 0 means they
 *                   never share a document at all — which for two associations
 *                   of the same person is itself a finding.
 */

const CO_OCCURRENCE_FLOOR = 2; // one shared document is an anecdote, not a pattern

function documentSets(entityId) {
  const rows = all(
    `SELECT e.association_id AS id, e.document_id AS doc
       FROM evidence e
       JOIN associations a ON a.id = e.association_id
      WHERE e.entity_id = ? AND e.excluded = 0 AND a.status = 'active'
      GROUP BY e.association_id, e.document_id`,
    entityId
  );
  const sets = new Map();
  for (const row of rows) {
    if (!sets.has(row.id)) sets.set(row.id, new Set());
    sets.get(row.id).add(row.doc);
  }
  return sets;
}

export function relatedAssociations(associationId, { limit = 25, floor = CO_OCCURRENCE_FLOOR } = {}) {
  const association = get(
    `SELECT a.*, (SELECT COUNT(DISTINCT document_id) FROM evidence WHERE association_id = a.id AND excluded = 0) AS documents
       FROM associations a WHERE a.id = ?`,
    associationId
  );
  if (!association) return null;

  const entityId = association.entity_id;
  const entityDocuments =
    get(
      `SELECT COUNT(*) AS c FROM entity_document_matches WHERE entity_id = ? AND verdict = 'accept'`,
      entityId
    )?.c ?? 0;

  const sets = documentSets(entityId);
  const mine = sets.get(associationId) ?? new Set();

  const labels = new Map(
    all(
      `SELECT id, canonical_label, kind, category FROM associations WHERE entity_id = ? AND status = 'active'`,
      entityId
    ).map((a) => [a.id, a])
  );

  const related = [];
  for (const [otherId, theirs] of sets) {
    if (otherId === associationId) continue;
    const meta = labels.get(otherId);
    if (!meta) continue;

    let shared = 0;
    for (const doc of mine) if (theirs.has(doc)) shared += 1;
    if (shared < floor) continue;

    const shareOfThis = safeDiv(shared, mine.size, 0);
    const shareOfOther = safeDiv(shared, theirs.size, 0);
    const expected = safeDiv(mine.size * theirs.size, entityDocuments, 0);
    const lift = safeDiv(shared, expected, 0);

    related.push({
      association_id: otherId,
      label: meta.canonical_label,
      kind: meta.kind,
      category: meta.category,
      documents: theirs.size,
      shared,
      share_of_this: round(shareOfThis, 3),
      share_of_other: round(shareOfOther, 3),
      lift: round(lift, 2),
      // "This one rarely appears without that one." Whether the reverse also
      // holds is a separate fact, and the difference matters: mutual means the
      // two belong to one story, one-directional means this association is a
      // subset of the other's footprint and is being carried by it.
      carries_this: shareOfThis >= 0.6,
      mutual: shareOfThis >= 0.6 && shareOfOther >= 0.6,
    });
  }

  related.sort((a, b) => b.shared - a.shared || b.lift - a.lift);

  return {
    association: {
      id: association.id,
      entity_id: entityId,
      label: association.canonical_label,
      kind: association.kind,
      category: association.category,
      documents: association.documents,
    },
    entity_documents: entityDocuments,
    corpus_share: round(safeDiv(mine.size, entityDocuments, 0), 4),
    related: related.slice(0, limit),
    interpretation: interpret(association, mine.size, entityDocuments, related, disjointAssociations(associationId)),
  };
}

/**
 * A sentence saying what the numbers mean, because the asymmetry above is the
 * kind of thing that is obvious once pointed out and invisible until then.
 *
 * Deliberately conservative: it describes the corpus, never Google, and never
 * asserts causation it cannot see. "Rarely appears without" is a statement
 * about co-occurrence; whether one caused the other is not observable here.
 */
function interpret(association, myDocs, entityDocuments, related, disjoint = []) {
  const label = association.canonical_label;
  if (!myDocs) return `No active evidence for ${label}.`;

  const share = Math.round((myDocs / Math.max(1, entityDocuments)) * 100);
  const opening = `${label} appears in ${myDocs} document${myDocs === 1 ? '' : 's'}, ${share}% of the corpus`;
  const sentences = [];

  if (!related.length) {
    sentences.push(
      `${opening}, and shares none of them with another association above the reporting floor. On this evidence it stands alone rather than travelling with anything else.`
    );
  } else {
    const carriers = related.filter((r) => r.carries_this).slice(0, 3);
    if (carriers.length) {
      const names = carriers
        .map((c) => `${c.label} (${Math.round(c.share_of_this * 100)}%${c.mutual ? ', mutually' : ''})`)
        .join(', ');
      const allMutual = carriers.every((c) => c.mutual);
      sentences.push(
        `${opening}, and rarely appears without ${names}. ${
          allMutual
            ? 'The dependence runs both ways, so these belong to one story in the corpus rather than one being inherited from the other.'
            : 'Where that dependence is one-directional, this association is a subset of the other’s footprint — carried by it rather than standing on its own.'
        }`
      );
    } else {
      const top = related[0];
      sentences.push(
        `${opening}. It most often shares documents with ${top.label} (${top.shared}, lift ${top.lift}), but not so consistently that it looks dependent on it.`
      );
    }
  }

  // Two associations of one person that never meet in a single document mean
  // the corpus holds two separate populations — which is precisely the shape a
  // displaced reputation takes, and easy to miss when only looking at scores.
  const biggest = disjoint[0];
  if (biggest && biggest.documents >= Math.max(10, myDocs * 3)) {
    sentences.push(
      `It shares no document at all with ${biggest.label} (${biggest.documents} documents), so the corpus holds these as two separate populations rather than one connected account.`
    );
  }

  return sentences.join(' ');
}

/**
 * The complement of the above: which associations does this one NOT share a
 * corpus with. Two associations of the same person that never meet in a single
 * document usually mean the corpus holds two separate populations of documents
 * — two different stories about the same person — which is exactly the shape an
 * ORM problem takes when an old chapter is being displaced by a new one.
 */
export function disjointAssociations(associationId, { limit = 10, minDocuments = 5 } = {}) {
  const association = get(`SELECT * FROM associations WHERE id = ?`, associationId);
  if (!association) return [];
  const sets = documentSets(association.entity_id);
  const mine = sets.get(associationId) ?? new Set();
  if (!mine.size) return [];

  const labels = new Map(
    all(
      `SELECT id, canonical_label, kind FROM associations WHERE entity_id = ? AND status = 'active'`,
      association.entity_id
    ).map((a) => [a.id, a])
  );

  const out = [];
  for (const [otherId, theirs] of sets) {
    if (otherId === associationId || theirs.size < minDocuments) continue;
    const meta = labels.get(otherId);
    if (!meta) continue;
    let shared = 0;
    for (const doc of mine) if (theirs.has(doc)) { shared = 1; break; }
    if (shared) continue;
    out.push({ association_id: otherId, label: meta.canonical_label, kind: meta.kind, documents: theirs.size });
  }
  return out.sort((a, b) => b.documents - a.documents).slice(0, limit);
}
