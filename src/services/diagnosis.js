import { all, get } from '../db.js';

/**
 * Why is this dashboard empty?
 *
 * A build can finish every step without producing anything: the corpus comes
 * back, disambiguation rejects all of it, extraction has nothing to read, and
 * the job reports success. The money is spent either way. From the dashboard
 * that is indistinguishable from a build that was never run — which leaves
 * someone staring at an empty screen knowing only that they were charged.
 *
 * This reads the last job's own step details and says what happened, in the
 * order the pipeline would have hit it. It asserts nothing the steps did not
 * report; where the cause is ambiguous it says which two things to check
 * rather than picking one.
 */
export function diagnoseEmptyEntity(entityId) {
  const entity = get(`SELECT * FROM entities WHERE id = ?`, entityId);
  if (!entity) return null;

  const job = get(
    `SELECT * FROM crawl_jobs WHERE entity_id = ? AND kind = 'full_build' ORDER BY id DESC LIMIT 1`,
    entityId
  );
  if (!job) {
    return {
      verdict: 'never_built',
      headline: 'No build has been run for this entity yet.',
      detail: 'Start one from Jobs & cost.',
      steps: [],
    };
  }

  let steps = [];
  try {
    steps = JSON.parse(job.progress).filter((p) => p.step);
  } catch { /* a corrupt progress blob should not hide the rest */ }

  const stepDetail = (name) => steps.find((s) => s.step === name)?.detail ?? null;
  const counts = {
    documents: get(
      `SELECT COUNT(*) AS n FROM entity_document_matches WHERE entity_id = ?`,
      entityId
    )?.n ?? 0,
    accepted: get(
      `SELECT COUNT(*) AS n FROM entity_document_matches WHERE entity_id = ? AND verdict = 'accept'`,
      entityId
    )?.n ?? 0,
    review: get(
      `SELECT COUNT(*) AS n FROM entity_document_matches WHERE entity_id = ? AND verdict = 'review'`,
      entityId
    )?.n ?? 0,
    rejected: get(
      `SELECT COUNT(*) AS n FROM entity_document_matches WHERE entity_id = ? AND verdict = 'reject'`,
      entityId
    )?.n ?? 0,
    evidence: get(`SELECT COUNT(*) AS n FROM evidence WHERE entity_id = ?`, entityId)?.n ?? 0,
    associations: get(
      `SELECT COUNT(*) AS n FROM associations WHERE entity_id = ? AND status = 'active'`,
      entityId
    )?.n ?? 0,
  };
  const spend = get(
    `SELECT COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS calls, SUM(ok = 0) AS failures
       FROM api_usage WHERE entity_id = ?`,
    entityId
  ) ?? { usd: 0, calls: 0, failures: 0 };

  const base = { job_id: job.id, job_status: job.status, steps, counts, spend };

  if (job.status === 'running' || job.status === 'queued') {
    return { ...base, verdict: 'in_progress', headline: 'A build is still running.', detail: null };
  }
  if (job.status === 'failed') {
    return {
      ...base,
      verdict: 'failed',
      headline: `The last build failed at step ${job.steps_done + 1} of ${job.steps_total}.`,
      detail: job.error,
    };
  }
  if (job.status === 'cancelled') {
    return {
      ...base,
      verdict: 'cancelled',
      headline: 'The last build was cancelled before it finished.',
      detail: 'Anything it had already written was kept, so a rebuild resumes cheaply.',
    };
  }

  // The job says done. Work out where the pipeline ran dry, in pipeline order,
  // because the first empty stage is the one that caused every later one.
  if (!counts.documents) {
    return {
      ...base,
      verdict: 'no_corpus',
      headline: 'The corpus search returned no documents.',
      detail:
        'Nothing was found for any of the names searched. Check the spelling of the entity name and its aliases on the Identity profile screen — the search is an exact phrase match, so a middle initial or a misspelling returns nothing at all.',
      remedy: 'identity',
    };
  }

  if (!counts.accepted) {
    const marker = get(
      `SELECT COUNT(*) AS n FROM entity_identity_markers WHERE entity_id = ?`,
      entityId
    )?.n ?? 0;
    return {
      ...base,
      verdict: 'all_rejected',
      headline: `${counts.documents} documents were retrieved, and every one was judged to be a different person.`,
      detail:
        `Nothing reached the scoring stage, which is why the dashboard is empty even though the build completed and the corpus was paid for. ` +
        (marker === 0
          ? 'This entity has no identity markers at all, so no document could confirm it. Add an organisation, a location and an occupation on the Identity profile screen and rebuild.'
          : `The ${marker} identity markers on file did not appear in any retrieved document. Either they are wrong for this person, or the corpus is genuinely about someone else with the same name. The review queue holds ${counts.review} borderline documents worth reading before rebuilding.`),
      remedy: 'identity',
    };
  }

  if (!counts.evidence) {
    const extraction = stepDetail('extract_associations');
    return {
      ...base,
      verdict: 'no_evidence',
      headline: `${counts.accepted} documents were accepted, but no evidence was extracted from them.`,
      detail:
        extraction ??
        'The extraction step produced nothing. The usual cause is a missing or rejected LLM key — check Settings & model, which reports which extractor is actually in use.',
      remedy: 'settings',
    };
  }

  if (!counts.associations) {
    return {
      ...base,
      verdict: 'all_merged_or_excluded',
      headline: `${counts.evidence} pieces of evidence exist, but no association is active.`,
      detail: 'Every association has been merged away or excluded. Check the review queue and the correction history.',
      remedy: 'review',
    };
  }

  return {
    ...base,
    verdict: 'ok',
    headline: `${counts.associations} associations from ${counts.accepted} accepted documents.`,
    detail: null,
  };
}
