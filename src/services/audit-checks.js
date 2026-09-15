import { MODEL } from '../config.js';
import { all, get } from '../db.js';
import { AUDIT_CHECKS } from '../copy/metrics.js';
import { embed, cosine, embeddingModelName } from '../providers/embeddings/index.js';
import { simhash, minhash, hammingDistance, minhashSimilarity, canonicaliseUrl, rootDomain } from '../util/hash.js';
import { findOccurrences } from '../util/text.js';
import { unverifiedQuotes, verbatimOverlaps, withoutQuotes, usableAliases } from './content-checks.js';
import { projectDraft } from './audit-projection.js';
import { fetchPublicPage } from './content-source.js';
import {
  sentencesOf, countIndependent, highestClass, VERIFIABLE_CLASSES, candidatePersonNames, subjectShare, repetitionWaste,
  wasteSentence, attributionLoad, extractLinks, linkPlacement, hostFit, personSchema, regulatedProfile, numberWord,
  unsupportedEvents, isLinked,
} from './audit-rules.js';

/**
 * §99 — the fifteen checks. Each returns a result, the number with its
 * denominator (§93), a one-line summary, and the evidence behind it. `items`
 * in the detail are the specific lines a person acts on. A check never passes
 * because it had nothing to look at: it says so instead.
 */

const A = () => MODEL.audit;
const pct = (v) => `${Math.round((v ?? 0) * 100)}%`;
const s = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const result = (check_id, outcome, summary, { value = null, denominator = null, ...detail } = {}) => ({
  check_id,
  result: outcome,
  summary,
  value,
  denominator,
  detail: { items: [], ...detail },
});

const resolved = (ctx) => ctx.facts.filter((f) => f.resolution === 'resolved' && f.association_id);
const uniqueBy = (list, key) => [...new Map(list.map((x) => [key(x), x])).values()];

// --- Blocking ------------------------------------------------------------------------------

async function c1(ctx) {
  if (!ctx.exclusions.length) {
    return result('C1', 'insufficient',
      'No adverse associations are recorded for this client, so there is nothing to check this text against. Mark them on each association’s page.',
      { denominator: 0 });
  }
  const sentences = sentencesOf(ctx.text);
  const matches = [];
  for (const ex of ctx.exclusions) {
    for (const hit of findOccurrences(ctx.text, ex.terms)) {
      const sentence = sentences.find((x) => hit.start >= x.start && hit.start < x.end)?.text ?? '';
      matches.push({ association: ex.label, term: hit.phrase, sentence, match: 'literal' });
    }
  }
  // Close matches the literal terms miss: a paraphrase, a misspelling. Local
  // embeddings only catch surface similarity, and the detail says which model ran.
  const literalSentences = new Set(matches.map((m) => m.sentence));
  const candidates = sentences.filter((x) => !literalSentences.has(x.text));
  if (candidates.length) {
    const vectors = await embed([...candidates.map((x) => x.text), ...ctx.exclusions.map((e) => e.label)], { entityId: ctx.entity.id });
    const labelVectors = vectors.slice(candidates.length);
    candidates.forEach((sentence, i) => {
      ctx.exclusions.forEach((ex, j) => {
        const similarity = cosine(vectors[i], labelVectors[j]);
        if (similarity >= A().exclusion.embeddingSimilarity) {
          matches.push({ association: ex.label, term: null, sentence: sentence.text, match: 'similar', similarity: Math.round(similarity * 100) / 100 });
        }
      });
    });
  }
  const terms = ctx.exclusions.reduce((n, e) => n + e.terms.length, 0);
  const detail = {
    value: matches.length,
    denominator: ctx.exclusions.length,
    matches,
    exclusions: ctx.exclusions.map((e) => ({ association_id: e.association_id, label: e.label, source: e.source, terms: e.terms })),
    embedding_model: embeddingModelName(),
    items: matches.map((m) => (m.match === 'literal'
      ? `Names “${m.term}” (${m.association}): “${m.sentence}”`
      : `Reads close to ${m.association} (similarity ${m.similarity}): “${m.sentence}”`)),
  };
  return matches.length
    ? result('C1', 'fail', `Mentions ${s(uniqueBy(matches, (m) => m.association).length, 'excluded association')}, ${s(matches.length, 'time')}.`, detail)
    : result('C1', 'pass', `None of the ${s(ctx.exclusions.length, 'adverse association')} appears, as ${s(terms, 'term')} or as a close match.`, detail);
}

async function c2(ctx) {
  const claims = ctx.facts;
  const unsupported = claims.filter((f) => f.resolution === 'unsupported');
  const draft = ctx.contentDraft;
  const placeholders = draft ? (String(draft.body ?? '').match(/\[CONFIRM:[^\]]*\]/gi) ?? []) : [];
  const quotes = draft ? unverifiedQuotes(draft.body, draft.facts ?? []) : [];
  // "Joins" on a profile of someone already in post reports an event nobody reported.
  const events = draft ? unsupportedEvents(draft.title, draft.body, (draft.facts ?? []).map((f) => f.passage)) : [];
  const items = [
    ...unsupported.map((f) => `No source in the corpus holds “${f.extracted_claim}” (${String(f.relationship ?? '').replace(/_/g, ' ')}): “${f.sentence}”`),
    ...placeholders.map((p) => `Waiting to be confirmed: ${p}`),
    ...quotes.map((q) => `Quotes words no source contains: “${q}”`),
    ...events.map((e) => `Reports an event no fact reports (“${e.verb}”): “${e.sentence}”. Describe the current role instead.`),
  ];
  const detail = {
    value: unsupported.length,
    denominator: claims.length,
    extractor: ctx.extractor,
    claims: claims.map((f) => ({ claim: f.extracted_claim, relationship: f.relationship, sentence: f.sentence, resolution: f.resolution, sources: f.sources })),
    placeholders,
    unverified_quotes: quotes,
    unsupported_events: events,
    items,
  };
  if (placeholders.length || quotes.length || events.length) {
    return result('C2', 'fail', `${s(placeholders.length + quotes.length + events.length, 'statement')} cannot be stood behind${unsupported.length ? `, and ${unsupported.length} of ${claims.length} claims have no source` : ''}.`, detail);
  }
  if (!claims.length) {
    return result('C2', 'insufficient', 'No claims about the client could be extracted from this text, so none could be checked.', detail);
  }
  if (ctx.extractor !== 'llm') {
    return result('C2', 'insufficient',
      `The fallback extractor read this text, so claims could not be checked reliably${unsupported.length ? ` (${unsupported.length} of ${claims.length} look unsupported)` : ''}. Add a working LLM key and audit again.`,
      detail);
  }
  return unsupported.length
    ? result('C2', 'fail', `${unsupported.length} of ${claims.length} claims have no source in the corpus.`, detail)
    : result('C2', 'pass', `All ${claims.length} claims rest on at least one source the corpus holds.`, detail);
}

function c3(ctx) {
  const { registrations, occupation_hints: hints } = regulatedProfile(ctx.profile.markers ?? []);
  const signoff = ctx.signoffs.find((x) => x.check_id === 'C3');
  if (registrations.length) {
    const detail = { value: registrations.length, registrations, signed_off_by: signoff?.user_name ?? null };
    if (signoff) return result('C3', 'pass', `Compliance sign-off recorded by ${signoff.user_name} on ${String(signoff.signed_at).slice(0, 10)}.`, detail);
    return result('C3', 'fail', `The identity profile records a regulator registration (${registrations.join(', ')}). A named approver must sign this off before publication.`,
      { ...detail, items: ['Needs compliance sign-off recorded here, by name.'] });
  }
  if (hints.length) {
    return result('C3', 'warn', `No registration is recorded, but the occupation (${hints.join(', ')}) is usually regulated. Add the registration to the identity profile if there is one.`,
      { value: 0, occupation_hints: hints, items: [`Check whether ${ctx.profile.canonical_name} holds a regulator registration.`] });
  }
  return result('C3', 'pass', 'No regulator registration is recorded on the identity profile.', { value: 0 });
}

// --- Corroboration and novelty ----------------------------------------------------------------------

function attributionsFor(ctx) {
  const lookup = (documentId, url) => {
    const doc = documentId
      ? get(`SELECT d.id, d.root_domain, d.duplicate_cluster_id, dom.owner_key FROM documents d LEFT JOIN domains dom ON dom.root_domain = d.root_domain WHERE d.id = ?`, documentId)
      : url ? get(`SELECT d.id, d.root_domain, d.duplicate_cluster_id, dom.owner_key FROM documents d LEFT JOIN domains dom ON dom.root_domain = d.root_domain WHERE d.url = ? OR d.canonical_url = ?`, url, canonicaliseUrl(url)) : null;
    return doc ?? null;
  };
  if (ctx.contentDraft) {
    // A source counts only if the reader can reach it: named but unlinked is an assertion, not an attribution.
    const facts = new Map((ctx.contentDraft.facts ?? []).map((f) => [f.id, f]));
    const out = [];
    const unlinked = new Set();
    for (const claim of ctx.contentDraft.claims ?? []) {
      for (const id of claim.fact_ids ?? []) {
        const fact = facts.get(id);
        if (!fact || !['evidence', 'page'].includes(fact.source)) continue;
        if (!isLinked(fact.url, ctx.links)) {
          const domain = fact.domain ?? (fact.url ? rootDomain(fact.url) : null);
          if (domain) unlinked.add(domain);
          continue;
        }
        const doc = lookup(fact.document_id, fact.url);
        out.push({ root_domain: doc?.root_domain ?? fact.domain ?? rootDomain(fact.url), duplicate_cluster_id: doc?.duplicate_cluster_id ?? null, owner_key: doc?.owner_key ?? null, cited: id });
      }
    }
    return { list: out, unlinked: [...unlinked] };
  }
  const list = ctx.links
    .filter((l) => !ctx.ownDomains.some((d) => l.domain === d || l.domain.endsWith(`.${d}`)))
    .map((l) => {
      const doc = lookup(null, l.href);
      return { root_domain: doc?.root_domain ?? rootDomain(l.href), duplicate_cluster_id: doc?.duplicate_cluster_id ?? null, owner_key: doc?.owner_key ?? null, cited: l.href };
    });
  return { list, unlinked: [] };
}

function c4(ctx) {
  const { list, unlinked } = attributionsFor(ctx);
  const counted = countIndependent(list);
  const detail = { value: counted.independent, denominator: counted.attributions, clusters: counted.clusters, unlinked_sources: unlinked };
  const unlinkedItems = unlinked.map((d) => `Relies on ${d} without linking it. Link it so the reader can reach the source.`);
  const line = `${s(counted.attributions, 'linked attribution')} across ${s(counted.independent, 'independent source')}`;
  if (!counted.attributions) {
    return unlinked.length
      ? result('C4', 'warn', `Relies on ${s(unlinked.length, 'source')} but links none of them, so nothing it asserts can be checked.`, { ...detail, items: unlinkedItems })
      : result('C4', 'warn', 'Cites no sources at all.', { ...detail, items: ['Attribute the facts to the sources that establish them.'] });
  }
  if (counted.independent === 1) {
    return result('C4', 'fail', `${line}. Everything rests on ${counted.clusters[0].label}: this is a restatement.`,
      { ...detail, items: [`All linked attributions go to ${counted.clusters[0].label}.`, ...unlinkedItems] });
  }
  if (counted.independent < A().sources.minIndependent) {
    return result('C4', 'warn', `${line}, fewer than ${A().sources.minIndependent}.`, { ...detail, items: [...counted.clusters.map((c) => `${c.label}: ${s(c.attributions, 'attribution')}`), ...unlinkedItems] });
  }
  if (unlinked.length) return result('C4', 'warn', `${line}, but ${s(unlinked.length, 'source')} used without a link.`, { ...detail, items: unlinkedItems });
  return result('C4', 'pass', `${line}.`, detail);
}

const resolvedIn = (draftIds) => new Set(draftIds.length
  ? all(
      `SELECT DISTINCT association_id FROM audit_draft_fact WHERE resolution = 'resolved' AND association_id IS NOT NULL
         AND draft_id IN (${draftIds.map(() => '?').join(',')})`,
      ...draftIds
    ).map((r) => r.association_id)
  : []);

/** How many revisions of this draft in a row added no fact the earlier versions lacked. */
function revisionsWithoutNewFacts(ctx) {
  if (!ctx.draft.content_draft_id) return 0;
  const versions = [];
  for (const row of all(
    `SELECT id, text_hash FROM audit_draft WHERE content_draft_id = ? AND status = 'done' AND id < ? ORDER BY id DESC LIMIT 12`,
    ctx.draft.content_draft_id,
    ctx.draft.id
  )) {
    // Re-audits of unchanged text are not revisions.
    if (row.text_hash === ctx.draft.text_hash || versions.at(-1)?.text_hash === row.text_hash) continue;
    versions.push(row);
  }
  const chain = [new Set(resolved(ctx).map((f) => f.association_id)), ...versions.map((v) => resolvedIn([v.id]))];
  let streak = 0;
  for (let i = 0; i < chain.length - 1; i += 1) {
    const earlier = new Set(chain.slice(i + 1).flatMap((set) => [...set]));
    if ([...chain[i]].some((id) => !earlier.has(id))) break;
    streak += 1;
  }
  return streak;
}

function c5(ctx) {
  const facts = uniqueBy(resolved(ctx), (f) => f.association_id);
  const audited = ctx.liveAssets.filter((a) => a.latest_audit_id);
  const onAssets = resolvedIn(audited.map((a) => a.latest_audit_id));
  // The client's other drafts count too: a fact already written up elsewhere is not new because it is written again.
  const otherDrafts = all(
    `SELECT MAX(a.id) AS id FROM audit_draft a JOIN content_drafts c ON c.id = a.content_draft_id
      WHERE a.entity_id = ? AND a.status = 'done' AND c.status != 'archived' AND a.content_draft_id != ?
      GROUP BY a.content_draft_id`,
    ctx.entity.id,
    ctx.draft.content_draft_id ?? -1
  ).map((r) => r.id);
  const inDrafts = resolvedIn(otherDrafts);
  const known = (id) => onAssets.has(id) || inDrafts.has(id);
  const novel = facts.filter((f) => !known(f.association_id) && f.independent_sources >= A().novelty.minClustersPerFact);
  const streak = revisionsWithoutNewFacts(ctx);
  const detail = {
    value: novel.length,
    denominator: facts.length,
    novel_association_ids: novel.map((f) => f.association_id),
    live_assets: ctx.liveAssets.length,
    audited_assets: audited.length,
    other_drafts: otherDrafts.length,
    revisions_without_new_facts: streak,
    already_on_assets: facts.filter((f) => onAssets.has(f.association_id)).map((f) => f.extracted_claim),
    already_in_drafts: facts.filter((f) => !onAssets.has(f.association_id) && inDrafts.has(f.association_id)).map((f) => f.extracted_claim),
    single_source: facts.filter((f) => f.independent_sources < A().novelty.minClustersPerFact).map((f) => f.extracted_claim),
    items: novel.map((f) => `New to your network: ${f.extracted_claim}`),
  };
  if (!facts.length) return result('C5', 'insufficient', 'No supported facts to compare with your live assets and other drafts.', detail);
  const note = ctx.liveAssets.length > audited.length ? ` ${ctx.liveAssets.length - audited.length} of ${ctx.liveAssets.length} live assets have not been audited, so their facts are not counted.` : '';
  if (novel.length < A().novelty.minNovelFacts) {
    const stuck = streak
      ? ` Neither did the last ${s(streak, 'revision')}: rewriting does not add facts. Gather new ones before another draft.`
      : '';
    return result('C5', 'warn', `0 of ${facts.length} supported facts are new. This piece adds a URL and nothing else.${stuck}${note}`, {
      ...detail,
      items: [
        'Every supported fact is already on a live asset, in another draft, or rests on a single source.',
        ...(streak ? ['Stop revising. Get facts that are not yet written up anywhere — a register record, dates, prior roles, education — then draft again.'] : []),
      ],
    });
  }
  return result('C5', 'pass', `${novel.length} of ${facts.length} supported facts are new to your live assets and other drafts, and independently sourced.${note}`, detail);
}

function c6(ctx) {
  const facts = uniqueBy(resolved(ctx), (f) => f.association_id);
  const classified = facts.map((f) => ({ claim: f.extracted_claim, class: highestClass(f.support.map((d) => d.root_domain), { ownDomains: ctx.ownDomains }) }));
  const verifiable = classified.filter((c) => VERIFIABLE_CLASSES.has(c.class));
  const share = facts.length ? verifiable.length / facts.length : 0;
  const detail = {
    value: verifiable.length,
    denominator: facts.length,
    share,
    by_class: classified.reduce((acc, c) => ({ ...acc, [c.class]: (acc[c.class] ?? 0) + 1 }), {}),
    facts: classified,
  };
  // A regulated person has a public register record: the most checkable facts there are.
  const regulated = regulatedProfile(ctx.profile.markers ?? []);
  const registerItems = regulated.registrations.length || regulated.occupation_hints.length
    ? ['Add the regulator’s public record to the corpus. For a US financial adviser that is FINRA BrokerCheck: CRD number, firms and dates, exams, state registrations, disclosures.']
    : [];
  if (facts.length < A().verifiability.minFacts) {
    return result('C6', 'insufficient', `Only ${s(facts.length, 'supported fact')}, too few for a share to mean anything.`, { ...detail, items: registerItems });
  }
  return share < A().verifiability.minShare
    ? result('C6', 'warn', `${verifiable.length} of ${facts.length} facts (${pct(share)}) are backed by a register, professional body or institution; the rest rest on press or the client’s own pages.`,
        { ...detail, items: [...classified.filter((c) => !VERIFIABLE_CLASSES.has(c.class)).map((c) => `${c.claim}: best source is ${c.class.replace(/_/g, ' ')}`), ...registerItems] })
    : result('C6', 'pass', `${verifiable.length} of ${facts.length} facts (${pct(share)}) are backed by a register, professional body or institution.`, detail);
}

// --- Differentiation ----------------------------------------------------------------------------------

function c7(ctx) {
  if (!ctx.exclusions.length) return result('C7', 'insufficient', 'No adverse associations are recorded for this client, so overlap with adverse coverage cannot be measured.');
  const ids = ctx.exclusions.map((e) => e.association_id);
  const adverseDocs = new Set(all(
    `SELECT DISTINCT e.document_id FROM evidence e JOIN entity_document_matches m ON m.document_id = e.document_id AND m.entity_id = e.entity_id AND m.verdict = 'accept'
      WHERE e.association_id IN (${ids.map(() => '?').join(',')}) AND e.excluded = 0`,
    ...ids
  ).map((r) => r.document_id));
  if (adverseDocs.size < A().adverseOverlap.minAdverseDocuments) {
    return result('C7', 'insufficient', `Only ${s(adverseDocs.size, 'document')} carry adverse associations: not enough coverage to judge overlap.`, { denominator: adverseDocs.size });
  }
  const attributes = uniqueBy(resolved(ctx).filter((f) => !ids.includes(f.association_id)), (f) => f.association_id).map((f) => {
    const docs = f.support.map((d) => d.document_id);
    const shared = docs.filter((d) => adverseDocs.has(d)).length;
    return { claim: f.extracted_claim, association_id: f.association_id, documents: docs.length, in_adverse: shared, share: docs.length ? shared / docs.length : 0 };
  }).sort((a, b) => b.share - a.share);
  if (!attributes.length) return result('C7', 'insufficient', 'The text asserts no supported attributes to compare with adverse coverage.');
  const overlapping = attributes.filter((a) => a.share >= A().adverseOverlap.attributeShare);
  const share = overlapping.length / attributes.length;
  const detail = { value: overlapping.length, denominator: attributes.length, share, adverse_documents: adverseDocs.size, attributes, items: overlapping.map((a) => `${a.claim}: ${a.in_adverse} of its ${a.documents} documents also carry adverse coverage`) };
  return share > A().adverseOverlap.warnShare
    ? result('C7', 'warn', `${overlapping.length} of ${attributes.length} attributes (${pct(share)}) are ones adverse coverage also uses.`, detail)
    : result('C7', 'pass', `${overlapping.length} of ${attributes.length} attributes overlap with adverse coverage.`, detail);
}

async function c8(ctx) {
  const extracted = ctx.facts.filter((f) => f.extracted_claim);
  if (!extracted.length) return result('C8', 'insufficient', 'No associations could be extracted, so there is nothing to project.');
  let deltas;
  try {
    deltas = await projectDraft({
      entityId: ctx.entity.id,
      text: ctx.text,
      title: ctx.title,
      hostDomain: ctx.hostDomain,
      associations: extracted.map((f) => ({ ...f, canonical_label: f.extracted_claim })),
    });
  } catch (err) {
    return result('C8', 'insufficient', `The projection could not run: ${err.message}`);
  }
  const draftKeys = new Set(extracted.map((f) => f.association_id).filter(Boolean));
  const draftLabels = new Set(extracted.map((f) => f.extracted_claim.toLowerCase()));
  const mine = deltas.filter((d) => draftKeys.has(d.association_id) || draftLabels.has(String(d.label).toLowerCase()));
  const adverse = deltas.filter((d) => ctx.exclusions.some((e) => e.association_id === d.association_id));
  const threshold = A().projection.negligibleDelta;
  const moving = mine.filter((d) => Math.abs(d.pias_delta) >= threshold || Math.abs(d.current_delta) >= threshold);
  const detail = {
    value: moving.length,
    denominator: mine.length,
    associations: mine.slice(0, 20),
    adverse,
    note: 'Association strength and recent strength only. No Google Retrieval Score is projected, and ACS is not defined in this tool, so it is not either.',
    items: moving.slice(0, 8).map((d) => `${d.label}: strength ${d.pias_delta >= 0 ? '+' : ''}${d.pias_delta}, recent ${d.current_delta >= 0 ? '+' : ''}${d.current_delta}`),
  };
  return moving.length
    ? result('C8', 'pass', `${moving.length} of ${mine.length} associations would move by ${threshold} points or more.`, detail)
    : result('C8', 'warn', `None of the ${mine.length} associations would move by ${threshold} points or more. The piece would not change how the client is described.`, detail);
}

// --- Composition ----------------------------------------------------------------------------------------

function comparisonTexts(ctx) {
  const sources = [];
  if (ctx.contentDraft) {
    const docIds = [...new Set((ctx.contentDraft.facts ?? []).filter((f) => f.document_id).map((f) => f.document_id))];
    for (const d of docIds.length ? all(`SELECT id, url, title, COALESCE(body_text, snippet) AS text FROM documents WHERE id IN (${docIds.map(() => '?').join(',')})`, ...docIds) : []) {
      sources.push({ kind: 'source', label: d.title ?? d.url, url: d.url, text: d.text });
    }
    const sourceId = ctx.contentDraft.inputs?.source_id;
    const page = sourceId ? get(`SELECT id, url, title, body FROM content_sources WHERE id = ?`, sourceId) : null;
    if (page) sources.push({ kind: 'source', label: page.title ?? page.url, url: page.url, text: page.body });
  } else {
    for (const link of ctx.links) {
      const d = get(`SELECT id, url, title, COALESCE(body_text, snippet) AS text FROM documents WHERE url = ? OR canonical_url = ?`, link.href, canonicaliseUrl(link.href));
      if (d) sources.push({ kind: 'source', label: d.title ?? d.url, url: d.url, text: d.text });
    }
  }
  const siblings = [];
  for (const asset of ctx.liveAssets) {
    if (asset.id === ctx.draft.asset_id || !asset.latest_audit_id || asset.latest_audit_id === ctx.draft.id) continue;
    const other = get(`SELECT text FROM audit_draft WHERE id = ?`, asset.latest_audit_id);
    if (other) siblings.push({ kind: 'asset', label: asset.label ?? asset.url, url: asset.url, text: other.text });
  }
  for (const d of all(`SELECT id, title, body FROM content_drafts WHERE entity_id = ? AND body IS NOT NULL AND status != 'archived' AND id != ?`, ctx.entity.id, ctx.draft.content_draft_id ?? -1)) {
    siblings.push({ kind: 'draft', label: d.title || `Draft ${d.id}`, url: `#/content/${d.id}`, text: `${d.title ?? ''}\n\n${d.body}` });
  }
  return { sources: sources.filter((x) => x.text), siblings: siblings.filter((x) => x.text) };
}

function c9(ctx) {
  const mineSim = simhash(ctx.text);
  const mineMin = minhash(ctx.text);
  const { sources, siblings } = comparisonTexts(ctx);
  const compare = (other) => {
    const distance = hammingDistance(mineSim, simhash(other.text));
    const similarity = minhashSimilarity(mineMin, minhash(other.text));
    return { ...other, text: undefined, distance, similarity: Math.round(similarity * 100) / 100, clusters: distance <= MODEL.duplicates.nearSimhashDistance || similarity >= A().duplicates.minhashSimilarity };
  };
  const sourceMatches = sources.map(compare).filter((x) => x.clusters);
  const siblingMatches = siblings.map(compare).filter((x) => x.clusters);
  const copied = verbatimOverlaps(withoutQuotes(ctx.text), sources.map((x, i) => ({ id: x.label ?? `source ${i + 1}`, passage: x.text })), A().duplicates.verbatimWords);
  const detail = {
    value: sourceMatches.length + siblingMatches.length + copied.length,
    denominator: sources.length + siblings.length,
    source_matches: sourceMatches,
    sibling_matches: siblingMatches,
    copied_runs: copied,
    items: [
      ...sourceMatches.map((m) => `Near copy of its own source “${m.label}” (similarity ${m.similarity}).`),
      ...copied.map((c) => `Copies a run of words from “${c.fact_id}”: “${c.excerpt}…”`),
      ...siblingMatches.map((m) => `Clusters with ${m.kind === 'asset' ? 'the live asset' : 'the draft'} “${m.label}” (similarity ${m.similarity}).`),
    ],
  };
  if (!sources.length && !siblings.length) return result('C9', 'insufficient', 'No cited source or sibling asset text was available to compare with.', detail);
  if (sourceMatches.length || copied.length) {
    return result('C9', 'fail', sourceMatches.length ? `Clusters with its own source “${sourceMatches[0].label}”: a restatement.` : `Copies ${s(copied.length, 'run')} of words from its sources.`, detail);
  }
  if (siblingMatches.length) return result('C9', 'warn', `Clusters with ${siblingMatches[0].kind === 'asset' ? 'the live asset' : 'the draft'} “${siblingMatches[0].label}”: wasted budget.`, detail);
  return result('C9', 'pass', `Distinct from ${s(sources.length, 'cited source')} and ${s(siblings.length, 'other asset or draft', 'other assets and drafts')}.`, detail);
}

function c10(ctx) {
  const nonPeople = [
    ...(ctx.profile.markers ?? []).filter((m) => ['location', 'organization'].includes(m.kind)).map((m) => m.value),
    ...ctx.facts.filter((f) => f.category && f.category !== 'person').map((f) => f.extracted_claim),
  ];
  const extractedPeople = ctx.facts.filter((f) => f.kind === 'named_entity' && f.category === 'person').map((f) => f.extracted_claim);
  const others = [...new Set([...candidatePersonNames(ctx.text, { clientNames: ctx.names, knownNonPeople: nonPeople }), ...extractedPeople])]
    .filter((n) => !findOccurrences(n, ctx.names).length);
  const share = subjectShare(ctx.text, { clientNames: ctx.names, otherNames: others });
  const detail = {
    value: share.client,
    denominator: share.sentences,
    share: share.share,
    others: share.others,
    paragraphs_about_others: share.paragraphs_about_others,
    items: share.paragraphs_about_others.map((p) => `Paragraph ${p.index + 1} is mostly about ${p.names.join(', ')}: “${p.excerpt}…”`),
  };
  if (share.sentences < A().subject.minSentences) return result('C10', 'insufficient', `Only ${s(share.sentences, 'sentence')} name anyone, too few to judge.`, detail);
  const named = share.others.slice(0, 4).map((o) => `${o.name} ${pct(o.share)}`).join(', ');
  const line = `${share.client} of ${share.sentences} sentences (${pct(share.share)}) are about the client${named ? `; the rest are about ${named}` : ''}.`;
  if (share.share < A().subject.failShare) return result('C10', 'fail', line, detail);
  if (share.share < A().subject.warnShare) return result('C10', 'warn', line, detail);
  return result('C10', 'pass', line, detail);
}

function c11(ctx) {
  const phrases = uniqueBy([
    ...(ctx.contentDraft?.brief?.targets ?? []).map((t) => ({ label: t.label, terms: t.terms ?? [] })),
    ...ctx.facts.map((f) => ({ label: f.extracted_claim, terms: usableAliases([f.surface_form], { entityName: ctx.profile.canonical_name, label: f.extracted_claim }) })),
  ], (p) => p.label.toLowerCase());
  const waste = repetitionWaste(ctx.text, phrases);
  const wasted = waste.filter((w) => w.wasted > 0);
  const total = wasted.reduce((n, w) => n + w.wasted, 0);
  const mentions = waste.reduce((n, w) => n + w.mentions, 0);
  const detail = { value: total, denominator: mentions, phrases: waste, items: wasted.map((w) => wasteSentence(w)) };
  if (!waste.length) return result('C11', 'insufficient', 'No association is mentioned, so there is no repetition to measure.', detail);
  return total >= A().repetition.warnWasted
    ? result('C11', 'warn', `${s(total, 'mention')} of ${mentions} add nothing: they come after the cap.`, detail)
    : result('C11', 'pass', `All ${mentions} mentions fall within the cap.`, detail);
}

function c12(ctx) {
  const sourceNames = [
    ...(ctx.contentDraft?.brief?.source ? [ctx.contentDraft.brief.source.title, ctx.contentDraft.brief.source.domain] : []),
    ...ctx.links.map((l) => l.domain.split('.')[0]),
  ].filter(Boolean);
  const load = attributionLoad(ctx.text, { sourceNames });
  const rules = A().attribution;
  const q = load.quotation;
  const detail = {
    value: load.attributed.length,
    denominator: load.sentences,
    load: load.load,
    quotation: q,
    attributed: load.attributed,
    items: [
      ...load.attributed.map((a) => `Spent on the source (${a.reasons.join(', ')}): “${a.sentence}”`),
      ...(q.longest > rules.maxQuoteWords ? [`One quotation runs to ${q.longest} words.`] : []),
    ],
  };
  if (load.sentences < 3) return result('C12', 'insufficient', 'Too short to measure attribution load.', detail);
  const line = `${load.attributed.length} of ${load.sentences} sentences (${pct(load.load)}) are spent on the source; quotations are ${pct(q.share)} of the words.`;
  if (load.load > rules.failLoad || q.share > rules.failQuoteShare || q.longest > rules.maxQuoteWords) return result('C12', 'fail', line, detail);
  if (load.load > rules.warnLoad || q.share > rules.warnQuoteShare) return result('C12', 'warn', line, detail);
  return result('C12', 'pass', line, detail);
}

// --- Placement --------------------------------------------------------------------------------------------

function c13(ctx) {
  const targets = [...ctx.ownDomains, ...(ctx.targetUrl ? [rootDomain(ctx.targetUrl)] : [])].filter(Boolean);
  if (!targets.length) return result('C13', 'insufficient', 'No client property is recorded. Add the client’s site as a known URL or register an owned asset.');
  const placement = linkPlacement(ctx.links, { targetDomains: targets });
  const detail = { value: placement.target_in_body, denominator: placement.outbound, ...placement, links: ctx.links, targets };
  if (!placement.target_links) {
    return result('C13', 'warn', placement.only_sources
      ? `None of the ${s(placement.outbound, 'outbound link')} points at the client’s property; they all point at sources.`
      : 'Does not link to the client’s property.', { ...detail, items: [`Link ${targets[0]} from the body text.`] });
  }
  if (!placement.target_in_body) return result('C13', 'warn', 'Links the client’s property only from navigation, a sidebar, a footer or an author bio.', { ...detail, items: ['Move the link into the body text.'] });
  if (placement.late) return result('C13', 'warn', `The first body link to the client’s property sits ${pct(placement.first_target_position)} of the way down.`, { ...detail, items: ['Link it nearer the top.'] });
  return result('C13', 'pass', `Links the client’s property from the body, ${pct(placement.first_target_position)} of the way down.`, detail);
}

async function c14(ctx) {
  const host = ctx.hostDomain;
  if (!host) return result('C14', 'insufficient', 'No host site was given, so fit cannot be judged.');
  if (ctx.ownDomains.some((d) => host === d || host.endsWith(`.${d}`))) return result('C14', 'not_applicable', 'The host is a property the client controls.');
  let page;
  try {
    page = await fetchPublicPage(`https://${host}/`, { entityId: ctx.entity.id });
  } catch (err) {
    return result('C14', 'insufficient', `The host’s home page could not be read: ${err.message}`);
  }
  const profile = `${page.title ?? ''}\n${String(page.text ?? '').slice(0, 3000)}`;
  if (profile.trim().length < A().hostFit.minProfileChars) return result('C14', 'insufficient', 'The host’s home page says too little about itself to compare.');
  const markers = (kind) => (ctx.profile.markers ?? []).filter((m) => m.kind === kind && m.polarity !== -1).map((m) => m.value);
  const fit = hostFit(profile, { locations: markers('location'), occupations: markers('occupation'), organizations: markers('organization') });
  const detail = { value: fit.geo.length + fit.topic.length, ...fit, host, host_title: page.title, excerpt: profile.slice(0, 300) };
  return fit.fits
    ? result('C14', 'pass', `The host shares the client’s ${[fit.geo.length ? `place (${fit.geo.join(', ')})` : '', fit.topic.length ? `subject (${fit.topic.join(', ')})` : ''].filter(Boolean).join(' and ')}.`, detail)
    : result('C14', 'warn', `${host} shares neither the client’s places nor their subject. Check the placement makes sense before commissioning it.`, { ...detail, items: [`${host} describes itself as: “${profile.slice(0, 160).trim()}…”`] });
}

function c15(ctx) {
  const host = ctx.hostDomain;
  const owned = host && ctx.ownDomains.some((d) => host === d || host.endsWith(`.${d}`));
  if (!owned) return result('C15', 'not_applicable', 'Only checked for pages on properties the client controls.');
  if (!ctx.html) return result('C15', 'not_applicable', 'There is no live page to inspect yet; this is checked once the page is published.');
  const { persons, errors } = personSchema(ctx.html);
  const person = persons.find((p) => p.name && findOccurrences(p.name, ctx.names).length) ?? null;
  const expected = [...new Set([
    ...ctx.liveAssets.filter((a) => a.host_domain && a.host_domain !== host).map((a) => a.url),
    ...(ctx.profile.markers ?? []).filter((m) => m.kind === 'url' && m.value !== host).map((m) => `https://${m.value}`),
  ])];
  const sameAs = (person?.sameAs ?? []).map((u) => rootDomain(u));
  const missing = expected.filter((u) => !sameAs.includes(rootDomain(u)));
  const detail = { value: person ? 1 : 0, persons, parse_errors: errors, expected_same_as: expected, missing_same_as: missing };
  if (!persons.length) return result('C15', 'warn', 'The page has no Person JSON-LD.', { ...detail, items: ['Add Person markup describing the client.'] });
  if (!person) return result('C15', 'warn', 'Person markup is present but does not name the client.', { ...detail, items: ['Set the Person name to the client’s name.'] });
  if (missing.length) return result('C15', 'warn', `Person markup is missing ${s(missing.length, 'sameAs link')} to the client’s other properties.`, { ...detail, items: missing.map((u) => `Add sameAs: ${u}`) });
  return result('C15', 'pass', 'Person markup names the client and links their other properties.', detail);
}

const CHECKS = { C1: c1, C2: c2, C3: c3, C4: c4, C5: c5, C6: c6, C7: c7, C8: c8, C9: c9, C10: c10, C11: c11, C12: c12, C13: c13, C14: c14, C15: c15 };

/** Runs every check. A check that throws reports that it could not run, rather than disappearing. */
export async function runChecks(ctx, { report = null } = {}) {
  const links = extractLinks({ html: ctx.html, text: ctx.html ? '' : ctx.text, baseUrl: ctx.pageUrl });
  const full = { ...ctx, links };
  const out = [];
  for (const id of Object.keys(AUDIT_CHECKS)) {
    await report?.(id, 'running');
    let checked;
    try {
      checked = await CHECKS[id](full);
    } catch (err) {
      checked = result(id, 'insufficient', `This check could not run: ${err.message}`);
    }
    checked.blocking = A().blockingChecks.includes(id);
    out.push(checked);
    await report?.(id, 'done', `${checked.result}: ${checked.summary}`);
  }
  return out;
}

export { numberWord };
