import { h, api, fmt, toast, navigate, sortableTable, disclaimer, onTeardown } from '../app.js';
import { isPlain } from '../lib/metrics-ui.js';

/**
 * One chip that says what actually happened to the last build.
 *
 * `entities.status` alone is not enough: it says 'error' long after a later
 * build succeeded, and says nothing at all while one is in progress. The last
 * job is what someone looking at this screen wants to know about, and a failed
 * one carries its reason in the tooltip rather than hiding it in the job log.
 */
function buildChip(row) {
  const job = row.last_job_status;
  if (job === 'running' || job === 'queued') {
    const step = row.last_job_step ? String(row.last_job_step).replace(/_/g, ' ') : '';
    return h('span', { class: 'chip warn', title: step },
      job === 'queued' ? 'queued' : `building ${row.last_job_steps_done ?? 0}/${row.last_job_steps_total ?? 12}`);
  }
  if (job === 'failed') {
    return h('span', { class: 'chip bad', title: row.last_job_error ?? 'no error recorded' }, 'build failed');
  }
  if (job === 'cancelled') {
    return h('span', { class: 'chip warn', title: 'the last build was cancelled before it finished' }, 'cancelled');
  }
  return h('span', { class: `chip ${row.status === 'ready' ? 'good' : row.status === 'error' ? 'bad' : 'warn'}` }, row.status);
}

/** The entity list. */
export async function portfolioView() {
  const { entities } = await api('/api/entities');
  // §88: plain mode starts people at the summary and the guided path; the
  // dashboard and the full form are one click further, not gone.
  const plain = isPlain();
  const newHref = plain ? '#/quickstart' : '#/new';

  if (!entities.length) {
    return h('div', {},
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, plain ? 'Clients' : 'Entities'))),
      h('div', { class: 'panel' },
        h('div', { class: 'empty' },
          h('p', {}, plain ? 'No clients yet.' : 'No entities yet.'),
          h('div', { class: 'toolbar', style: { justifyContent: 'center' } },
            h('button', { class: 'primary', onclick: () => navigate('#/quickstart') }, 'Start the quickstart'),
            h('button', { onclick: () => navigate('#/new') }, 'Full form'))
        )
      )
    );
  }

  const table = sortableTable(
    [
      { key: 'canonical_name', label: plain ? 'Client' : 'Entity', render: (r) => h('a', { href: `#/entities/${r.id}${plain && r.associations ? '/summary' : ''}` }, r.canonical_name) },
      { key: 'entity_type', label: 'Type', render: (r) => h('span', { class: 'chip' }, r.entity_type) },
      {
        key: 'status',
        label: 'Status',
        // The build's state, not just the entity's. A build that died and one
        // that is still running were indistinguishable from this screen, which
        // is how a failure gets read as "still working" for five minutes.
        render: (r) => buildChip(r),
        sortValue: (r) => r.last_job_status ?? r.status,
      },
      { key: 'documents', metric: 'documents', num: true, render: (r) => fmt.n(r.documents) },
      { key: 'associations', label: 'Associations', num: true, render: (r) => fmt.n(r.associations) },
      { key: 'spend', label: 'Spend', num: true, sortValue: (r) => r.spend?.costUsd ?? 0, render: (r) => `$${(r.spend?.costUsd ?? 0).toFixed(3)}` },
      { key: 'updated_at', label: 'Updated', render: (r) => fmt.date(r.updated_at) },
    ],
    entities,
    { initialSort: 'updated_at' }
  );

  // While any build is live, keep this screen honest without a manual refresh.
  // Re-rendering only on an actual status change, so the table does not reset
  // the user's chosen sort every two seconds.
  if (entities.some((e) => e.last_job_status === 'running' || e.last_job_status === 'queued')) {
    const signature = () => entities.map((e) => `${e.id}:${e.last_job_status}:${e.last_job_steps_done}`).join('|');
    let previous = signature();
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const fresh = await api('/api/entities');
        const next = fresh.entities.map((e) => `${e.id}:${e.last_job_status}:${e.last_job_steps_done}`).join('|');
        if (next !== previous) {
          previous = next;
          navigate(location.hash || '#/');
          return;
        }
      } catch { /* a failed poll is not worth surfacing; try again */ }
      timer = setTimeout(tick, 2500);
    };
    let timer = setTimeout(tick, 2500);
    onTeardown(() => { stopped = true; clearTimeout(timer); });
  }

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, plain ? 'Clients' : 'Entities'), h('div', { class: 'sub' }, `${entities.length} tracked`)),
      h('button', { class: 'primary', onclick: () => navigate(newHref) }, plain ? 'New client' : 'New entity')
    ),
    disclaimer(),
    h('div', { class: 'panel' }, h('div', { class: 'panel-body tight' }, table))
  );
}

/** §5 — entity creation with the disambiguation facts the model needs. */
export async function newEntityView() {
  const form = h('form', { class: 'panel-body' });
  const field = (name, label, hint = '', type = 'text', value = '') =>
    h('label', { class: 'field' }, label,
      h('input', { type, name, value, placeholder: hint }),
      hint ? h('span', { class: 'hint' }, hint) : null);

  const area = (name, label, hint) =>
    h('label', { class: 'field' }, label,
      h('textarea', { name, placeholder: hint }),
      h('span', { class: 'hint' }, hint));

  form.append(
    h('div', { class: 'split-2' },
      h('div', {},
        field('canonical_name', 'Entity name *', 'John Smith'),
        h('label', { class: 'field' }, 'Entity type',
          h('select', { name: 'entity_type' },
            h('option', { value: 'person' }, 'Person'),
            h('option', { value: 'organization' }, 'Organization')
          )
        ),
        area('aliases', 'Aliases', 'One per line — John A. Smith, Jonathan Smith. Middle-initial variants are generated automatically.'),
        area('known_urls', 'Known URLs', 'One per line — johnsmith.com, linkedin.com/in/…, abccapital.com/team/john-smith'),
        field('wikidata_qid', 'Wikidata ID', 'Q12345 (optional)')
      ),
      h('div', {},
        area('organizations', 'Current / former organisations', 'ABC Capital — the strongest disambiguation signal there is.'),
        area('locations', 'Locations', 'New York'),
        area('occupations', 'Occupations', 'investor, executive'),
        area('educations', 'Education', 'Harvard University'),
        area('negative_markers', 'Negative markers', 'Words that mean it is NOT them: footballer, obituary, the other firm’s name.')
      )
    ),
    h('div', { class: 'split-2' },
      h('div', {}, field('max_documents', 'Document ceiling', '4000', 'number')),
      h('div', {}, field('max_api_cost_usd', 'Cost ceiling (USD)', '25', 'number'))
    ),
    h('label', { class: 'field' },
      h('input', { type: 'checkbox', name: 'build', checked: 'checked', style: { width: 'auto', marginRight: '0.4rem' } }),
      'Start the full build immediately',
      h('span', { class: 'hint' }, 'Ingests the corpus, disambiguates, extracts associations and scores. This spends API budget.')
    ),
    h('div', { class: 'toolbar' },
      h('button', { class: 'primary', type: 'submit' }, 'Create entity'),
      h('span', { class: 'small dim' }, 'Identity markers can be added later, but disambiguation is only as good as what it is given.')
    )
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const lines = (name) => String(data.get(name) ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    button.textContent = 'Creating…';

    try {
      const payload = {
        canonical_name: String(data.get('canonical_name') ?? '').trim(),
        entity_type: data.get('entity_type'),
        aliases: lines('aliases'),
        known_urls: lines('known_urls'),
        wikidata_qid: String(data.get('wikidata_qid') ?? '').trim() || null,
        negative_markers: lines('negative_markers'),
        identity_markers: {
          organizations: lines('organizations'),
          locations: lines('locations'),
          occupations: lines('occupations'),
          educations: lines('educations'),
        },
        max_documents: data.get('max_documents') ? Number(data.get('max_documents')) : null,
        max_api_cost_usd: data.get('max_api_cost_usd') ? Number(data.get('max_api_cost_usd')) : null,
        build: data.get('build') === 'on',
      };
      if (!payload.canonical_name) throw new Error('Entity name is required');
      const res = await api('/api/entities', { method: 'POST', body: payload });
      toast(res.job ? 'Entity created — build queued' : 'Entity created', 'success');
      navigate(`#/entities/${res.entity_id}${res.job ? '/jobs' : ''}`);
    } catch (err) {
      toast(err.message, 'error');
      button.disabled = false;
      button.textContent = 'Create entity';
    }
  });

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {},
        h('h1', {}, 'New entity'),
        h('div', { class: 'sub' }, 'The disambiguation facts below decide which of the web’s many John Smiths this analysis is about.')
      )
    ),
    disclaimer(),
    h('div', { class: 'panel' }, h('h2', {}, 'Identity profile'), form)
  );
}
