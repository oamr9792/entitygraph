import { h, clear } from './dom.js';
import { METRICS, BANDS, BAND_ORDER, DISCLAIMERS, NOTICES } from '/copy/metrics.js';

/**
 * The presentation layer for §88–§95.
 *
 * Everything here reads the copy registry and nothing here computes a number.
 * The mode changes which label is shown and which screens are in the nav; it
 * never changes a score, never drops a denominator, never hides a disclaimer.
 * Someone who switches to plain mode must get the same answer, only readably.
 */

export { METRICS, BANDS, BAND_ORDER, DISCLAIMERS, NOTICES };

// --- §88 Mode ---------------------------------------------------------------

const MODE_KEY = 'entitygraph.mode';

export function getMode() {
  try {
    return localStorage.getItem(MODE_KEY) === 'advanced' ? 'advanced' : 'plain';
  } catch {
    // Storage can be blocked. Plain is the default, so that is also the fallback.
    return 'plain';
  }
}

export function setMode(mode) {
  try {
    localStorage.setItem(MODE_KEY, mode === 'advanced' ? 'advanced' : 'plain');
  } catch { /* the choice just will not persist */ }
}

export const isPlain = () => getMode() === 'plain';

// --- §89 Registry access ----------------------------------------------------

export function metric(key) {
  const entry = METRICS[key];
  if (!entry) {
    // The test suite fails on this before it can ship; at runtime, degrade to
    // the raw key rather than breaking the screen.
    console.error(`[copy] no registry entry for metric "${key}"`);
    return { plain: key, advanced: key, what: '', look: '' };
  }
  return entry;
}

export const labelText = (key, mode = getMode()) => metric(key)[mode] ?? metric(key).plain;

// --- Formatting -------------------------------------------------------------

const whole = (v) => Math.round(Number(v)).toLocaleString('en-GB');
const plural = (count, one, many) => (Math.round(Number(count)) === 1 ? one : many);
const scoreText = (v) => Number(v).toFixed(1).replace(/\.0$/, '');

// Independent sources are a weighted count, so they are rarely whole. Shown
// rounded with a marker rather than to one decimal: "≈26 independent sources"
// reads as a count, "25.9 independent sources" reads as an error.
const sourcesText = (v) => (Number.isInteger(Number(v)) ? whole(v) : `≈${whole(v)}`);

// --- §92 Tooltips and terms -------------------------------------------------

/** A metric label that carries its own tooltip. Use for headers and labels. */
export function metricLabel(key, { text = null } = {}) {
  return h('span', {
    class: 'metric-term',
    'data-metric': key,
    tabindex: '0',
    role: 'button',
    'aria-haspopup': 'dialog',
    'aria-expanded': 'false',
  }, text ?? labelText(key));
}

let seenTerms = new Set();

/** Called once per render, so "first use on this screen" means what it says. */
export const resetTerms = () => { seenTerms = new Set(); };

/**
 * A metric named in body copy. The first use on a screen gets the other name
 * in brackets — "Association strength (PIAS)" — so the plain label and the
 * report abbreviation are connected once; later uses are the label alone.
 */
export function term(key) {
  const entry = metric(key);
  const mode = getMode();
  const main = labelText(key, mode);
  const other = mode === 'advanced' ? entry.plain : entry.advanced;
  if (seenTerms.has(key) || !other || other === main) return metricLabel(key, { text: main.toLowerCase() === main ? main : main });
  seenTerms.add(key);
  return h('span', {}, metricLabel(key, { text: main }), ` (${mode === 'advanced' ? other.toLowerCase() : other})`);
}

let tip = null;
let anchor = null;

function placeTip() {
  if (!tip || !anchor) return;
  const r = anchor.getBoundingClientRect();
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  const gap = 8;
  let left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
  let top = r.bottom + gap;
  if (top + height > window.innerHeight - 8) top = Math.max(8, r.top - height - gap);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function showTip(target) {
  const key = target.getAttribute('data-metric');
  const entry = key === 'band' && target.dataset.band
    ? { ...metric('band'), bandWhat: BANDS[target.dataset.band]?.what }
    : metric(key);
  if (anchor && anchor !== target) anchor.setAttribute('aria-expanded', 'false');

  const mode = getMode();
  clear(tip).append(
    h('div', { class: 'tip-head' },
      labelText(key, mode),
      entry.advanced && entry.advanced !== entry.plain
        ? h('span', { class: 'alt' }, mode === 'plain' ? entry.advanced : entry.plain)
        : null),
    entry.bandWhat ? h('p', {}, entry.bandWhat) : null,
    // §92: two sentences maximum — what it is, then what to look for.
    h('p', {}, entry.what),
    h('p', { class: 'tip-look' }, entry.look),
    h('a', { href: `#/glossary?term=${encodeURIComponent(key)}` }, 'Glossary')
  );
  tip.hidden = false;
  anchor = target;
  target.setAttribute('aria-expanded', 'true');
  target.setAttribute('aria-describedby', 'metric-tip');
  placeTip();
}

function hideTip() {
  if (!tip) return;
  tip.hidden = true;
  if (anchor) {
    anchor.setAttribute('aria-expanded', 'false');
    anchor.removeAttribute('aria-describedby');
  }
  anchor = null;
}

let bound = false;

/**
 * One delegated binding for every [data-metric] element, present or future.
 * CSP-safe: no inline handlers anywhere. Works for mouse, touch and keyboard —
 * a tooltip that only opens on hover is unreachable on a phone and invisible to
 * anyone tabbing through a table.
 */
export function bindTooltips() {
  if (bound) return;
  bound = true;
  tip = h('div', { class: 'metric-tip', id: 'metric-tip', role: 'tooltip' });
  tip.hidden = true;
  document.body.append(tip);

  const targetOf = (event) => event.target?.closest?.('[data-metric]') ?? null;

  // Capture phase, so a term inside a sortable table header opens its tooltip
  // instead of re-sorting the table.
  document.addEventListener('click', (event) => {
    const target = targetOf(event);
    if (target) {
      event.preventDefault();
      event.stopPropagation();
      if (anchor === target && !tip.hidden) hideTip();
      else showTip(target);
      return;
    }
    if (!tip.contains(event.target)) hideTip();
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      const back = anchor;
      hideTip();
      back?.focus?.();
      return;
    }
    const target = targetOf(event);
    if (target && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      event.stopPropagation();
      if (anchor === target && !tip.hidden) hideTip();
      else showTip(target);
    }
  }, true);

  document.addEventListener('mouseover', (event) => {
    const target = targetOf(event);
    if (target && target !== anchor) showTip(target);
  });
  document.addEventListener('mouseout', (event) => {
    const target = targetOf(event);
    if (target && target === anchor && !tip.contains(event.relatedTarget) && !target.contains(event.relatedTarget)) hideTip();
  });
  tip.addEventListener('mouseleave', (event) => {
    if (anchor && !anchor.contains(event.relatedTarget)) hideTip();
  });
  document.addEventListener('focusin', (event) => {
    const target = targetOf(event);
    if (target) showTip(target);
    else if (!tip.contains(event.target)) hideTip();
  });

  window.addEventListener('hashchange', hideTip);
  window.addEventListener('resize', placeTip);
  window.addEventListener('scroll', placeTip, true);
}

// --- §93 Denominators -------------------------------------------------------

/**
 * A score with the count it rests on. Never a score alone.
 *
 * `basis` is { sources, documents } for corpus scores, or { results, total }
 * for what Google shows. Where independent sources fall far below documents,
 * both are shown and flagged, because that divergence is the syndication story
 * and the single most likely thing to change someone's mind about a number.
 */
export function scoreWithBasis(key, value, basis = {}, { compact = false } = {}) {
  if (value === null || value === undefined) {
    return h('span', { class: 'dim' }, '—');
  }
  const mode = getMode();
  const pageWord = (count) => (mode === 'plain' ? plural(count, 'page', 'pages') : plural(count, 'document', 'documents'));

  let text;
  let syndication = false;
  if (basis.results !== undefined && basis.results !== null) {
    text = `from ${whole(basis.results)} of ${whole(basis.total ?? 0)} first-page ${plural(basis.total ?? 0, 'result', 'results')}`;
  } else if (basis.sources !== undefined && basis.sources !== null && basis.documents !== undefined && basis.documents !== null) {
    text = `from ${sourcesText(basis.sources)} independent ${plural(basis.sources, 'source', 'sources')} across ${whole(basis.documents)} ${pageWord(basis.documents)}`;
    syndication = basis.documents >= 4 && basis.sources / basis.documents < 0.5;
  } else if (basis.documents !== undefined && basis.documents !== null) {
    text = `from ${whole(basis.documents)} ${pageWord(basis.documents)}`;
  } else {
    // §97: a score without its denominator is never shown silently.
    console.error(`[§93] "${key}" rendered without a denominator`);
    text = 'basis unavailable';
  }

  return h('span', { class: `score-basis${compact ? ' compact' : ''}` },
    h('span', { class: 'score-cell' }, scoreText(value)),
    h('span', { class: 'basis' }, text),
    syndication
      ? h('span', {
          class: 'chip warn',
          'data-metric': 'independence_weight',
          tabindex: '0',
          role: 'button',
        }, 'mostly repeats')
      : null
  );
}

/** The same denominator as a sentence fragment, for summaries written as prose. */
export function basisPhrase(basis = {}) {
  const mode = getMode();
  if (basis.results !== undefined && basis.results !== null) {
    return `${whole(basis.results)} of ${whole(basis.total ?? 0)} first-page results`;
  }
  const pages = mode === 'plain' ? plural(basis.documents, 'page', 'pages') : plural(basis.documents, 'document', 'documents');
  return `${sourcesText(basis.sources ?? 0)} independent ${plural(basis.sources ?? 0, 'source', 'sources')} across ${whole(basis.documents ?? 0)} ${pages}`;
}

// --- §94 Momentum below the floor ---------------------------------------------

export function momentumCell(m) {
  if (!m) return h('span', { class: 'dim' }, '—');
  if (m.below_floor || m.bucket === 'insufficient') {
    return h('span', { class: 'momentum-floor' },
      h('span', { class: 'trend insufficient', 'data-metric': 'momentum', tabindex: '0', role: 'button' }, '—'),
      h('span', { class: 'basis' }, NOTICES.momentum_floor()));
  }
  const pct = m.basis === null || m.basis === undefined ? '' : ` ${m.basis >= 0 ? '+' : ''}${Math.round(m.basis * 100)}%`;
  return h('span', { class: `trend ${m.bucket}`, title: `${m.label}${pct}` }, m.arrow);
}

// --- §95 Bands --------------------------------------------------------------

export function bandChip(band) {
  if (!band || !BANDS[band]) return null;
  return h('span', {
    class: `chip band band-${band}`,
    'data-metric': 'band',
    'data-band': band,
    tabindex: '0',
    role: 'button',
  }, BANDS[band].plain);
}

/** Permanently beside any bands on a screen. The misreading it prevents is the likely one. */
export const bandNote = () => h('p', { class: 'band-note' }, DISCLAIMERS.bands);
