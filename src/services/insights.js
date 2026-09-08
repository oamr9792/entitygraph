import { all, get } from '../db.js';
import { leaderboard } from './metrics.js';
import { retrievalGap } from './serp.js';
import { round, humanAge } from '../util/stats.js';

/**
 * §51, §59, §60, §75 — the reading layer.
 *
 * Nothing here computes a new score. These functions arrange scores that
 * already exist into the four comparisons an ORM analyst actually acts on:
 * one association against another, historical state against current state,
 * corpus against Google, and the whole thing written out in sentences.
 */

/**
 * §44 — the Current Entity State header.
 *
 * Five figures, each answering a different question, and the fifth
 * ("current-state change") only when there is an older snapshot to measure
 * against. Inventing a change figure from a single observation would be
 * exactly the kind of number that reads as evidence and is not.
 */
export function entityState(entityId, { now = Date.now(), changeWindowDays = 182 } = {}) {
  const board = leaderboard(entityId, { now });
  if (!board || !board.associations.length) return null;
  const rows = board.associations;

  const historicalDominant = rows.slice().sort((a, b) => b.historical_pias - a.historical_pias)[0];
  const currentDominant = rows.slice().sort((a, b) => b.current_pias - a.current_pias)[0];
  const fastestGrowing = rows
    .filter((r) => r.current_documents > 0 && r.momentum.basis !== null)
    .sort((a, b) => (b.momentum.basis ?? -Infinity) - (a.momentum.basis ?? -Infinity))[0];
  const mostRecent = rows
    .filter((r) => r.freshness.latest_mention_age_days !== null)
    .sort((a, b) => a.freshness.latest_mention_age_days - b.freshness.latest_mention_age_days)[0];

  // §44's "+31 points over 6 months" — measured against a stored snapshot.
  const cutoff = new Date(now - changeWindowDays * 86400000).toISOString();
  const older = get(
    `SELECT payload, captured_at FROM entity_snapshots
      WHERE entity_id = ? AND captured_at <= ? ORDER BY captured_at DESC LIMIT 1`,
    entityId,
    cutoff
  );
  let stateChange = null;
  if (older && currentDominant) {
    try {
      const payload = JSON.parse(older.payload);
      const prior = (payload.associations ?? []).find((a) => a.association_id === currentDominant.association_id);
      if (prior) {
        stateChange = {
          association: currentDominant.label,
          from: prior.current_pias,
          to: currentDominant.current_pias,
          points: round(currentDominant.current_pias - (prior.current_pias ?? 0), 1),
          since: older.captured_at,
        };
      }
    } catch { /* malformed snapshot: report no change rather than a wrong one */ }
  }

  return {
    entity: board.entity,
    generated_at: board.generated_at,
    historical_dominant: historicalDominant
      ? { label: historicalDominant.label, score: historicalDominant.historical_pias, association_id: historicalDominant.association_id }
      : null,
    current_dominant: currentDominant
      ? { label: currentDominant.label, score: currentDominant.current_pias, association_id: currentDominant.association_id }
      : null,
    fastest_growing: fastestGrowing
      ? {
          label: fastestGrowing.label,
          change: formatChange(fastestGrowing.momentum.basis),
          arrow: fastestGrowing.momentum.arrow,
          association_id: fastestGrowing.association_id,
        }
      : null,
    most_recent: mostRecent
      ? {
          label: mostRecent.label,
          age: mostRecent.freshness.latest_mention_age,
          association_id: mostRecent.association_id,
        }
      : null,
    state_change: stateChange,
    state_change_note: stateChange
      ? null
      : 'No snapshot old enough to measure change against yet — this appears once the entity has been tracked for the chosen window.',
  };
}

/** §51 — the association competition view. */
export function compareAssociations(entityId, associationIds, options = {}) {
  const board = leaderboard(entityId, options);
  if (!board) return null;
  const rows = associationIds
    .map((id) => board.associations.find((a) => a.association_id === Number(id)))
    .filter(Boolean);
  if (rows.length < 2) return { error: 'select at least two associations that exist for this entity' };

  const fields = [
    ['Lifetime documents', (r) => r.documents],
    ['Current-window documents', (r) => r.current_documents],
    ['Independent domains', (r) => r.domains],
    ['Independent sources (weighted)', (r) => r.independent_sources],
    ['Current corpus share', (r) => pct(r.current_corpus_share)],
    ['Lifetime corpus share', (r) => pct(r.corpus_share)],
    ['Median age', (r) => r.freshness.median_age ?? '—'],
    ['Evidence under 365 days', (r) => pct(r.freshness.evidence_share_under_365d)],
    ['PIAS', (r) => r.pias],
    ['Current PIAS', (r) => r.current_pias],
    ['Historical PIAS', (r) => r.historical_pias],
    ['Google Retrieval Score', (r) => r.google_retrieval_score ?? '—'],
    ['Momentum', (r) => `${r.momentum.arrow} ${r.momentum.label}`],
    ['Sentiment', (r) => r.sentiment.label],
  ];

  return {
    entity: board.entity,
    associations: rows.map((r) => ({ association_id: r.association_id, label: r.label })),
    rows: fields.map(([label, fn]) => ({ metric: label, values: rows.map(fn) })),
    detail: rows,
  };
}

const pct = (v) => (v === null || v === undefined ? '—' : `${round(v * 100, 1)}%`);

/**
 * §50 — historical state versus current state, split at a cutoff the user
 * chooses. Two separate leaderboards over the same corpus, which is the whole
 * point: the evidence did not change, the window did.
 */
export function oldVsCurrent(entityId, { cutoff, now = Date.now(), limit = 12 } = {}) {
  const board = leaderboard(entityId, { cutoff, now });
  if (!board) return null;
  const historical = board.associations
    .filter((a) => a.historical_pias > 0)
    .sort((a, b) => b.historical_pias - a.historical_pias)
    .slice(0, limit)
    .map((a) => ({ association_id: a.association_id, label: a.label, score: a.historical_pias, documents: a.documents - a.current_documents }));
  const current = board.associations
    .filter((a) => a.current_pias > 0)
    .sort((a, b) => b.current_pias - a.current_pias)
    .slice(0, limit)
    .map((a) => ({ association_id: a.association_id, label: a.label, score: a.current_pias, documents: a.current_documents }));

  return {
    cutoff: cutoff ?? board.current_window_start,
    historical_documents: board.historical_entity_documents,
    current_documents: board.current_entity_documents,
    historical,
    current,
    // Associations that dominate one column and not the other are the finding.
    replaced: historical.filter((h) => !current.some((c) => c.association_id === h.association_id)),
    emerged: current.filter((c) => !historical.some((h) => h.association_id === c.association_id)),
  };
}

/**
 * §59, §60 — the gap finder and the campaign-priority buckets.
 *
 * These are strategy inputs, not instructions. Every bucket is derived from
 * measurements already on the leaderboard, and the reasoning is returned with
 * each row so an analyst can disagree with the classification.
 */
export function gaps(entityId, options = {}) {
  const board = leaderboard(entityId, options);
  if (!board) return null;

  const rows = board.associations;
  const historicallyStrongNowWeak = rows
    .filter((r) => r.historical_pias >= 40 && r.current_pias < r.historical_pias * 0.6)
    .map((r) => ({ ...summary(r), reason: `historical PIAS ${r.historical_pias} against current ${r.current_pias}; ${pct(r.freshness.evidence_share_under_365d)} of evidence is under a year old` }));

  const growing = rows
    .filter((r) => ['up', 'rapid_up'].includes(r.momentum.bucket))
    .sort((a, b) => (b.momentum.basis ?? 0) - (a.momentum.basis ?? 0))
    .map((r) => ({ ...summary(r), reason: `share-adjusted momentum ${formatChange(r.momentum.basis)} over the last period` }));

  // Valid but under-evidenced: the association is real (it has corroboration
  // from more than one domain) but thin, which is exactly what a placement
  // campaign can move.
  const underrepresented = rows
    .filter((r) => r.domains >= 2 && r.domains < 15 && r.current_pias < 50 && r.sentiment.label !== 'negative')
    .sort((a, b) => a.domains - b.domains)
    .map((r) => ({ ...summary(r), reason: `only ${r.domains} independent domains behind it, current PIAS ${r.current_pias}` }));

  const risk = rows
    .filter((r) => r.sentiment.label === 'negative' && ['up', 'rapid_up'].includes(r.momentum.bucket))
    .map((r) => ({ ...summary(r), reason: `negative sentiment and ${r.momentum.label} (${formatChange(r.momentum.basis)})` }));

  return {
    entity: board.entity,
    historically_strong_currently_weak: historicallyStrongNowWeak,
    currently_growing: growing,
    valid_but_underrepresented: underrepresented,
    risk,
    priorities: priorities(rows),
  };
}

function priorities(rows) {
  const buckets = { defend: [], build: [], monitor: [], historical: [], risk: [] };
  for (const r of rows) {
    const negative = r.sentiment.label === 'negative';
    const strongNow = r.current_pias >= 60;
    const strongThen = r.historical_pias >= 50;
    const rising = ['up', 'rapid_up'].includes(r.momentum.bucket);

    if (negative && (rising || strongNow)) buckets.risk.push(summary(r, 'current negative association with momentum'));
    else if (strongNow && !negative) buckets.defend.push(summary(r, 'strong, desirable and current'));
    else if (!strongNow && !negative && r.domains >= 2 && r.current_documents > 0) buckets.build.push(summary(r, 'valid and current but thinly evidenced'));
    else if (strongThen && !strongNow) buckets.historical.push(summary(r, 'strong over the lifetime, weak in the current window'));
    else buckets.monitor.push(summary(r, 'neutral'));
  }
  return buckets;
}

const summary = (r, note = null) => ({
  association_id: r.association_id,
  label: r.label,
  kind: r.kind,
  category: r.category,
  pias: r.pias,
  current_pias: r.current_pias,
  historical_pias: r.historical_pias,
  documents: r.documents,
  domains: r.domains,
  current_corpus_share: r.current_corpus_share,
  momentum: r.momentum.arrow,
  sentiment: r.sentiment.label,
  median_age: r.freshness.median_age,
  ...(note ? { note } : {}),
});

const formatChange = (v) =>
  v === null || v === undefined ? '—' : `${v >= 0 ? '+' : ''}${round(v * 100, 0)}%`;

/**
 * §75 — the written summary.
 *
 * The last sentence is the one the brief calls particularly valuable: where
 * Google's current results and the current corpus disagree. It is only written
 * when there is a SERP snapshot to support it — an assertion about Google's
 * results with no observation behind it would be exactly the kind of claim
 * this product exists to avoid.
 */
export function narrative(entityId, { now = Date.now(), coverage = null } = {}) {
  const board = leaderboard(entityId, { now });
  if (!board || !board.associations.length) return null;
  const entity = board.entity;
  const rows = board.associations;
  const sentences = [];

  const domains = get(
    `SELECT COUNT(DISTINCT d.root_domain) AS n FROM documents d
       JOIN entity_document_matches m ON m.document_id = d.id
      WHERE m.entity_id = ? AND m.verdict = 'accept'`,
    entityId
  )?.n ?? 0;

  sentences.push(
    `We found ${board.entity_documents.toLocaleString()} high-confidence documents concerning this ${entity.entity_type === 'person' ? 'person' : 'organisation'} across ${domains.toLocaleString()} independent domains.`
  );

  const lifetime = rows.slice(0, 5);
  sentences.push(
    `The strongest lifetime associations are ${listOf(lifetime.map((r) => `${r.label} (${r.pias})`))}.`
  );

  const current = rows.slice().sort((a, b) => b.current_pias - a.current_pias).slice(0, 4);
  const fallen = rows
    .filter((r) => r.historical_pias - r.current_pias >= 20)
    .sort((a, b) => b.historical_pias - b.current_pias - (a.historical_pias - a.current_pias))[0];

  if (current.length) {
    sentences.push(
      `The current ${Math.round(board.current_window_days / 30.44)}-month entity state is ${fallen ? 'materially different' : 'broadly consistent'}: ${listOf(current.map((r) => `${r.label} ${r.current_pias}`))}${fallen ? `, while ${fallen.label} falls to ${fallen.current_pias}` : ''}.`
    );
  }

  if (fallen) {
    sentences.push(
      `${fallen.label} remains a historically strong association, but only ${pct(fallen.freshness.evidence_share_under_365d)} of its weighted evidence is less than 12 months old${fallen.freshness.median_age ? ` and its median supporting document is ${fallen.freshness.median_age} old` : ''}.`
    );
  }

  const riser = rows
    .filter((r) => ['up', 'rapid_up'].includes(r.momentum.bucket) && r.current_documents >= 3)
    .sort((a, b) => (b.momentum.basis ?? 0) - (a.momentum.basis ?? 0))[0];
  if (riser) {
    sentences.push(
      `${riser.label} has ${riser.current_documents} supporting documents from the current window across ${riser.current_domains} domains, representing ${pct(riser.current_corpus_share)} of the current observed entity corpus, and its share-adjusted momentum is ${formatChange(riser.momentum.basis)} against the preceding period.`
    );
  }

  const gap = retrievalGap(entityId, rows);
  // The superseded-state case first: an association Google still surfaces that
  // the current corpus has moved past. A merely over-represented but currently
  // strong association is the system working, not a finding.
  const anchored = gap?.historically_anchored?.[0] ?? gap?.overweighted_by_google?.[0];
  if (anchored) {
    sentences.push(
      `Google's current first page still overweights the ${anchored.label} relationship relative to the wider current corpus: it accounts for ${anchored.google_retrieval_score}% of the classified first-page weight against ${anchored.current_association_share_pct}% of the current association mass, and its historical score (${anchored.historical_pias}) exceeds its current one (${anchored.current_pias}).`
    );
  } else if (!gap) {
    sentences.push('No Google SERP snapshot has been captured yet, so no comparison with Google retrieval is possible.');
  }

  if (coverage) {
    sentences.push(`Coverage confidence for this analysis is ${coverage.level}.`);
  }

  return {
    entity_id: entityId,
    generated_at: new Date(now).toISOString(),
    text: sentences.join('\n\n'),
    sentences,
    retrieval_gap: gap,
  };
}

function listOf(items) {
  if (!items.length) return 'none';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export { humanAge };
