import { h, api, fmt, disclaimer, toast, navigate, sortableTable, state, clear } from '../app.js';

/** §74 — the manual review queue for the 0.40–0.69 confidence band. */
export async function reviewView({ params }) {
  const data = await api(`/api/entities/${params.id}/review-queue?limit=100`);
  const reviews = await api(`/api/entities/${params.id}/reviews`);

  const decide = async (documentId, verdict) => {
    try {
      await api('/api/review', {
        method: 'POST',
        body: { entity_id: Number(params.id), action: verdict === 'accept' ? 'right_entity' : 'wrong_entity', document_id: documentId },
      });
      toast(verdict === 'accept' ? 'Accepted — scores updated' : 'Rejected — scores updated', 'success');
      location.reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const rows = data.queue.map((r) => h('div', { class: 'panel' },
    h('div', { class: 'panel-body' },
      h('div', { class: 'toolbar' },
        h('span', { class: 'chip warn' }, `confidence ${r.entity_confidence}`),
        h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.root_domain),
        h('span', { class: 'small dim' }, fmt.date(r.published_at ?? r.group_date)),
        h('span', { class: 'spacer' }),
        h('button', { class: 'small', onclick: () => decide(r.document_id, 'accept') }, 'Right person'),
        h('button', { class: 'small danger', onclick: () => decide(r.document_id, 'reject') }, 'Wrong person')
      ),
      h('div', { style: { fontWeight: 600, marginBottom: '0.3rem' } }, r.title ?? '(untitled)'),
      h('div', { class: 'evidence-text', style: { maxWidth: 'none' } }, (r.snippet ?? '').slice(0, 400)),
      h('div', { class: 'small dim', style: { marginTop: '0.4rem' } },
        'Signals: ',
        (Array.isArray(r.reasons) ? r.reasons : []).map((x) =>
          h('span', { class: 'chip', style: { marginRight: '0.25rem' } },
            `${x.kind}${x.value ? `: ${String(x.value).slice(0, 40)}` : ''}${x.contribution !== undefined ? ` ${x.contribution > 0 ? '+' : ''}${x.contribution}` : ''}`))
      )
    )
  ));

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {},
        h('h1', {}, 'Review queue'),
        h('div', { class: 'sub' },
          `Documents scoring between ${data.thresholds.review} and ${data.thresholds.accept} for identity. They contribute nothing to any score until a human decides (§8).`)
      )
    ),
    disclaimer(),
    data.queue.length ? rows : h('div', { class: 'panel' }, h('div', { class: 'empty' }, 'Nothing awaiting review.')),
    reviews.reviews?.length
      ? h('div', { class: 'panel' },
          h('h2', {}, 'Correction history'),
          h('div', { class: 'panel-body tight' },
            h('table', {}, h('tbody', {}, reviews.reviews.slice(0, 40).map((r) => h('tr', {},
              h('td', { class: 'small dim' }, fmt.date(r.created_at)),
              h('td', {}, h('span', { class: 'chip' }, r.action.replace(/_/g, ' '))),
              h('td', { class: 'small muted' }, `${r.target_kind} #${r.target_id}`),
              h('td', { class: 'small dim' }, r.reviewer)
            ))))
          )
        )
      : null
  );
}

/**
 * §9 — paired search probes.
 *
 * The name-only corpus search returns the provider's top-relevance slice,
 * ordered by something that has nothing to do with what is being investigated.
 * A subject that matters can sit in hundreds of indexed documents and never
 * appear in it — on the entity this was built for, 750 documents paired the
 * name with a controversy and the name search surfaced one of them.
 *
 * So an analyst can name the subjects they already know exist. Each becomes
 * its own filtered query on the next build.
 */
function probeTermsPanel(entityId, entity) {
  let terms = [];
  try { terms = JSON.parse(entity?.probe_terms ?? '[]'); } catch { terms = []; }

  const list = h('div', { class: 'probe-list' });
  const input = h('input', { type: 'text', placeholder: 'Epstein', style: { width: '14rem' } });

  const save = async (next) => {
    try {
      await api(`/api/entities/${entityId}`, { method: 'PATCH', body: { probe_terms: next } });
      terms = next;
      paint();
      toast('Saved — takes effect on the next build', 'success');
    } catch (err) { toast(err.message, 'error'); }
  };

  const paint = () => {
    clear(list).append(
      ...(terms.length
        ? terms.map((t) =>
            h('span', { class: 'chip probe' }, t,
              h('button', {
                class: 'chip-x',
                title: 'Remove',
                onclick: () => save(terms.filter((x) => x !== t)),
              }, '×'))
          )
        : [h('span', { class: 'small dim' }, 'None. The corpus is searched by name alone.')])
    );
  };
  paint();

  const add = () => {
    const value = input.value.trim();
    if (!value || terms.includes(value)) return;
    input.value = '';
    save([...terms, value]);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });

  return h('div', { class: 'panel' },
    h('h2', {}, 'Paired search probes', h('span', { class: 'small dim' }, 'applied on the next build')),
    h('div', { class: 'panel-body' },
      h('p', { class: 'small muted', style: { marginTop: 0 } },
        'Searching the name alone returns whatever the provider ranks highest for it, which is often not the coverage that matters. Name a subject here and it gets its own query — documents mentioning both the entity and that term, regardless of where they sit in the default ordering.'),
      list,
      h('div', { class: 'toolbar', style: { marginTop: '0.7rem' } },
        input,
        h('button', { onclick: add }, 'Add probe')
      )
    )
  );
}

/** §7 — the identity profile, editable, because §6 depends on it. */
export async function identityView({ params }) {
  const data = await api(`/api/entities/${params.id}`);
  const { profile, search_queries: queries } = data;

  const addMarker = async (kind, value, polarity = 1) => {
    try {
      await api(`/api/entities/${params.id}/markers`, { method: 'POST', body: { kind, value, polarity } });
      toast('Marker added — rebuild or rescore to apply it', 'success');
      location.reload();
    } catch (err) { toast(err.message, 'error'); }
  };

  const removeMarker = async (markerId) => {
    try {
      await api(`/api/entities/${params.id}/markers/${markerId}`, { method: 'DELETE' });
      toast('Marker removed', 'success');
      location.reload();
    } catch (err) { toast(err.message, 'error'); }
  };

  const kindSelect = h('select', { style: { width: '10rem' } },
    ['organization', 'location', 'occupation', 'education', 'person', 'url', 'other'].map((k) => h('option', { value: k }, k)));
  const valueInput = h('input', { type: 'text', placeholder: 'ABC Capital', style: { width: '16rem' } });
  const polaritySelect = h('select', { style: { width: '9rem' } },
    h('option', { value: '1' }, 'confirms'), h('option', { value: '-1' }, 'rules out'));

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, `${profile.canonical_name} — identity profile`),
        h('div', { class: 'sub' }, 'Association scoring on the wrong entity is worse than no scoring. These facts decide which documents count.'))
    ),
    disclaimer(),
    h('div', { class: 'split-2' },
      h('div', { class: 'panel' },
        h('h2', {}, 'Identity markers'),
        h('div', { class: 'panel-body tight' },
          h('table', {}, h('tbody', {}, profile.markers.map((m) => h('tr', {},
            h('td', {}, h('span', { class: `chip ${m.polarity === -1 ? 'bad' : ''}` }, m.kind)),
            h('td', {}, m.value),
            h('td', { class: 'num dim small' }, `weight ${m.weight}`),
            h('td', { class: 'num' }, h('button', { class: 'small danger', onclick: () => removeMarker(m.id) }, 'remove'))
          )))),
          h('div', { class: 'toolbar', style: { padding: '0.7rem' } },
            kindSelect, valueInput, polaritySelect,
            h('button', {
              onclick: () => valueInput.value.trim() && addMarker(kindSelect.value, valueInput.value.trim(), Number(polaritySelect.value)),
            }, 'Add')
          )
        )
      ),
      probeTermsPanel(params.id, data.entity),
      h('div', { class: 'panel' },
        h('h2', {}, 'Names searched (§10)'),
        h('div', { class: 'panel-body' },
          h('p', { class: 'small muted' }, 'Every alias is queried as an exact phrase and the results merged; duplicate URLs are counted once.'),
          queries.map((q) => h('div', { class: 'mono small', style: { padding: '0.1rem 0' } }, `"${q}"`)),
          h('p', { class: 'small dim', style: { marginTop: '0.8rem', marginBottom: 0 } },
            `Type: ${profile.entity_type}${profile.wikidata_qid ? ` · Wikidata ${profile.wikidata_qid}` : ''}`)
        )
      )
    )
  );
}

/** Job progress and the §66 cost ledger. */
export async function jobsView({ params }) {
  const defaults = state.settings?.limits ?? { maxDocuments: 4000, maxApiCostUsd: 25 };
  const [entity, jobs, usage] = await Promise.all([
    api(`/api/entities/${params.id}`),
    api(`/api/jobs?entity_id=${params.id}`),
    api(`/api/usage?entity_id=${params.id}`),
  ]);

  /**
   * §66 — the ceilings, editable here rather than only at entity creation.
   * This is the screen where someone decides to spend money, so it is the
   * screen that has to let them decide how much. Saved before the build is
   * queued, because the pipeline reads them off the entity when it starts.
   */
  const ceilingInput = (name, value, placeholder) =>
    h('input', { type: 'number', name, value: value ?? '', placeholder, min: '1', class: 'ceiling' });

  const docsField = ceilingInput('max_documents', entity.entity?.max_documents, String(defaults.maxDocuments));
  const costField = ceilingInput('max_api_cost_usd', entity.entity?.max_api_cost_usd, String(defaults.maxApiCostUsd));

  const saveCeilings = async () => {
    const body = {
      max_documents: docsField.value ? Number(docsField.value) : null,
      max_api_cost_usd: costField.value ? Number(costField.value) : null,
    };
    await api(`/api/entities/${params.id}`, { method: 'PATCH', body });
    return body;
  };

  const build = async (options) => {
    try {
      const ceilings = await saveCeilings();
      await api(`/api/entities/${params.id}/build`, { method: 'POST', body: { options } });
      toast(`Build queued · ceiling ${ceilings.max_documents ?? defaults.maxDocuments} documents`, 'success');
      navigate(`#/entities/${params.id}`);
    } catch (err) { toast(err.message, 'error'); }
  };

  const settingsPanel = h('div', { class: 'panel' },
    h('h2', {}, 'Build ceilings'),
    h('div', { class: 'panel-body' },
      h('p', { class: 'small dim', style: { marginTop: 0 } },
        'Checked before every provider call, so a build stops rather than overruns. Leave blank to use the system default. A first build on a common name is worth running small — the disambiguation is easier to judge on 400 documents than on 4,000.'),
      h('div', { class: 'ceiling-row' },
        h('label', {}, 'Documents', docsField),
        h('label', {}, 'Cost (USD)', costField),
        h('button', {
          class: 'small',
          onclick: async () => {
            try { await saveCeilings(); toast('Ceilings saved', 'success'); }
            catch (err) { toast(err.message, 'error'); }
          },
        }, 'Save')
      )
    )
  );

  const rescore = async () => {
    try {
      const res = await api(`/api/entities/${params.id}/rescore`, { method: 'POST', body: {} });
      toast(`Rescored ${res.rescored} evidence rows`, 'success');
      navigate(`#/entities/${params.id}`);
    } catch (err) { toast(err.message, 'error'); }
  };

  const jobPanels = jobs.jobs.map((job) => h('div', { class: 'panel' },
    h('h2', {},
      `Job #${job.id} · ${job.kind}`,
      h('span', { class: `chip ${job.status === 'done' ? 'good' : job.status === 'failed' ? 'bad' : 'warn'}` }, job.status)
    ),
    h('div', { class: 'panel-body' },
      h('div', { class: 'small dim', style: { marginBottom: '0.5rem' } },
        `${fmt.date(job.created_at)} · ${job.steps_done}/${job.steps_total} steps · $${(job.cost_usd ?? 0).toFixed(4)}`),
      job.error ? h('p', { class: 'sentiment negative' }, job.error) : null,
      h('div', { class: 'progress' }, (job.progress ?? []).filter((p) => p.step).map((p) =>
        h('div', { class: `step ${p.status}` },
          h('span', { class: 'mark' }, p.status === 'done' ? '✓' : p.status === 'skipped' ? '–' : '…'),
          h('span', { style: { minWidth: '15rem' } }, p.step),
          h('span', { class: 'detail' }, p.detail ?? '')
        )
      )),
      job.status === 'running' || job.status === 'queued'
        ? h('button', { class: 'small danger', style: { marginTop: '0.6rem' },
            onclick: async () => { await api(`/api/jobs/${job.id}/cancel`, { method: 'POST' }); location.reload(); } }, 'Cancel')
        : null
    )
  ));

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Jobs & cost'),
        h('div', { class: 'sub' }, `Spend on this entity so far: $${(entity.spend?.costUsd ?? 0).toFixed(4)} · ${fmt.n(entity.spend?.tokens)} LLM tokens`)),
      h('div', { class: 'toolbar' },
        h('button', { onclick: rescore, title: 'Recompute scores from stored evidence. No provider calls, no cost.' }, 'Rescore only'),
        h('button', { onclick: () => build({ skipSerp: true }) }, 'Rebuild (no SERP)'),
        h('button', { class: 'primary', onclick: () => build({}) }, 'Full rebuild')
      )
    ),
    disclaimer(),
    settingsPanel,
    usage.by_provider?.length
      ? h('div', { class: 'panel' },
          h('h2', {}, 'API usage (§66)'),
          h('div', { class: 'panel-body tight' },
            sortableTable([
              { key: 'provider', label: 'Provider' },
              { key: 'endpoint', label: 'Endpoint' },
              { key: 'calls', label: 'Calls', num: true },
              { key: 'cached', label: 'Cached', num: true },
              { key: 'tokens_in', label: 'Tokens in', num: true, render: (r) => fmt.n(r.tokens_in) },
              { key: 'tokens_out', label: 'Tokens out', num: true, render: (r) => fmt.n(r.tokens_out) },
              { key: 'failures', label: 'Failures', num: true },
              { key: 'cost_usd', label: 'Cost', num: true, render: (r) => `$${(r.cost_usd ?? 0).toFixed(4)}` },
            ], usage.by_provider, { initialSort: 'cost_usd' })
          )
        )
      : null,
    // A failure count in the usage table tells you something went wrong and
    // nothing about what. The provider's own error message is the one thing
    // that turns "104 failures" into an action, so it goes on the screen
    // rather than staying in a column nobody can read.
    usage.recent_failures?.length
      ? h('div', { class: 'panel' },
          h('h2', {}, 'Recent provider failures',
            h('span', { class: 'chip bad' }, String(usage.recent_failures.length))),
          h('div', { class: 'panel-body' },
            h('p', { class: 'small dim', style: { marginTop: 0 } },
              'What the provider actually said. A run where every call to one provider fails usually means a key that is missing, mistyped or revoked — the corpus is still charged for, so it is worth fixing before rebuilding.'),
            h('table', {}, h('tbody', {}, usage.recent_failures.map((f) => h('tr', {},
              h('td', { class: 'small dim', style: { whiteSpace: 'nowrap' } }, fmt.date(f.created_at)),
              h('td', {}, h('span', { class: 'chip' }, f.provider)),
              h('td', { class: 'small mono dim' }, f.endpoint),
              h('td', { class: 'small sentiment negative' }, f.detail ?? '(no detail recorded)')
            ))))
          )
        )
      : null,
    jobs.jobs.length ? jobPanels : h('div', { class: 'panel' }, h('div', { class: 'empty' }, 'No jobs yet.'))
  );
}
