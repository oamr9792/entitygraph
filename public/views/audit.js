import { h, api, fmt, navigate, toast, onTeardown, clear, disclaimer } from '../app.js';
import { AUDIT_CHECKS, AUDIT_RESULTS } from '/copy/metrics.js';

/**
 * §101 — the content audit, one screen per draft. Blocking failures first, then
 * warnings, then what could not be judged, then passes collapsed. Every check
 * shows its plain name and description from the registry, its number with a
 * denominator, the evidence, and one line on what to do. There is no score.
 */

const RESULT_CLASS = { fail: 'bad', warn: 'warn', insufficient: '', pass: 'good', not_applicable: '' };
// Missing facts and compliance approval are not a wording problem, so there is no AI button for them.
const NOT_FIXED_BY_REWRITING = new Set(['C3', 'C5', 'C6']);
const SOURCE_LABEL = { paste: 'Pasted text', url: 'Live page', generated: 'Generated draft' };
const num = (v) => (v === null || v === undefined ? null : Number.isInteger(Number(v)) ? String(v) : Number(v).toFixed(1));

function valueLine(check) {
  const value = num(check.value);
  const denominator = num(check.denominator);
  if (value !== null && denominator !== null) return `${value} of ${denominator}`;
  return value;
}

const table = (head, rows) => h('div', { class: 'table-wrap' }, h('table', {},
  h('thead', {}, h('tr', {}, head.map((c) => h('th', { class: 'no-sort' }, c)))),
  h('tbody', {}, rows)));

/** The evidence a check produced, rendered from its stored detail rather than recomputed. */
function evidence(check) {
  const d = check.detail ?? {};
  const parts = [];
  if (d.items?.length) parts.push(h('ul', { class: 'audit-items' }, d.items.slice(0, 20).map((item) => h('li', {}, item))));
  const extra = [];
  switch (check.check_id) {
    case 'C1':
      if (d.exclusions?.length) extra.push(h('p', { class: 'small muted' }, 'Checked against: ', d.exclusions.map((e) => h('span', { class: 'chip', style: { marginRight: '0.25rem' } }, e.label)), ` · close matches by ${d.embedding_model}`));
      break;
    case 'C2':
      if (d.claims?.length) {
        extra.push(table(['Claim', 'Sentence', 'Sources'], d.claims.map((c) => h('tr', {},
          h('td', {}, h('span', { class: `chip ${c.resolution === 'resolved' ? 'good' : 'bad'}` }, c.resolution), ' ', c.claim),
          h('td', { class: 'small muted' }, c.sentence),
          h('td', { class: 'num' }, c.sources)))));
      }
      if (d.extractor) extra.push(h('p', { class: 'small dim' }, `Read by: ${d.extractor}`));
      break;
    case 'C4':
      if (d.clusters?.length) extra.push(h('p', { class: 'small muted' }, d.clusters.map((c) => `${c.label} (${c.attributions})`).join(' · ')));
      break;
    case 'C5':
      if (d.already_on_assets?.length) extra.push(h('p', { class: 'small muted' }, `Already on a live asset: ${d.already_on_assets.join(', ')}`));
      if (d.single_source?.length) extra.push(h('p', { class: 'small muted' }, `Resting on a single source: ${d.single_source.join(', ')}`));
      break;
    case 'C6':
      if (d.by_class) extra.push(h('p', { class: 'small muted' }, Object.entries(d.by_class).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ')));
      break;
    case 'C7':
      if (d.attributes?.length) {
        extra.push(table(['Attribute', 'In adverse coverage'], d.attributes.map((a) => h('tr', {},
          h('td', {}, a.claim), h('td', { class: 'num' }, `${a.in_adverse} of ${a.documents} (${Math.round(a.share * 100)}%)`)))));
      }
      break;
    case 'C8':
      if (d.associations?.length) {
        const signed = (v) => `${v >= 0 ? '+' : ''}${v}`;
        extra.push(table(['Association', 'Strength', 'Recent strength'], [...d.associations, ...(d.adverse ?? []).map((a) => ({ ...a, adverse: true }))].map((a) => h('tr', {},
          h('td', {}, a.label, a.new_association ? h('span', { class: 'chip' }, ' new') : null, a.adverse ? h('span', { class: 'chip bad' }, ' adverse') : null),
          h('td', { class: 'num' }, `${fmt.score(a.pias_after)} (${signed(a.pias_delta)})`),
          h('td', { class: 'num' }, `${fmt.score(a.current_after)} (${signed(a.current_delta)})`)))));
      }
      if (d.note) extra.push(h('p', { class: 'small dim' }, d.note));
      break;
    case 'C10':
      if (d.others?.length) extra.push(h('p', { class: 'small muted' }, 'Other people: ', d.others.map((o) => `${o.name} ${Math.round(o.share * 100)}%`).join(', ')));
      break;
    case 'C12':
      if (d.quotation) extra.push(h('p', { class: 'small muted' }, `Quotations: ${Math.round((d.quotation.share ?? 0) * 100)}% of words; longest ${d.quotation.longest} words.`));
      break;
    case 'C13':
      if (d.links?.length) {
        extra.push(table(['Link', 'Where', 'How far down'], d.links.slice(0, 15).map((l) => h('tr', {},
          h('td', {}, h('a', { href: l.href, target: '_blank', rel: 'noopener noreferrer' }, l.domain), h('div', { class: 'small dim' }, l.anchor)),
          h('td', {}, l.location),
          h('td', { class: 'num' }, `${Math.round(l.position * 100)}%`)))));
      }
      break;
    case 'C14':
      if (d.excerpt) extra.push(h('p', { class: 'small muted' }, `${d.host}: “${d.excerpt}…”`));
      break;
    case 'C15':
      if (d.missing_same_as?.length) extra.push(h('p', { class: 'small muted' }, `Missing sameAs: ${d.missing_same_as.join(', ')}`));
      break;
    default:
  }
  if (extra.length) parts.push(h('details', { class: 'audit-more' }, h('summary', { class: 'small' }, 'Evidence'), ...extra));
  return parts;
}

function signoffControl(check, auditId, refresh) {
  if (check.signoff && check.signed_off) {
    return h('p', { class: 'small good-text' }, `Signed off by ${check.signoff.user_name} on ${fmt.date(check.signoff.signed_at)}: ${check.signoff.reason ?? ''}`);
  }
  const rule = check.signoff_rule ?? {};
  if (!['fail', 'warn'].includes(check.result)) return null;
  if (!rule.allowed) return rule.why ? h('p', { class: 'small dim' }, rule.why) : null;

  const send = async (reason, button) => {
    button.disabled = true;
    try {
      await api(`/api/audits/${auditId}/signoff`, { method: 'POST', body: { check_id: check.check_id, reason } });
      toast('Sign-off recorded', 'success');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
      button.disabled = false;
    }
  };
  if (rule.approval) {
    const button = h('button', { type: 'button', class: 'small primary' }, 'Record compliance approval');
    button.addEventListener('click', () => {
      if (confirm('Record that you, by name, have approved this content for publication?')) send(null, button);
    });
    return h('div', { class: 'toolbar', style: { margin: '0.4rem 0 0' } }, button);
  }
  const reason = h('input', { type: 'text', placeholder: 'Why this is acceptable', style: { flex: '1 1 18rem' } });
  const button = h('button', { type: 'button', class: 'small' }, 'Sign off');
  button.addEventListener('click', () => send(reason.value, button));
  return h('div', { class: 'toolbar', style: { margin: '0.4rem 0 0' } }, reason, button);
}

function checkCard(check, { auditId, refresh, aiButton }) {
  const copy = check.copy ?? AUDIT_CHECKS[check.check_id];
  const value = valueLine(check);
  return h('div', { class: `audit-check ${check.result}${check.signed_off ? ' signed' : ''}` },
    h('div', { class: 'audit-check-head' },
      h('span', { class: `chip ${RESULT_CLASS[check.result] ?? ''}` }, check.signed_off ? 'Signed off' : AUDIT_RESULTS[check.result] ?? check.result),
      check.blocking ? h('span', { class: 'chip bad' }, 'blocking') : null,
      h('strong', {}, `${check.check_id} · ${copy.name}`),
      value ? h('span', { class: 'audit-value' }, value) : null,
      h('span', { class: 'spacer' }),
      aiButton ? aiButton(check) : null),
    h('p', { class: 'small dim', style: { margin: '0.2rem 0' } }, copy.what),
    h('p', { style: { margin: '0.35rem 0' } }, check.summary),
    ...evidence(check),
    ['fail', 'warn', 'insufficient'].includes(check.result) && !check.signed_off ? h('p', { class: 'small audit-act' }, copy.act) : null,
    check.stale ? h('p', { class: 'small sentiment negative' }, 'The text has changed since this ran.') : null,
    signoffControl(check, auditId, refresh));
}

/**
 * The audit results for one audit, polling while it runs. `contentDraftId`
 * adds the separate, human-chosen AI fix buttons for generated drafts.
 */
export function auditPanel(initial, { contentDraftId = null, llmAvailable = false, onChange = null, guard = null } = {}) {
  const root = h('div', { class: 'audit-panel' });
  let timer = null;
  let stopped = false;
  onTeardown(() => { stopped = true; clearTimeout(timer); });

  const refresh = async () => {
    try {
      const fresh = await api(`/api/audits/${initial.draft.id}`);
      paint(fresh);
      onChange?.(fresh);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const rerun = async (button) => {
    button.disabled = true;
    try { paint(await api(`/api/audits/${initial.draft.id}/rerun`, { method: 'POST', body: {} })); } catch (err) { toast(err.message, 'error'); button.disabled = false; }
  };

  const aiButton = contentDraftId && llmAvailable
    ? (audit) => (check) => {
        if (!['fail', 'warn'].includes(check.result) || check.signed_off || NOT_FIXED_BY_REWRITING.has(check.check_id)) return null;
        const button = h('button', { type: 'button', class: 'small ghost', title: 'A separate action: the AI revises the text and the audit runs again. You can undo it.' },
          check.result === 'fail' ? 'Fix with AI' : 'Check with AI');
        button.addEventListener('click', () => askAi(audit, { check_ids: [check.check_id] }, button));
        return button;
      }
    : null;

  const askAi = async (audit, payload, button) => {
    const blocked = guard?.();
    if (blocked) { toast(blocked, 'error'); return; }
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Revising…';
    try {
      const res = await api(`/api/content/${contentDraftId}/fix`, { method: 'POST', body: { ...payload, audit_id: audit.draft.id } });
      toast(res.fix.changed ? `Revised, and audited again. ${res.fix.explanation}` : `No change: ${res.fix.explanation}`, 'success');
      navigate(location.hash);
    } catch (err) {
      toast(err.message, 'error');
      button.disabled = false;
      button.textContent = label;
    }
  };

  const paint = (audit) => {
    clearTimeout(timer);
    const { draft, checks } = audit;
    const running = draft.status === 'pending' || draft.status === 'running';
    const rerunButton = h('button', { type: 'button', class: 'small' }, 'Audit again');
    rerunButton.addEventListener('click', () => rerun(rerunButton));

    const byGroup = { blocking: [], warnings: [], unjudged: [], passed: [] };
    for (const c of checks) {
      if (c.signed_off) byGroup.passed.push(c);
      else if (c.result === 'fail' && c.blocking) byGroup.blocking.push(c);
      else if (c.result === 'fail' || c.result === 'warn') byGroup.warnings.push(c);
      else if (c.result === 'insufficient') byGroup.unjudged.push(c);
      else byGroup.passed.push(c);
    }
    const card = (c) => checkCard(c, { auditId: draft.id, refresh, aiButton: aiButton ? aiButton(audit) : null });
    const fixAll = aiButton && checks.some((c) => c.result === 'fail' && !c.signed_off && !NOT_FIXED_BY_REWRITING.has(c.check_id)) && !running
      ? (() => {
          const b = h('button', { type: 'button', class: 'small' }, 'Fix all failures with AI');
          b.addEventListener('click', () => askAi(audit, { all_blocking: true }, b));
          return b;
        })()
      : null;

    const steps = (audit.job?.progress ?? []).filter((p) => p.step);
    clear(root).append(
      h('div', { class: 'panel' },
        h('h2', {}, 'Content audit',
          h('span', { class: 'toolbar', style: { margin: 0 } },
            fixAll,
            running ? h('span', { class: 'chip warn' }, draft.status) : rerunButton,
            h('a', { class: 'small', href: `#/audits/${draft.id}` }, 'Open'))),
        h('div', { class: 'panel-body' },
          running
            ? h('div', {},
                h('p', { style: { marginTop: 0 } }, 'Auditing… extraction, fifteen checks and a projection of the association scores. This takes a minute or two.'),
                steps.length ? h('p', { class: 'small dim' }, `${steps.filter((p) => p.status === 'done').length} of ${audit.job?.steps_total ?? steps.length} steps done${steps.at(-1)?.step ? ` · ${steps.at(-1).step}` : ''}`) : null)
            : h('p', { class: 'audit-summary' }, audit.summary ?? draft.status_detail ?? ''),
          draft.status === 'refused' || draft.status === 'failed'
            ? h('p', { class: 'sentiment negative small' }, draft.status_detail)
            : null,
          audit.approval && contentDraftId
            ? h('p', { class: `small ${audit.approval.ready ? 'good-text' : 'muted'}` }, audit.approval.ready ? 'Nothing blocking: this version can be approved.' : `Approval: ${audit.approval.reason}`)
            : null)),
      byGroup.blocking.length ? h('div', { class: 'audit-group' }, h('h3', { class: 'audit-group-h bad-text' }, 'Blocking'), ...byGroup.blocking.map(card)) : null,
      byGroup.warnings.length ? h('div', { class: 'audit-group' }, h('h3', { class: 'audit-group-h' }, 'Warnings'), ...byGroup.warnings.map(card)) : null,
      byGroup.unjudged.length ? h('div', { class: 'audit-group' }, h('h3', { class: 'audit-group-h' }, 'Could not be judged'), ...byGroup.unjudged.map(card)) : null,
      byGroup.passed.length
        ? h('details', { class: 'audit-group' }, h('summary', { class: 'audit-group-h' }, `Passed or not applicable (${byGroup.passed.length})`), ...byGroup.passed.map(card))
        : null);

    if (running && !stopped) timer = setTimeout(refresh, 2500);
  };

  paint(initial);
  return root;
}

// --- Screens ---------------------------------------------------------------------------------------

export async function auditView({ params }) {
  const audit = await api(`/api/audits/${params.id}`);
  const d = audit.draft;
  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {},
        h('h1', {}, d.title || `${SOURCE_LABEL[d.source_kind]} for ${d.entity_name}`),
        h('div', { class: 'sub' },
          `${SOURCE_LABEL[d.source_kind]} · ${d.entity_name}`,
          d.host_domain ? ` · host ${d.host_domain}` : '',
          d.page_url ? h('span', {}, ' · ', h('a', { href: d.page_url, target: '_blank', rel: 'noopener noreferrer' }, 'live page')) : null,
          ` · ${fmt.date(d.created_at)}${d.created_by_name ? ` by ${d.created_by_name}` : ''}`,
          d.extractor ? ` · read by ${d.extractor}` : '')),
      h('div', { class: 'toolbar' },
        d.content_draft_id ? h('button', { onclick: () => navigate(`#/content/${d.content_draft_id}`) }, 'Draft') : null,
        h('button', { onclick: () => navigate(`#/entities/${d.entity_id}/audits`) }, 'All audits'))),
    disclaimer(),
    auditPanel(audit),
    audit.facts.length
      ? h('div', { class: 'panel' },
          h('h2', {}, 'Claims extracted', h('span', { class: 'small dim' }, `${audit.facts.length}`)),
          h('div', { class: 'panel-body tight' }, table(['Claim', 'Relationship', 'Sources', 'Independent', 'Best source', 'New'], audit.facts.map((f) => h('tr', {},
            h('td', {}, h('span', { class: `chip ${f.resolution === 'resolved' ? 'good' : 'bad'}` }, f.resolution), ' ',
              f.association_id ? h('a', { href: `#/associations/${f.association_id}` }, f.extracted_claim) : f.extracted_claim,
              h('div', { class: 'small dim' }, f.sentence)),
            h('td', { class: 'small' }, String(f.relationship ?? '').replace(/_/g, ' ')),
            h('td', { class: 'num' }, f.sources),
            h('td', { class: 'num' }, f.independent_sources),
            h('td', { class: 'small' }, String(f.source_class ?? '—').replace(/_/g, ' ')),
            h('td', {}, f.novel ? h('span', { class: 'chip good' }, 'new') : '—'))))))
      : null,
    h('details', { class: 'panel' }, h('summary', { class: 'panel-body' }, 'The audited text'),
      h('div', { class: 'panel-body' }, h('pre', { class: 'audit-text' }, d.text))));
}

function exclusionsPanel(entityId) {
  const body = h('div', { class: 'panel-body' }, h('p', { class: 'small dim' }, 'Loading…'));
  const load = () => api(`/api/entities/${entityId}/exclusions`).then(({ exclusions, suggestions }) => {
    const set = async (associationId, polarity, reason, button) => {
      button.disabled = true;
      try {
        await api(`/api/associations/${associationId}/polarity`, { method: 'POST', body: { polarity, reason } });
        load();
      } catch (err) { toast(err.message, 'error'); button.disabled = false; }
    };
    clear(body).append(
      h('p', { class: 'small muted', style: { marginTop: 0 } }, 'C1 fails any text that names these, and C7 measures overlap with their coverage. Coverage tone is not used to decide this: it is too noisy.'),
      exclusions.length
        ? h('div', {}, exclusions.map((e) => {
            const remove = h('button', { type: 'button', class: 'chip-x', title: 'Not adverse' }, '×');
            remove.addEventListener('click', () => set(e.association_id, null, null, remove));
            return h('span', { class: 'chip bad', style: { marginRight: '0.3rem' } }, e.label, e.source === 'analyst' ? remove : null);
          }))
        : h('p', { class: 'small sentiment negative' }, 'None recorded, so C1 and C7 cannot be judged.'),
      suggestions.length
        ? h('div', { style: { marginTop: '0.7rem' } },
            h('div', { class: 'small muted' }, 'Mostly negative and well evidenced — mark any that are adverse:'),
            suggestions.map((s) => {
              const mark = h('button', { type: 'button', class: 'small ghost', style: { marginRight: '0.3rem', marginTop: '0.3rem' } }, `+ ${s.label} (${s.documents})`);
              mark.addEventListener('click', () => set(s.association_id, 'adverse', 'marked from the audit screen', mark));
              return mark;
            }))
        : null);
  }).catch((err) => clear(body).append(h('p', { class: 'small sentiment negative' }, err.message)));
  load();
  return h('div', { class: 'panel' }, h('h2', {}, 'Adverse associations'), body);
}

export async function auditListView({ params }) {
  const data = await api(`/api/entities/${params.id}/audits`);
  const { entity, audits, assets, report } = data;

  const text = h('textarea', { rows: '8', placeholder: 'Paste the text to audit.' });
  const title = h('input', { type: 'text', placeholder: 'Title (optional)' });
  const host = h('input', { type: 'text', placeholder: 'Intended host, e.g. shorenews.com' });
  const target = h('input', { type: 'url', placeholder: 'Client page it should link to (optional)' });
  const url = h('input', { type: 'url', placeholder: 'https://… a live page' });
  const urlTarget = h('input', { type: 'url', placeholder: 'Client page it should link to (optional)' });

  const submit = async (payload, button) => {
    button.disabled = true;
    const label = button.textContent;
    button.textContent = 'Starting…';
    try {
      const res = await api(`/api/entities/${entity.id}/audits`, { method: 'POST', body: payload });
      navigate(`#/audits/${res.draft.id}`);
    } catch (err) {
      toast(err.message, 'error');
      button.disabled = false;
      button.textContent = label;
    }
  };
  const pasteButton = h('button', { type: 'button', class: 'primary' }, 'Audit text');
  pasteButton.addEventListener('click', () => submit({ text: text.value, title: title.value, host_domain: host.value, target_url: target.value }, pasteButton));
  const urlButton = h('button', { type: 'button', class: 'primary' }, 'Audit page');
  urlButton.addEventListener('click', () => submit({ url: url.value, target_url: urlTarget.value }, urlButton));

  const assetUrl = h('input', { type: 'url', placeholder: 'https://… a published asset' });
  const assetKind = h('select', {}, h('option', { value: 'placed' }, 'placed'), h('option', { value: 'owned' }, 'owned'));
  const addButton = h('button', { type: 'button' }, 'Register asset');
  addButton.addEventListener('click', async () => {
    try {
      await api(`/api/entities/${entity.id}/assets`, { method: 'POST', body: { url: assetUrl.value, kind: assetKind.value } });
      navigate(location.hash);
    } catch (err) { toast(err.message, 'error'); }
  });
  const batchButton = h('button', { type: 'button', class: 'primary' }, 'Audit all live assets');
  batchButton.addEventListener('click', async () => {
    batchButton.disabled = true;
    try {
      await api(`/api/entities/${entity.id}/assets/audit`, { method: 'POST', body: {} });
      toast('Queued. Each live asset is read and audited in turn.', 'success');
    } catch (err) { toast(err.message, 'error'); batchButton.disabled = false; }
  });

  const keyChip = (c) => (c ? h('span', { class: `chip ${RESULT_CLASS[c.result] ?? ''}`, style: { marginRight: '0.2rem' } }, `${c.check_id} ${c.result}`) : h('span', { class: 'dim' }, '—'));

  return h('div', {},
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Content audit'),
      h('div', { class: 'sub' }, `Checks for ${entity.canonical_name}: before publication on a draft, after it on a live page. No score, only the checks.`))),
    disclaimer(),
    h('div', { class: 'split-2' },
      h('div', { class: 'panel' }, h('h2', {}, 'Audit pasted text'),
        h('div', { class: 'panel-body' }, title, text, h('div', { class: 'toolbar', style: { marginTop: '0.5rem' } }, host, target), pasteButton)),
      h('div', { class: 'panel' }, h('h2', {}, 'Audit a live page'),
        h('div', { class: 'panel-body' }, url, h('div', { style: { marginTop: '0.5rem' } }, urlTarget), h('div', { style: { marginTop: '0.5rem' } }, urlButton)))),
    exclusionsPanel(entity.id),
    h('div', { class: 'panel' },
      h('h2', {}, 'Live assets', h('span', { class: 'toolbar', style: { margin: 0 } }, batchButton)),
      h('div', { class: 'panel-body' },
        report.audited
          ? h('p', { style: { marginTop: 0 } },
              `${report.audited} of ${report.live} live assets audited. `,
              report.restatement_share !== null ? `${Math.round(report.restatement_share * 100)}% are restatements of their sources. ` : '',
              report.rewrite_candidates.length ? `${report.rewrite_candidates.length} add no new facts and would not move any association: candidates for rewriting. ` : '',
              report.collapsing.length ? `${report.collapsing.length} pairs cluster with each other.` : '')
          : h('p', { class: 'small muted', style: { marginTop: 0 } }, 'Register published pages to find out which are contributing. They are re-audited weekly.'),
        h('div', { class: 'toolbar' }, assetUrl, assetKind, addButton),
        assets.length
          ? table(['Asset', 'Kind', 'Status', 'Last audit', 'New facts · projection · duplicates', ''], assets.map((a) => h('tr', {},
              h('td', {}, h('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer' }, a.label || a.url)),
              h('td', { class: 'small' }, a.kind),
              h('td', {}, h('span', { class: `chip ${a.status === 'live' ? 'good' : ''}` }, a.status)),
              h('td', { class: 'small' }, a.audit_id ? h('a', { href: `#/audits/${a.audit_id}` }, a.audit_summary ?? a.audit_status) : '—'),
              h('td', {}, keyChip(a.key_checks.C5), keyChip(a.key_checks.C8), keyChip(a.key_checks.C9)),
              h('td', {}, h('button', {
                type: 'button', class: 'small ghost',
                onclick: async () => {
                  try { await api(`/api/assets/${a.id}/status`, { method: 'POST', body: { status: a.status === 'live' ? 'retired' : 'live' } }); navigate(location.hash); }
                  catch (err) { toast(err.message, 'error'); }
                },
              }, a.status === 'live' ? 'Retire' : 'Restore')))))
          : null)),
    h('div', { class: 'panel' },
      h('h2', {}, 'Audits'),
      h('div', { class: 'panel-body tight' }, audits.length
        ? table(['Audit', 'Status', 'Blocking', 'Warnings', 'When'], audits.map((a) => h('tr', {},
            h('td', {}, h('a', { href: `#/audits/${a.id}` }, a.title || a.page_url || `${SOURCE_LABEL[a.source_kind]} #${a.id}`),
              h('div', { class: 'small dim' }, SOURCE_LABEL[a.source_kind])),
            h('td', {}, h('span', { class: `chip ${a.status === 'done' ? '' : a.status === 'refused' || a.status === 'failed' ? 'bad' : 'warn'}` }, a.status),
              a.status_detail ? h('div', { class: 'small dim' }, a.status_detail.slice(0, 140)) : null),
            h('td', { class: 'num' }, a.blocking_open ?? '—'),
            h('td', { class: 'num' }, a.warnings ?? '—'),
            h('td', { class: 'small' }, fmt.date(a.audited_at ?? a.created_at)))))
        : h('div', { class: 'empty' }, 'No audits yet.'))));
}

/** A toggle for marking one association adverse, used on its evidence page. */
export function polarityControl(associationId) {
  const slot = h('span', {});
  const paint = (polarity) => {
    const adverse = polarity?.polarity === 'adverse';
    const button = h('button', { type: 'button', class: adverse ? 'danger' : '' }, adverse ? 'Marked adverse' : 'Mark adverse');
    button.title = adverse ? 'Excluded from content (audit C1). Click to unmark.' : 'Content must never name it (audit C1).';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const res = await api(`/api/associations/${associationId}/polarity`, { method: 'POST', body: { polarity: adverse ? null : 'adverse' } });
        paint(res.polarity);
      } catch (err) { toast(err.message, 'error'); button.disabled = false; }
    });
    clear(slot).append(button);
  };
  api(`/api/associations/${associationId}/polarity`).then((r) => paint(r.polarity)).catch(() => {});
  return slot;
}
