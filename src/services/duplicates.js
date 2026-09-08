import { MODEL } from '../config.js';
import { all, run, tx } from '../db.js';
import { simhash, minhash, hammingDistance, minhashSimilarity, contentHash } from '../util/hash.js';
import { normaliseForMatch } from '../util/text.js';
import { parseDate } from '../util/stats.js';

/**
 * §21, §22 — duplicate detection and independence.
 *
 * This is the component US8682913B1 is about. The corroboration patent's
 * central claim is that independent sources are what make a fact credible, and
 * that documents from the same site, or copies of the same wire story, are not
 * independent. Without this stage, a single press release syndicated to two
 * hundred aggregators would outrank a fact reported once by each of forty
 * separate newsrooms — which is exactly backwards.
 *
 * Detection uses three signals in increasing order of cost: canonical URL,
 * content hash, then simhash with a MinHash confirmation. Candidate pairs come
 * from banded simhash buckets rather than an all-pairs comparison, so this
 * stays linear-ish as a corpus grows.
 */

export function fingerprint(doc) {
  const basis = [doc.title, doc.main_title, doc.body_text || doc.snippet].filter(Boolean).join('\n');
  if (!basis.trim()) return { content_hash: null, simhash: null, minhash: null };
  return {
    content_hash: contentHash(basis),
    simhash: simhash(basis),
    minhash: minhash(basis),
  };
}

export function fingerprintDocument(documentId, doc) {
  const fp = fingerprint(doc);
  run(
    `UPDATE documents SET content_hash = ?, simhash = ?, minhash = ? WHERE id = ?`,
    fp.content_hash,
    fp.simhash,
    fp.minhash,
    documentId
  );
  return fp;
}

const BANDS = 4;
const BAND_BITS = 16;

/** Banded LSH keys: two near-identical simhashes share at least one band. */
function bandKeys(hex) {
  if (!hex) return [];
  const value = BigInt('0x' + hex);
  const keys = [];
  for (let b = 0; b < BANDS; b += 1) {
    const shift = BigInt(b * BAND_BITS);
    const mask = (1n << BigInt(BAND_BITS)) - 1n;
    keys.push(`${b}:${((value >> shift) & mask).toString(16)}`);
  }
  return keys;
}

const titleSimilarity = (a, b) => {
  const x = new Set(normaliseForMatch(a ?? '').split(' ').filter(Boolean));
  const y = new Set(normaliseForMatch(b ?? '').split(' ').filter(Boolean));
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / Math.max(x.size, y.size);
};

/**
 * Clusters an entity's documents and writes the result back.
 *
 * The primary of a cluster is the earliest-published member — the original,
 * as far as we can tell — falling back to the highest-ranked domain when
 * nothing is dated. That choice matters: the primary keeps full independence
 * weight and everything else in the cluster is discounted, so picking the
 * syndicator over the originator would credit the wrong source.
 */
export function clusterDocuments(entityId, overrides = null) {
  const m = { ...MODEL.duplicates, ...(overrides?.duplicates || {}) };
  const docs = all(
    `SELECT d.* FROM documents d
       JOIN entity_document_matches m ON m.document_id = d.id
      WHERE m.entity_id = ? AND m.verdict = 'accept'
      ORDER BY d.id`,
    entityId
  );
  if (!docs.length) return { clusters: 0, documents: 0 };

  const parent = new Map(docs.map((d) => [d.id, d.id]));
  const kindOf = new Map();
  const find = (x) => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(x) !== root) { const next = parent.get(x); parent.set(x, root); x = next; }
    return root;
  };
  const union = (a, b, kind) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) {
      // Keep the strongest claim about the pair's relationship.
      if (kind === 'exact') kindOf.set(ra, 'exact');
      return;
    }
    parent.set(rb, ra);
    const merged = kindOf.get(ra) === 'exact' || kindOf.get(rb) === 'exact' || kind === 'exact' ? 'exact' : kind;
    kindOf.set(ra, merged);
    kindOf.delete(rb);
  };

  // 1. Canonical URL and exact content hash.
  const byCanonical = new Map();
  const byHash = new Map();
  for (const d of docs) {
    if (d.canonical_url) {
      if (byCanonical.has(d.canonical_url)) union(byCanonical.get(d.canonical_url), d.id, 'exact');
      else byCanonical.set(d.canonical_url, d.id);
    }
    if (d.content_hash) {
      if (byHash.has(d.content_hash)) union(byHash.get(d.content_hash), d.id, 'exact');
      else byHash.set(d.content_hash, d.id);
    }
  }

  // 2. Near duplicates via banded simhash, confirmed by MinHash or title.
  const buckets = new Map();
  for (const d of docs) {
    for (const key of bandKeys(d.simhash)) {
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(d);
    }
  }
  const compared = new Set();
  const byId = new Map(docs.map((d) => [d.id, d]));
  for (const bucket of buckets.values()) {
    if (bucket.length < 2 || bucket.length > 400) continue; // a huge bucket is boilerplate, not a story
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const a = bucket[i];
        const b = bucket[j];
        const pairKey = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
        if (compared.has(pairKey)) continue;
        compared.add(pairKey);
        const distance = hammingDistance(a.simhash, b.simhash);
        if (distance <= m.exactSimhashDistance) { union(a.id, b.id, 'exact'); continue; }
        if (distance > m.nearSimhashDistance) continue;
        const confirmed =
          minhashSimilarity(a.minhash, b.minhash) >= 0.6 ||
          titleSimilarity(a.title || a.main_title, b.title || b.main_title) >= m.titleSimilarity;
        if (confirmed) union(a.id, b.id, 'near');
      }
    }
  }

  // 3. Persist.
  const groups = new Map();
  for (const d of docs) {
    const root = find(d.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(d);
  }

  return tx(() => {
    run(`UPDATE documents SET duplicate_cluster_id = NULL, is_cluster_primary = 1 WHERE id IN (SELECT document_id FROM entity_document_matches WHERE entity_id = ?)`, entityId);
    let clusters = 0;
    for (const [root, members] of groups) {
      if (members.length < 2) continue;
      clusters += 1;
      const primary = pickPrimary(members);
      const kind = kindOf.get(root) ?? 'near';
      const res = run(
        `INSERT INTO document_duplicate_clusters (primary_document_id, kind, simhash, member_count) VALUES (?, ?, ?, ?)`,
        primary.id,
        kind,
        primary.simhash,
        members.length
      );
      const clusterId = Number(res.lastInsertRowid);
      for (const member of members) {
        run(
          `UPDATE documents SET duplicate_cluster_id = ?, is_cluster_primary = ? WHERE id = ?`,
          clusterId,
          member.id === primary.id ? 1 : 0,
          member.id
        );
      }
    }
    return { clusters, documents: docs.length, byId };
  });
}

function pickPrimary(members) {
  const dated = members.filter((d) => parseDate(d.published_at ?? d.group_date));
  const pool = dated.length ? dated : members;
  return pool.slice().sort((a, b) => {
    const da = parseDate(a.published_at ?? a.group_date)?.getTime() ?? Infinity;
    const db = parseDate(b.published_at ?? b.group_date)?.getTime() ?? Infinity;
    if (da !== db) return da - db;
    return (b.domain_rank ?? 0) - (a.domain_rank ?? 0);
  })[0];
}

/**
 * §22 — assigns an independence weight to each document supporting one
 * association, in a fixed order so the result is reproducible.
 *
 * Order matters and is deliberate: the strongest document on each domain is
 * seen first, so it receives the full weight and its weaker siblings get the
 * additional-article discount rather than the other way round.
 */
export function assignIndependence(docs, overrides = null) {
  const w = { ...MODEL.independence, ...(overrides?.independence || {}) };
  const ordered = docs.slice().sort((a, b) => {
    if (Boolean(b.is_cluster_primary) !== Boolean(a.is_cluster_primary)) return b.is_cluster_primary ? 1 : -1;
    return (b.source_reliability ?? 0) - (a.source_reliability ?? 0);
  });

  const domainCount = new Map();
  const clusterSeen = new Map();
  const out = new Map();

  for (const doc of ordered) {
    const domain = doc.root_domain ?? `doc:${doc.id}`;
    const ordinal = domainCount.get(domain) ?? 0;

    let weight;
    let reason;
    if (doc.duplicate_cluster_id) {
      const seen = clusterSeen.get(doc.duplicate_cluster_id);
      if (!seen) {
        // First member of this cluster we have counted: it is the evidence.
        clusterSeen.set(doc.duplicate_cluster_id, doc);
        weight = ordinal === 0 ? w.first_unique_on_domain : w.additional_unique_on_domain;
        reason = ordinal === 0 ? 'cluster_primary_first_on_domain' : 'cluster_primary_additional_on_domain';
      } else if (doc.cluster_kind === 'exact') {
        weight = w.exact_duplicate;
        reason = 'exact_duplicate';
      } else {
        const sameDomain = seen.root_domain === doc.root_domain;
        weight = sameDomain ? w.near_duplicate_same_domain : w.syndicated_other_domain;
        reason = sameDomain ? 'near_duplicate_same_domain' : 'syndicated_other_domain';
      }
    } else {
      weight = ordinal === 0 ? w.first_unique_on_domain : w.additional_unique_on_domain;
      reason = ordinal === 0 ? 'first_unique_on_domain' : 'additional_unique_on_domain';
    }

    domainCount.set(domain, ordinal + 1);
    out.set(doc.id, { weight, reason, ordinal_on_domain: ordinal });
  }

  return out;
}

/** Cluster membership for the evidence explorer (§48). */
export function clusterMembers(clusterId) {
  return all(
    `SELECT d.id, d.url, d.root_domain, d.title, d.published_at, d.is_cluster_primary
       FROM documents d WHERE d.duplicate_cluster_id = ? ORDER BY d.is_cluster_primary DESC, d.published_at`,
    clusterId
  );
}
