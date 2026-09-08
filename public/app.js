/**
 * EntityGraph front end. Hash routing, a fetch helper, a few DOM utilities,
 * and one render pass per navigation. No framework: the screens are tables and
 * one SVG, and a framework would be more code than the app.
 */

// --- DOM helpers ------------------------------------------------------------

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else el.setAttribute(key, value);
  }
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

export function toast(message, kind = '') {
  const el = h('div', { class: `toast ${kind}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 4000);
}

// --- API --------------------------------------------------------------------

export async function api(path, { method = 'GET', body = null } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try { payload = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const message = payload?.error ?? `${res.status} ${res.statusText}`;
    throw Object.assign(new Error(message), { status: res.status, details: payload?.details });
  }
  return payload;
}

// --- Formatting -------------------------------------------------------------

export const fmt = {
  n: (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString()),
  score: (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(1).replace(/\.0$/, '')),
  pct: (v, dp = 0) => (v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(dp)}%`),
  pctRaw: (v, dp = 0) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(dp)}%`),
  change: (v) => (v === null || v === undefined ? '—' : `${v >= 0 ? '+' : ''}${Math.round(Number(v) * 100)}%`),
  date: (v) => (v ? String(v).slice(0, 10) : '—'),
  ago: (v) => (v ? `${v} ago` : '—'),
};

/** Category colours for the graph and timeline, derived from the label itself
 *  so the same association keeps its colour across screens without a registry. */
export function colourFor(label) {
  let hash = 0;
  for (let i = 0; i < String(label).length; i += 1) hash = (hash * 31 + String(label).charCodeAt(i)) % 360;
  return `hsl(${hash}, 58%, 58%)`;
}

export function sentimentClass(sentiment) {
  if (sentiment === 'negative') return 'bad';
  if (sentiment === 'positive') return 'good';
  return '';
}

/**
 * A sortable table. Sorting is client-side over the rows already fetched,
 * which is what §45 asks for ("allow sorting by every column") without a round
 * trip per click.
 */
export function sortableTable(columns, rows, { initialSort = null, initialDesc = true, footer = null } = {}) {
  let sortKey = initialSort ?? columns[0].key;
  let desc = initialDesc;
  const wrap = h('div', { class: 'table-wrap' });

  const render = () => {
    const column = columns.find((c) => c.key === sortKey);
    const sorted = rows.slice().sort((a, b) => {
      const va = column?.sortValue ? column.sortValue(a) : a[sortKey];
      const vb = column?.sortValue ? column.sortValue(b) : b[sortKey];
      if (va === vb) return 0;
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return desc ? -cmp : cmp;
    });

    clear(wrap).append(
      h('table', {},
        h('thead', {},
          h('tr', {}, columns.map((c) =>
            h('th', {
              class: [c.num ? 'num' : '', c.sortable === false ? 'no-sort' : ''].filter(Boolean).join(' '),
              title: c.title ?? '',
              onclick: c.sortable === false ? null : () => {
                if (sortKey === c.key) desc = !desc;
                else { sortKey = c.key; desc = true; }
                render();
              },
            }, c.label, sortKey === c.key ? h('span', { class: 'arrow' }, desc ? ' ▼' : ' ▲') : null)
          ))
        ),
        h('tbody', {}, sorted.map((row) => h('tr', {}, columns.map((c) =>
          h('td', { class: c.num ? 'num' : '' }, c.render ? c.render(row) : row[c.key] ?? '—')
        )))),
        footer ? h('tfoot', {}, h('tr', {}, h('td', { colspan: columns.length }, footer))) : null
      )
    );
  };

  render();
  return wrap;
}

// --- Routing ----------------------------------------------------------------

const routes = [];
export const route = (pattern, loader) => routes.push({ pattern, loader });

export function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

export const state = { settings: null };

function matchRoute(path) {
  for (const r of routes) {
    const names = [];
    const source = r.pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; });
    const m = new RegExp(`^${source}$`).exec(path);
    if (!m) continue;
    const params = {};
    names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
    return { loader: r.loader, params };
  }
  return null;
}

async function render() {
  const app = document.getElementById('app');
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, queryString] = raw.split('?');
  const query = new URLSearchParams(queryString ?? '');
  const match = matchRoute(path);

  if (!match) {
    clear(app).append(shell(h('div', { class: 'empty' }, `No screen for ${path}`), path));
    return;
  }

  try {
    const view = await match.loader();
    const content = await view({ params: match.params, query, path });
    clear(app).append(shell(content, path));
    app.classList.remove('app-loading');
    window.scrollTo(0, 0);
  } catch (err) {
    console.error(err);
    clear(app).append(shell(
      h('div', { class: 'panel' },
        h('h2', {}, 'Something went wrong'),
        h('div', { class: 'panel-body' },
          h('p', {}, err.message),
          err.details ? h('pre', { class: 'small mono' }, JSON.stringify(err.details, null, 2)) : null
        )
      ),
      path
    ));
    app.classList.remove('app-loading');
  }
}

// --- Shell ------------------------------------------------------------------

function shell(content, path) {
  const entityId = /^\/entities\/(\d+)/.exec(path)?.[1];
  const link = (href, label) =>
    h('a', { href: `#${href}`, class: path === href || path.startsWith(href + '/') ? 'active' : '' }, label);

  return h('div', { class: 'shell' },
    h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' }, '◕', h('div', {}, 'EntityGraph', h('small', {}, 'Association Intelligence'))),
      h('nav', { class: 'nav' },
        link('/', 'Entities'),
        link('/new', 'New entity'),
        entityId ? h('div', { class: 'group-label' }, 'This entity') : null,
        entityId ? link(`/entities/${entityId}`, 'Dashboard') : null,
        entityId ? link(`/entities/${entityId}/graph`, 'Graph') : null,
        entityId ? link(`/entities/${entityId}/timeline`, 'Timeline') : null,
        entityId ? link(`/entities/${entityId}/old-vs-current`, 'Old vs current') : null,
        entityId ? link(`/entities/${entityId}/compare`, 'Compare') : null,
        entityId ? link(`/entities/${entityId}/serp`, 'Google overlay') : null,
        entityId ? link(`/entities/${entityId}/gaps`, 'Gaps & priorities') : null,
        entityId ? link(`/entities/${entityId}/review`, 'Review queue') : null,
        entityId ? link(`/entities/${entityId}/identity`, 'Identity profile') : null,
        entityId ? link(`/entities/${entityId}/jobs`, 'Jobs & cost') : null,
        h('div', { class: 'group-label' }, 'System'),
        link('/settings', 'Settings & model')
      ),
      h('div', { class: 'small dim', style: { marginTop: 'auto' } },
        'PIAS is an external estimate. It is not a Google score.')
    ),
    h('main', { class: 'main' }, content)
  );
}

/** §3 — rendered on every screen that shows a score. */
export const disclaimer = (text) =>
  h('div', { class: 'disclaimer' }, text ?? state.settings?.disclaimer ?? '');

// --- Registration -----------------------------------------------------------

route('/', () => import('./views/portfolio.js').then((m) => m.portfolioView));
route('/new', () => import('./views/portfolio.js').then((m) => m.newEntityView));
route('/settings', () => import('./views/settings.js').then((m) => m.settingsView));
route('/entities/:id', () => import('./views/entity.js').then((m) => m.dashboardView));
route('/entities/:id/graph', () => import('./views/graph.js').then((m) => m.graphView));
route('/entities/:id/timeline', () => import('./views/graph.js').then((m) => m.timelineView));
route('/entities/:id/old-vs-current', () => import('./views/compare.js').then((m) => m.oldVsCurrentView));
route('/entities/:id/compare', () => import('./views/compare.js').then((m) => m.compareView));
route('/entities/:id/gaps', () => import('./views/compare.js').then((m) => m.gapsView));
route('/entities/:id/serp', () => import('./views/serp.js').then((m) => m.serpView));
route('/entities/:id/review', () => import('./views/review.js').then((m) => m.reviewView));
route('/entities/:id/identity', () => import('./views/review.js').then((m) => m.identityView));
route('/entities/:id/jobs', () => import('./views/review.js').then((m) => m.jobsView));
route('/associations/:id', () => import('./views/evidence.js').then((m) => m.evidenceView));

window.addEventListener('hashchange', render);

api('/api/settings')
  .then((settings) => { state.settings = settings; })
  .catch(() => { /* the screens degrade without it */ })
  .finally(render);
