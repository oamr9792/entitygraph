import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import config from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

/**
 * Schema (§61).
 *
 * Four families live here:
 *
 *  - Identity:    entities, entity_aliases, entity_identity_markers
 *  - Corpus:      domains, documents, document_versions,
 *                 document_duplicate_clusters, entity_document_matches
 *  - Association: associations, association_aliases, association_hierarchy,
 *                 evidence, association_document_scores
 *  - Observation: serp_snapshots, serp_results, serp_result_associations,
 *                 association_metrics_daily/_monthly, entity_snapshots
 *
 * The observation family is append-only by convention. §55 exists to compare
 * this week's numbers with last week's; overwriting a snapshot destroys the
 * only thing it is for.
 *
 * Two structural decisions worth stating, because they are load-bearing:
 *
 *  1. `evidence` is one row per (document, association) occurrence, holding
 *     every factor of §31 as its own column. Scores are recomputed from those
 *     columns, never accumulated in place, so changing a MODEL parameter and
 *     rescoring cannot drift away from the evidence that produced it.
 *
 *  2. Named entities and concepts share one table with a `kind` column (§17)
 *     rather than living in two. They score identically and must never be
 *     collapsed into each other, which a CHECK constraint enforces just as well
 *     as separate tables while keeping every query single-source.
 */
const SCHEMA = `
-- ===========================================================================
-- Identity (§5, §7)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS entities (
  id              INTEGER PRIMARY KEY,
  canonical_name  TEXT NOT NULL,
  entity_type     TEXT NOT NULL DEFAULT 'person'
                  CHECK (entity_type IN ('person','organization')),
  wikidata_qid    TEXT,
  wikipedia_url   TEXT,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','building','ready','error')),
  -- Per-entity overrides of MODEL. JSON; empty object means "use the defaults".
  model_overrides TEXT NOT NULL DEFAULT '{}',
  -- Terms to pair with the name when searching the corpus (§9). The plain
  -- name search returns the provider's own top-relevance slice; a subject that
  -- matters can sit in hundreds of indexed documents and never appear in it.
  probe_terms     TEXT NOT NULL DEFAULT '[]',
  max_documents   INTEGER,
  max_api_cost_usd REAL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at      TEXT
);

CREATE TABLE IF NOT EXISTS entity_aliases (
  id         INTEGER PRIMARY KEY,
  entity_id  INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias      TEXT NOT NULL,
  -- 'canonical' is the name itself; 'generated' variants (middle initial and
  -- so on) come from identity.js and can be pruned without losing user input.
  origin     TEXT NOT NULL DEFAULT 'user'
             CHECK (origin IN ('canonical','user','generated','wikidata')),
  searchable INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entity_id, alias)
);

-- Markers are rows, not columns, because §7 lists five kinds today and real
-- engagements invent more (military service, sports club, court district).
CREATE TABLE IF NOT EXISTS entity_identity_markers (
  id         INTEGER PRIMARY KEY,
  entity_id  INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,   -- organization | location | occupation | education | person | url | other
  value      TEXT NOT NULL,
  weight     REAL NOT NULL DEFAULT 1.0,
  -- A negative marker is a disambiguator in reverse: "footballer", "obituary".
  polarity   INTEGER NOT NULL DEFAULT 1 CHECK (polarity IN (-1, 1)),
  source     TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entity_id, kind, value)
);
CREATE INDEX IF NOT EXISTS idx_markers_entity ON entity_identity_markers(entity_id);

-- ===========================================================================
-- Corpus (§9, §12, §21, §26)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS domains (
  id              INTEGER PRIMARY KEY,
  root_domain     TEXT NOT NULL UNIQUE,
  domain_rank     REAL,
  spam_score      REAL,
  classification  TEXT CHECK (classification IN ('major','specialist','ordinary','blog','unknown','spam')),
  -- Set by a human in the QA screen (§74) and never overwritten by a crawl.
  classification_override TEXT CHECK (classification_override IN ('major','specialist','ordinary','blog','unknown','spam')),
  reliability_override REAL,
  -- Domains sharing an owner (network sites, regional chains) are not
  -- independent of each other (§21). Null means "assume independent".
  owner_key       TEXT,
  notes           TEXT,
  first_seen      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id               INTEGER PRIMARY KEY,
  url              TEXT NOT NULL UNIQUE,
  canonical_url    TEXT,
  domain_id        INTEGER REFERENCES domains(id),
  root_domain      TEXT,
  title            TEXT,
  main_title       TEXT,
  previous_heading TEXT,
  semantic_location TEXT,
  page_type        TEXT,
  language         TEXT,
  country          TEXT,
  snippet          TEXT,
  -- Body text is only stored when we fetched it (§15). Capped, never a full
  -- article archive: we keep what an analyst needs to audit a score.
  body_text        TEXT,
  body_chars       INTEGER,
  content_hash     TEXT,
  simhash          TEXT,
  minhash          TEXT,
  url_rank         REAL,
  domain_rank      REAL,
  spam_score       REAL,
  content_quality  REAL,
  prominence       REAL,          -- DataForSEO citation prominence
  sentiment_positive REAL,
  sentiment_negative REAL,
  sentiment_neutral  REAL,
  published_at     TEXT,
  group_date       TEXT,
  fetched_at       TEXT,
  provider         TEXT NOT NULL DEFAULT 'dataforseo',
  provider_ref     TEXT,
  discovered_at    TEXT NOT NULL DEFAULT (datetime('now')),
  duplicate_cluster_id INTEGER,
  is_cluster_primary   INTEGER NOT NULL DEFAULT 1,
  fetch_status     TEXT NOT NULL DEFAULT 'snippet_only'
                   CHECK (fetch_status IN ('snippet_only','fetched','failed','blocked','skipped'))
);
CREATE INDEX IF NOT EXISTS idx_documents_domain ON documents(root_domain);
CREATE INDEX IF NOT EXISTS idx_documents_published ON documents(published_at);
CREATE INDEX IF NOT EXISTS idx_documents_cluster ON documents(duplicate_cluster_id);

-- §12: a document seen again later with different content is a new version,
-- not an overwrite. Freshness (§5 / US9189526B1) needs the history.
CREATE TABLE IF NOT EXISTS document_versions (
  id            INTEGER PRIMARY KEY,
  document_id   INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  content_hash  TEXT NOT NULL,
  body_chars    INTEGER,
  published_at  TEXT,
  observed_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_docversions_doc ON document_versions(document_id);

CREATE TABLE IF NOT EXISTS document_duplicate_clusters (
  id                  INTEGER PRIMARY KEY,
  primary_document_id INTEGER REFERENCES documents(id),
  kind                TEXT NOT NULL CHECK (kind IN ('exact','near','same_domain')),
  simhash             TEXT,
  member_count        INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- §8 — the disambiguation verdict for one document about one entity. A
-- document can legitimately concern two different entities in the system.
CREATE TABLE IF NOT EXISTS entity_document_matches (
  id                INTEGER PRIMARY KEY,
  entity_id         INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  document_id       INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_confidence REAL NOT NULL,
  verdict           TEXT NOT NULL CHECK (verdict IN ('accept','review','reject')),
  method            TEXT NOT NULL DEFAULT 'markers',  -- markers | llm | manual
  matched_alias     TEXT,
  reasons           TEXT NOT NULL DEFAULT '[]',       -- JSON array of {marker, kind, weight}
  manual_verdict    TEXT CHECK (manual_verdict IN ('accept','reject')),
  reviewed_by       TEXT,
  reviewed_at       TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entity_id, document_id)
);
CREATE INDEX IF NOT EXISTS idx_edm_entity ON entity_document_matches(entity_id, verdict);

-- ===========================================================================
-- Associations (§17, §18, §19, §20)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS associations (
  id              INTEGER PRIMARY KEY,
  entity_id       INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  canonical_label TEXT NOT NULL,
  -- §17: named_entity and concept are different things and must not be merged.
  kind            TEXT NOT NULL CHECK (kind IN ('named_entity','concept')),
  category        TEXT NOT NULL DEFAULT 'other',   -- §18 taxonomy, extensible
  parent_id       INTEGER REFERENCES associations(id) ON DELETE SET NULL,
  wikidata_qid    TEXT,
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','merged','excluded')),
  merged_into_id  INTEGER REFERENCES associations(id),
  -- §38's Jaccard needs N(A): how many documents on the wider web concern the
  -- association at all, independently of this entity. That is one provider
  -- call per association, so it is fetched on demand and cached here rather
  -- than assumed. Null means "not measured", which §38 treats as "no Jaccard".
  corpus_total_count INTEGER,
  corpus_total_checked_at TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entity_id, canonical_label, kind)
);
CREATE INDEX IF NOT EXISTS idx_assoc_entity ON associations(entity_id, status);

-- §19: surface forms are kept. "charitable giving" is evidence about how the
-- web phrases it, and an analyst auditing a merge needs to see them.
CREATE TABLE IF NOT EXISTS association_aliases (
  id             INTEGER PRIMARY KEY,
  association_id INTEGER NOT NULL REFERENCES associations(id) ON DELETE CASCADE,
  surface_form   TEXT NOT NULL,
  occurrences    INTEGER NOT NULL DEFAULT 1,
  first_seen     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (association_id, surface_form)
);

-- §20. Kept separate from associations.parent_id: parent_id is the single
-- drill-down tree shown in the UI, this table records typed relations between
-- associations (including the inferred XYZ Foundation -> philanthropy edge,
-- which §17 forbids collapsing into the primary tree).
CREATE TABLE IF NOT EXISTS association_hierarchy (
  id           INTEGER PRIMARY KEY,
  parent_id    INTEGER NOT NULL REFERENCES associations(id) ON DELETE CASCADE,
  child_id     INTEGER NOT NULL REFERENCES associations(id) ON DELETE CASCADE,
  relation     TEXT NOT NULL DEFAULT 'narrower',  -- narrower | instance_of | implies
  confidence   REAL NOT NULL DEFAULT 1.0,
  source       TEXT NOT NULL DEFAULT 'llm',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (parent_id, child_id, relation)
);

-- §62 — the evidence table. One row per occurrence of one association in one
-- document. Every factor of §31 is a column so the score is auditable.
CREATE TABLE IF NOT EXISTS evidence (
  id                      INTEGER PRIMARY KEY,
  entity_id               INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  association_id          INTEGER NOT NULL REFERENCES associations(id) ON DELETE CASCADE,
  document_id             INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  surface_form            TEXT,
  relationship            TEXT,
  evidence_text           TEXT NOT NULL,
  occurrence_index        INTEGER NOT NULL DEFAULT 0,   -- 0-based; drives the §32 cap
  entity_confidence       REAL NOT NULL,
  relationship_confidence REAL NOT NULL,
  token_distance          INTEGER,
  boundary                TEXT,
  proximity_score         REAL NOT NULL,
  sentiment_positive      REAL NOT NULL DEFAULT 0,
  sentiment_negative      REAL NOT NULL DEFAULT 0,
  sentiment_neutral       REAL NOT NULL DEFAULT 1,
  source_reliability      REAL NOT NULL,
  recency_weight          REAL NOT NULL,
  independence_weight     REAL NOT NULL,
  mention_cap_weight      REAL NOT NULL DEFAULT 1,
  evidence_score          REAL NOT NULL,
  published_at            TEXT,
  discovered_at           TEXT NOT NULL DEFAULT (datetime('now')),
  extractor               TEXT NOT NULL DEFAULT 'llm',
  manually_verified       INTEGER NOT NULL DEFAULT 0,
  excluded                INTEGER NOT NULL DEFAULT 0,
  exclusion_reason        TEXT
);
CREATE INDEX IF NOT EXISTS idx_evidence_assoc ON evidence(association_id, excluded);
CREATE INDEX IF NOT EXISTS idx_evidence_entity ON evidence(entity_id, excluded);
CREATE INDEX IF NOT EXISTS idx_evidence_doc ON evidence(document_id);

-- §31 rolled up to the document level: one row per (association, document),
-- which is the unit §32's cap applies to and the unit §21 dedupes.
CREATE TABLE IF NOT EXISTS association_document_scores (
  id                  INTEGER PRIMARY KEY,
  entity_id           INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  association_id      INTEGER NOT NULL REFERENCES associations(id) ON DELETE CASCADE,
  document_id         INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  raw_mentions        INTEGER NOT NULL DEFAULT 1,
  capped_weight       REAL NOT NULL DEFAULT 1,
  best_proximity      REAL,
  max_relationship_confidence REAL,
  independence_weight REAL NOT NULL DEFAULT 1,
  recency_weight      REAL NOT NULL DEFAULT 1,
  source_reliability  REAL NOT NULL DEFAULT 0,
  document_evidence   REAL NOT NULL DEFAULT 0,   -- decay applied
  document_evidence_undecayed REAL NOT NULL DEFAULT 0,
  sentiment           REAL,
  published_at        TEXT,
  computed_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (association_id, document_id)
);
CREATE INDEX IF NOT EXISTS idx_ads_entity ON association_document_scores(entity_id);

-- ===========================================================================
-- Observation: SERP layer (§13, §52, §53) — deliberately separate from corpus
-- ===========================================================================
CREATE TABLE IF NOT EXISTS serp_snapshots (
  id             INTEGER PRIMARY KEY,
  entity_id      INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  query          TEXT NOT NULL,
  query_kind     TEXT NOT NULL DEFAULT 'entity'
                 CHECK (query_kind IN ('entity','association')),
  association_id INTEGER REFERENCES associations(id) ON DELETE SET NULL,
  location       TEXT NOT NULL DEFAULT 'United States',
  language       TEXT NOT NULL DEFAULT 'en',
  device         TEXT NOT NULL DEFAULT 'desktop',
  depth          INTEGER NOT NULL DEFAULT 100,
  item_types     TEXT NOT NULL DEFAULT '[]',
  captured_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_serp_entity ON serp_snapshots(entity_id, captured_at);

CREATE TABLE IF NOT EXISTS serp_results (
  id           INTEGER PRIMARY KEY,
  snapshot_id  INTEGER NOT NULL REFERENCES serp_snapshots(id) ON DELETE CASCADE,
  -- Organic position: 1 for the first organic result. rank_absolute is the
  -- on-page position counting every SERP feature, kept for audit only.
  rank         INTEGER NOT NULL,
  rank_absolute INTEGER,
  url          TEXT NOT NULL,
  root_domain  TEXT,
  title        TEXT,
  description  TEXT,
  document_id  INTEGER REFERENCES documents(id),
  is_owned     INTEGER NOT NULL DEFAULT 0,
  sentiment    REAL
);
CREATE INDEX IF NOT EXISTS idx_serpresults_snapshot ON serp_results(snapshot_id, rank);

CREATE TABLE IF NOT EXISTS serp_result_associations (
  id             INTEGER PRIMARY KEY,
  serp_result_id INTEGER NOT NULL REFERENCES serp_results(id) ON DELETE CASCADE,
  association_id INTEGER NOT NULL REFERENCES associations(id) ON DELETE CASCADE,
  confidence     REAL NOT NULL DEFAULT 1,
  method         TEXT NOT NULL DEFAULT 'corpus_match',  -- corpus_match | llm | manual
  UNIQUE (serp_result_id, association_id)
);

-- ===========================================================================
-- Observation: metrics and snapshots (§55)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS association_metrics_daily (
  id             INTEGER PRIMARY KEY,
  entity_id      INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  association_id INTEGER NOT NULL REFERENCES associations(id) ON DELETE CASCADE,
  day            TEXT NOT NULL,
  metrics        TEXT NOT NULL,   -- JSON blob of the full metric set for that day
  UNIQUE (association_id, day)
);

CREATE TABLE IF NOT EXISTS association_metrics_monthly (
  id             INTEGER PRIMARY KEY,
  entity_id      INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  association_id INTEGER NOT NULL REFERENCES associations(id) ON DELETE CASCADE,
  month          TEXT NOT NULL,   -- YYYY-MM
  documents      INTEGER NOT NULL DEFAULT 0,
  domains        INTEGER NOT NULL DEFAULT 0,
  raw_mentions   INTEGER NOT NULL DEFAULT 0,
  evidence_sum   REAL NOT NULL DEFAULT 0,
  share          REAL,
  UNIQUE (association_id, month)
);

-- §55: the weekly row the correlation study is eventually run over.
CREATE TABLE IF NOT EXISTS entity_snapshots (
  id             INTEGER PRIMARY KEY,
  entity_id      INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  captured_at    TEXT NOT NULL DEFAULT (datetime('now')),
  coverage       TEXT NOT NULL DEFAULT '{}',
  payload        TEXT NOT NULL          -- JSON: per-association PIAS/CES/ACS/AM/GRS
);
CREATE INDEX IF NOT EXISTS idx_entsnap_entity ON entity_snapshots(entity_id, captured_at);

-- ===========================================================================
-- Operations
-- ===========================================================================
CREATE TABLE IF NOT EXISTS crawl_jobs (
  id           INTEGER PRIMARY KEY,
  entity_id    INTEGER REFERENCES entities(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,          -- full_build | refresh | serp | rescore
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','running','done','failed','cancelled')),
  step         TEXT,
  steps_done   INTEGER NOT NULL DEFAULT 0,
  steps_total  INTEGER NOT NULL DEFAULT 0,
  progress     TEXT NOT NULL DEFAULT '[]',   -- JSON array of {step, status, detail, at}
  options      TEXT NOT NULL DEFAULT '{}',
  error        TEXT,
  cost_usd     REAL NOT NULL DEFAULT 0,
  llm_tokens   INTEGER NOT NULL DEFAULT 0,
  documents    INTEGER NOT NULL DEFAULT 0,
  started_at   TEXT,
  finished_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON crawl_jobs(status, id);

CREATE TABLE IF NOT EXISTS api_usage (
  id          INTEGER PRIMARY KEY,
  provider    TEXT NOT NULL,
  endpoint    TEXT NOT NULL,
  entity_id   INTEGER REFERENCES entities(id) ON DELETE SET NULL,
  job_id      INTEGER REFERENCES crawl_jobs(id) ON DELETE SET NULL,
  cost_usd    REAL NOT NULL DEFAULT 0,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  cached      INTEGER NOT NULL DEFAULT 0,
  ok          INTEGER NOT NULL DEFAULT 1,
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_entity ON api_usage(entity_id, created_at);

-- §74 — every human correction, kept as a record rather than applied silently,
-- so it can be replayed after a rescore and fed back into classification.
CREATE TABLE IF NOT EXISTS manual_reviews (
  id          INTEGER PRIMARY KEY,
  entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL,   -- document | evidence | association | domain
  target_id   INTEGER NOT NULL,
  action      TEXT NOT NULL,   -- wrong_entity | exclude_source | include | merge | split |
                               -- recategorise | mark_duplicate | set_tier | approve | reject | add_marker
  payload     TEXT NOT NULL DEFAULT '{}',
  reviewer    TEXT NOT NULL DEFAULT 'analyst',
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reviews_entity ON manual_reviews(entity_id, created_at);

CREATE TABLE IF NOT EXISTS alerts (
  id             INTEGER PRIMARY KEY,
  entity_id      INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  association_id INTEGER REFERENCES associations(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,   -- new_negative | rapid_growth | resurgence | serp_convergence
  severity       TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  headline       TEXT NOT NULL,
  detail         TEXT,
  payload        TEXT NOT NULL DEFAULT '{}',
  acknowledged   INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alerts_entity ON alerts(entity_id, acknowledged, created_at);

-- §63 — pgvector's stand-in. Float32 vectors as BLOBs with cosine similarity
-- computed in process. Fine at this corpus size (tens of thousands of rows);
-- the day it is not, this table is the one thing that has to move.
CREATE TABLE IF NOT EXISTS embeddings (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL,   -- association | evidence | document | identity
  ref_id     INTEGER NOT NULL,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vector     BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, ref_id, model)
);

CREATE TABLE IF NOT EXISTS api_cache (
  cache_key  TEXT PRIMARY KEY,
  provider   TEXT NOT NULL,
  payload    TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cache_provider ON api_cache(provider);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===========================================================================
-- Access control
--
-- Single-tenant: one firm, its own analysts, its own clients. Roles are
-- 'admin' (can manage users) and 'analyst' (everything else), because a
-- finer-grained matrix would be ceremony over a team small enough to know
-- each other's names.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS app_user (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT,
  role          TEXT NOT NULL DEFAULT 'analyst' CHECK (role IN ('admin','analyst')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at    TEXT
);

CREATE TABLE IF NOT EXISTS app_session (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_session_user ON app_session(user_id);

-- Who did what. Manual review decisions already have their own table; this is
-- for the actions that change access or spend money.
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

-- Content drafts built from an association's action plan. The brief is stored
-- whole, so a draft can always be checked against the facts and the terms to
-- avoid that it was written from, even after the corpus has moved on.
CREATE TABLE IF NOT EXISTS content_drafts (
  id               INTEGER PRIMARY KEY,
  entity_id        INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  association_id   INTEGER NOT NULL REFERENCES associations(id) ON DELETE CASCADE,
  format           TEXT NOT NULL,
  mode             TEXT NOT NULL CHECK (mode IN ('grow','correct')),
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','published','archived')),
  title            TEXT,
  body             TEXT,
  claims           TEXT NOT NULL DEFAULT '[]',
  brief            TEXT NOT NULL DEFAULT '{}',
  inputs           TEXT NOT NULL DEFAULT '{}',
  checks           TEXT,
  notes_for_editor TEXT,
  generation_error TEXT,
  model            TEXT,
  cost_usd         REAL NOT NULL DEFAULT 0,
  published_url    TEXT,
  created_by       INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  approved_by      INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_content_entity ON content_drafts(entity_id, updated_at);

-- Pages pasted in to be analysed. Deliberately not documents: they are
-- material for writing, and must never count as evidence or move a score.
CREATE TABLE IF NOT EXISTS content_sources (
  id           INTEGER PRIMARY KEY,
  entity_id    INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  final_url    TEXT,
  title        TEXT,
  body         TEXT NOT NULL,
  chars        INTEGER NOT NULL DEFAULT 0,
  via          TEXT NOT NULL,
  names_client INTEGER NOT NULL DEFAULT 0,
  byline_client INTEGER NOT NULL DEFAULT 0,
  fetched_by   INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_content_sources_entity ON content_sources(entity_id, created_at);
`;

db.exec(SCHEMA);

/**
 * Additive migrations.
 *
 * `CREATE TABLE IF NOT EXISTS` creates a table once and never touches it again,
 * so a column added to the schema above reaches a fresh database and silently
 * never reaches an existing one. That is exactly how a deployed database ended
 * up without `probe_terms`: saving a probe failed, every build read the absent
 * column as "no probes", and nothing reported either.
 *
 * Every column added after the first deploy is declared here as well as in the
 * schema. Additive only — nothing here drops, renames or retypes, because a
 * migration that can destroy data has no business running on every boot.
 */
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (columns.includes(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`[db] added ${table}.${column}`);
  return true;
}

ensureColumn('entities', 'probe_terms', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('serp_snapshots', 'signals', "TEXT NOT NULL DEFAULT '{}'");
ensureColumn('content_sources', 'byline_client', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('serp_results', 'rank_absolute', 'INTEGER');

// --- Query helpers ----------------------------------------------------------

export function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}

export function get(sql, ...params) {
  return db.prepare(sql).get(...params) ?? null;
}

export function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}

/**
 * Synchronous transaction. node:sqlite is synchronous, so this is a plain
 * try/catch around BEGIN/COMMIT — but the ingest paths write thousands of rows
 * and doing that outside a transaction is roughly a hundred times slower.
 */
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

export const setSetting = (key, value) =>
  run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    key,
    typeof value === 'string' ? value : JSON.stringify(value)
  );

export function getSetting(key, dflt = null) {
  const row = get(`SELECT value FROM settings WHERE key = ?`, key);
  if (!row) return dflt;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

export default db;
