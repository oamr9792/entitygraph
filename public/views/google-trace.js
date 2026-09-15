import { h, api, clear, toast } from '../app.js';

/**
 * Google's results for the client's name, each traced through the build. The
 * panel exists for the moment someone can see a page on Google and cannot find
 * it in the evidence: it names the step that lost it.
 */

const STAGE = {
  evidence: ['Evidence', 'good'],
  fallback_only: ['Fallback only', 'warn'],
  no_evidence: ['Nothing extracted', 'warn'],
  not_read: ['Not read', 'bad'],
  in_review: ['Needs review', 'warn'],
  rejected: ['Different person', ''],
  not_checked: ['Not checked', 'bad'],
  not_collected: ['Not collected', 'bad'],
};

export function googleTracePanel(entityId) {
  const body = h('div', { class: 'panel-body tight' },
    h('div', { class: 'dim small', style: { padding: '0.9rem' } }, 'Tracing Google’s results…'));
  const panel = h('div', { class: 'panel' },
    h('h2', {}, 'Google’s results, traced', h('span', { class: 'small dim' }, 'where each page for the name ended up')),
    body);

  const decide = async (documentId, action, button) => {
    button.disabled = true;
    try {
      await api('/api/review', { method: 'POST', body: { entity_id: Number(entityId), action, document_id: documentId } });
      toast(action === 'right_entity'
        ? 'Marked as the same person. The next build reads it and adds its evidence.'
        : 'Marked as a different person.', 'success');
      load();
    } catch (err) {
      toast(err.message, 'error');
      button.disabled = false;
    }
  };

  const load = () => api(`/api/entities/${entityId}/google/trace?limit=30`)
    .then((t) => {
      clear(body);
      if (!t.available) {
        body.append(h('div', { class: 'empty' }, t.reason));
        return;
      }

      const lost = ['not_read', 'in_review', 'not_checked', 'not_collected', 'no_evidence']
        .reduce((n, s) => n + (t.counts[s] ?? 0), 0);
      body.append(h('div', { style: { padding: '0.8rem 0.95rem 0' } },
        h('p', { class: 'interpretation', style: { marginTop: 0 } },
          `${t.top_ten_with_evidence} of Google’s top ${t.top_ten} results for “${t.snapshot.query}” produced evidence. `,
          lost
            ? `${lost} of the ${t.results.length} results traced here were lost before extraction — the reason is on each row.`
            : 'Every result traced here was either used or ruled out as a different person.'),
        h('p', { class: 'small dim' },
          'Pages you mark as the same person count after the next build reads them. A rebuild also re-reads any Google result that was blocked or came back short.')));

      body.append(h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {},
          h('th', { class: 'num no-sort' }, '#'),
          h('th', { class: 'no-sort' }, 'Result'),
          h('th', { class: 'no-sort' }, 'Outcome'),
          h('th', { class: 'no-sort' }, 'What it contributes'),
          h('th', { class: 'no-sort' }, ''))),
        h('tbody', {}, t.results.map((r) => {
          const [label, cls] = STAGE[r.stage] ?? [r.stage, ''];
          const actions = h('div', { class: 'toolbar', style: { margin: 0, gap: '0.25rem', flexWrap: 'nowrap' } });
          if (r.document_id && (r.stage === 'in_review' || (r.stage === 'rejected' && !r.manual))) {
            const yes = h('button', { class: 'small', type: 'button' }, 'This is them');
            yes.addEventListener('click', () => decide(r.document_id, 'right_entity', yes));
            actions.append(yes);
          }
          if (r.document_id && r.stage === 'in_review') {
            const no = h('button', { class: 'small ghost', type: 'button' }, 'Someone else');
            no.addEventListener('click', () => decide(r.document_id, 'wrong_entity', no));
            actions.append(no);
          }
          return h('tr', {},
            h('td', { class: 'num' }, r.rank),
            h('td', {},
              h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.domain ?? r.url),
              h('div', { class: 'small dim' }, r.title ?? ''),
              r.read ? h('div', { class: 'small muted' }, r.read) : null),
            h('td', {},
              h('span', { class: `chip ${cls}`.trim() }, label),
              h('div', { class: 'small muted', style: { maxWidth: '28rem' } }, r.explanation)),
            h('td', {}, r.associations.length
              ? r.associations.map((a) => h('a', { class: 'chip', href: `#/associations/${a.association_id}`, style: { marginRight: '0.25rem' } }, a.label))
              : h('span', { class: 'dim' }, '—')),
            h('td', {}, actions));
        })))));
    })
    .catch((err) => {
      clear(body).append(h('div', { class: 'empty' }, `Could not trace Google’s results: ${err.message}`));
    });

  load();
  return panel;
}
