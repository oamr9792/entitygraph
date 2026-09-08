import crypto from 'node:crypto';
import { normaliseForMatch, normaliseWhitespace } from './text.js';

/**
 * Document fingerprinting (§21).
 *
 * Three independent signals, because each catches something the others miss:
 *
 *  - content_hash  exact byte-identical republication (and revision tracking)
 *  - simhash       near-duplicates: same article, different boilerplate/ads
 *  - minhash       set overlap, which survives reordering and heavy trimming
 *
 * Plus canonical URL, which catches the cheapest case of all: the same page
 * reached through tracking parameters, AMP paths and www variants.
 */

export const contentHash = (text) =>
  crypto.createHash('sha256').update(normaliseWhitespace(text)).digest('hex');

const shingles = (text, size = 3) => {
  const tokens = normaliseForMatch(text).split(' ').filter(Boolean);
  if (tokens.length < size) return tokens.length ? [tokens.join(' ')] : [];
  const out = [];
  for (let i = 0; i + size <= tokens.length; i += 1) out.push(tokens.slice(i, i + size).join(' '));
  return out;
};

/** 64-bit hash of a string as a BigInt. FNV-1a over the sha1 digest bytes. */
function hash64(s) {
  const digest = crypto.createHash('sha1').update(s).digest();
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < 8; i += 1) {
    h = ((h ^ BigInt(digest[i])) * prime) & mask;
  }
  return h;
}

/**
 * Simhash over 3-token shingles, returned as a 16-char hex string.
 * Hamming distance between two of these is the near-duplicate test.
 */
export function simhash(text) {
  const grams = shingles(text, 3);
  if (!grams.length) return null;
  const bits = new Array(64).fill(0);
  const counts = new Map();
  for (const g of grams) counts.set(g, (counts.get(g) ?? 0) + 1);
  for (const [gram, weight] of counts) {
    const h = hash64(gram);
    for (let b = 0; b < 64; b += 1) {
      bits[b] += (h >> BigInt(b)) & 1n ? weight : -weight;
    }
  }
  let out = 0n;
  for (let b = 0; b < 64; b += 1) if (bits[b] > 0) out |= 1n << BigInt(b);
  return out.toString(16).padStart(16, '0');
}

export function hammingDistance(hexA, hexB) {
  if (!hexA || !hexB) return 64;
  let x = BigInt('0x' + hexA) ^ BigInt('0x' + hexB);
  let count = 0;
  while (x) {
    x &= x - 1n;
    count += 1;
  }
  return count;
}

const MINHASH_PERMUTATIONS = 64;

/**
 * MinHash signature as a comma-separated string of 64 values. Comparing two
 * signatures gives an estimate of the Jaccard similarity of their shingle sets
 * without storing the sets.
 */
export function minhash(text) {
  const grams = shingles(text, 3);
  if (!grams.length) return null;
  const sig = new Array(MINHASH_PERMUTATIONS).fill(0xffffffff);
  for (const g of grams) {
    const base = crypto.createHash('md5').update(g).digest();
    const h1 = base.readUInt32BE(0);
    const h2 = base.readUInt32BE(4) | 1; // odd, so it is coprime with 2^32
    for (let i = 0; i < MINHASH_PERMUTATIONS; i += 1) {
      const v = (h1 + Math.imul(i, h2)) >>> 0;
      if (v < sig[i]) sig[i] = v;
    }
  }
  return sig.join(',');
}

export function minhashSimilarity(a, b) {
  if (!a || !b) return 0;
  const x = a.split(',');
  const y = b.split(',');
  if (x.length !== y.length) return 0;
  let same = 0;
  for (let i = 0; i < x.length; i += 1) if (x[i] === y[i]) same += 1;
  return same / x.length;
}

// --- URLs -------------------------------------------------------------------

const TRACKING_PARAMS = /^(utm_|fbclid|gclid|mc_|ref|ref_src|source|cmpid|icid|ito|CMP|spm)/i;

/**
 * Canonical URL: lowercase host, no www, no tracking parameters, no fragment,
 * no trailing slash, AMP suffix removed. Two URLs that canonicalise the same
 * are the same document even if both were returned by the corpus provider.
 */
export function canonicaliseUrl(raw) {
  if (!raw) return null;
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return String(raw).trim().toLowerCase() || null;
  }
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  u.protocol = u.protocol === 'http:' ? 'https:' : u.protocol;
  const keep = [];
  for (const [k, v] of u.searchParams) if (!TRACKING_PARAMS.test(k)) keep.push([k, v]);
  u.search = '';
  keep.sort(([a], [b]) => a.localeCompare(b));
  for (const [k, v] of keep) u.searchParams.append(k, v);
  u.pathname = u.pathname
    .replace(/\/amp\/?$/, '/')
    .replace(/\.amp$/, '')
    .replace(/\/index\.(html?|php)$/, '/')
    .replace(/\/+$/, '') || '/';
  return u.toString().replace(/\/$/, '');
}

// Two-part public suffixes we actually meet. Not a full PSL — a full list is a
// 200KB dependency, and getting bbc.co.uk right covers the real cases.
const TWO_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'co.za', 'co.jp', 'ne.jp', 'or.jp', 'co.in', 'net.in', 'org.in',
  'com.br', 'com.mx', 'com.ar', 'com.sg', 'com.hk', 'com.tr', 'com.cn',
  'gov.in', 'ac.in', 'edu.hk', 'ac.nz', 'org.nz', 'gov.au',
]);

export function rootDomain(urlOrHost) {
  if (!urlOrHost) return null;
  let host = String(urlOrHost).trim().toLowerCase();
  if (host.includes('://')) {
    try { host = new URL(host).hostname; } catch { /* fall through to raw */ }
  }
  host = host.replace(/^www\./, '').replace(/:\d+$/, '').replace(/\/.*$/, '');
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host || null;
  const lastTwo = parts.slice(-2).join('.');
  if (TWO_PART_TLDS.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

export const shortHash = (input) =>
  crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, 40);
