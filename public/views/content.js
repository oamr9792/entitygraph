import { h, api, fmt, navigate, toast, disclaimer, sortableTable } from '../app.js';
import { DISCLAIMERS, scoreWithBasis, bandChip, bandNote } from '../lib/metrics-ui.js';

/**
 * The content builder screens: the builder for one association, a draft, and
 * the list of drafts for a client.
 */

// Notes survive re-renders while someone changes format or topics.
const notesDraft = new Map();

const STATUS_CLASS = { draft: 'warn', approved: 'good', published: 'good', archived: '' };

function factList(facts) {
  if (!facts?.length) return h('p', { class: 'small dim' }, 'No facts yet.');
  return h('div', { class: 'facts' }, facts.map((f) => h('div', { class: 'fact', id: `fact-${f.id}` },
    h('span', { class: `chip fact-id ${f.source}` }, f.id),
    h('div', {},
      f.source === 'evidence' || f.source === 'page'
        ? h('div', { class: 'small dim' },
            f.source === 'page' ? 'Page to analyse · ' : f.association ? `${f.association} · ` : '',
            f.google_rank ? `#${f.google_rank} on Google · ` : '',
            h('a', { href: f.url, target: '_blank', rel: 'noopener noreferrer' }, f.domain ?? f.url),
            f.source === 'page' ? '' : ` · ${fmt.date(f.date)}`)
        : h('div', { class: 'small dim' }, f.source === 'notes' ? 'Your notes' : 'Identity profile'),
      h('blockquote', {}, f.passage)))));
}

function placementPanel(p, avoid) {
  if (!p) return null;
  return h('div', { class: 'panel' },
    h('h2', {}, 'Placement'),
    h('div', { class: 'panel-body' },
      h('p', { style: { marginTop: 0 } }, h('strong', {}, 'Where: '), p.where),
      p.displacement?.additional_documents_required !== undefined
        ? h('p', {}, `The plan estimates about ${fmt.n(p.displacement.additional_documents_required)} new pages about the client, on sites not already covering them, to bring this association from ${fmt.pct(p.displacement.current_share, 1)} to ${fmt.pct(p.displacement.target_share, 1)} of recent coverage.`)
        : p.displacement?.reason ? h('p', { class: 'small muted' }, p.displacement.reason) : null,
      h('p', { class: 'small muted' }, p.rule),
      avoid?.length
        ? h('div', { style: { margin: '0.6rem 0' } },
            h('div', { class: 'small muted' }, 'Keep out of the text:'),
            avoid.map((a) => h('span', { class: `chip ${a.severity === 'block' ? 'bad' : 'warn'}`, title: a.reason, style: { marginRight: '0.3rem' } }, a.term)))
        : null,
      p.domains_in_corpus?.length
        ? h('details', {},
            h('summary', { class: 'small' }, `Sites already in the corpus (${p.domains_in_corpus.length}) — a new piece counts for less on these`),
            h('div', { style: { marginTop: '0.4rem' } },
              p.domains_in_corpus.map((d) => h('span', { class: 'chip', style: { marginRight: '0.3rem' } }, `${d.domain} · ${d.documents}`))))
        : null,
      p.first_page?.length
        ? h('details', {},
            h('summary', { class: 'small' }, `Google’s first page for the name (${fmt.date(p.first_page_captured_at)})`),
            h('ol', { class: 'small' }, p.first_page.map((r) => h('li', {},
              h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.domain), ` — ${r.title ?? ''}`))))
        : null));
}

// --- Builder ----------------------------------------------------------------

export async function contentBuilderView({ params, query }) {
  const qs = new URLSearchParams();
  for (const key of ['format', 'grow', 'document', 'purpose', 'source', 'relation']) if (query.get(key)) qs.set(key, query.get(key));
  const brief = await api(`/api/associations/${params.id}/content-brief?${qs}`);

  if (brief.unavailable) {
    return h('div', {},
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Content builder'))),
      h('div', { class: 'panel' }, h('div', { class: 'panel-body' },
        h('p', {}, brief.headline), brief.detail ? h('p', { class: 'small dim' }, brief.detail) : null)));
  }

  const go = (changes) => {
    const next = new URLSearchParams(qs);
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    navigate(`#/associations/${params.id}/content?${next}`);
  };

  // The purpose is always chosen, never guessed. Coverage tone is too noisy to
  // decide it: an association someone badly wants gone can read "mixed/neutral",
  // and defaulting that to "strengthen" would write more of it.
  if (!query.get('purpose')) {
    const label = brief.association.label;
    const choice = (purpose, title, text) => h('button', {
      type: 'button',
      class: 'format-card',
      onclick: () => go({ purpose }),
    }, h('span', { class: 'format-name' }, title), h('span', { class: 'small muted' }, text));
    return h('div', {},
      h('div', { class: 'page-head' },
        h('div', {},
          h('h1', {}, 'Content builder'),
          h('div', { class: 'sub' }, `“${label}” for ${brief.entity.canonical_name}`)),
        h('div', { class: 'toolbar' },
          h('button', { onclick: () => navigate(`#/associations/${params.id}/plan`) }, 'Action plan'),
          h('button', { onclick: () => navigate(`#/entities/${brief.entity.id}/content`) }, 'All drafts'))),
      disclaimer(brief.disclaimer),
      h('div', { class: 'panel' },
        h('h2', {}, 'What should this content do?'),
        h('div', { class: 'panel-body' },
          h('div', { class: 'format-grid' },
            choice('strengthen', `Strengthen “${label}”`,
              'Write more that states this relationship directly, beside the client’s name.'),
            choice('displace', `Displace “${label}”`,
              'Write about other true things and never name it, so it becomes a smaller share of what is said about the client.')),
          h('p', { class: 'small dim', style: { marginBottom: 0 } },
            `In the coverage this association reads ${brief.association.sentiment?.label ?? 'neutral'}. Its action plan: `,
            brief.plan.routes.length ? brief.plan.routes.map((r) => r.title).join('; ') : 'no route applies',
            '. ',
            h('a', { href: `#/associations/${params.id}/plan` }, 'Open the plan')))));
  }

  const format = brief.formats.find((f) => f.key === brief.format);
  const correcting = brief.mode === 'correct';

  const notices = brief.strategy.notices.map((n) => h('div', { class: `weak ${n.level === 'block' ? 'bad' : ''}`.trim() },
    h('span', { class: 'weak-tag' }, n.level === 'block' ? 'Stop' : 'Note'),
    h('span', {}, n.text, n.association_id
      ? h('span', {}, ' ', h('a', { href: `#/associations/${n.association_id}/plan` }, 'Open that plan'))
      : null)));

  const reasonsPanel = h('div', { class: 'panel' },
    h('h2', {}, '1. What the plan calls for'),
    h('div', { class: 'panel-body' },
      brief.strategy.reasons.length
        ? brief.strategy.reasons.map((r) => h('div', { class: 'route', style: { marginBottom: '0.6rem' } },
            h('strong', {}, r.title),
            h('p', { class: 'route-why' }, r.why)))
        : h('p', { class: 'small muted', style: { margin: 0 } },
            'The plan has no route that content serves directly. Content can still add what else is true about the client; weigh that against the plan before spending on it.')));

  const formatPanel = h('div', { class: 'panel' },
    h('h2', {}, '2. Format'),
    h('div', { class: 'panel-body' },
      h('div', { class: 'format-grid' }, brief.formats.map((f) => h('button', {
        type: 'button',
        class: `format-card ${f.key === brief.format ? 'active' : ''}`,
        'aria-pressed': f.key === brief.format ? 'true' : 'false',
        onclick: () => go({ format: f.key, document: null }),
      },
        h('span', { class: 'format-name' }, f.label, f.recommended ? h('span', { class: 'chip good' }, 'recommended') : null),
        h('span', { class: 'small dim' }, f.length),
        h('span', { class: 'small muted' }, f.where))))));

  let sourcePanel = null;
  if (format.requiresSource) {
    const s = brief.source;
    const input = h('input', {
      type: 'url',
      placeholder: 'https://… the press release or page to analyse',
      value: s?.url ?? '',
      style: { flex: '1 1 22rem' },
    });
    const read = h('button', { class: 'primary', type: 'button' }, s ? 'Read another page' : 'Read page');
    read.addEventListener('click', async () => {
      if (!input.value.trim()) return;
      read.disabled = true;
      read.textContent = 'Reading…';
      try {
        const res = await api(`/api/entities/${brief.entity.id}/content-sources`, { method: 'POST', body: { url: input.value.trim() } });
        go({ source: String(res.source.id), relation: null });
      } catch (err) {
        toast(err.message, 'error');
        read.disabled = false;
        read.textContent = s ? 'Read another page' : 'Read page';
      }
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); read.click(); } });
    const others = (brief.recent_sources ?? []).filter((r) => r.id !== s?.id).slice(0, 6);

    sourcePanel = h('div', { class: 'panel' },
      h('h2', {}, 'The page to analyse', s ? h('span', { class: 'chip good' }, 'read') : h('span', { class: 'chip warn' }, 'required')),
      h('div', { class: 'panel-body' },
        h('div', { class: 'toolbar', style: { margin: 0 } }, input, read),
        s
          ? h('div', { style: { marginTop: '0.7rem' } },
              h('strong', {}, s.title ?? '(untitled)'), ' ',
              h('a', { href: s.final_url, target: '_blank', rel: 'noopener noreferrer' }, s.domain),
              h('div', { class: 'small dim' },
                `${fmt.n(s.chars)} characters, read ${s.via === 'direct' ? 'directly' : 'through DataForSEO'} · `,
                `${brief.facts.filter((f) => f.source === 'page').length} passages the draft can cite`),
              s.names_client ? null : h('div', { class: 'small sentiment negative' }, 'This page never names the client.'),
              h('div', { style: { marginTop: '0.7rem' } },
                h('div', { class: 'small muted', style: { marginBottom: '0.3rem' } }, 'This page is:'),
                h('div', { class: 'segmented' }, brief.relations.map((r) => h('button', {
                  type: 'button',
                  class: r.key === brief.relation ? 'active' : '',
                  onclick: () => go({ relation: r.key }),
                }, r.label))),
                h('div', { class: 'small dim', style: { marginTop: '0.3rem' } },
                  brief.relations.find((r) => r.key === brief.relation)?.hint ?? '',
                  s.byline_client ? ' The byline appears to be the client’s.' : '')))
          : h('p', { class: 'small muted', style: { marginBottom: 0 } },
              'Paste the URL of a press release, announcement or article. The draft analyses it — what was announced and why it matters — and carries the associations below. Quotations must match the page word for word.'),
        others.length
          ? h('div', { class: 'small', style: { marginTop: '0.6rem' } }, 'Read before: ',
              others.map((r, i) => [i ? ' · ' : '', h('a', {
                href: '#',
                onclick: (e) => { e.preventDefault(); go({ source: String(r.id), relation: null }); },
              }, r.title ?? r.domain)]))
          : null));
  }

  let topicPanel;
  if (!correcting) {
    const selected = new Set(brief.selected_ids);
    topicPanel = h('div', { class: 'panel' },
      h('h2', {}, '3. Associations to strengthen',
        h('span', { class: 'small dim' }, brief.purpose === 'strengthen'
          ? 'positive first; the draft is written and checked to carry every one ticked'
          : 'positive first, never negative, never tied to the association being displaced')),
      h('div', { class: 'panel-body tight' },
        brief.candidates.length
          ? sortableTable([
              {
                key: 'pick', label: '', sortable: false,
                render: (c) => h('input', {
                  type: 'checkbox',
                  checked: selected.has(c.association_id) ? 'checked' : null,
                  'aria-label': `Write about ${c.label}`,
                  onchange: (e) => {
                    if (e.target.checked) selected.add(c.association_id);
                    else selected.delete(c.association_id);
                    go({ grow: [...selected].join(',') || null });
                  },
                }),
              },
              {
                key: 'label', label: 'Association',
                render: (c) => h('div', {},
                  h('a', { href: `#/associations/${c.association_id}` }, c.label),
                  c.association_id === brief.selected_ids[0] ? h('span', { class: 'chip good', title: 'The first association ticked leads the piece.' }, ' main') : null,
                  c.is_identity_marker ? h('span', { class: 'chip marker' }, ' identity') : null,
                  h('div', { class: 'small dim' }, c.why)),
              },
              { key: 'category', label: 'Category', render: (c) => h('span', { class: 'small dim' }, c.category) },
              {
                key: 'sentiment', label: 'Reads', sortValue: (c) => (c.sentiment === 'positive' ? 1 : 0),
                render: (c) => h('span', { class: `sentiment ${c.sentiment}` }, c.sentiment),
              },
              {
                key: 'pias', metric: 'pias', num: true,
                render: (c) => h('div', {},
                  scoreWithBasis('pias', c.pias, { sources: c.independent_sources, documents: c.documents }, { compact: true }),
                  bandChip(c.band)),
              },
              { key: 'domains', metric: 'domains', num: true, render: (c) => fmt.n(c.domains) },
            ], brief.candidates, { initialSort: 'pias' })
          : h('div', { class: 'empty' }, 'No association qualifies: every candidate is negative, too thin, or travels with the one being displaced.'),
        h('div', { style: { padding: '0 0.7rem 0.7rem' } }, bandNote())));
  } else {
    topicPanel = h('div', { class: 'panel' },
      h('h2', {}, '3. Which article', h('span', { class: 'small dim' }, 'one request per publication')),
      h('div', { class: 'panel-body' },
        brief.target_documents.length
          ? brief.target_documents.map((d) => h('label', { class: `pick-doc ${d.document_id === brief.source_document_id ? 'active' : ''}` },
              h('input', {
                type: 'radio', name: 'source-document',
                checked: d.document_id === brief.source_document_id ? 'checked' : null,
                onchange: () => go({ document: String(d.document_id) }),
              }),
              h('div', {},
                h('div', {}, h('strong', {}, d.title ?? '(untitled)'), ' ',
                  d.duplicate_cluster_id && !d.is_cluster_primary ? h('span', { class: 'chip warn' }, 'copy of another page') : null),
                h('div', { class: 'small dim' },
                  h('a', { href: d.url, target: '_blank', rel: 'noopener noreferrer' }, d.root_domain), ` · ${fmt.date(d.date)}`),
                d.passage ? h('blockquote', { class: 'small' }, d.passage.slice(0, 400)) : null)))
          : h('div', { class: 'empty' }, 'No pages carry this association.')));
  }

  const notes = h('textarea', {
    rows: '6',
    placeholder: correcting
      ? 'What exactly is inaccurate, and what is correct? Include only what you can document.'
      : format.requiresNotes
        ? 'The news being announced: what, when, who is involved. Only real, confirmed facts.'
        : 'Optional. True things the sources do not cover: current role, recent work, dates.',
  });
  notes.value = notesDraft.get(params.id) ?? '';
  notes.addEventListener('input', () => notesDraft.set(params.id, notes.value));

  const notesPanel = h('div', { class: 'panel' },
    h('h2', {}, '4. Your notes', format.requiresNotes ? h('span', { class: 'chip warn' }, 'required') : null),
    h('div', { class: 'panel-body' },
      notes,
      h('p', { class: 'small dim', style: { marginBottom: 0 } },
        'The draft may use these, and every sentence that relies on them is labelled as coming from you.')));

  const optimisationPanel = !correcting && brief.targets?.length
    ? h('div', { class: 'panel' },
        h('h2', {}, '5. How the draft is shaped', h('span', { class: 'small dim' }, 'checked every time it is saved')),
        h('div', { class: 'panel-body' },
          h('table', {},
            h('thead', {}, h('tr', {},
              h('th', { class: 'no-sort' }, 'Association'),
              h('th', { class: 'no-sort' }, 'Also written as'),
              h('th', { class: 'no-sort' }, 'Relationship in the sources'))),
            h('tbody', {}, brief.targets.map((t) => h('tr', {},
              h('td', {}, t.label, t.primary ? h('span', { class: 'chip good', style: { marginLeft: '0.3rem' } }, 'main') : null),
              h('td', { class: 'small dim' }, t.terms.join(', ') || '—'),
              h('td', { class: 'small dim' }, t.relationships.join(', ') || '—'))))),
          h('ul', { style: { marginTop: '0.8rem' } }, brief.optimisation.map((o) => h('li', { class: 'small' }, o))),
          h('p', { class: 'small dim', style: { marginBottom: 0 } }, DISCLAIMERS.content_optimisation)))
    : null;

  const briefPanel = h('div', { class: 'panel' },
    h('h2', {}, 'Brief', h('span', { class: 'small dim' }, `${brief.facts.length} facts`)),
    h('div', { class: 'panel-body' },
      h('h3', { class: 'google-h' }, 'Outline'),
      h('ol', {}, brief.outline.map((o) => h('li', {}, o))),
      h('h3', { class: 'google-h' }, 'Facts the draft may use'),
      factList(brief.facts)));

  const acknowledge = h('input', { type: 'checkbox' });
  const generate = h('button', { class: 'primary', type: 'button' },
    brief.llm.available ? 'Generate draft' : 'Save brief');
  if (format.requiresSource && !brief.source) {
    generate.disabled = true;
    generate.title = 'Read the page to analyse first';
  }
  generate.addEventListener('click', async () => {
    if (brief.strategy.blocked && !acknowledge.checked) {
      toast('Confirm you have checked the identity first.', 'error');
      return;
    }
    generate.disabled = true;
    generate.textContent = brief.llm.available ? 'Writing… this takes up to a minute' : 'Saving…';
    try {
      const res = await api(`/api/associations/${params.id}/content`, {
        method: 'POST',
        body: {
          format: brief.format,
          purpose: brief.purpose,
          grow_association_ids: brief.selected_ids,
          source_document_id: brief.source_document_id,
          source_id: brief.source?.id ?? null,
          relation: brief.relation,
          notes: notes.value,
          acknowledge: acknowledge.checked,
        },
      });
      notesDraft.delete(params.id);
      navigate(`#/content/${res.draft.id}`);
    } catch (err) {
      toast(err.message, 'error');
      generate.disabled = false;
      generate.textContent = brief.llm.available ? 'Generate draft' : 'Save brief';
    }
  });

  const actions = h('div', { class: 'panel' }, h('div', { class: 'panel-body' },
    brief.strategy.blocked
      ? h('label', { class: 'small', style: { display: 'block', marginBottom: '0.6rem' } }, acknowledge,
          ' I have checked the identity behind this association and want to continue anyway')
      : null,
    brief.llm.available
      ? h('p', { class: 'small muted', style: { marginTop: 0 } }, `Written by ${brief.llm.model}, charged to this client’s spend ceiling.`)
      : h('p', { class: 'small muted', style: { marginTop: 0 } },
          'No working LLM key, so this saves the brief for a writer to work from. You can generate the draft later from the saved brief.'),
    h('div', { class: 'toolbar', style: { margin: 0 } }, generate)));

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {},
        h('h1', {}, 'Content builder'),
        h('div', { class: 'sub' },
          correcting
            ? `Correcting coverage of “${brief.association.label}” for ${brief.entity.canonical_name}`
            : brief.purpose === 'strengthen'
              ? `Strengthening “${brief.association.label}” for ${brief.entity.canonical_name}`
              : `Displacing “${brief.association.label}” for ${brief.entity.canonical_name}`,
          correcting
            ? null
            : h('span', {}, ' · ', h('a', {
                href: `#/associations/${params.id}/content?purpose=${brief.purpose === 'strengthen' ? 'displace' : 'strengthen'}`,
              }, brief.purpose === 'strengthen' ? 'Displace it instead' : 'Strengthen it instead')))),
      h('div', { class: 'toolbar' },
        h('button', { onclick: () => navigate(`#/associations/${params.id}/plan`) }, 'Action plan'),
        h('button', { onclick: () => navigate(`#/entities/${brief.entity.id}/content`) }, 'All drafts'))),
    disclaimer(brief.disclaimer),
    h('div', { class: 'weak-states' },
      ...notices,
      h('div', { class: 'weak' }, h('span', { class: 'weak-tag' }, 'Content'), h('span', {}, DISCLAIMERS.content)),
      h('div', { class: 'weak' }, h('span', { class: 'weak-tag' }, 'Disclosure'), h('span', {}, DISCLAIMERS.content_disclosure))),
    reasonsPanel,
    formatPanel,
    sourcePanel,
    topicPanel,
    notesPanel,
    optimisationPanel,
    h('div', { class: 'split-2' }, briefPanel, placementPanel(brief.placement, correcting ? [] : brief.avoid)),
    actions);
}

// --- Draft ------------------------------------------------------------------

export async function draftView({ params }) {
  const { draft: d, llm } = await api(`/api/content/${params.id}`);

  const save = async (patch, message) => {
    try {
      await api(`/api/content/${d.id}`, { method: 'PATCH', body: patch });
      toast(message, 'success');
      navigate(location.hash);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const title = h('input', { type: 'text', value: d.title ?? '', placeholder: 'Title' });
  const body = h('textarea', { class: 'draft-editor', rows: '26' });
  body.value = d.body ?? '';

  const checks = d.checks;

  // The AI revises the saved text against the list shown here, so unsaved
  // edits are saved first rather than silently overwritten.
  const unsaved = () => title.value !== (d.title ?? '') || body.value !== (d.body ?? '');
  const askAi = async (payload, button, busy) => {
    if (unsaved()) {
      toast('Save & re-check your edits first, so the AI works on the text you see.', 'error');
      return;
    }
    const label = button.textContent;
    button.disabled = true;
    button.textContent = busy;
    try {
      const res = await api(`/api/content/${d.id}/fix`, {
        method: 'POST',
        body: { ...payload, checked_at: checks.checked_at },
      });
      toast(res.fix.changed
        ? `Revised. ${res.fix.after.blocking} blocking left. ${res.fix.explanation}`
        : `No change: ${res.fix.explanation}`, 'success');
      navigate(location.hash);
    } catch (err) {
      toast(err.message, 'error');
      button.disabled = false;
      button.textContent = label;
    }
  };
  const aiTitle = llm.available
    ? 'Uses the LLM, charged to this client’s spend. You can undo the revision.'
    : 'No working LLM key';
  const issueButton = (issue, index) => {
    const blocking = issue.severity === 'block';
    const button = h('button', {
      type: 'button',
      class: 'small ghost ai-fix',
      title: aiTitle,
      disabled: llm.available ? null : 'disabled',
    }, blocking ? 'Fix with AI' : 'Check with AI');
    button.addEventListener('click', () => askAi({ issues: [index] }, button, blocking ? 'Fixing…' : 'Checking…'));
    return button;
  };
  const fixAll = checks?.blocking
    ? (() => {
        const button = h('button', { type: 'button', class: 'small', title: aiTitle, disabled: llm.available ? null : 'disabled' },
          `Fix all ${checks.blocking} with AI`);
        button.addEventListener('click', () => askAi({ all_blocking: true }, button, 'Fixing…'));
        return button;
      })()
    : null;

  const checksPanel = h('div', { class: 'panel' },
    h('h2', {}, 'Checks',
      h('span', { class: 'toolbar', style: { margin: 0 } },
        fixAll,
        checks
          ? h('span', { class: `chip ${checks.ok ? 'good' : 'bad'}` }, checks.ok ? 'nothing blocking' : `${checks.blocking} to fix`)
          : h('span', { class: 'chip' }, 'no draft yet'))),
    h('div', { class: 'panel-body' },
      checks?.issues?.length
        ? h('ul', { class: 'issues' }, checks.issues.map((i, index) => h('li', { class: `issue ${i.severity}` },
            h('span', { class: `chip ${i.severity === 'block' ? 'bad' : 'warn'}` }, i.severity === 'block' ? 'fix' : 'check'),
            h('span', { class: 'issue-text' }, i.text),
            issueButton(i, index))))
        : h('p', { class: 'small muted', style: { margin: 0 } },
            checks ? 'No problems found. A person still needs to read it against the facts before approving.' : 'Checks run once there is draft text.'),
      h('p', { class: 'small dim', style: { marginBottom: 0 } },
        'Checked for: the displaced association or its surname, claims with no source, figures with no source, copied runs of words, unconfirmed placeholders, and whether each association to strengthen is mentioned, beside the client’s name and early.')));

  const yesNo = (value) => h('span', { class: `chip ${value ? 'good' : 'bad'}` }, value ? 'yes' : 'no');
  const targetsPanel = checks?.targets?.length
    ? h('div', { class: 'panel' },
        h('h2', {}, 'Associations it strengthens'),
        h('div', { class: 'panel-body tight' }, h('table', {},
          h('thead', {}, h('tr', {},
            h('th', { class: 'no-sort' }, 'Association'),
            h('th', { class: 'num no-sort' }, 'Mentions that count'),
            h('th', { class: 'no-sort' }, 'Beside the name'),
            h('th', { class: 'no-sort' }, 'Title or opening'))),
          h('tbody', {}, checks.targets.map((t) => h('tr', {},
            h('td', {}, h('a', { href: `#/associations/${t.association_id}` }, t.label),
              t.primary ? h('span', { class: 'chip good', style: { marginLeft: '0.3rem' } }, 'main') : null),
            h('td', { class: 'num' }, `${t.counted} of ${t.cap}`, t.mentions > t.counted ? h('div', { class: 'small dim' }, `${t.mentions} in total`) : null),
            h('td', {}, yesNo(t.beside_name)),
            h('td', {}, t.primary ? yesNo(t.in_title || t.in_opening) : h('span', { class: 'dim small' }, 'not needed'))))))),
        h('p', { class: 'small dim', style: { padding: '0 0.95rem 0.7rem', margin: 0 } }, DISCLAIMERS.content_optimisation))
    : null;

  const statusActions = h('div', { class: 'toolbar', style: { margin: 0 } });
  const saveButton = h('button', { class: 'primary', type: 'button', onclick: () => save({ title: title.value, body: body.value }, 'Saved and re-checked') }, 'Save & re-check');
  statusActions.append(saveButton);
  if (d.status === 'draft' && d.body) {
    statusActions.append(h('button', {
      type: 'button',
      disabled: checks && !checks.ok ? 'disabled' : null,
      title: checks && !checks.ok ? 'Fix the blocking issues first' : '',
      onclick: () => save({ title: title.value, body: body.value, status: 'approved' }, 'Approved'),
    }, 'Approve'));
  }
  if (d.status === 'approved') {
    const url = h('input', { type: 'url', placeholder: 'https://… where it was published', style: { width: '20rem' } });
    statusActions.append(url, h('button', { type: 'button', onclick: () => save({ status: 'published', published_url: url.value }, 'Marked as published') }, 'Mark published'),
      h('button', { type: 'button', class: 'ghost', onclick: () => save({ status: 'draft' }, 'Reopened') }, 'Reopen'));
  }
  if (d.status !== 'archived') {
    statusActions.append(h('button', { type: 'button', class: 'ghost', onclick: () => save({ status: 'archived' }, 'Archived') }, 'Archive'));
  }
  if (d.body) {
    statusActions.append(h('button', {
      type: 'button', class: 'ghost',
      onclick: async () => {
        try { await navigator.clipboard.writeText(`${title.value}\n\n${body.value}`); toast('Copied', 'success'); }
        catch { toast('Copy failed: select the text and copy it instead.', 'error'); }
      },
    }, 'Copy text'));
  }

  const generateButton = llm.available
    ? h('button', {
        type: 'button',
        class: d.body ? 'ghost' : 'primary',
        onclick: async (e) => {
          if (d.body && !confirm('Replace the current text with a newly generated draft?')) return;
          e.target.disabled = true;
          e.target.textContent = 'Writing…';
          try {
            await api(`/api/content/${d.id}/generate`, { method: 'POST', body: {} });
            navigate(location.hash);
          } catch (err) {
            toast(err.message, 'error');
            e.target.disabled = false;
            e.target.textContent = 'Generate draft';
          }
        },
      }, d.body ? 'Regenerate' : 'Generate draft')
    : null;

  const undoButton = d.previous_body
    ? h('button', {
        type: 'button',
        class: 'small',
        onclick: async (e) => {
          if (unsaved() && !confirm('Undo the AI revision and discard your unsaved edits?')) return;
          e.target.disabled = true;
          try {
            await api(`/api/content/${d.id}/undo`, { method: 'POST', body: {} });
            toast('AI revision undone', 'success');
            navigate(location.hash);
          } catch (err) {
            toast(err.message, 'error');
            e.target.disabled = false;
          }
        },
      }, 'Undo AI revision')
    : null;

  const factIds = new Set((d.facts ?? []).map((f) => f.id));
  const claimsPanel = d.claims?.length
    ? h('div', { class: 'panel' },
        h('h2', {}, 'Where each claim comes from'),
        h('div', { class: 'panel-body tight' }, h('table', {}, h('tbody', {}, d.claims.map((c) => h('tr', {},
          h('td', {}, c.sentence),
          h('td', { class: 'num' }, (c.fact_ids ?? []).length
            ? c.fact_ids.map((id) => factIds.has(id)
                ? h('a', { class: 'chip', href: `#/content/${d.id}`, onclick: (e) => { e.preventDefault(); document.getElementById(`fact-${id}`)?.scrollIntoView({ block: 'center' }); } }, id)
                : h('span', { class: 'chip bad' }, `${id}?`))
            : h('span', { class: 'chip bad' }, 'no source'))))))))
    : null;

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {},
        h('h1', {}, d.title || `Untitled ${d.format_label.toLowerCase()}`),
        h('div', { class: 'sub' },
          h('span', { class: `chip ${STATUS_CLASS[d.status] ?? ''}` }, d.status), ' ',
          `${d.format_label} · ${d.mode === 'correct' ? 'correcting' : d.purpose === 'strengthen' ? 'strengthening' : 'displacing'} “${d.association_label}” for ${d.entity_name}`,
          ` · ${fmt.date(d.created_at)}${d.created_by_name ? ` by ${d.created_by_name}` : ''}`,
          d.model ? ` · ${d.model}, $${Number(d.cost_usd ?? 0).toFixed(3)}` : '',
          d.published_url ? h('span', {}, ' · ', h('a', { href: d.published_url, target: '_blank', rel: 'noopener noreferrer' }, 'published')) : null)),
      h('div', { class: 'toolbar' },
        h('button', { onclick: () => navigate(`#/associations/${d.association_id}/content?format=${d.format}&purpose=${d.purpose}${d.inputs?.source_id ? `&source=${d.inputs.source_id}` : ''}${d.inputs?.relation ? `&relation=${d.inputs.relation}` : ''}`) }, 'Builder'),
        h('button', { onclick: () => navigate(`#/entities/${d.entity_id}/content`) }, 'All drafts'))),
    disclaimer(),
    h('div', { class: 'weak-states' },
      h('div', { class: 'weak' }, h('span', { class: 'weak-tag' }, 'Content'), h('span', {}, DISCLAIMERS.content)),
      h('div', { class: 'weak' }, h('span', { class: 'weak-tag' }, 'Disclosure'), h('span', {}, DISCLAIMERS.content_disclosure)),
      d.generation_error
        ? h('div', { class: 'weak bad' }, h('span', { class: 'weak-tag' }, 'No draft'), h('span', {}, d.generation_error, ' ', generateButton))
        : null,
      d.revision_note
        ? h('div', { class: 'weak' }, h('span', { class: 'weak-tag' }, 'AI revision'), h('span', {}, d.revision_note, ' ', undoButton))
        : null),
    checksPanel,
    targetsPanel,
    h('div', { class: 'panel' },
      h('h2', {}, 'Draft', d.approved_by_name ? h('span', { class: 'small dim' }, `approved by ${d.approved_by_name}`) : null),
      h('div', { class: 'panel-body' },
        title,
        body,
        d.notes_for_editor ? h('p', { class: 'small muted' }, h('strong', {}, 'For the editor: '), d.notes_for_editor) : null,
        h('div', { style: { marginTop: '0.7rem' } }, statusActions),
        !d.generation_error && generateButton ? h('div', { style: { marginTop: '0.5rem' } }, generateButton) : null)),
    claimsPanel,
    h('div', { class: 'split-2' },
      h('div', { class: 'panel' },
        h('h2', {}, 'Facts it was written from'),
        h('div', { class: 'panel-body' },
          h('ol', { class: 'small muted' }, (d.brief.outline ?? []).map((o) => h('li', {}, o))),
          factList(d.facts))),
      placementPanel(d.brief.placement, d.mode === 'correct' ? [] : d.brief.avoid)));
}

// --- List -------------------------------------------------------------------

export async function contentListView({ params }) {
  const { entity, drafts } = await api(`/api/entities/${params.id}/content`);

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Content'), h('div', { class: 'sub' }, `${drafts.length} drafts for ${entity.canonical_name}`))),
    h('div', { class: 'weak-states' },
      h('div', { class: 'weak' }, h('span', { class: 'weak-tag' }, 'Disclosure'), h('span', {}, DISCLAIMERS.content_disclosure))),
    h('div', { class: 'panel' },
      drafts.length
        ? h('div', { class: 'panel-body tight' }, sortableTable([
            {
              key: 'title', label: 'Title',
              render: (r) => h('a', { href: `#/content/${r.id}` }, r.title || `Untitled ${r.format_label.toLowerCase()}`),
            },
            { key: 'format_label', label: 'Format' },
            {
              key: 'association_label', label: 'Association',
              render: (r) => h('span', {}, r.mode === 'correct' ? 'correcting ' : r.purpose === 'strengthen' ? 'strengthening ' : 'displacing ',
                h('a', { href: `#/associations/${r.association_id}/plan` }, r.association_label)),
            },
            { key: 'status', label: 'Status', render: (r) => h('span', { class: `chip ${STATUS_CLASS[r.status] ?? ''}` }, r.status) },
            {
              key: 'checks', label: 'Checks', sortValue: (r) => r.checks?.blocking ?? -1,
              render: (r) => r.checks
                ? h('span', { class: `chip ${r.checks.ok ? 'good' : 'bad'}` }, r.checks.ok ? 'clear' : `${r.checks.blocking} to fix`)
                : h('span', { class: 'chip' }, 'brief only'),
            },
            { key: 'updated_at', label: 'Updated', render: (r) => fmt.date(r.updated_at) },
          ], drafts, { initialSort: 'updated_at' }))
        : h('div', { class: 'empty' },
            h('p', {}, 'No content yet.'),
            h('p', { class: 'small dim' }, 'Open an association’s action plan and choose “Build content”.'),
            h('button', { class: 'primary', onclick: () => navigate(`#/entities/${params.id}`) }, 'Dashboard'))));
}
