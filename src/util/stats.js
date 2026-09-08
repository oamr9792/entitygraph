/**
 * Small numeric helpers. Kept together because scoring reads better when the
 * arithmetic idioms it relies on are named — `normaliseWithin(x, max)` says
 * what §33 means; `100 * x / max || 0` does not.
 */

export const clamp = (v, lo = 0, hi = 1) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

export const round = (v, dp = 2) => {
  if (!Number.isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

export const sum = (xs) => xs.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

export const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);

export function median(xs) {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export function quantile(xs, q) {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

/**
 * §33/§34 — every PIAS component is expressed as 0–100 relative to the
 * strongest association for the same entity. That makes PIAS explicitly a
 * within-entity ranking, which is what the brief asks for, and it is why two
 * entities' PIAS values must never be compared directly.
 */
export const normaliseWithin = (value, max) =>
  !Number.isFinite(value) || !Number.isFinite(max) || max <= 0 ? 0 : clamp((value / max) * 100, 0, 100);

export const safeDiv = (a, b, dflt = 0) => (Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : dflt);

// --- Dates ------------------------------------------------------------------

export const DAY_MS = 86400000;

/**
 * DataForSEO emits "2024-03-11 14:22:07 +00:00": a space instead of the T, and
 * a second space before the offset. Date() rejects it. This repairs both so
 * the string parses, and is also used at ingest so every stored date is a real
 * ISO string — SQLite compares dates as text, and a corpus holding two date
 * formats compares them wrongly at exactly the boundaries that matter.
 */
export function toIsoish(value) {
  const s = String(value ?? '').trim();
  if (!s) return s;
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
  return s.replace(/^(\d{4}-\d{2}-\d{2})[ T]/, '$1T').replace(/\s+([+-]\d{2}:?\d{2}|Z)$/, '$1');
}

/** Normalised ISO-8601 for storage, or null when the value is unusable. */
export function normaliseDate(value) {
  const d = parseDate(value);
  return d ? d.toISOString() : null;
}

/** Parses the date formats corpus providers actually emit. Null when unusable. */
export function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const s = String(value).trim();
  if (!s) return null;
  const d = new Date(toIsoish(s));
  if (Number.isNaN(d.getTime())) return null;
  // A publication date in the future is a CMS artefact, not information.
  if (d.getTime() > Date.now() + 2 * DAY_MS) return null;
  return d;
}

export function ageDays(value, now = Date.now()) {
  const d = parseDate(value);
  if (!d) return null;
  return Math.max(0, (now - d.getTime()) / DAY_MS);
}

export const monthKey = (value) => {
  const d = parseDate(value);
  return d ? d.toISOString().slice(0, 7) : null;
};

export const dayKey = (value) => {
  const d = parseDate(value);
  return d ? d.toISOString().slice(0, 10) : null;
};

export const isoNow = () => new Date().toISOString();

export const daysAgoIso = (days, now = Date.now()) => new Date(now - days * DAY_MS).toISOString();

/** "4.8 years" / "4 months" / "3 days" — the age format the tables use. */
export function humanAge(days) {
  if (days === null || days === undefined || !Number.isFinite(days)) return null;
  if (days < 1) return 'today';
  if (days < 45) return `${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'}`;
  if (days < 545) {
    const m = Math.round(days / 30.44);
    return `${m} month${m === 1 ? '' : 's'}`;
  }
  const y = days / 365.25;
  return `${y < 10 ? y.toFixed(1) : Math.round(y)} years`;
}

/** Pearson correlation, for the §55/§56 calibration read-outs. */
export function correlation(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  if (pairs.length < 3) return null;
  const mx = mean(pairs.map(([a]) => a));
  const my = mean(pairs.map(([, b]) => b));
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (const [a, b] of pairs) {
    num += (a - mx) * (b - my);
    dx += (a - mx) ** 2;
    dy += (b - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? null : round(num / den, 3);
}
