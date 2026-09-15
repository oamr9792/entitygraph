import config from '../config.js';
import { all, get, run } from '../db.js';
import * as dfs from '../providers/dataforseo.js';
import { badRequest } from '../http.js';
import { extractText, robotsAllows } from './fetch.js';
import { identityProfile } from './identity.js';
import { assertPublicUrl } from './url-safety.js';
import { findOccurrences, normaliseWhitespace } from '../util/text.js';
import { rootDomain } from '../util/hash.js';
import { chunkPassages, cleanPageTitle, detectBylineClient } from './content-checks.js';

/**
 * The page an analysis is written from — usually the client's own press
 * release — read once and kept, so a draft can always be checked against the
 * words it was built from.
 *
 * Kept apart from the corpus on purpose: a page someone pastes in is material
 * for writing, not evidence the web holds, and it must not change any score.
 */

const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 4;
const MAX_STORED_CHARS = 60000;
// Below this a direct read has usually hit a cookie wall or a script shell.
const GOOD_ENOUGH_CHARS = 1500;

async function fetchDirect(start) {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicUrl(url.href);
    const res = await fetch(url, {
      redirect: 'manual',
      headers: {
        'user-agent': config.pageFetchUserAgent,
        accept: 'text/html,application/xhtml+xml,text/plain',
        'accept-language': 'en',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url);
      continue;
    }
    if (!res.ok) return { ok: false, reason: `the site answered ${res.status}` };
    const type = res.headers.get('content-type') ?? '';
    if (type && !/html|text\/plain|xml/i.test(type)) return { ok: false, reason: `it is not a web page (${type.split(';')[0]})` };
    if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) return { ok: false, reason: 'the page is too large' };
    return { ok: true, html: (await res.text()).slice(0, MAX_BYTES), finalUrl: url.href };
  }
  return { ok: false, reason: 'it redirected too many times' };
}

function titleOf(html) {
  const og = /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1];
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return normaliseWhitespace(extractText(og ?? title ?? '')).slice(0, 300) || null;
}

export function sourceSummary(row) {
  if (!row) return null;
  const url = row.final_url ?? row.url;
  return {
    id: row.id,
    url: row.url,
    final_url: url,
    domain: rootDomain(url),
    title: row.title,
    chars: row.chars,
    via: row.via,
    names_client: Boolean(row.names_client),
    byline_client: Boolean(row.byline_client),
    created_at: row.created_at,
  };
}

export async function readSource(entityId, rawUrl, user = null) {
  const url = await assertPublicUrl(rawUrl);
  let text = '';
  let title = null;
  let via = null;
  let finalUrl = url.href;
  let reason = null;
  let html = '';

  let allowed = true;
  try { allowed = await robotsAllows(url.href); } catch { /* unreadable robots.txt permits reading */ }

  if (allowed) {
    try {
      const direct = await fetchDirect(url);
      if (direct.ok) {
        html = direct.html;
        text = extractText(direct.html);
        title = titleOf(direct.html);
        via = 'direct';
        finalUrl = direct.finalUrl;
      } else {
        reason = direct.reason;
      }
    } catch (err) {
      // A redirect to a private address is refused outright, not retried elsewhere.
      if (err.status === 400) throw err;
      reason = `it could not be fetched (${err.message})`;
    }
  } else {
    reason = 'the site’s robots.txt does not allow automated reading';
  }

  if (text.length < GOOD_ENOUGH_CHARS && dfs.isConfigured()) {
    try {
      const parsed = await dfs.contentParsing(url.href, { entityId });
      if (parsed?.text && parsed.text.length > text.length) {
        text = parsed.text;
        via = 'dataforseo_content_parsing';
      }
    } catch {
      // Best effort: keep whatever the direct read found.
    }
  }

  text = text.slice(0, MAX_STORED_CHARS);
  if (text.length < 200) {
    throw badRequest(`Could not read enough of that page${reason ? `: ${reason}` : ''}. Try a different URL, or paste the text into the notes and use another format.`);
  }

  const profile = identityProfile(entityId);
  const names = [profile.canonical_name, ...(profile.aliases ?? [])];
  const namesClient = findOccurrences(text, names).length > 0;
  const bylineClient = detectBylineClient({ html, text, names });
  // A direct read that hit a bot check still has a <title> — "One moment,
  // please…" — even when DataForSEO supplied the real text.
  title = cleanPageTitle(title, text);
  const res = run(
    `INSERT INTO content_sources (entity_id, url, final_url, title, body, chars, via, names_client, byline_client, fetched_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    entityId,
    url.href,
    finalUrl,
    title,
    text,
    text.length,
    via,
    namesClient ? 1 : 0,
    bylineClient ? 1 : 0,
    user?.id ?? null
  );
  return sourceSummary(get(`SELECT * FROM content_sources WHERE id = ?`, Number(res.lastInsertRowid)));
}

export const getSource = (entityId, id) =>
  get(`SELECT * FROM content_sources WHERE id = ? AND entity_id = ?`, Number(id), entityId);

export const listSources = (entityId, limit = 10) =>
  all(`SELECT * FROM content_sources WHERE entity_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`, entityId, limit)
    .map(sourceSummary);

/** The page as numbered passages a draft can cite. */
export function sourceFacts(row) {
  const summary = sourceSummary(row);
  return chunkPassages(row.body, { maxChars: 700, maxChunks: 25 }).map((passage, i) => ({
    id: `S${i + 1}`,
    source: 'page',
    passage,
    url: summary.final_url,
    domain: summary.domain,
    title: summary.title,
  }));
}
