import { h, api, fmt, navigate, toast, onTeardown, state, clear, disclaimer } from '../app.js';
import { metricLabel } from '../lib/metrics-ui.js';

/**
 * §90 — the quickstart wizard.
 *
 * A path through endpoints the normal screens already use, never a separate
 * mode: every write here — the entity, its markers, the ceilings, the build,
 * the identity decisions — can be made and undone from the ordinary screens.
 * The step lives in the URL, so a refresh or a back button lands where it was.
 */

const STEPS = [
  ['who', 'Who is this?'],
  ['markers', 'Confirm the markers'],
  ['build', 'Build'],
  ['review', 'Same person?'],
  ['done', 'What we found'],
];

// §90 step 3 — one plain line per stage, mapped onto the pipeline's own steps.
const STAGES = [
  ['Finding pages that mention them', ['build_identity_profile', 'fetch_entity_citations', 'fetch_corpus_history', 'fetch_evidence_windows']],
  ['Checking which ones are really about them', ['entity_disambiguation']],
  ['Working out what each page associates them with', ['extract_associations', 'canonicalise_associations']],
  ['Merging pages that are copies of each other', ['detect_duplicates']],
  ['Scoring', ['calculate_document_scores', 'calculate_association_scores']],
  ['Checking what Google currently shows', ['run_serp_queries', 'generate_dashboard']],
];

const MONEY = (v) => `$${Number(v ?? 0).toFixed(2)}`;

export async function quickstartView({ params, query }) {
  if (!params.id) return whoStep();
  const step = query.get('step') ?? 'markers';
  if (step === 'markers') return markersStep(params.id);
  if (step === 'build') return buildStep(params.id);
  if (step === 'review') return reviewStep(params.id);
  navigate(`#/entities/${params.id}/summary`);
  return h('div', {});
}

function wizard(step, title, why, ...content) {
  const index = STEPS.findIndex(([key]) => key === step);
  return h('div', { class: 'wizard' },
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Quickstart'))),
    h('div', { class: 'wizard-steps', role: 'list', 'aria-label': 'Quickstart progress' },
      STEPS.map(([, label], i) => h('span', {
        role: 'listitem',
        class: i < index ? 'done' : i === index ? 'current' : '',
        'aria-current': i === index ? 'step' : null,
      }, `${i + 1}. ${label}`))),
    disclaimer(),
    h('div', { class: 'panel' },
      h('h2', {}, title),
      h('div', { class: 'panel-body' }, h('p', { class: 'wizard-why' }, why), ...content)));
}

const field = (label, input, hint = null) =>
  h('label', { class: 'field' }, label, input, hint ? h('span', { class: 'hint' }, hint) : null);

function errorBox() {
  const box = h('div', { class: 'form-error', role: 'alert' });
  box.hidden = true;
  return {
    el: box,
    show: (message) => { box.textContent = message; box.hidden = false; },
    hide: () => { box.hidden = true; },
  };
}

// --- Step 1 -----------------------------------------------------------------

function whoStep() {
  const name = h('input', { type: 'text', required: 'required', placeholder: 'Jane Smith', autocomplete: 'off' });
  const type = h('select', {},
    h('option', { value: 'person' }, 'A person'),
    h('option', { value: 'organization' }, 'An organisation'));
  const organisation = h('input', { type: 'text', placeholder: 'Harbour Capital' });
  const city = h('input', { type: 'text', placeholder: 'London' });
  const title = h('input', { type: 'text', placeholder: 'Managing partner' });
  const registration = h('input', { type: 'text', placeholder: 'Bar number, company number, licence' });
  const error = errorBox();
  const submit = h('button', { class: 'primary', type: 'submit' }, 'Continue');

  const form = h('form', {},
    field('Name, as it is written', name),
    field('This is', type),
    h('p', { class: 'small muted', style: { margin: '1rem 0 0.4rem' } }, 'At least one of these:'),
    h('div', { class: 'split-2' },
      h('div', {}, field('Current organisation', organisation), field('City', city)),
      h('div', {}, field('Job title', title), field('Registration number', registration))),
    error.el,
    h('div', { class: 'actions' }, submit));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hide();
    const clean = (input) => input.value.trim();
    if (!clean(name)) return error.show('A name is required.');
    const markers = {
      organizations: clean(organisation) ? [clean(organisation)] : [],
      locations: clean(city) ? [clean(city)] : [],
      occupations: clean(title) ? [clean(title)] : [],
    };
    if (!markers.organizations.length && !markers.locations.length && !markers.occupations.length && !clean(registration)) {
      return error.show('Add at least one marker. Without one, we will collect the wrong person’s coverage.');
    }

    submit.disabled = true;
    submit.textContent = 'Saving…';
    try {
      const created = await api('/api/entities', {
        method: 'POST',
        body: { canonical_name: clean(name), entity_type: type.value, identity_markers: markers, build: false },
      });
      if (clean(registration)) {
        await api(`/api/entities/${created.entity_id}/markers`, {
          method: 'POST',
          body: { kind: 'other', value: clean(registration) },
        });
      }
      navigate(`#/quickstart/${created.entity_id}?step=markers`);
    } catch (err) {
      error.show(err.message);
      submit.disabled = false;
      submit.textContent = 'Continue';
    }
  });

  setTimeout(() => name.focus(), 0);
  return wizard('who', 'Who is this?',
    'Markers are how we tell your client apart from everyone with the same name. Without at least one, we will collect the wrong person’s coverage.',
    form);
}

// --- Step 2 -----------------------------------------------------------------

async function markersStep(id) {
  const data = await api(`/api/entities/${id}`);
  let markers = data.profile?.markers ?? [];
  const list = h('div', {});
  const error = errorBox();
  const next = h('button', { class: 'primary', type: 'button', onclick: () => navigate(`#/quickstart/${id}?step=build`) }, 'Looks right');

  const refresh = async () => {
    const fresh = await api(`/api/entities/${id}`);
    markers = fresh.profile?.markers ?? [];
    paint();
  };

  const remove = async (marker) => {
    try {
      await api(`/api/entities/${id}/markers/${marker.id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  };

  const paint = () => {
    const confirming = markers.filter((m) => m.polarity !== -1 && m.kind !== 'url');
    clear(list).append(
      markers.length
        ? h('table', {}, h('tbody', {}, markers.map((m) => h('tr', {},
            h('td', {}, h('span', { class: `chip ${m.polarity === -1 ? 'bad' : ''}`.trim() }, m.polarity === -1 ? `rules out · ${m.kind}` : m.kind)),
            h('td', {}, m.value),
            h('td', { class: 'num' }, h('button', { class: 'small danger', type: 'button', onclick: () => remove(m) }, 'Remove'))))))
        : null,
      confirming.length ? null : h('p', { class: 'form-error' }, 'No markers yet. Add at least one before building.'));
    next.disabled = !confirming.length;
  };

  const kind = h('select', { style: { width: '10rem' } },
    ['organization', 'location', 'occupation', 'education', 'person', 'other'].map((k) => h('option', { value: k }, k)));
  const value = h('input', { type: 'text', placeholder: 'Add a marker' });
  const polarity = h('select', { style: { width: '9rem' } },
    h('option', { value: '1' }, 'confirms'),
    h('option', { value: '-1' }, 'rules out'));
  const add = async () => {
    error.hide();
    if (!value.value.trim()) return;
    try {
      await api(`/api/entities/${id}/markers`, {
        method: 'POST',
        body: { kind: kind.value, value: value.value.trim(), polarity: Number(polarity.value) },
      });
      value.value = '';
      await refresh();
    } catch (err) { error.show(err.message); }
  };
  value.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });

  paint();
  const aliases = data.profile?.aliases ?? [];
  return wizard('markers', 'Confirm the markers',
    'A document has to match at least one of these, or be confirmed by the identity check, to count. Everything else gets thrown out.',
    aliases.length ? h('p', { class: 'small muted' }, `Also searched as: ${aliases.join(', ')}`) : null,
    list,
    h('div', { class: 'toolbar', style: { marginTop: '0.8rem' } }, kind, value, polarity,
      h('button', { type: 'button', onclick: add }, 'Add')),
    h('p', { class: 'small dim' }, '“Rules out” is for words that mean it is someone else — a sport, another company, “obituary”.'),
    error.el,
    h('div', { class: 'actions' },
      h('button', { type: 'button', onclick: () => navigate(`#/entities/${id}/identity`) }, 'Open the full identity screen'),
      next));
}

// --- Step 3 -----------------------------------------------------------------

async function buildStep(id) {
  const [data, jobs] = await Promise.all([api(`/api/entities/${id}`), api(`/api/jobs?entity_id=${id}&limit=1`)]);
  const limits = state.settings?.limits ?? { maxDocuments: 4000, maxApiCostUsd: 25 };
  let entity = data.entity;
  let job = jobs.jobs?.[0] ?? null;
  const body = h('div', {});
  let timer = null;
  let stopped = false;
  onTeardown(() => { stopped = true; clearTimeout(timer); });

  const ceiling = () => Number(entity.max_api_cost_usd ?? limits.maxApiCostUsd);
  const live = (j) => j && (j.status === 'running' || j.status === 'queued');

  const stageStatus = (j, steps) => {
    const progress = new Map((j?.progress ?? []).filter((p) => p.step).map((p) => [p.step, p.status]));
    const statuses = steps.map((s) => progress.get(s));
    if (statuses.every((s) => s === 'done' || s === 'skipped')) return 'done';
    if (statuses.some((s) => s === 'running' || s === 'done' || s === 'skipped')) return live(j) ? 'running' : 'pending';
    return 'pending';
  };

  const poll = async () => {
    if (stopped) return;
    try {
      const [fresh, jobList] = await Promise.all([api(`/api/entities/${id}`), api(`/api/jobs?entity_id=${id}&limit=1`)]);
      entity = fresh.entity;
      job = jobList.jobs?.[0] ?? null;
      paintProgress(fresh.spend?.costUsd ?? 0);
      if (live(job)) timer = setTimeout(poll, 2000);
    } catch {
      if (!stopped) timer = setTimeout(poll, 6000);
    }
  };

  const start = async (options = {}) => {
    try {
      await api(`/api/entities/${id}`, {
        method: 'PATCH',
        body: { max_documents: Number(docsInput.value) || null, max_api_cost_usd: Number(costInput.value) || null },
      });
      await api(`/api/entities/${id}/build`, { method: 'POST', body: { options } });
      poll();
    } catch (err) { toast(err.message, 'error'); }
  };

  const docsInput = h('input', { type: 'number', min: '50', step: '50', value: String(entity.max_documents ?? 400), style: { width: '9rem' } });
  const costInput = h('input', { type: 'number', min: '1', step: '1', value: String(entity.max_api_cost_usd ?? 10), style: { width: '9rem' } });

  const paintIdle = () => {
    const costLine = h('p', { class: 'cost-line' });
    const update = () => {
      costLine.textContent = `Nothing is spent until you press Start. This build stops at ${MONEY(costInput.value)}, however much is left to read.`;
    };
    costInput.addEventListener('input', update);
    update();
    clear(body).append(
      h('div', { class: 'ceiling-row' },
        h('label', {}, 'Pages to collect, at most', docsInput),
        h('label', {}, 'Spend, at most (USD)', costInput)),
      costLine,
      h('p', { class: 'small dim' }, 'A few hundred pages is enough to see whether we have the right person. You can build again with a larger ceiling afterwards.'),
      h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'button', onclick: () => start() }, 'Start')));
  };

  const paintProgress = (spend) => {
    const done = job?.status === 'done';
    const failed = job?.status === 'failed';
    const cancelled = job?.status === 'cancelled';

    const stages = h('ul', { class: 'plain-steps' }, STAGES.map(([label, steps]) => {
      const status = stageStatus(job, steps);
      return h('li', { class: status },
        h('span', { class: 'mark', 'aria-hidden': 'true' }, status === 'done' ? '✓' : status === 'running' ? '…' : '·'),
        h('span', {}, label));
    }));

    const actions = h('div', { class: 'actions' });
    if (live(job)) {
      actions.append(h('button', {
        class: 'danger', type: 'button',
        onclick: async () => {
          try { await api(`/api/jobs/${job.id}/cancel`, { method: 'POST' }); toast('Stopping after the current step', 'success'); }
          catch (err) { toast(err.message, 'error'); }
        },
      }, 'Stop'));
    } else if (done) {
      actions.append(
        h('button', { type: 'button', onclick: () => paintIdle() }, 'Build again'),
        h('button', { class: 'primary', type: 'button', onclick: () => navigate(`#/quickstart/${id}?step=review`) }, 'Next'));
    } else {
      actions.append(h('button', { class: 'primary', type: 'button', onclick: () => paintIdle() }, failed ? 'Try again' : 'Start again'));
    }

    clear(body).append(
      stages,
      h('p', { class: 'cost-line' }, `${MONEY(spend)} spent of the ${MONEY(ceiling())} ceiling`),
      failed ? h('p', { class: 'form-error' }, job.error ?? 'The build failed.') : null,
      cancelled ? h('p', { class: 'small muted' }, 'Stopped. Everything already collected was kept.') : null,
      actions);
  };

  if (job && (live(job) || job.status === 'done' || job.status === 'failed' || job.status === 'cancelled')) {
    paintProgress(data.spend?.costUsd ?? 0);
    if (live(job)) poll();
  } else {
    paintIdle();
  }

  return wizard('build', 'Build',
    'We collect pages that mention them, keep the ones really about them, and score what those pages link them to.',
    body);
}

// --- Step 4 -----------------------------------------------------------------

function highlight(text, names) {
  const escaped = [...new Set(names)]
    .filter((n) => n && n.length > 2)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length);
  if (!escaped.length || !text) return [text ?? ''];
  // A capturing split puts the matched names at the odd indices.
  return String(text).split(new RegExp(`(${escaped.join('|')})`, 'gi'))
    .map((part, i) => (i % 2 === 1 ? h('mark', {}, part) : part));
}

async function reviewStep(id) {
  const [data, queue] = await Promise.all([
    api(`/api/entities/${id}`),
    api(`/api/entities/${id}/review-queue?limit=200`),
  ]);
  const names = [data.profile?.canonical_name, ...(data.profile?.aliases ?? [])];
  const items = queue.queue ?? [];
  const body = h('div', {});
  let index = 0;
  let confirmed = 0;
  let rejected = 0;

  const toSummary = () => navigate(`#/entities/${id}/summary`);

  const finish = () => {
    if (!confirmed) return toSummary();
    // Honest about what an answer does. A rejection stops a page counting at
    // once. A confirmation cannot add evidence until the page is read, and
    // pages in this band were not read by the first build.
    clear(body).append(
      h('p', {}, `You confirmed ${confirmed} ${confirmed === 1 ? 'page' : 'pages'} and ruled out ${rejected}.`),
      h('p', { class: 'small muted' },
        'Pages you ruled out have already stopped counting. Pages you confirmed were not read in the first build, so they count once a build reads them. Reading them re-reads every accepted page, so it costs about what the first build’s reading step did.'),
      h('div', { class: 'actions' },
        h('button', { type: 'button', onclick: toSummary }, 'Skip that — show the summary'),
        h('button', {
          class: 'primary', type: 'button',
          onclick: async () => {
            try {
              await api(`/api/entities/${id}/build`, {
                method: 'POST',
                body: { options: { skip: ['fetch_entity_citations', 'fetch_corpus_history', 'fetch_evidence_windows', 'entity_disambiguation'] } },
              });
              navigate(`#/quickstart/${id}?step=build`);
            } catch (err) { toast(err.message, 'error'); }
          },
        }, 'Read the confirmed pages')));
  };

  const decide = async (item, isThem, buttons) => {
    buttons.forEach((b) => { b.disabled = true; });
    try {
      await api('/api/review', {
        method: 'POST',
        body: { entity_id: Number(id), action: isThem ? 'right_entity' : 'wrong_entity', document_id: item.document_id },
      });
      if (isThem) confirmed += 1; else rejected += 1;
      index += 1;
      paint();
    } catch (err) {
      toast(err.message, 'error');
      buttons.forEach((b) => { b.disabled = false; });
    }
  };

  const paint = () => {
    if (index >= items.length) return finish();
    const item = items[index];
    const yes = h('button', { class: 'primary', type: 'button' }, 'This is them');
    const no = h('button', { class: 'danger', type: 'button' }, 'This is someone else');
    yes.addEventListener('click', () => decide(item, true, [yes, no]));
    no.addEventListener('click', () => decide(item, false, [yes, no]));

    clear(body).append(
      h('div', { class: 'toolbar' },
        h('strong', {}, `${index + 1} of ${items.length}`),
        h('span', { class: 'spacer' }),
        h('span', { class: 'small muted' }, metricLabel('entity_confidence'), ` ${Math.round(Number(item.entity_confidence) * 100)}%`)),
      h('div', { style: { margin: '0.6rem 0 0.4rem', fontWeight: 600 } }, highlight(item.title ?? '(untitled)', names)),
      h('div', { class: 'small dim', style: { marginBottom: '0.5rem' } },
        h('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer' }, item.root_domain ?? item.url),
        item.published_at || item.group_date ? ` · ${fmt.date(item.published_at ?? item.group_date)}` : ''),
      h('div', { class: 'passage' }, highlight((item.snippet ?? '').slice(0, 900), names)),
      h('div', { class: 'actions' },
        h('button', { class: 'ghost', type: 'button', onclick: () => finish() }, 'Skip to the end'),
        no, yes));
    setTimeout(() => yes.focus(), 0);
  };

  if (!items.length) {
    clear(body).append(
      h('p', {}, 'Nothing to check. Every page was either clearly about them or clearly not.'),
      h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'button', onclick: toSummary }, 'Show what we found')));
  } else {
    paint();
  }

  return wizard('review', 'Same person?',
    'We are unsure about these. Your answer changes the scores, so it is worth five minutes.',
    body);
}
