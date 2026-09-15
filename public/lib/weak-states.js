import { h, clear } from './dom.js';
import { NOTICES, metricLabel } from './metrics-ui.js';

/**
 * §94 — honest weak and empty states, shown above every entity screen.
 *
 * Rendered by the shell rather than by each view, so no screen can forget it,
 * and in both modes, because plain mode may relabel a number but may never hide
 * why the number is weak.
 *
 * Fetched directly rather than through api(): this is a banner, and an expired
 * session should not bounce someone to the login screen from a banner request.
 */
export function weakStatesBanner(entityId) {
  const slot = h('div', { class: 'weak-states', 'aria-live': 'polite' });
  fetch(`/api/entities/${encodeURIComponent(entityId)}/weak-states`, {
    headers: { 'x-requested-with': 'entitygraph' },
  })
    .then((res) => (res.ok ? res.json() : null))
    .then((states) => { if (states) paint(slot, states); })
    .catch(() => { /* a banner that fails to load must not break the screen */ });
  return slot;
}

function notice(className, tag, text) {
  return h('div', { class: `weak ${className}`.trim() },
    h('span', { class: 'weak-tag' }, tag),
    h('span', {}, text));
}

function paint(slot, s) {
  const items = [];

  if (s.low_coverage) {
    items.push(notice('bad', metricLabel('coverage_confidence'), NOTICES.low_coverage({ documents: s.documents })));
  }

  // The extractor badge is persistent: it names the condition every time, not
  // once. A report built on fallback extraction should never look like one that
  // was not.
  if (!s.llm?.key_configured) {
    items.push(notice('bad', metricLabel('extractor'), NOTICES.no_llm_key()));
  } else if ((s.extraction?.heuristic ?? 0) > 0) {
    items.push(notice('', metricLabel('extractor'),
      NOTICES.heuristic_rows({ heuristic: s.extraction.heuristic, total: s.extraction.total })));
  }

  if (s.show_dates_notice) {
    items.push(notice('', metricLabel('recency_weight'),
      NOTICES.dates_inferred({ inferred: s.dating.inferred, total: s.dating.total })));
  }

  if (!s.google_available) {
    items.push(notice('', metricLabel('google_retrieval_score'), NOTICES.no_google()));
  }

  clear(slot).append(...items);
}
