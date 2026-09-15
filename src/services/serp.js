import { all, get, run, tx } from '../db.js';
import * as dfs from '../providers/dataforseo.js';
import { canonicaliseUrl, rootDomain } from '../util/hash.js';
import { findOccurrences, normaliseForMatch } from '../util/text.js';
import { googleRetrievalScores, rankWeight } from './scoring.js';
import { round, safeDiv } from '../util/stats.js';
import { llmJson, getLlm } from '../providers/llm/index.js';

/**
 * §13, §14, §52, §53 — the Google retrieval layer.
 *
 * §14 is the reason this is its own module and its own tables. Corpus
 * Association Strength answers "what does the observable web associate with
 * this entity"; Google Retrieval Strength answers "what is Google actually
 * surfacing". They are different questions, they routinely disagree, and the
 * gap between them is the product's central finding (§76/§77). Nothing here
 * writes to the corpus tables, and nothing in the corpus pipeline reads from
 * these — the separation is structural, not a convention.
 */

export async function captureEntitySerp(entityId, query, { depth = 100, location = 'United States', language = 'en', jobId = null, force = false } = {}) {
  const serp = await dfs.serpOrganic(query, { depth, location, language, entityId, jobId, force });
  return storeSnapshot(entityId, serp, { queryKind: 'entity' });
}

export async function captureAssociationSerp(entityId, associationId, query, opts = {}) {
  const serp = await dfs.serpOrganic(query, {
    depth: opts.depth ?? 100,
    location: opts.location,
    language: opts.language,
    entityId,
    jobId: opts.jobId,
    force: opts.force,
  });
  return storeSnapshot(entityId, serp, { queryKind: 'association', associationId });
}

function storeSnapshot(entityId, serp, { queryKind, associationId = null }) {
  return tx(() => {
    const res = run(
      `INSERT INTO serp_snapshots (entity_id, query, query_kind, association_id, location, language, device, depth, item_types, signals)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entityId,
      serp.keyword,
      queryKind,
      associationId,
      serp.location,
      serp.language,
      serp.device,
      serp.depth,
      JSON.stringify(serp.item_types ?? []),
      // Related searches, People Also Ask, the knowledge panel. Snapshotted with
      // the organic results because they change week to week as well, and a
      // related search appearing or disappearing is itself a finding.
      JSON.stringify(serp.signals ?? {})
    );
    const snapshotId = Number(res.lastInsertRowid);

    for (const r of serp.results) {
      // Link the ranking URL back to a corpus document when we already have
      // it. That link is what lets a SERP result inherit the associations we
      // extracted from the page itself rather than from its title alone.
      const canonical = canonicaliseUrl(r.url);
      const doc = get(`SELECT id FROM documents WHERE canonical_url = ? OR url = ?`, canonical, r.url);
      run(
        `INSERT INTO serp_results (snapshot_id, rank, url, root_domain, title, description, document_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        snapshotId,
        r.rank,
        r.url,
        r.root_domain ?? rootDomain(r.url),
        r.title,
        r.description,
        doc?.id ?? null
      );
    }
    return { snapshot_id: snapshotId, results: serp.results.length, knowledge_graph: Boolean(serp.knowledge_graph) };
  });
}

/**
 * §52 — classify each ranking URL by the associations it supports.
 *
 * Three methods in increasing order of cost, and the method used is stored on
 * every link so the overlay can be audited:
 *
 *   corpus_match  the URL is a document we already analysed. Its associations
 *                 are known from its own evidence — the strongest signal.
 *   text_match    an association label or surface form appears in the title or
 *                 description.
 *   llm           for results neither of the above resolved, when configured.
 */
export async function classifySnapshot(entityId, snapshotId, { useLlm = true, jobId = null, maxLlm = 20 } = {}) {
  const results = all(`SELECT * FROM serp_results WHERE snapshot_id = ? ORDER BY rank`, snapshotId);
  const associations = all(
    `SELECT id, canonical_label, kind, category FROM associations WHERE entity_id = ? AND status = 'active'`,
    entityId
  );
  if (!associations.length || !results.length) return { classified: 0, unclassified: results.length };

  const aliasesFor = new Map(
    associations.map((a) => [
      a.id,
      [a.canonical_label, ...all(`SELECT surface_form FROM association_aliases WHERE association_id = ?`, a.id).map((r) => r.surface_form)],
    ])
  );

  let classified = 0;
  const unresolved = [];

  // Tokens of the entity's own name. An association sharing a surname with the
  // entity — a spouse, a sibling — would otherwise match every result that names
  // the entity and swallow the whole retrieval score.
  const entityRow = get(`SELECT canonical_name FROM entities WHERE id = ?`, entityId);
  const ownTokens = new Set(normaliseForMatch(entityRow?.canonical_name ?? '').split(' ').filter(Boolean));

  for (const result of results) {
    const links = new Map();

    if (result.document_id) {
      const rows = all(
        `SELECT association_id, document_evidence_undecayed FROM association_document_scores
          WHERE document_id = ? AND entity_id = ?
          ORDER BY document_evidence_undecayed DESC LIMIT 3`,
        result.document_id,
        entityId
      );
      for (const r of rows) links.set(r.association_id, { confidence: 1, method: 'corpus_match' });
    }

    // The title and description are what a searcher actually reads, and a
    // subject named there is what Google is presenting the result as being
    // about. So headline matches are always recorded — not only when the page's
    // own evidence found nothing. A biography whose body is mostly about a law
    // firm, headlined "represented Epstein", supports both.
    const text = [result.title, result.description].filter(Boolean).join(' — ');
    for (const association of associations) {
      if (links.has(association.id)) continue;
      if (findOccurrences(text, aliasesFor.get(association.id) ?? []).length) {
        links.set(association.id, { confidence: 0.7, method: 'text_match' });
        continue;
      }
      // Headlines name people by surname: "Kirkland Partner Who Represented
      // Epstein", never "…Represented Jeffrey Epstein". Matching only the full
      // label missed every one of those. Restricted to people, to distinctive
      // surnames, and never to a surname the entity itself carries.
      if (association.kind === 'named_entity' && association.category === 'person') {
        const surname = normaliseForMatch(association.canonical_label).split(' ').filter(Boolean).at(-1);
        if (surname && surname.length >= 4 && !ownTokens.has(surname) && findOccurrences(text, [surname]).length) {
          links.set(association.id, { confidence: 0.55, method: 'surname_match' });
        }
      }
    }

    if (!links.size) unresolved.push(result);

    for (const [associationId, meta] of links) {
      run(
        `INSERT INTO serp_result_associations (serp_result_id, association_id, confidence, method)
         VALUES (?, ?, ?, ?) ON CONFLICT(serp_result_id, association_id) DO NOTHING`,
        result.id,
        associationId,
        meta.confidence,
        meta.method
      );
      classified += 1;
    }
  }

  // The LLM pass is limited to the results that actually rank: an unclassified
  // result at #83 carries zero rank weight and would cost a call for nothing.
  if (useLlm && getLlm() && unresolved.length) {
    const worth = unresolved.filter((r) => rankWeight(r.rank) > 0).slice(0, maxLlm);
    for (const result of worth) {
      const picked = await classifyOne(entityId, result, associations, { jobId });
      for (const associationId of picked) {
        run(
          `INSERT INTO serp_result_associations (serp_result_id, association_id, confidence, method)
           VALUES (?, ?, 0.6, 'llm') ON CONFLICT(serp_result_id, association_id) DO NOTHING`,
          result.id,
          associationId
        );
        classified += 1;
      }
    }
  }

  const stillUnclassified = all(
    `SELECT COUNT(*) AS n FROM serp_results r
      WHERE r.snapshot_id = ?
        AND NOT EXISTS (SELECT 1 FROM serp_result_associations ra WHERE ra.serp_result_id = r.id)`,
    snapshotId
  )[0]?.n ?? 0;

  return { classified, unclassified: stillUnclassified, results: results.length };
}

const CLASSIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['association_labels'],
  properties: {
    association_labels: {
      type: 'array',
      description: 'Labels from the supplied list that this result supports. Empty if none clearly apply.',
      items: { type: 'string' },
    },
  },
};

async function classifyOne(entityId, result, associations, { jobId }) {
  const res = await llmJson(
    {
      system:
        'You label a Google search result with the entity associations it supports.\n' +
        'Choose only from the supplied labels. Choose none rather than guessing — an unlabelled result is reported honestly as unclassified, a wrongly labelled one corrupts the retrieval score.',
      user: [
        `RESULT #${result.rank}`,
        `URL: ${result.url}`,
        `TITLE: ${result.title ?? ''}`,
        `DESCRIPTION: ${result.description ?? ''}`,
        '',
        'AVAILABLE LABELS:',
        associations.map((a) => `- ${a.canonical_label} (${a.category})`).join('\n'),
      ].join('\n'),
      schema: CLASSIFY_SCHEMA,
      schemaName: 'serp_result_associations',
      maxTokens: 300,
    },
    { entityId, jobId, endpoint: 'serp_classification' }
  );
  if (!res) return [];
  const wanted = new Set((res.data.association_labels ?? []).map((l) => normaliseForMatch(l)));
  return associations.filter((a) => wanted.has(normaliseForMatch(a.canonical_label))).map((a) => a.id);
}

/** §53 — the Google Retrieval Score for the most recent entity snapshot. */
export function retrievalOverlay(entityId, { snapshotId = null } = {}) {
  const snapshot = snapshotId
    ? get(`SELECT * FROM serp_snapshots WHERE id = ?`, snapshotId)
    : get(`SELECT * FROM serp_snapshots WHERE entity_id = ? AND query_kind = 'entity' ORDER BY captured_at DESC LIMIT 1`, entityId);
  if (!snapshot) return null;

  const results = all(
    `SELECT r.*, GROUP_CONCAT(ra.association_id) AS association_ids, GROUP_CONCAT(ra.method) AS methods
       FROM serp_results r
       LEFT JOIN serp_result_associations ra ON ra.serp_result_id = r.id
      WHERE r.snapshot_id = ?
      GROUP BY r.id ORDER BY r.rank`,
    snapshot.id
  );

  const labels = new Map(
    all(`SELECT id, canonical_label FROM associations WHERE entity_id = ?`, entityId).map((a) => [a.id, a.canonical_label])
  );

  const shaped = results.map((r) => ({
    rank: r.rank,
    associationIds: (r.association_ids ?? '').split(',').filter(Boolean).map(Number),
  }));
  const scores = googleRetrievalScores(shaped);

  return {
    snapshot: {
      id: snapshot.id,
      query: snapshot.query,
      captured_at: snapshot.captured_at,
      location: snapshot.location,
      depth: snapshot.depth,
    },
    results: results.map((r) => ({
      rank: r.rank,
      url: r.url,
      root_domain: r.root_domain,
      title: r.title,
      rank_weight: rankWeight(r.rank),
      associations: (r.association_ids ?? '')
        .split(',')
        .filter(Boolean)
        .map(Number)
        .map((id) => ({ association_id: id, label: labels.get(id) ?? `#${id}` })),
      method: (r.methods ?? '').split(',')[0] || null,
    })),
    scores: Object.entries(scores.scores).map(([id, v]) => ({
      association_id: Number(id),
      label: labels.get(Number(id)) ?? `#${id}`,
      weight: v.weight,
      google_retrieval_score: v.grs,
      results: v.results,
    })).sort((a, b) => b.google_retrieval_score - a.google_retrieval_score),
    first_page_results: scores.first_page_results,
    classified_weight: scores.classified_weight,
    total_weight: scores.total_weight,
    unclassified_share: scores.unclassified_share,
  };
}

/**
 * §55 — the comparison the whole product is built to make: where the corpus
 * and Google's first page disagree about what this entity is associated with.
 */
export function retrievalGap(entityId, leaderboardRows) {
  const overlay = retrievalOverlay(entityId);
  if (!overlay) return null;
  const grsByAssociation = new Map(overlay.scores.map((s) => [s.association_id, s.google_retrieval_score]));

  const rows = leaderboardRows.map((row) => {
    const grs = grsByAssociation.get(row.association_id) ?? 0;
    // Like with like. GRS is the share of first-page weight that *carries* the
    // association (§53, summed, not divided), so a result carrying two
    // associations counts for both and scores do not sum to 100. Its corpus
    // counterpart is the share of recent documents that carry the association
    // (§37/§39), which is non-exclusive in exactly the same way. Comparing GRS
    // with an exclusive share that sums to 100 made every association look
    // over-shown by Google.
    const corpusShare = (row.current_corpus_share ?? 0) * 100;
    return {
      association_id: row.association_id,
      label: row.label,
      current_pias: row.current_pias,
      historical_pias: row.historical_pias,
      current_corpus_share_pct: round(corpusShare, 1),
      documents: row.documents,
      current_documents: row.current_documents,
      google_results: row.google_results ?? null,
      google_retrieval_score: grs,
      // Positive: Google surfaces more of this than the current web carries.
      // Negative: the current web has moved on and Google has not caught up.
      gap: round(grs - corpusShare, 1),
    };
  });

  return {
    snapshot_at: overlay.snapshot.captured_at,
    unclassified_share: overlay.unclassified_share,
    rows: rows.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)),
    overweighted_by_google: rows.filter((r) => r.gap > 15).sort((a, b) => b.gap - a.gap),
    underweighted_by_google: rows.filter((r) => r.gap < -15).sort((a, b) => a.gap - b.gap),
    /**
     * §77's actual finding, which is narrower than "Google shows more of this
     * than the corpus has". An association Google overweights is only
     * interesting when the corpus has moved past it — a strong current
     * association that also ranks well is the system working, not a gap. So
     * this list requires a positive gap AND that the association is weaker now
     * than it was historically: Google still reflecting a superseded state.
     */
    historically_anchored: rows
      .filter((r) => r.gap > 5 && r.historical_pias > r.current_pias)
      .sort((a, b) => b.gap - a.gap),
  };
}

/** §13 — the association query set for the separate SERP dataset. */
export function associationQueries(entityId, { limit = 8 } = {}) {
  const entity = get(`SELECT canonical_name FROM entities WHERE id = ?`, entityId);
  const associations = all(
    `SELECT a.id, a.canonical_label, SUM(s.document_evidence_undecayed) AS weight
       FROM associations a
       LEFT JOIN association_document_scores s ON s.association_id = a.id
      WHERE a.entity_id = ? AND a.status = 'active'
      GROUP BY a.id ORDER BY weight DESC LIMIT ?`,
    entityId,
    limit
  );
  return associations.map((a) => ({
    association_id: a.id,
    query: `${entity.canonical_name} ${a.canonical_label}`,
  }));
}

export { safeDiv };
