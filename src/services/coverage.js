import { all, get, getSetting } from '../db.js';
import { round, ageDays, humanAge } from '../util/stats.js';
import { disambiguationSummary } from './disambiguation.js';
import { aliasCoverage } from './identity.js';
import { llmStatus } from '../providers/llm/index.js';

/**
 * §70, §71 — Coverage Confidence.
 *
 * This is not Google's index. Every analysis therefore has to state how much
 * of the picture we actually saw, and §71 is explicit that it must not become
 * false mathematical precision. So this returns a band — LOW, MEDIUM, HIGH —
 * derived from named criteria that are each reported in plain language, rather
 * than a score with decimal places that implies a measurement nobody made.
 *
 * The band is the count of satisfied criteria. The criteria are the value.
 */
export function coverageConfidence(entityId) {
  const entity = get(`SELECT * FROM entities WHERE id = ?`, entityId);
  if (!entity) return null;

  const ingest = getSetting(`ingest:${entityId}`, null);
  const trends = getSetting(`trends:${entityId}`, null);
  const disambiguation = disambiguationSummary(entityId);

  const documents = get(
    `SELECT COUNT(*) AS total,
            COUNT(DISTINCT d.root_domain) AS domains,
            SUM(CASE WHEN d.published_at IS NOT NULL THEN 1 ELSE 0 END) AS publisher_dated,
            SUM(CASE WHEN d.published_at IS NULL AND d.group_date IS NOT NULL THEN 1 ELSE 0 END) AS group_dated,
            SUM(CASE WHEN d.published_at IS NULL AND d.group_date IS NULL THEN 1 ELSE 0 END) AS undated,
            SUM(CASE WHEN d.fetch_status = 'fetched' THEN 1 ELSE 0 END) AS fetched,
            MIN(COALESCE(d.published_at, d.group_date)) AS earliest,
            MAX(COALESCE(d.published_at, d.group_date)) AS latest
       FROM documents d
       JOIN entity_document_matches m ON m.document_id = d.id
      WHERE m.entity_id = ? AND m.verdict = 'accept'`,
    entityId
  ) ?? {};

  const providers = all(
    `SELECT d.provider, COUNT(*) AS n FROM documents d
       JOIN entity_document_matches m ON m.document_id = d.id
      WHERE m.entity_id = ? GROUP BY d.provider`,
    entityId
  );

  const aliases = aliasCoverage(entityId, ingest?.queried_aliases ?? []);
  const total = documents.total ?? 0;
  const domains = documents.domains ?? 0;

  // Named criteria, each independently reported. Deliberately coarse.
  const criteria = [
    {
      key: 'corpus_size',
      met: total >= 500,
      partial: total >= 100,
      detail: `${total.toLocaleString()} documents analysed`,
    },
    {
      key: 'domain_diversity',
      met: domains >= 150,
      partial: domains >= 40,
      detail: `${domains.toLocaleString()} independent domains`,
    },
    {
      key: 'corpus_exhausted',
      met: ingest?.stop_reason === 'exhausted',
      partial: ingest?.stop_reason === 'max_documents',
      detail: ingest
        ? stopReasonText(ingest.stop_reason, ingest.total_available)
        : 'no ingest run recorded',
    },
    {
      key: 'alias_coverage',
      met: aliases.complete,
      partial: aliases.queried > 0,
      detail: aliases.complete
        ? `all ${aliases.known} aliases queried`
        : `${aliases.queried} of ${aliases.known} aliases queried${aliases.missing.length ? ` (missing: ${aliases.missing.slice(0, 3).join(', ')})` : ''}`,
    },
    {
      key: 'disambiguation',
      met: (disambiguation.mean_accepted_confidence ?? 0) >= 0.85 && disambiguation.review < disambiguation.accepted * 0.25,
      partial: (disambiguation.mean_accepted_confidence ?? 0) >= 0.75,
      detail: disambiguation.total
        ? `${disambiguation.accepted} accepted, ${disambiguation.review} awaiting review, ${disambiguation.rejected} rejected (mean confidence ${disambiguation.mean_accepted_confidence ?? '—'})`
        : 'no documents scored for identity yet',
    },
    {
      key: 'historical_depth',
      met: historyYears(documents.earliest) >= 5,
      partial: historyYears(documents.earliest) >= 2,
      detail: documents.earliest
        ? `earliest dated document ${String(documents.earliest).slice(0, 10)} (${humanAge(ageDays(documents.earliest))} of history)`
        : 'no dated documents',
    },
    {
      key: 'dating',
      met: (documents.undated ?? 0) + (documents.group_dated ?? 0) < total * 0.3,
      partial: (documents.undated ?? 0) < total * 0.3,
      detail: `${documents.publisher_dated ?? 0} publisher-dated, ${documents.group_dated ?? 0} dated by inference, ${documents.undated ?? 0} undated`,
    },
    {
      key: 'provider_diversity',
      met: providers.length >= 2,
      partial: providers.length >= 1,
      detail: providers.length
        ? providers.map((p) => `${p.provider} (${p.n})`).join(', ')
        : 'no providers recorded',
    },
    {
      // §11 — how much of what the provider holds we actually retrieved. A
      // corpus of 400 documents drawn from an index holding 40,000 citations
      // is a sample, and saying so is the difference between a finding and an
      // overstatement.
      key: 'corpus_sampling',
      met: Boolean(trends?.total_citations) && total >= trends.total_citations * 0.5,
      partial: Boolean(trends?.total_citations) && total >= trends.total_citations * 0.1,
      detail: trends?.total_citations
        ? `${total.toLocaleString()} analysed of ${Number(trends.total_citations).toLocaleString()} citations the provider reports since ${String(trends.earliest_month ?? '').slice(0, 7) || 'the start of the window'}`
        : 'provider citation history not fetched',
    },
  ];

  const met = criteria.filter((c) => c.met).length;
  const partial = criteria.filter((c) => !c.met && c.partial).length;
  const score = met + partial * 0.5;
  // Bands, not a percentage. §71 is explicit that this must not become false
  // mathematical precision, so the thresholds are round numbers over a count
  // of named criteria and the criteria themselves are what get displayed.
  const level = score >= 7 ? 'HIGH' : score >= 4.5 ? 'MEDIUM' : 'LOW';

  const warnings = [];
  if (!aliases.complete) warnings.push('Not every known alias was searched — the corpus is narrower than the identity profile allows for.');
  if (disambiguation.review > 0) warnings.push(`${disambiguation.review} documents are in the manual review band and are not contributing to any score.`);
  if ((documents.undated ?? 0) > total * 0.2) warnings.push('A significant share of documents carry no date; recency and momentum are less reliable for this entity.');
  if (ingest?.stop_reason === 'budget' || ingest?.stop_reason === 'max_documents') {
    warnings.push('Ingestion stopped at a configured ceiling rather than exhausting the corpus.');
  }
  if (!llmStatus().available) warnings.push('No LLM is configured: associations came from the deterministic fallback extractor and precision is materially lower.');

  if (trends?.total_citations && total < trends.total_citations * 0.25) {
    warnings.push(
      `This analysis covers ${total.toLocaleString()} of roughly ${Number(trends.total_citations).toLocaleString()} citations the provider holds for this name. Treat shares and momentum as measurements of the sample, not of the whole web.`
    );
  }

  return {
    level,
    documents_analysed: total,
    independent_domains: domains,
    corpus_history: trends
      ? {
          earliest_month: trends.earliest_month,
          total_citations: trends.total_citations,
          months: (trends.as_is ?? []).map((p) => ({
            month: String(p.date ?? '').slice(0, 7),
            citations: p.total_count,
            domains: (trends.one_per_domain ?? []).find((q) => q.date === p.date)?.total_count ?? null,
            partial: Boolean(p.partial),
          })),
        }
      : null,
    documents_with_body_text: documents.fetched ?? 0,
    date_range: documents.earliest
      ? { earliest: String(documents.earliest).slice(0, 10), latest: String(documents.latest).slice(0, 10) }
      : null,
    providers: providers.map((p) => p.provider),
    criteria,
    criteria_met: met,
    criteria_partial: partial,
    warnings,
    disambiguation,
  };
}

function historyYears(earliest) {
  const age = ageDays(earliest);
  return age === null ? 0 : age / 365.25;
}

function stopReasonText(reason, totalAvailable) {
  switch (reason) {
    case 'exhausted':
      return 'provider corpus exhausted';
    case 'max_documents':
      return `stopped at the document ceiling${totalAvailable ? ` of ${Number(totalAvailable).toLocaleString()} available` : ''}`;
    case 'budget':
      return 'stopped at the cost ceiling';
    case 'provider_depth_limit':
      return 'stopped at the provider pagination limit';
    case 'provider_balance':
      return 'stopped — provider account balance exhausted';
    default:
      return reason ? `stopped: ${reason}` : 'unknown';
  }
}

export { round };
