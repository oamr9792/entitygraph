import { h, api, fmt, toast, navigate, sortableTable, disclaimer } from '../app.js';

/** The entity list. */
export async function portfolioView() {
  const { entities } = await api('/api/entities');

  if (!entities.length) {
    return h('div', {},
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Entities'))),
      h('div', { class: 'panel' },
        h('div', { class: 'empty' },
          h('p', {}, 'No entities yet.'),
          h('button', { class: 'primary', onclick: () => navigate('#/new') }, 'Add the first entity')
        )
      )
    );
  }

  const table = sortableTable(
    [
      { key: 'canonical_name', label: 'Entity', render: (r) => h('a', { href: `#/entities/${r.id}` }, r.canonical_name) },
      { key: 'entity_type', label: 'Type', render: (r) => h('span', { class: 'chip' }, r.entity_type) },
      { key: 'status', label: 'Status', render: (r) => h('span', { class: `chip ${r.status === 'ready' ? 'good' : r.status === 'error' ? 'bad' : 'warn'}` }, r.status) },
      { key: 'documents', label: 'Documents', num: true, render: (r) => fmt.n(r.documents) },
      { key: 'associations', label: 'Associations', num: true, render: (r) => fmt.n(r.associations) },
      { key: 'spend', label: 'Spend', num: true, sortValue: (r) => r.spend?.costUsd ?? 0, render: (r) => `$${(r.spend?.costUsd ?? 0).toFixed(3)}` },
      { key: 'updated_at', label: 'Updated', render: (r) => fmt.date(r.updated_at) },
    ],
    entities,
    { initialSort: 'updated_at' }
  );

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Entities'), h('div', { class: 'sub' }, `${entities.length} tracked`)),
      h('button', { class: 'primary', onclick: () => navigate('#/new') }, 'New entity')
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
