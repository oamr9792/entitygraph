import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Minimal .env loader. Parses the subset of dotenv syntax we use (KEY=VALUE,
 * # comments, optional surrounding quotes) and never overrides a variable that
 * is already in the real environment, so CI/container config always wins.
 */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.join(ROOT, '.env'));

const bool = (v, dflt = false) =>
  v === undefined || v === '' ? dflt : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
const int = (v, dflt) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? dflt : Number(v));
const num = int;

/**
 * Secrets have to exist for the app to be safe, but demanding that someone
 * generate a base64 key before they can see the login screen is a bad first
 * run. In development we generate and persist one into .env; in production we
 * refuse to start without it, because a session secret that changes on every
 * redeploy silently logs everyone out and, worse, invites someone to "fix" it
 * with a hardcoded default.
 */
function resolveSecret(name, isProduction) {
  const existing = process.env[name];
  if (existing) return existing;
  if (isProduction) {
    throw new Error(
      `${name} is not set. Generate one with:\n` +
        `  node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"\n` +
        `and set it in the environment before starting in production.`
    );
  }
  const generated = crypto.randomBytes(32).toString('base64');
  const envPath = path.join(ROOT, '.env');
  const line = `${name}=${generated}\n`;
  if (fs.existsSync(envPath)) {
    const body = fs.readFileSync(envPath, 'utf8');
    fs.writeFileSync(
      envPath,
      new RegExp(`^${name}=\\s*$`, 'm').test(body)
        ? body.replace(new RegExp(`^${name}=\\s*$`, 'm'), line.trimEnd())
        : body.replace(/\n*$/, '\n') + line
    );
  } else {
    fs.writeFileSync(envPath, line);
  }
  process.env[name] = generated;
  console.warn(`[config] generated ${name} and wrote it to .env (development only)`);
  return generated;
}

const NODE_ENV = process.env.NODE_ENV || 'development';

/**
 * MODEL is the single home for every modelling parameter in the brief.
 *
 * Read the header of every group before changing a number: none of these are
 * Google's weights. They are our assumptions about how observable signals map
 * onto the factors the patents describe, and the product is required to say so
 * (§3, §22, §25, §30). They are here, in one object, precisely so that §56
 * (empirical calibration) can replace them later without touching any of the
 * scoring code.
 */
export const MODEL = {
  // §8 — document-level entity disambiguation thresholds.
  entityConfidence: {
    accept: 0.7,
    review: 0.4, // 0.40–0.69 goes to the manual review queue; below 0.40 is rejected
  },

  // §25 — textual proximity. Two views of the same thing, blended: a continuous
  // token-distance decay and a discrete grammatical-boundary score. Neither is
  // sufficient alone — 30 tokens inside one sentence means more than 30 tokens
  // spanning a paragraph break.
  proximity: {
    tokenDecay: 50,
    blend: 0.5, // 0 = boundary only, 1 = token decay only
    boundary: {
      same_clause: 1.0,
      same_sentence: 0.9,
      adjacent_sentence: 0.7,
      same_paragraph: 0.5,
      different_paragraph: 0.2,
    },
  },

  // §22 — independence. The corroboration patent's whole point is that the
  // same story on 40 syndication partners is not 40 pieces of evidence.
  independence: {
    first_unique_on_domain: 1.0,
    additional_unique_on_domain: 0.35,
    syndicated_other_domain: 0.2,
    near_duplicate_same_domain: 0.05,
    exact_duplicate: 0,
  },

  // §21 — what counts as a duplicate. simhashDistance is Hamming distance over
  // a 64-bit simhash; below `exact` we treat two documents as the same text.
  duplicates: {
    exactSimhashDistance: 3,
    nearSimhashDistance: 12,
    titleSimilarity: 0.9,
    embeddingSimilarity: 0.94,
  },

  // §26 — source reliability proxy. NOT Domain Authority, NOT Google trust.
  reliability: {
    weights: { domain_rank: 0.4, url_rank: 0.2, prominence: 0.2, classification: 0.2 },
    classification: {
      major: 1.0,
      specialist: 0.8,
      ordinary: 0.6,
      blog: 0.35,
      unknown: 0.2,
      spam: 0,
    },
    spamScoreCutoff: 60, // DataForSEO spam score at or above this classifies as spam
  },

  // §30 — continuous recency decay. Not a known Google curve.
  recency: {
    halfLifeDays: 365,
    allowedHalfLives: [180, 365, 730],
  },

  // §29 — the discrete recency views shown alongside the continuous score.
  recencyWindows: [90, 180, 365, 730],

  // §32 — a single document repeating an association ten times is one document
  // that is confident about it, not ten documents. Cumulative multiplier.
  mentionCap: [1.0, 0.2, 0.1],

  // §33 — PIAS composition. Components are each normalised 0–100 within the
  // entity before weighting, so PIAS is explicitly a relative score: it ranks
  // associations against each other for one entity, not across entities.
  pias: {
    corroboration: 0.3,
    authority: 0.25,
    recency: 0.2,
    relationship: 0.15,
    corpusShare: 0.1,
  },

  // §39/§49 — the window that counts as "current".
  currentWindowDays: 365,

  // §40 — momentum buckets.
  momentum: {
    periodDays: 90,
    thresholds: { rapid_up: 1.0, up: 0.2, down: -0.2, rapid_down: -0.5 },
  },

  // §53 — SERP rank weights for the Google Retrieval Score.
  serpRankWeights: [1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1],

  // §34 — corroboration is log-scaled so 500 weak domains cannot swamp 40
  // strong ones purely by count.
  corroborationLog: true,
};

export const config = {
  env: NODE_ENV,
  isProd: NODE_ENV === 'production',
  port: int(process.env.PORT, 8788),
  host: process.env.HOST || '127.0.0.1',
  dbPath: path.resolve(ROOT, process.env.DB_PATH || './data/entitygraph.db'),

  sessionSecret: resolveSecret('SESSION_SECRET', NODE_ENV === 'production'),
  sessionTtlHours: int(process.env.SESSION_TTL_HOURS, 12),
  trustProxy: bool(process.env.TRUST_PROXY, NODE_ENV === 'production'),
  bootstrap: {
    email: process.env.BOOTSTRAP_ADMIN_EMAIL || '',
    name: process.env.BOOTSTRAP_ADMIN_NAME || 'Administrator',
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD || '',
  },

  dataforseo:
    process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD
      ? { login: process.env.DATAFORSEO_LOGIN, password: process.env.DATAFORSEO_PASSWORD }
      : null,

  llm: {
    provider: (process.env.LLM_PROVIDER || 'anthropic').toLowerCase(),
    anthropicKey: process.env.ANTHROPIC_API_KEY || '',
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
    openaiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  },

  embeddings: {
    provider: (process.env.EMBEDDING_PROVIDER || 'local').toLowerCase(),
    openaiModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
    dimensions: int(process.env.EMBEDDING_DIMENSIONS, 256),
  },

  limits: {
    maxDocuments: int(process.env.MAX_DOCUMENTS, 4000),
    maxApiCostUsd: num(process.env.MAX_API_COST_USD, 25),
    maxLlmTokens: int(process.env.MAX_LLM_TOKENS, 4_000_000),
  },

  httpTimeoutMs: int(process.env.HTTP_TIMEOUT_MS, 45000),
  providerCacheTtlS: int(process.env.PROVIDER_CACHE_TTL_S, 86400),
  pageFetchEnabled: bool(process.env.PAGE_FETCH_ENABLED, true),
  pageFetchUserAgent:
    process.env.PAGE_FETCH_USER_AGENT || 'EntityGraph/1.0 (+https://example.com/bot)',
  extraCaCerts: (process.env.EXTRA_CA_CERTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  model: MODEL,
};

/**
 * The disclaimer §3 requires the product to display. Exported from config so
 * there is exactly one copy of the wording and every surface renders the same
 * sentence.
 */
export const SCORE_DISCLAIMER =
  'This is an external estimate of entity-association strength. It does not expose Google’s internal Knowledge Graph or ranking scores.';

export default config;
