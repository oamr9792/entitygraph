import { run, get, all, tx } from '../db.js';
import { HttpError } from '../http.js';
import { generateNameVariants, normaliseWhitespace } from '../util/text.js';
import { rootDomain } from '../util/hash.js';

/**
 * §5, §7 — the EntityIdentityProfile.
 *
 * This is the input to everything that follows. Association scoring on the
 * wrong John Smith is worse than no scoring at all, and §6 is explicit that
 * disambiguation is one of the most important components — so the profile is
 * built deliberately and shown to the user rather than inferred quietly.
 */

const MARKER_KINDS = ['organization', 'location', 'occupation', 'education', 'person', 'url', 'other'];

/**
 * Default marker weights. An organisation is a much stronger identity signal
 * than a location: thousands of John Smiths live in New York, very few work at
 * one named firm. §8's worked examples encode exactly this intuition
 * ("founder of ABC Capital" = 0.99, "New York businessman" = 0.75), and these
 * weights are what reproduce them.
 */
const DEFAULT_WEIGHTS = {
  organization: 1.0,
  url: 1.0,
  person: 0.8,
  education: 0.7,
  occupation: 0.5,
  location: 0.45,
  other: 0.4,
};

export function createEntity(input) {
  const canonicalName = normaliseWhitespace(input.canonical_name);
  if (!canonicalName) throw new HttpError('canonical_name is required');
  const entityType = input.entity_type === 'organization' ? 'organization' : 'person';

  return tx(() => {
    const res = run(
      `INSERT INTO entities (canonical_name, entity_type, wikidata_qid, wikipedia_url, description, max_documents, max_api_cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      canonicalName,
      entityType,
      input.wikidata_qid || null,
      input.wikipedia_url || null,
      input.description || null,
      input.max_documents ?? null,
      input.max_api_cost_usd ?? null
    );
    const entityId = Number(res.lastInsertRowid);

    addAlias(entityId, canonicalName, 'canonical');
    for (const alias of input.aliases ?? []) addAlias(entityId, alias, 'user');
    // §10 — the middle-initial and short forms wire copy actually uses.
    for (const variant of generateNameVariants(canonicalName, entityType)) {
      addAlias(entityId, variant, 'generated');
    }

    for (const kind of MARKER_KINDS) {
      for (const value of input.identity_markers?.[`${kind}s`] ?? input.identity_markers?.[kind] ?? []) {
        addMarker(entityId, kind, value);
      }
    }
    for (const url of input.known_urls ?? []) addMarker(entityId, 'url', url);
    for (const person of input.known_people ?? []) addMarker(entityId, 'person', person);
    // Negative markers: the disambiguator's most useful input on common names.
    for (const value of input.negative_markers ?? []) addMarker(entityId, 'other', value, { polarity: -1 });

    return entityId;
  });
}

export function addAlias(entityId, alias, origin = 'user', searchable = true) {
  const clean = normaliseWhitespace(alias);
  if (!clean) return;
  run(
    `INSERT INTO entity_aliases (entity_id, alias, origin, searchable) VALUES (?, ?, ?, ?)
     ON CONFLICT(entity_id, alias) DO NOTHING`,
    entityId,
    clean,
    origin,
    searchable ? 1 : 0
  );
}

export function addMarker(entityId, kind, value, { weight = null, polarity = 1, source = 'user' } = {}) {
  const clean = normaliseWhitespace(value);
  if (!clean) return;
  const normalisedKind = MARKER_KINDS.includes(kind) ? kind : 'other';
  run(
    `INSERT INTO entity_identity_markers (entity_id, kind, value, weight, polarity, source)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity_id, kind, value) DO UPDATE SET weight = excluded.weight, polarity = excluded.polarity`,
    entityId,
    normalisedKind,
    // URL markers are stored as their root domain: what a document can show us
    // is "this page links to or sits on johnsmith.com", not the exact path.
    normalisedKind === 'url' ? rootDomain(clean) ?? clean : clean,
    weight ?? DEFAULT_WEIGHTS[normalisedKind] ?? 0.4,
    polarity,
    source
  );
}

export function getEntity(entityId) {
  const entity = get(`SELECT * FROM entities WHERE id = ? AND deleted_at IS NULL`, entityId);
  if (!entity) throw new HttpError(`entity ${entityId} not found`, 404);
  return entity;
}

/** The §7 profile, assembled from its normalised rows. */
export function identityProfile(entityId) {
  const entity = getEntity(entityId);
  const aliases = all(`SELECT * FROM entity_aliases WHERE entity_id = ? ORDER BY origin, alias`, entityId);
  const markers = all(`SELECT * FROM entity_identity_markers WHERE entity_id = ? ORDER BY kind, value`, entityId);

  const grouped = {};
  for (const kind of MARKER_KINDS) {
    const values = markers.filter((m) => m.kind === kind && m.polarity === 1).map((m) => m.value);
    if (values.length) grouped[`${kind}s`] = values;
  }

  return {
    entity_id: entity.id,
    canonical_name: entity.canonical_name,
    entity_type: entity.entity_type,
    wikidata_qid: entity.wikidata_qid,
    wikipedia_url: entity.wikipedia_url,
    description: entity.description,
    aliases: aliases.filter((a) => a.origin !== 'canonical').map((a) => a.alias),
    identity_markers: grouped,
    negative_markers: markers.filter((m) => m.polarity === -1).map((m) => m.value),
    known_urls: markers.filter((m) => m.kind === 'url').map((m) => m.value),
    known_people: markers.filter((m) => m.kind === 'person').map((m) => m.value),
    markers,
    status: entity.status,
  };
}

/** §10 — the query set. Canonical name first, then aliases, longest first. */
export function searchQueries(entityId, { includeGenerated = true } = {}) {
  const rows = all(
    `SELECT alias, origin FROM entity_aliases WHERE entity_id = ? AND searchable = 1`,
    entityId
  );
  return rows
    .filter((r) => includeGenerated || r.origin !== 'generated')
    .map((r) => r.alias)
    .sort((a, b) => b.length - a.length);
}

/**
 * §71 — alias coverage feeds Coverage Confidence. An entity searched under one
 * of four known names has a materially incomplete corpus, and the confidence
 * panel has to be able to say so.
 */
export function aliasCoverage(entityId, queriedAliases) {
  const known = searchQueries(entityId);
  const queried = new Set(queriedAliases.map((a) => a.toLowerCase()));
  const missing = known.filter((a) => !queried.has(a.toLowerCase()));
  return {
    known: known.length,
    queried: known.length - missing.length,
    missing,
    complete: missing.length === 0,
  };
}

export { MARKER_KINDS, DEFAULT_WEIGHTS };
