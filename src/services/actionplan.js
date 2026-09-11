import { all, get } from '../db.js';
import { MODEL, SCORE_DISCLAIMER } from '../config.js';
import { leaderboard, entityDocumentCount } from './metrics.js';
import { relatedAssociations } from './related.js';
import { median, round, safeDiv, ageDays, humanAge, clamp } from '../util/stats.js';

/**
 * Association action planning (§57, §58, §59, §60).
 *
 * Someone looking at an unwanted association wants to know what to do about
 * it. The honest answer depends entirely on what kind of association it is,
 * and the corpus already knows: how many independent domains carry it, how
 * authoritative they are, how directly they state the relationship, how old
 * they are, and whether the documents are even about the right person.
 *
 * Three things this deliberately does NOT do.
 *
 * It does not plan the removal of third-party documents. The corroboration
 * model (§21, §22) exists precisely because independently published documents
 * are hard evidence; a tool built on that premise cannot coherently offer to
 * make them disappear, and nothing in the patents suggests it would work.
 *
 * It does not predict Google. Every number here is a projection of our own
 * metric under stated assumptions (§57's disclaimer is attached to the
 * output). The gap between our corpus and Google's retrieval is reported as a
 * gap, not resolved by assertion.
 *
 * And it does not pretend every association is movable. Where the evidence is
 * dense, independent, authoritative and directly stated, the plan says so and
 * recommends against a displacement campaign, because selling one would be
 * taking money for arithmetic that does not work.
 */

// What one new document plausibly contributes, by source tier (§26, §31).
// Fresh, so recency is 1.0; first on its domain, so independence is 1.0. The
// rest are the median values a well-placed, on-topic piece actually achieves —
// not best case, because a plan built on best case is a plan that misses.
const NEW_DOCUMENT_ASSUMPTIONS = {
  entity_confidence: 0.95,
  relationship_confidence: 0.85,
  proximity: 0.75,
};

const TIERS = [
  { key: 'major', label: 'major institution or national publication' },
  { key: 'specialist', label: 'established specialist source' },
  { key: 'ordinary', label: 'ordinary publication' },
  { key: 'blog', label: 'small blog or low-authority site' },
];

const tierEvidence = (tier) =>
  NEW_DOCUMENT_ASSUMPTIONS.entity_confidence *
  NEW_DOCUMENT_ASSUMPTIONS.relationship_confidence *
  NEW_DOCUMENT_ASSUMPTIONS.proximity *
  (MODEL.reliability.classification[tier] ?? 0.5);

export function actionPlan(associationId, { targetShare = null, now = Date.now() } = {}) {
  const association = get(`SELECT * FROM associations WHERE id = ?`, associationId);
  if (!association) return null;
  const entityId = association.entity_id;

  const board = leaderboard(entityId, { now });
  const row = board.associations.find((a) => a.association_id === associationId);
  if (!row) {
    // A merged association is a normal thing to arrive at from an older link
    // or a bookmark. Saying "nothing here" would be true and useless; the
    // plan lives on whatever it was merged into.
    if (association.status === 'merged' && association.merged_into_id) {
      const target = get(`SELECT id, canonical_label FROM associations WHERE id = ?`, association.merged_into_id);
      return {
        disclaimer: SCORE_DISCLAIMER,
        association: { id: associationId, label: association.canonical_label },
        verdict: 'merged',
        headline: `${association.canonical_label} was merged into ${target?.canonical_label ?? 'another association'}.`,
        detail: 'Its evidence now counts towards that association, which is where the plan belongs.',
        redirect_to: target ? { id: target.id, label: target.canonical_label } : null,
        routes: [],
      };
    }
    return {
      disclaimer: SCORE_DISCLAIMER,
      association: { id: associationId, label: association.canonical_label },
      verdict: association.status === 'excluded' ? 'excluded' : 'no_active_evidence',
      headline:
        association.status === 'excluded'
          ? `${association.canonical_label} has been excluded, so it contributes to no score.`
          : `${association.canonical_label} has no active evidence, so there is nothing to plan against.`,
      routes: [],
    };
  }

  const evidence = all(
    `SELECT e.*, d.root_domain, d.published_at AS doc_published, d.group_date, dom.classification,
            dom.classification_override
       FROM evidence e
       JOIN documents d ON d.id = e.document_id
       LEFT JOIN domains dom ON dom.root_domain = d.root_domain
      WHERE e.association_id = ? AND e.excluded = 0`,
    associationId
  );

  const character = characterise(row, evidence, now);
  const related = relatedAssociations(associationId, { limit: 6 });
  const decay = projectDecay(row, evidence, board, now);
  const displacement = planDisplacement(row, board, targetShare);
  const retrieval = retrievalGap(row, board);
  const routes = chooseRoutes({ row, character, related, board, decay, displacement, retrieval });

  return {
    disclaimer: SCORE_DISCLAIMER,
    simulation_disclaimer:
      'These projections describe this tool’s own association metric under the stated assumptions. They are not predictions of Google rankings, and no part of this model can see Google’s retrieval.',
    association: {
      id: row.association_id,
      label: row.label,
      kind: row.kind,
      category: row.category,
      sentiment: row.sentiment,
    },
    entity: board.entity,
    current: {
      pias: row.pias,
      current_pias: row.current_pias,
      historical_pias: row.historical_pias,
      documents: row.documents,
      current_documents: row.current_documents,
      domains: row.domains,
      independent_sources: row.independent_sources,
      corpus_share: row.corpus_share,
      current_corpus_share: row.current_corpus_share,
      google_retrieval_score: row.google_retrieval_score,
      momentum: row.momentum,
      freshness: row.freshness,
    },
    character,
    carried_by: (related?.related ?? []).filter((r) => r.carries_this),
    decay,
    displacement,
    retrieval,
    routes,
  };
}

/**
 * What kind of association is this? Everything downstream turns on the answer,
 * and each input below is already computed by the scoring model — this only
 * reads them together and gives the combination a name.
 */
function characterise(row, evidence, now) {
  const directRelationships = evidence.filter((e) => (e.relationship_confidence ?? 0) >= 0.8).length;
  const directShare = safeDiv(directRelationships, evidence.length, 0);
  const meanEntityConfidence = safeDiv(
    evidence.reduce((a, e) => a + (e.entity_confidence ?? 0), 0),
    evidence.length,
    0
  );
  const meanProximity = safeDiv(
    evidence.reduce((a, e) => a + (e.proximity_score ?? 0), 0),
    evidence.length,
    0
  );
  const tiers = evidence.map((e) => e.classification_override ?? e.classification ?? 'unknown');
  const topTier = tiers.filter((t) => t === 'major' || t === 'specialist').length;
  const topTierShare = safeDiv(topTier, evidence.length, 0);

  // Distinct high-authority domains, which is the figure that actually
  // matters. Share alone is misleading: a corpus that is overwhelmingly trade
  // blogs can carry a claim in four national newspapers and still show a
  // top-tier share near zero. Four national newspapers is corroboration.
  const topTierDomains = new Set(
    evidence
      .filter((e) => ['major', 'specialist'].includes(e.classification_override ?? e.classification))
      .map((e) => e.root_domain)
      .filter(Boolean)
  ).size;
  const majorDomains = new Set(
    evidence
      .filter((e) => (e.classification_override ?? e.classification) === 'major')
      .map((e) => e.root_domain)
      .filter(Boolean)
  ).size;
  const ages = evidence.map((e) => ageDays(e.published_at ?? e.doc_published ?? e.group_date, now)).filter((a) => a !== null);

  // Domain concentration is the difference between "the web says this" and
  // "one outlet said this and others repeated it".
  const byDomain = new Map();
  for (const e of evidence) byDomain.set(e.root_domain, (byDomain.get(e.root_domain) ?? 0) + 1);
  const topDomainShare = byDomain.size
    ? safeDiv(Math.max(...byDomain.values()), evidence.length, 0)
    : 0;

  let verdict;
  let reasoning;
  if (meanEntityConfidence < 0.75) {
    verdict = 'possibly_misattributed';
    reasoning =
      'The documents behind this association are not confidently about this entity. Before anything else, establish whether they concern the right person at all.';
  } else if (
    row.domains >= 8 &&
    directShare >= 0.5 &&
    (topTierShare >= 0.25 || topTierDomains >= 5 || majorDomains >= 3)
  ) {
    verdict = 'central_and_corroborated';
    reasoning =
      `Carried by ${row.domains} independent domains, ${topTierDomains} of them high-authority` +
      (majorDomains ? ` (${majorDomains} major)` : '') +
      `, with ${Math.round(directShare * 100)}% of passages stating the relationship directly rather than in passing. This is an established fact of the public record, not a gap in coverage.`;
  } else if (row.domains >= 5 && directShare >= 0.4) {
    verdict = 'substantive';
    reasoning =
      'Genuinely corroborated across several independent domains and stated directly rather than in passing.';
  } else if (topDomainShare >= 0.6 || row.domains <= 2) {
    verdict = 'concentrated';
    reasoning =
      'The evidence sits on very few domains. That is a thin base: it may be one account propagating, rather than independent corroboration.';
  } else {
    verdict = 'peripheral';
    reasoning =
      'Present but loosely stated — mentions in passing rather than direct assertions of a relationship.';
  }

  return {
    verdict,
    reasoning,
    direct_relationship_share: round(directShare, 3),
    mean_entity_confidence: round(meanEntityConfidence, 3),
    mean_proximity: round(meanProximity, 3),
    top_tier_share: round(topTierShare, 3),
    top_tier_domains: topTierDomains,
    major_domains: majorDomains,
    top_domain_share: round(topDomainShare, 3),
    distinct_domains: byDomain.size,
    median_age_days: ages.length ? Math.round(median(ages)) : null,
    median_age: ages.length ? humanAge(median(ages)) : null,
    evidence_rows: evidence.length,
  };
}

/**
 * §30 — what happens if nothing is done.
 *
 * Often the most useful line in the plan. Current-state scores are a function
 * of a decaying window, so an association that has stopped attracting new
 * coverage loses current weight on its own. Quantifying that stops a client
 * paying for a campaign to achieve what the calendar was going to do anyway —
 * and, in the other direction, shows when waiting will achieve nothing because
 * the coverage is still being added to.
 */
function projectDecay(row, evidence, board, now) {
  const windowDays = board.current_window_days ?? MODEL.currentWindowDays;
  const halfLife = board.half_life_days ?? MODEL.recency.halfLifeDays;

  const dated = evidence
    .map((e) => ageDays(e.published_at ?? e.doc_published ?? e.group_date, now))
    .filter((a) => a !== null);
  const inWindow = dated.filter((a) => a <= windowDays).length;

  const horizons = [90, 180, 365, 730].map((days) => {
    const stillInWindow = dated.filter((a) => a + days <= windowDays).length;
    // Relative weight remaining under the half-life curve, against today.
    const weightNow = dated.reduce((acc, a) => acc + 0.5 ** (a / halfLife), 0);
    const weightThen = dated.reduce((acc, a) => acc + 0.5 ** ((a + days) / halfLife), 0);
    return {
      in_days: days,
      documents_still_in_current_window: stillInWindow,
      weight_remaining: round(safeDiv(weightThen, weightNow, 0), 3),
    };
  });

  // "Still being written about" is not the same as "one document exists in the
  // window". A single piece in twelve months is a residue, not live coverage,
  // and calling it live tells someone to spend money on a problem that is
  // already solving itself.
  const current = row.current_documents ?? 0;
  const months = Math.max(1, windowDays / 30.44);
  const perMonth = current / months;
  const stillAccruing = current >= 3 && perMonth >= 0.5;

  const note = !current
    ? `No documents in the current ${Math.round(months)}-month window. This association is already historical and will keep losing current-state weight with no intervention at all.`
    : stillAccruing
      ? `${current} documents inside the current ${Math.round(months)}-month window, about ${perMonth.toFixed(1)} a month. It is still being actively written about, so decay alone will not resolve it.`
      : `Only ${current} document${current === 1 ? '' : 's'} in the current ${Math.round(months)}-month window — a residue rather than live coverage. It is fading on its own; measure again before spending against it.`;

  return {
    window_days: windowDays,
    half_life_days: halfLife,
    documents_in_current_window: inWindow,
    documents_per_month: round(perMonth, 2),
    horizons,
    still_accruing: stillAccruing,
    note,
  };
}

/**
 * §58 in its honest form.
 *
 * The target association's documents cannot be removed, so its share can only
 * fall if the denominator grows: new documents about the entity that do not
 * carry this association. This computes how many, at each source tier, and is
 * explicit that the arithmetic is about share rather than about deletion.
 */
function planDisplacement(row, board, requestedTarget) {
  const currentDocuments = board.current_entity_documents ?? 0;
  const carrying = row.current_documents ?? 0;
  const currentShare = safeDiv(carrying, currentDocuments, 0);

  // Default target: a third of where it is now. Not floored at a fixed
  // percentage — a floor above the current share produces a "target" the
  // association has already beaten and an instruction to place zero articles,
  // which reads as a plan and is nothing of the kind.
  const target = requestedTarget ?? currentShare / 3;

  if (!carrying) {
    return {
      applicable: false,
      reason: 'This association has no documents in the current window, so it already holds no current share to displace.',
      current_share: round(currentShare, 4),
    };
  }

  if (target >= currentShare) {
    return {
      applicable: false,
      reason: `Current share is already ${round(currentShare * 100, 2)}%, at or below the ${round(target * 100, 2)}% target. There is nothing to displace; set a lower target if you want to push it further.`,
      current_share: round(currentShare, 4),
      target_share: round(target, 4),
    };
  }

  // Below roughly one document in fifty, share is dominated by how many
  // documents happened to be retrieved rather than by anything about the
  // entity's reputation, and a displacement plan is false precision.
  if (currentShare < 0.02) {
    return {
      applicable: false,
      reason: `This association carries ${carrying} of ${currentDocuments} current-window documents (${round(currentShare * 100, 2)}%). At that level its share moves with sampling noise, and a placement plan would be false precision. Watch momentum instead.`,
      current_share: round(currentShare, 4),
    };
  }

  // share = carrying / total  =>  total needed = carrying / target
  const totalNeeded = Math.ceil(safeDiv(carrying, target, 0));
  const additional = Math.max(0, totalNeeded - currentDocuments);

  return {
    applicable: true,
    current_share: round(currentShare, 4),
    target_share: round(target, 4),
    current_window_documents: currentDocuments,
    documents_carrying_association: carrying,
    additional_documents_required: additional,
    by_tier: TIERS.map((t) => ({
      tier: t.key,
      label: t.label,
      // Every document counts once toward share regardless of tier, but tier
      // decides how much authority-weighted evidence it adds to whatever it is
      // about — which is what moves the other association's PIAS up while this
      // one's share falls.
      documents: additional,
      evidence_contribution_each: round(tierEvidence(t.key), 3),
      total_evidence_added: round(tierEvidence(t.key) * additional, 2),
    })),
    assumptions: {
      ...NEW_DOCUMENT_ASSUMPTIONS,
      independence: 'each on a distinct root domain not already in the corpus (§22)',
      recency: 'published within the current window',
      note: 'Documents on a domain already represented count for far less (§22: 0.35), and a syndicated version of the same piece counts for 0.20 or less. The figures above assume genuinely independent placements.',
    },
  };
}

/** §14, §52 — is the problem the corpus, or what Google retrieves from it? */
function retrievalGap(row, board) {
  const grs = row.google_retrieval_score;
  if (grs === null || grs === undefined) {
    return {
      measurable: false,
      note: 'No SERP snapshot has classified this association, so the gap between corpus and Google retrieval cannot be measured. Run the Google overlay.',
    };
  }
  const corpusShare = (row.current_corpus_share ?? 0) * 100;
  const gap = round(grs - corpusShare, 1);
  return {
    measurable: true,
    google_retrieval_score: grs,
    current_corpus_share_pct: round(corpusShare, 1),
    gap,
    note:
      gap > 15
        ? 'Google surfaces this association far more than the current corpus would suggest. The corpus has already moved on further than Google has; the constraint is which pages rank, not what the web says.'
        : gap < -15
          ? 'Google surfaces this association less than the corpus would suggest. Retrieval is not currently the problem.'
          : 'Google retrieval and current corpus share are roughly aligned.',
  };
}

/**
 * Which routes are actually open. Ordered by what should be done first, and
 * honest when the answer is that displacement is not the right instrument.
 */
function chooseRoutes({ row, character, related, board, decay, displacement, retrieval }) {
  const routes = [];

  if (character.verdict === 'possibly_misattributed') {
    routes.push({
      key: 'verify_identity',
      priority: 1,
      title: 'Establish whether these documents are about this person at all',
      rationale: `Mean entity confidence across this association's evidence is ${character.mean_entity_confidence}, below the 0.70 acceptance threshold in places. An association built on misattributed documents is a data problem, not a reputation problem, and correcting it removes the evidence legitimately.`,
      actions: [
        'Open the evidence explorer and read the passages with the lowest entity confidence.',
        'Mark any that concern a different person as "wrong person" — scores recompute immediately from the remaining evidence.',
        'Add identity markers that distinguish this entity from whoever else the documents describe, then rebuild.',
      ],
      screen: 'evidence',
    });
  }

  const carriers = (related?.related ?? []).filter((r) => r.carries_this);
  if (carriers.length) {
    routes.push({
      key: 'address_carrier',
      priority: 2,
      title: `This association travels with ${carriers[0].label}`,
      rationale: `It appears in ${Math.round(carriers[0].share_of_this * 100)}% of the same documents. Where an association rarely appears alone, acting on it directly will not work — the documents are about the other thing, and this rides along with them.`,
      actions: [
        `Plan against ${carriers[0].label} instead, and check its own action plan.`,
        'Confirm in the evidence whether this association is the subject of those documents or incidental to them.',
      ],
      screen: 'related',
    });
  }

  if (character.verdict === 'concentrated') {
    routes.push({
      key: 'challenge_accuracy',
      priority: 2,
      title: 'Test whether the base is as independent as it looks',
      rationale: `${character.distinct_domains} distinct domains carry this, with ${Math.round(character.top_domain_share * 100)}% of the evidence on a single one. Under the corroboration model (§21) that is a thin base — possibly one account being repeated rather than independently established.`,
      actions: [
        'Check the duplicate-cluster column in the evidence explorer for syndication of a single original.',
        'Where the underlying claim is factually wrong, the route is a correction request to the originating publisher — which, if successful, removes the source the others derive from.',
      ],
      screen: 'evidence',
    });
  }

  if (character.verdict === 'central_and_corroborated') {
    routes.push({
      key: 'not_a_metrics_problem',
      priority: 1,
      title: 'Displacement is not the right instrument here',
      rationale: `${row.domains} independent domains carry this, ${Math.round(character.top_tier_share * 100)}% of the evidence sits on high-authority sources, and ${Math.round(character.direct_relationship_share * 100)}% of passages state the relationship directly rather than in passing. On this model's own terms that is an established fact of the public record. A displacement campaign against it would need to move numbers this arithmetic says will not move, and the honest advice is to say so rather than sell one.`,
      actions: [
        'Where the coverage is factually wrong, pursue corrections with the publishers — that is a legitimate route and this tool will show the effect when they land.',
        'Where it is accurate, the realistic objective is what else is true about the entity ranking alongside it, not its removal.',
        'Set expectations with the client using the Old vs current screen, which shows what is actually moving.',
      ],
      screen: 'compare',
    });
  }

  if (!decay.still_accruing) {
    routes.push({
      key: 'let_it_decay',
      priority: 3,
      title: 'It is already decaying — quantify before spending',
      rationale: decay.note,
      actions: [
        `In 12 months, ${round((1 - (decay.horizons.find((h) => h.in_days === 365)?.weight_remaining ?? 0)) * 100, 0)}% of its current recency weight will have gone on its own, assuming no new coverage.`,
        'Re-measure in 90 days before committing budget; the comparison is the strongest evidence of whether intervention is needed.',
      ],
      screen: 'timeline',
    });
  }

  if (displacement.applicable && character.verdict !== 'central_and_corroborated') {
    routes.push({
      key: 'displace',
      priority: 4,
      title: 'Grow the denominator',
      rationale: `Its ${displacement.documents_carrying_association} current-window documents cannot be removed, but its share of ${displacement.current_window_documents} can fall if the rest of the corpus grows. Reaching ${round(displacement.target_share * 100, 1)}% share requires roughly ${displacement.additional_documents_required} additional documents about the entity, on distinct domains, that do not carry this association.`,
      actions: [
        `Identify which existing association to grow — the Gaps screen lists ones that are factually valid but under-represented.`,
        'Placements must be on domains not already in the corpus; a second piece on a domain already present counts for roughly a third (§22).',
        'Re-measure monthly: relative momentum (§41) will show movement before absolute scores do.',
      ],
      screen: 'gaps',
    });
  }

  if (retrieval.measurable && retrieval.gap > 15) {
    routes.push({
      key: 'retrieval_gap',
      priority: 2,
      title: 'Google is behind the corpus',
      rationale: retrieval.note,
      actions: [
        'Work the SERP directly: the pages ranking for the entity query are the constraint, not the wider corpus.',
        'Track whether corpus movement precedes SERP movement — that correlation is what the weekly snapshots exist to establish.',
      ],
      screen: 'serp',
    });
  }

  return routes.sort((a, b) => a.priority - b.priority);
}
