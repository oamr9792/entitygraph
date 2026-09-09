import { all, get, run } from '../db.js';
import { runPipeline, STEPS } from './pipeline.js';
import { spendForEntity } from '../providers/http-client.js';
import { diagnoseNetworkError } from '../tls-trust.js';

/**
 * A single-worker job queue.
 *
 * Celery and Redis are the right answer at scale; at this one they would be
 * two more services to run for a workload that is entirely I/O-bound on
 * outbound HTTP. One in-process worker draining a SQLite-backed queue gives
 * the same three properties that actually matter here: jobs survive a restart,
 * progress is visible while a job runs, and two builds of the same entity
 * cannot interleave and corrupt each other's scores.
 *
 * The queue is deliberately serial. Running two entity builds at once would
 * multiply provider rate-limit pressure for no wall-clock gain on a workload
 * whose bottleneck is a throttled API.
 */

let running = false;
const cancelled = new Set();

export function enqueue(entityId, kind = 'full_build', options = {}) {
  const res = run(
    `INSERT INTO crawl_jobs (entity_id, kind, status, steps_total, options) VALUES (?, ?, 'queued', ?, ?)`,
    entityId,
    kind,
    STEPS.length,
    JSON.stringify(options)
  );
  const jobId = Number(res.lastInsertRowid);
  setImmediate(drain);
  return getJob(jobId);
}

export const getJob = (jobId) => {
  const job = get(`SELECT * FROM crawl_jobs WHERE id = ?`, jobId);
  if (!job) return null;
  return { ...job, options: safeParse(job.options, {}), progress: safeParse(job.progress, []) };
};

export const listJobs = (entityId = null, limit = 25) =>
  all(
    `SELECT * FROM crawl_jobs WHERE (? IS NULL OR entity_id = ?) ORDER BY id DESC LIMIT ?`,
    entityId,
    entityId,
    limit
  ).map((j) => ({ ...j, options: safeParse(j.options, {}), progress: safeParse(j.progress, []) }));

export function cancelJob(jobId) {
  const job = get(`SELECT * FROM crawl_jobs WHERE id = ?`, jobId);
  if (!job) return null;
  if (job.status === 'queued') {
    run(`UPDATE crawl_jobs SET status = 'cancelled', finished_at = datetime('now') WHERE id = ?`, jobId);
  } else if (job.status === 'running') {
    // Cooperative: the pipeline checks between steps and inside long loops.
    cancelled.add(jobId);
  }
  return getJob(jobId);
}

function safeParse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

async function drain() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const next = get(`SELECT * FROM crawl_jobs WHERE status = 'queued' ORDER BY id LIMIT 1`);
      if (!next) break;
      await execute(next);
    }
  } finally {
    running = false;
  }
}

async function execute(job) {
  run(`UPDATE crawl_jobs SET status = 'running', started_at = datetime('now') WHERE id = ?`, job.id);
  const progress = [];
  let stepsDone = 0;

  const report = async (step, status, detail = null) => {
    const entry = { step, status, detail, at: new Date().toISOString() };
    const existing = progress.findIndex((p) => p.step === step);
    if (existing >= 0) progress[existing] = entry;
    else progress.push(entry);
    if (status === 'done' || status === 'skipped') stepsDone += 1;
    run(
      `UPDATE crawl_jobs SET step = ?, steps_done = ?, progress = ? WHERE id = ?`,
      step,
      stepsDone,
      JSON.stringify(progress),
      job.id
    );
    if (detail) console.log(`[job ${job.id}] ${step}: ${detail}`);
  };

  const heartbeat = async (info) => {
    run(`UPDATE crawl_jobs SET progress = ? WHERE id = ?`, JSON.stringify([...progress, { heartbeat: info, at: new Date().toISOString() }]), job.id);
  };

  try {
    await runPipeline({
      entityId: job.entity_id,
      jobId: job.id,
      options: safeParse(job.options, {}),
      report,
      heartbeat,
      shouldStop: () => cancelled.has(job.id),
    });
    const spend = spendForEntity(job.entity_id);
    const wasCancelled = cancelled.delete(job.id);
    run(
      `UPDATE crawl_jobs SET status = ?, finished_at = datetime('now'), cost_usd = ? WHERE id = ?`,
      wasCancelled ? 'cancelled' : 'done',
      spend.costUsd,
      job.id
    );
  } catch (err) {
    cancelled.delete(job.id);
    // A raw OpenSSL code tells an analyst nothing. When the failure is about
    // this machine rather than the request — an antivirus web shield, a
    // corporate proxy, dead DNS — say which, and what to do about it.
    const diagnosis = diagnoseNetworkError(err.message);
    const message = diagnosis ? `${diagnosis.message}\n\nUnderlying error: ${err.message}` : err.message;
    console.error(`[job ${job.id}] failed:`, err.message);
    if (diagnosis) console.error(`[job ${job.id}] diagnosis: ${diagnosis.kind}`);
    run(
      `UPDATE crawl_jobs SET status = 'failed', finished_at = datetime('now'), error = ? WHERE id = ?`,
      String(message).slice(0, 1000),
      job.id
    );
  }
}

/**
 * Requeues anything left running by a crash. Called at boot: a job marked
 * running with no worker behind it would otherwise sit there forever.
 */
export function recoverOrphanedJobs() {
  const orphans = all(`SELECT id FROM crawl_jobs WHERE status = 'running'`);
  for (const job of orphans) {
    run(
      `UPDATE crawl_jobs SET status = 'failed', error = 'interrupted by restart', finished_at = datetime('now') WHERE id = ?`,
      job.id
    );
  }
  setImmediate(drain);
  return orphans.length;
}

export { STEPS };
