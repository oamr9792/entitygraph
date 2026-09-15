import config, { MODEL } from '../config.js';
import { all, get, run, tx } from '../db.js';
import { AUDIT_CHECKS } from '../copy/metrics.js';
import { identityProfile, getEntity } from './identity.js';
import { coverageConfidence } from './coverage.js';
import { contentHash, rootDomain } from '../util/hash.js';
import { normaliseWhitespace } from '../util/text.js';
import { HttpError, badRequest, notFound } from '../http.js';
import { enqueue, getJob } from '../jobs/queue.js';
import { llmStatus } from '../providers/llm/index.js';
import { fetchPublicPage } from './content-source.js';
import { clientNames, ownDomains, exclusionsFor, extractFacts, storedFacts } from './audit-facts.js';
import { runChecks } from './audit-checks.js';
import { groupChecks, summarySentence, signoffRule } from './audit-rules.js';

/**
 * §98–§103 — the content audit: an on-demand job, never part of a build.
 *
 * It reports; a person fixes. Nothing here rewrites, publishes or scores. Every
 * result is stored against the exact text it was run on (text_hash), so a
 * change to the words makes old results and sign-offs visibly stale.
 */

const LEVELS = ['LOW', 'MEDIUM', 'HIGH'];
const CHECK_IDS = Object.keys(AUDIT_CHECKS);
export const AUDIT_STEPS = CHECK_IDS.length + 2;

const parse = (value, fallback) => {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};
export const hashText = (text) => contentHash(normaliseWhitespace(text));
const hostOf = (value) => (value ? rootDomain(String(value).includes('://') ? value : `https://${value}`) : null);

// --- Creating audits -------------------------------------------------------------------------

export function createAuditDraft({
  entityId, sourceKind, text, title = null, html = null, hostDomain = null, targetUrl = null, pageUrl = null,
  assetId = null, contentDraftId = null, user = null,
}) {
  getEntity(entityId);
  const clean = String(text ?? '').trim();
  if (clean.length < 80) throw badRequest('Give the audit at least a paragraph of text.');
  const res = run(
    `INSERT INTO audit_draft
       (entity_id, asset_id, content_draft_id, source_kind, host_domain, target_url, page_url, title, text, html, text_hash, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    entityId,
    assetId,
    contentDraftId,
    sourceKind,
    hostOf(hostDomain),
    targetUrl || null,
    pageUrl,
    title ? normaliseWhitespace(title).slice(0, 300) : null,
    clean,
    html,
    hashText(clean),
    user?.id ?? null
  );
  return Number(res.lastInsertRowid);
}

export function queueAudit(draftId) {
  const draft = get(`SELECT id, entity_id FROM audit_draft WHERE id = ?`, draftId);
  if (!draft) throw notFound('audit not found');
  const job = enqueue(draft.entity_id, 'content_audit', { draft_id: draftId, steps_total: AUDIT_STEPS });
  run(`UPDATE audit_draft SET status = 'pending', status_detail = NULL, job_id = ? WHERE id = ?`, job.id, draftId);
  return getAudit(draftId);
}

export async function auditUrl(entityId, url, { assetId = null, targetUrl = null, user = null } = {}) {
  const page = await fetchPublicPage(url, { entityId });
  if ((page.text ?? '').length < 200) {
    throw badRequest(`Could not read enough of that page${page.reason ? `: ${page.reason}` : ''}.`);
  }
  const id = createAuditDraft({
    entityId, sourceKind: 'url', text: page.text, title: page.title, html: page.html || null,
    hostDomain: page.finalUrl, pageUrl: page.finalUrl, targetUrl, assetId, user,
  });
  return id;
}

/** A generated draft is audited as it stands; an unchanged draft reuses its audit. */
export async function auditContentDraft(contentDraftId, { user = null } = {}) {
  const { getDraft } = await import('./content.js');
  const draft = getDraft(contentDraftId).draft;
  if (!draft.body) throw badRequest('There is no draft text to audit yet.');
  const text = `${draft.title ?? ''}\n\n${draft.body}`.trim();
  const latest = get(`SELECT id, text_hash, status FROM audit_draft WHERE content_draft_id = ? ORDER BY id DESC LIMIT 1`, contentDraftId);
  if (latest && latest.text_hash === hashText(text) && latest.status !== 'failed') return getAudit(latest.id);
  const asset = get(`SELECT id, host_domain FROM content_assets WHERE content_draft_id = ? ORDER BY id DESC LIMIT 1`, contentDraftId);
  const id = createAuditDraft({
    entityId: draft.entity_id,
    sourceKind: 'generated',
    text,
    title: draft.title,
    hostDomain: asset?.host_domain ?? draft.published_url ?? null,
    contentDraftId,
    assetId: asset?.id ?? null,
    user,
  });
  return queueAudit(id);
}

// --- Running --------------------------------------------------------------------------------------

function storeFacts(draftId, textHash, facts) {
  tx(() => {
    run(`DELETE FROM audit_draft_fact WHERE draft_id = ?`, draftId);
    for (const f of facts) {
      run(
        `INSERT INTO audit_draft_fact
           (draft_id, association_id, extracted_claim, relationship, kind, category, sentence, surface_form, evidence,
            relationship_confidence, sentiment, token_distance, boundary, resolution, sources, independent_sources, extractor, text_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        draftId, f.association_id, f.extracted_claim, f.relationship, f.kind, f.category, f.sentence, f.surface_form, f.evidence,
        f.relationship_confidence, f.sentiment, f.token_distance, f.boundary, f.resolution, f.sources, f.independent_sources,
        f.extractor, textHash
      );
    }
  });
}

const currentSignoffs = (draftId, textHash) =>
  all(`SELECT * FROM audit_draft_signoff WHERE draft_id = ? AND text_hash = ? ORDER BY signed_at DESC, id DESC`, draftId, textHash);

export async function runAudit(draftId, { jobId = null, report = async () => {} } = {}) {
  const draft = get(`SELECT * FROM audit_draft WHERE id = ?`, draftId);
  if (!draft) throw notFound('audit not found');
  run(`UPDATE audit_draft SET status = 'running', status_detail = NULL WHERE id = ?`, draftId);

  try {
    const entity = getEntity(draft.entity_id);
    const profile = identityProfile(entity.id);

    // §98: refuse, and say why, rather than compare against a corpus too thin to mean anything.
    await report('coverage', 'running');
    const coverage = coverageConfidence(entity.id);
    const level = coverage?.level ?? 'LOW';
    if (LEVELS.indexOf(level) < LEVELS.indexOf(MODEL.audit.minCoverageLevel)) {
      const why = `Coverage confidence for ${entity.canonical_name} is ${level}, below the ${MODEL.audit.minCoverageLevel} an audit needs: every differentiation check would compare against a corpus too thin to mean anything. Widen the corpus, rebuild, and audit again.`;
      run(`UPDATE audit_draft SET status = 'refused', status_detail = ?, audited_at = datetime('now') WHERE id = ?`, why, draftId);
      await report('coverage', 'done', why);
      return getAudit(draftId);
    }
    await report('coverage', 'done', `coverage confidence ${level}`);

    let contentDraft = null;
    if (draft.content_draft_id) {
      const { getDraft } = await import('./content.js');
      try { contentDraft = getDraft(draft.content_draft_id).draft; } catch { contentDraft = null; }
    }

    // One extraction pass per text. Unchanged text reuses its stored rows,
    // unless they came from the fallback extractor and an LLM is now available.
    await report('facts', 'running');
    const excludeUrls = [draft.page_url].filter(Boolean);
    const stored = get(`SELECT COUNT(*) AS n FROM audit_draft_fact WHERE draft_id = ? AND text_hash = ?`, draftId, draft.text_hash).n;
    const reuse = stored > 0 && draft.extractor && !(draft.extractor !== 'llm' && llmStatus().available);
    let extractor = draft.extractor;
    if (!reuse) {
      const extracted = await extractFacts({ entityId: entity.id, profile, text: draft.text, excludeUrls, jobId });
      extractor = extracted.extractor;
      storeFacts(draftId, draft.text_hash, extracted.facts);
    }
    const facts = storedFacts(draftId, draft.text_hash, { excludeUrls });
    await report('facts', 'done', `${facts.length} claims, read by ${extractor}${reuse ? ' (reused: text unchanged)' : ''}`);

    const liveAssets = all(
      `SELECT a.*, (SELECT MAX(d.id) FROM audit_draft d WHERE d.asset_id = a.id AND d.status = 'done' AND d.id != ?) AS latest_audit_id
         FROM content_assets a WHERE a.entity_id = ? AND a.status = 'live'`,
      draftId,
      entity.id
    );

    const checks = await runChecks({
      draft, entity, profile, coverage, facts, extractor, contentDraft, liveAssets,
      names: clientNames(profile),
      text: draft.text,
      html: draft.html,
      title: draft.title,
      hostDomain: draft.host_domain,
      targetUrl: draft.target_url,
      pageUrl: draft.page_url,
      exclusions: exclusionsFor(entity.id, { profile, contentDraft }),
      ownDomains: ownDomains(entity.id, profile),
      signoffs: currentSignoffs(draftId, draft.text_hash),
    }, { report });

    const novel = new Set(checks.find((c) => c.check_id === 'C5')?.detail?.novel_association_ids ?? []);
    const classes = new Map((checks.find((c) => c.check_id === 'C6')?.detail?.facts ?? []).map((f) => [f.claim, f.class]));
    tx(() => {
      run(`DELETE FROM audit_draft_check WHERE draft_id = ?`, draftId);
      for (const c of checks) {
        run(
          `INSERT INTO audit_draft_check (draft_id, check_id, result, value, denominator, summary, detail_json, blocking, text_hash, build)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          draftId, c.check_id, c.result, c.value, c.denominator, c.summary, JSON.stringify(c.detail ?? {}), c.blocking ? 1 : 0,
          draft.text_hash, config.version?.commit ?? null
        );
      }
      for (const f of facts) {
        run(`UPDATE audit_draft_fact SET novel = ?, source_class = ? WHERE id = ?`,
          novel.has(f.association_id) ? 1 : 0, classes.get(f.extracted_claim) ?? null, f.id);
      }
      run(`UPDATE audit_draft SET status = 'done', extractor = ?, status_detail = ?, audited_at = datetime('now') WHERE id = ?`,
        extractor, summarySentence(checks), draftId);
    });
    return getAudit(draftId);
  } catch (err) {
    run(`UPDATE audit_draft SET status = 'failed', status_detail = ? WHERE id = ?`, String(err.message ?? err).slice(0, 500), draftId);
    throw err;
  }
}

// --- Reading ----------------------------------------------------------------------------------------------

function approvalState(draft, checks) {
  if (draft.status === 'refused') return { ready: false, reason: draft.status_detail };
  if (draft.status !== 'done') return { ready: false, reason: draft.status === 'failed' ? `The audit failed: ${draft.status_detail}` : 'The audit has not finished.' };
  const open = checks.filter((c) => c.blocking && c.result !== 'pass' && !c.signed_off);
  return open.length
    ? { ready: false, reason: `${open.map((c) => AUDIT_CHECKS[c.check_id].name).join(', ')} must pass first.`, open: open.map((c) => c.check_id) }
    : { ready: true, reason: null, open: [] };
}

export function getAudit(draftId) {
  const draft = get(
    `SELECT a.*, e.canonical_name AS entity_name, u.name AS created_by_name
       FROM audit_draft a JOIN entities e ON e.id = a.entity_id LEFT JOIN app_user u ON u.id = a.created_by
      WHERE a.id = ?`,
    draftId
  );
  if (!draft) throw notFound('audit not found');
  const signoffs = currentSignoffs(draftId, draft.text_hash);
  const checks = all(`SELECT * FROM audit_draft_check WHERE draft_id = ?`, draftId)
    .map(({ detail_json: detailJson, ...c }) => {
      const signoff = signoffs.find((x) => x.check_id === c.check_id) ?? null;
      return {
        ...c,
        blocking: Boolean(c.blocking),
        detail: parse(detailJson, {}),
        copy: AUDIT_CHECKS[c.check_id],
        signoff,
        // C3 is cleared by turning its result to pass, not by a sign-off flag.
        signed_off: Boolean(signoff) && !MODEL.audit.approvalOnly.includes(c.check_id),
        stale: c.text_hash !== draft.text_hash,
      };
    })
    .map((c) => ({ ...c, signoff_rule: c.signed_off ? { allowed: false, why: 'Already signed off.' } : signoffRule(c.check_id, c.result) }))
    .sort((a, b) => CHECK_IDS.indexOf(a.check_id) - CHECK_IDS.indexOf(b.check_id));
  const groups = groupChecks(checks);
  const { html, ...rest } = draft;
  return {
    draft: { ...rest, has_html: Boolean(html) },
    checks,
    facts: all(
      `SELECT id, association_id, extracted_claim, relationship, sentence, resolution, sources, independent_sources, source_class, novel, extractor
         FROM audit_draft_fact WHERE draft_id = ? AND text_hash = ? ORDER BY id`,
      draftId,
      draft.text_hash
    ),
    summary: draft.status === 'done' ? summarySentence(checks) : draft.status_detail,
    counts: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])),
    approval: approvalState(draft, checks),
    job: draft.job_id ? getJob(draft.job_id) : null,
  };
}

export function listAudits(entityId, { limit = 60 } = {}) {
  return all(
    `SELECT a.id, a.source_kind, a.title, a.page_url, a.host_domain, a.status, a.status_detail, a.created_at, a.audited_at,
            a.asset_id, a.content_draft_id,
            SUM(CASE WHEN c.blocking = 1 AND c.result != 'pass' THEN 1 ELSE 0 END) AS blocking_open,
            SUM(CASE WHEN c.result = 'warn' OR (c.result = 'fail' AND c.blocking = 0) THEN 1 ELSE 0 END) AS warnings
       FROM audit_draft a LEFT JOIN audit_draft_check c ON c.draft_id = a.id
      WHERE a.entity_id = ?
      GROUP BY a.id ORDER BY a.id DESC LIMIT ?`,
    entityId,
    limit
  );
}

/** Whether a generated draft may be approved: its current text must have a finished audit with nothing blocking. */
export function approvalForContentDraft(contentDraftId, text) {
  const latest = get(`SELECT id, text_hash FROM audit_draft WHERE content_draft_id = ? ORDER BY id DESC LIMIT 1`, contentDraftId);
  if (!latest) return { ready: false, reason: 'Audit this draft before approving it.', audit_id: null };
  if (latest.text_hash !== hashText(text)) return { ready: false, reason: 'The text has changed since the last audit. Audit it again.', audit_id: latest.id };
  return { ...getAudit(latest.id).approval, audit_id: latest.id };
}

// --- §101 sign-off --------------------------------------------------------------------------------------

export function signOff(draftId, checkId, { reason = null } = {}, user = null) {
  if (!user) throw new HttpError('A sign-off must be recorded by a signed-in person.', 401);
  const audit = getAudit(draftId);
  const check = audit.checks.find((c) => c.check_id === checkId);
  if (!check) throw notFound('check not found');
  if (audit.draft.status !== 'done') throw badRequest('Sign-off applies to a finished audit.');
  if (check.stale) throw badRequest('The text changed since this check ran. Audit it again first.');
  if (check.signed_off) throw badRequest('This check is already signed off.');
  const rule = signoffRule(checkId, check.result);
  if (!rule.allowed) throw badRequest(rule.why);
  const why = normaliseWhitespace(reason ?? '');
  if (rule.reasonRequired && why.length < 10) throw badRequest('Give a reason, in a sentence, for signing this off.');

  const name = user.name || user.email;
  run(
    `INSERT INTO audit_draft_signoff (draft_id, check_id, user_id, user_name, reason, text_hash) VALUES (?, ?, ?, ?, ?, ?)`,
    draftId, checkId, user.id, name, why || null, audit.draft.text_hash
  );
  if (rule.approval) {
    run(`UPDATE audit_draft_check SET result = 'pass', summary = ? WHERE draft_id = ? AND check_id = ?`,
      `Compliance sign-off recorded by ${name} on ${new Date().toISOString().slice(0, 10)}.`, draftId, checkId);
  }
  return getAudit(draftId);
}

// --- §102 the asset registry and batch audits ---------------------------------------------------------

export function listAssets(entityId) {
  return all(
    `SELECT a.*, d.id AS audit_id, d.status AS audit_status, d.audited_at, d.status_detail AS audit_summary
       FROM content_assets a
       LEFT JOIN audit_draft d ON d.id = (SELECT MAX(x.id) FROM audit_draft x WHERE x.asset_id = a.id)
      WHERE a.entity_id = ? ORDER BY a.status, a.created_at DESC`,
    entityId
  ).map((a) => ({
    ...a,
    key_checks: a.audit_id
      ? Object.fromEntries(all(`SELECT check_id, result, value, denominator FROM audit_draft_check WHERE draft_id = ? AND check_id IN ('C5','C8','C9')`, a.audit_id)
          .map((c) => [c.check_id, c]))
      : {},
  }));
}

export function addAsset(entityId, { url, kind = 'placed', label = null, contentDraftId = null } = {}, user = null) {
  getEntity(entityId);
  let parsed;
  try { parsed = new URL(String(url ?? '').trim()); } catch { throw badRequest('Give the asset’s full URL.'); }
  if (!/^https?:$/.test(parsed.protocol)) throw badRequest('Only http and https pages can be registered.');
  run(
    `INSERT INTO content_assets (entity_id, url, host_domain, kind, label, content_draft_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity_id, url) DO UPDATE SET status = 'live', kind = excluded.kind,
       label = COALESCE(excluded.label, content_assets.label), content_draft_id = COALESCE(excluded.content_draft_id, content_assets.content_draft_id)`,
    entityId, parsed.href, rootDomain(parsed.href), kind === 'owned' ? 'owned' : 'placed', label, contentDraftId, user?.id ?? null
  );
  return get(`SELECT * FROM content_assets WHERE entity_id = ? AND url = ?`, entityId, parsed.href);
}

export function setAssetStatus(assetId, status) {
  if (!['live', 'retired'].includes(status)) throw badRequest('Status must be live or retired.');
  run(`UPDATE content_assets SET status = ? WHERE id = ?`, status, assetId);
  return get(`SELECT * FROM content_assets WHERE id = ?`, assetId);
}

export function queueAssetBatch(entityId) {
  const count = get(`SELECT COUNT(*) AS n FROM content_assets WHERE entity_id = ? AND status = 'live'`, entityId).n;
  if (!count) throw badRequest('There are no live assets registered for this client.');
  return enqueue(entityId, 'asset_audit_batch', { steps_total: count });
}

export async function runAssetBatch(entityId, { jobId = null, report = async () => {} } = {}) {
  const assets = all(`SELECT * FROM content_assets WHERE entity_id = ? AND status = 'live' ORDER BY id`, entityId);
  for (const asset of assets) {
    const step = `asset ${asset.id}`;
    await report(step, 'running');
    try {
      const id = await auditUrl(entityId, asset.url, { assetId: asset.id });
      run(`UPDATE audit_draft SET job_id = ? WHERE id = ?`, jobId, id);
      const audit = await runAudit(id, { jobId });
      await report(step, 'done', `${asset.url}: ${audit.summary ?? audit.draft.status}`);
    } catch (err) {
      await report(step, 'done', `${asset.url}: could not be audited (${err.message})`);
    }
  }
}

/**
 * §102 — which live assets are contributing. Rewrite candidates fail both the
 * novelty and projection checks; collapsing pairs cluster with each other.
 */
export function assetReport(entityId) {
  const assets = listAssets(entityId).filter((a) => a.status === 'live');
  const rewrite = assets.filter((a) => {
    const c5 = a.key_checks.C5;
    const c8 = a.key_checks.C8;
    return c5 && c8 && c5.result !== 'pass' && c5.result !== 'insufficient' && c8.result === 'warn';
  });
  const collapsing = [];
  for (const a of assets) {
    if (!a.audit_id) continue;
    const detail = parse(get(`SELECT detail_json FROM audit_draft_check WHERE draft_id = ? AND check_id = 'C9'`, a.audit_id)?.detail_json, {});
    for (const m of detail.sibling_matches ?? []) {
      if (m.kind === 'asset') collapsing.push({ asset: a.url, clusters_with: m.url, similarity: m.similarity });
    }
  }
  const audited = assets.filter((a) => a.audit_status === 'done');
  const restatements = audited.filter((a) => a.key_checks.C9?.result === 'fail').length;
  return {
    live: assets.length,
    audited: audited.length,
    restatement_share: audited.length ? restatements / audited.length : null,
    rewrite_candidates: rewrite.map((a) => ({ id: a.id, url: a.url, audit_id: a.audit_id })),
    collapsing,
  };
}

/** §102 — a weekly batch per client with live assets. In-process: one worker, one queue. */
export function scheduleAssetAudits({ everyMs = 60 * 60 * 1000 } = {}) {
  const tick = () => {
    try {
      const due = all(
        `SELECT DISTINCT a.entity_id FROM content_assets a
          WHERE a.status = 'live'
            AND NOT EXISTS (
              SELECT 1 FROM crawl_jobs j WHERE j.entity_id = a.entity_id AND j.kind = 'asset_audit_batch'
                AND (j.status IN ('queued','running') OR j.created_at > datetime('now', ?))
            )`,
        `-${MODEL.audit.batch.intervalDays} days`
      );
      for (const { entity_id: entityId } of due) queueAssetBatch(entityId);
    } catch (err) {
      console.error('[audit] scheduling failed:', err.message);
    }
  };
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  return timer;
}
