/**
 * EntityGraph front end. Hash routing, a fetch helper, a few DOM utilities,
 * and one render pass per navigation. No framework: the screens are tables and
 * one SVG, and a framework would be more code than the app.
 */

// --- DOM helpers ------------------------------------------------------------
// Defined in lib/dom.js so the metric layer can share them without a cycle.

import { h, clear } from './lib/dom.js';
import { resetTerms, bindTooltips, getMode, setMode, labelText, metricLabel } from './lib/metrics-ui.js';
import { weakStatesBanner } from './lib/weak-states.js';

export { h, clear };

export function toast(message, kind = '') {
  const el = h('div', { class: `toast ${kind}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 4000);
}

// --- API --------------------------------------------------------------------

export async function api(path, { method = 'GET', body = null } = {}) {
  const res = await fetch(path, {
    method,
    // The server requires this header on every mutating request. A browser
    // will not let a cross-origin page set it without a preflight, and no
    // permissive CORS headers are sent — so it closes the CSRF hole that
    // SameSite=Lax alone leaves open.
    headers: {
      'x-requested-with': 'entitygraph',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try { payload = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    // A session that expired mid-use should return the user to the login
    // screen rather than showing them an error they cannot act on.
    if (res.status === 401 && !path.startsWith('/api/auth/') && path !== '/api/me') {
      state.user = null;
      render();
    }
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
 *
 * A column with `metric` takes its header from the copy registry (§89) and
 * carries that metric's tooltip; clicking the term opens the tooltip, clicking
 * the rest of the header sorts.
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
            }, c.metric ? metricLabel(c.metric) : c.label, sortKey === c.key ? h('span', { class: 'arrow' }, desc ? ' ▼' : ' ▲') : null)
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

// --- Live build status ------------------------------------------------------

/**
 * Timers and pollers registered by a view, torn down when the user navigates.
 * Without this a poller started on the dashboard keeps running — and keeps
 * re-rendering — after you have moved to another screen.
 */
const teardowns = [];
export function onTeardown(fn) { teardowns.push(fn); }

function runTeardowns() {
  while (teardowns.length) {
    try { teardowns.pop()(); } catch { /* a failed teardown must not block navigation */ }
  }
}

/**
 * The build-status strip. A long build used to look identical to a dead one:
 * the page rendered once, said "running", and never changed — so a job that
 * failed thirteen seconds in still read as in-progress five minutes later.
 *
 * This polls while a job is live, shows the step it is on, and re-renders the
 * screen once it finishes so the results appear on their own. A failed job
 * shows its error here rather than only in the job log, because the error is
 * the reason the screen the user is looking at is empty.
 */
export function buildStatus(entityId, { pollMs = 2000 } = {}) {
  const strip = h('div', {});
  let lastStatus = null;
  let stopped = false;

  const paint = (job) => {
    if (!job || job.status === 'done' || job.status === 'cancelled') { clear(strip); return; }

    if (job.status === 'failed') {
      clear(strip).append(
        h('div', { class: 'banner bad' },
          h('div', { class: 'banner-head' },
            h('strong', {}, `Build failed at step ${job.steps_done + 1} of ${job.steps_total}`),
            h('span', { class: 'small dim' }, job.step ? ` · ${job.step}` : '')
          ),
          h('p', { class: 'banner-body' }, job.error ?? 'No error recorded.'),
          h('div', { class: 'banner-actions' },
            h('button', { class: 'small', onclick: () => retry(entityId) }, 'Retry build'),
            h('button', { class: 'small ghost', onclick: () => navigate(`#/entities/${entityId}/jobs`) }, 'Job log')
          )
        )
      );
      return;
    }

    const pct = job.steps_total ? Math.round((job.steps_done / job.steps_total) * 100) : 0;
    clear(strip).append(
      h('div', { class: 'banner warn' },
        h('div', { class: 'banner-head' },
          h('strong', {}, job.status === 'queued' ? 'Build queued' : `Building · step ${job.steps_done + 1} of ${job.steps_total}`),
          h('span', { class: 'small dim' }, job.step ? ` · ${job.step.replace(/_/g, ' ')}` : '')
        ),
        h('div', { class: 'bar' }, h('div', { class: 'bar-fill', style: { width: `${pct}%` } })),
        h('div', { class: 'banner-actions' },
          h('span', { class: 'small dim' }, `$${(job.cost_usd ?? 0).toFixed(4)} spent so far`),
          h('button', { class: 'small ghost', onclick: () => navigate(`#/entities/${entityId}/jobs`) }, 'Details')
        )
      )
    );
  };

  const retry = async (id) => {
    try {
      await api(`/api/entities/${id}/build`, { method: 'POST', body: {} });
      toast('Build queued', 'success');
      poll();
    } catch (err) { toast(err.message, 'error'); }
  };

  const poll = async () => {
    if (stopped) return;
    try {
      const { jobs } = await api(`/api/jobs?entity_id=${entityId}&limit=1&kind=full_build`);
      const job = jobs?.[0] ?? null;
      paint(job);
      const live = job && (job.status === 'running' || job.status === 'queued');
      // A build that has just finished leaves the screen showing the empty
      // state it rendered before the data existed. Re-render once, on the
      // transition, so results appear without the user reloading.
      if (lastStatus && lastStatus !== job?.status && job?.status === 'done') {
        toast('Build complete', 'success');
        render();
        return;
      }
      lastStatus = job?.status ?? null;
      if (live) timer = setTimeout(poll, pollMs);
    } catch {
      // Polling failures are not worth a toast on every tick; try again.
      if (!stopped) timer = setTimeout(poll, pollMs * 3);
    }
  };

  let timer = null;
  onTeardown(() => { stopped = true; clearTimeout(timer); });
  poll();
  return strip;
}

// --- Routing ----------------------------------------------------------------

const routes = [];
export const route = (pattern, loader) => routes.push({ pattern, loader });

export function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

export const state = { settings: null, user: null };

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
  runTeardowns();
  // §92: one delegated tooltip binding for the life of the page, and a fresh
  // "first use on this screen" record for every render.
  bindTooltips();
  resetTerms();
  const app = document.getElementById('app');

  // The gate. Nothing else renders without a session — not the shell, not the
  // navigation, not a cached screen behind a modal. The server enforces this
  // too; doing it here as well means an expired session shows a login form
  // rather than a wall of failed requests.
  if (!state.user) {
    const { loginView } = await import('./views/login.js');
    clear(app).append(loginView({ onSignedIn: () => render() }));
    app.classList.remove('app-loading');
    return;
  }
  if (state.user.must_change_password) {
    const { changePasswordView } = await import('./views/login.js');
    clear(app).append(changePasswordView({
      onDone: async () => {
        state.user = { ...state.user, must_change_password: false };
        render();
      },
    }));
    app.classList.remove('app-loading');
    return;
  }

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

/**
 * §88 — plain mode changes the nav, not the numbers. The analytical screens are
 * one click away under "More screens" rather than gone, and the disclaimer, the
 * weak-state notices and every denominator render the same in both modes.
 */
function shell(content, path) {
  const entityId = /^\/entities\/(\d+)/.exec(path)?.[1];
  const mode = getMode();
  const plain = mode === 'plain';
  const isActive = (href) => path === href || (href !== `/entities/${entityId}` && path.startsWith(href + '/'));
  const link = (href, label) => h('a', { href: `#${href}`, class: isActive(href) ? 'active' : '' }, label);

  const analytical = entityId
    ? [
        [`/entities/${entityId}/graph`, 'Graph'],
        [`/entities/${entityId}/timeline`, 'Timeline'],
        [`/entities/${entityId}/old-vs-current`, 'Old vs current'],
        [`/entities/${entityId}/compare`, 'Compare'],
        [`/entities/${entityId}/serp`, 'Google overlay'],
        [`/entities/${entityId}/gaps`, 'Gaps & priorities'],
      ]
    : [];

  let entityNav = [];
  if (entityId) {
    const essentials = [
      link(`/entities/${entityId}/summary`, 'Summary'),
      link(`/entities/${entityId}`, 'Dashboard'),
      link(`/entities/${entityId}/content`, 'Content'),
      link(`/entities/${entityId}/audits`, 'Audit'),
    ];
    const upkeep = [
      link(`/entities/${entityId}/review`, plain ? 'Same person?' : 'Review queue'),
      link(`/entities/${entityId}/identity`, plain ? 'Markers' : 'Identity profile'),
      link(`/entities/${entityId}/jobs`, 'Jobs & cost'),
    ];
    const more = analytical.map(([href, label]) => link(href, label));
    entityNav = [
      h('div', { class: 'group-label' }, 'This client'),
      ...essentials,
      ...(plain
        ? [
            ...upkeep,
            h('details', { class: 'more', open: analytical.some(([href]) => isActive(href)) ? 'open' : null },
              h('summary', { class: 'more-link' }, 'More screens'),
              ...more),
          ]
        : [...more, ...upkeep]),
    ];
  }

  const modeToggle = h('div', { class: 'mode-toggle', role: 'group', 'aria-label': 'Label style' },
    [['plain', 'Plain'], ['advanced', 'Advanced']].map(([value, label]) =>
      h('button', {
        type: 'button',
        class: mode === value ? 'active' : '',
        'aria-pressed': mode === value ? 'true' : 'false',
        onclick: () => { if (getMode() !== value) { setMode(value); render(); } },
      }, label)));

  return h('div', { class: 'shell' },
    h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' }, '◕', h('div', {}, 'EntityGraph', h('small', {}, 'Association Intelligence'))),
      h('nav', { class: 'nav' },
        link('/', plain ? 'Clients' : 'Entities'),
        link('/quickstart', 'Quickstart'),
        plain ? null : link('/new', 'New entity'),
        ...entityNav,
        h('div', { class: 'group-label' }, 'Help & system'),
        link('/glossary', 'Glossary'),
        link('/settings', 'Settings & model')
      ),
      h('div', { class: 'sidebar-foot' },
        modeToggle,
        h('div', { class: 'signed-in' },
          h('span', { class: 'who', title: state.user?.email ?? '' }, state.user?.name ?? state.user?.email ?? ''),
          h('button', {
            class: 'small ghost',
            onclick: async () => {
              try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* sign out regardless */ }
              state.user = null;
              state.settings = null;
              render();
            },
          }, 'Sign out')
        ),
        h('div', { class: 'small dim' }, `${labelText('pias')} is an external estimate. It is not a Google score.`)
      )
    ),
    h('main', { class: 'main' },
      // §94 — above every entity screen, in both modes.
      entityId ? weakStatesBanner(entityId) : null,
      content)
  );
}

/** §3 — rendered on every screen that shows a score. */
export const disclaimer = (text) =>
  h('div', { class: 'disclaimer' }, text ?? state.settings?.disclaimer ?? '');

// --- Registration -----------------------------------------------------------

route('/', () => import('./views/portfolio.js').then((m) => m.portfolioView));
route('/new', () => import('./views/portfolio.js').then((m) => m.newEntityView));
route('/quickstart', () => import('./views/quickstart.js').then((m) => m.quickstartView));
route('/quickstart/:id', () => import('./views/quickstart.js').then((m) => m.quickstartView));
route('/glossary', () => import('./views/glossary.js').then((m) => m.glossaryView));
route('/settings', () => import('./views/settings.js').then((m) => m.settingsView));
route('/entities/:id', () => import('./views/entity.js').then((m) => m.dashboardView));
route('/entities/:id/summary', () => import('./views/summary.js').then((m) => m.summaryView));
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
route('/associations/:id/plan', () => import('./views/plan.js').then((m) => m.planView));
route('/associations/:id/content', () => import('./views/content.js').then((m) => m.contentBuilderView));
route('/content/:id', () => import('./views/content.js').then((m) => m.draftView));
route('/entities/:id/content', () => import('./views/content.js').then((m) => m.contentListView));
route('/entities/:id/audits', () => import('./views/audit.js').then((m) => m.auditListView));
route('/audits/:id', () => import('./views/audit.js').then((m) => m.auditView));

window.addEventListener('hashchange', render);

// Identity first: /api/settings is behind the gate, so asking who we are has
// to come before asking for anything else.
api('/api/me')
  .then(({ user }) => { state.user = user; })
  .catch(() => { state.user = null; })
  .then(() => (state.user ? api('/api/settings').then((s) => { state.settings = s; }).catch(() => {}) : null))
  .finally(render);
