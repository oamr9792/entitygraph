import { Worker } from 'node:worker_threads';

/**
 * Runs the §99 C8 projection in a worker thread and returns per-association
 * changes: lifetime association strength and recent strength, before and after.
 * No Google Retrieval Score is projected, ever — nothing in this model can see
 * Google's retrieval.
 */
export function projectDraft({ entityId, text, title = null, hostDomain = null, associations = [] }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./audit-projection-worker.js', import.meta.url), {
      workerData: { entityId, text, title, hostDomain, associations, now: Date.now() },
    });
    let settled = false;
    worker.once('message', (message) => {
      settled = true;
      resolve(projectionDeltas(message));
    });
    worker.once('error', (err) => {
      settled = true;
      reject(err);
    });
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`the projection worker stopped (exit code ${code})`));
    });
  });
}

const round1 = (v) => Math.round(Number(v ?? 0) * 10) / 10;

/** Pure: pairs the two leaderboards. Associations created by the draft have no baseline. */
export function projectionDeltas({ baseline = [], projected = [] }) {
  const before = new Map(baseline);
  return projected
    .map(([id, after]) => {
      const was = before.get(id) ?? null;
      return {
        association_id: id,
        label: after.label,
        new_association: !was,
        pias_before: was ? was.pias : null,
        pias_after: after.pias,
        pias_delta: round1(after.pias - (was?.pias ?? 0)),
        current_before: was ? was.current_pias : null,
        current_after: after.current_pias,
        current_delta: round1(after.current_pias - (was?.current_pias ?? 0)),
      };
    })
    .sort((a, b) => Math.abs(b.pias_delta) + Math.abs(b.current_delta) - (Math.abs(a.pias_delta) + Math.abs(a.current_delta)));
}
