import { h, api, fmt, colourFor, disclaimer, navigate } from '../app.js';
import { timeControl } from './entity.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, ...children) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(3)) if (c) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
};

const EDGE_COLOUR = { negative: '#f2726b', positive: '#5fd48a', 'mixed/neutral': '#5a6472', unknown: '#3a3f4a' };

/**
 * §46 — the entity graph.
 *
 * Radial rather than force-directed: with one centre and its associations, a
 * force simulation spends its effort re-deriving a layout we already know, and
 * a stable arrangement makes the year slider legible — nodes move because the
 * data moved, not because the simulation re-settled.
 */
function drawGraph(centreLabel, nodes, { width = 900, height = 620 } = {}) {
  const cx = width / 2;
  const cy = height / 2;
  const max = Math.max(1, ...nodes.map((n) => n.size));
  const ordered = nodes.slice().sort((a, b) => b.size - a.size);

  // Strongest associations sit closest to the centre; weak ones drift out.
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img' });
  const rings = svgEl('g');
  for (const r of [140, 220, 290]) {
    rings.append(svgEl('circle', { cx, cy, r, fill: 'none', stroke: '#1c2029', 'stroke-dasharray': '3 6' }));
  }
  svg.append(rings);

  const edges = svgEl('g');
  const nodeGroup = svgEl('g');

  ordered.forEach((node, index) => {
    const angle = (index / ordered.length) * Math.PI * 2 - Math.PI / 2;
    const strength = node.size / max;
    const radius = 120 + (1 - strength) * 175;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    const r = 7 + strength * 26;
    const colour = EDGE_COLOUR[node.sentiment] ?? EDGE_COLOUR.unknown;

    edges.append(svgEl('line', {
      x1: cx, y1: cy, x2: x, y2: y,
      stroke: colour,
      'stroke-width': Math.max(1, strength * 7),
      'stroke-opacity': 0.45,
    }));
    edges.append(svgEl('text', {
      x: cx + Math.cos(angle) * (radius * 0.55),
      y: cy + Math.sin(angle) * (radius * 0.55) - 3,
      fill: '#6b7482', 'font-size': 9, 'text-anchor': 'middle',
    }, Math.round(node.size)));

    const group = svgEl('g', {
      class: 'graph-node',
      onclick: () => node.association_id && navigate(`#/associations/${node.association_id}`),
    }, svgEl('title', {}, `${node.label} — ${node.detail ?? ''}`));
    group.append(svgEl('circle', {
      cx: x, cy: y, r,
      fill: colourFor(node.label), 'fill-opacity': 0.28,
      stroke: colourFor(node.label), 'stroke-width': 1.5,
    }));
    const anchor = Math.cos(angle) > 0.25 ? 'start' : Math.cos(angle) < -0.25 ? 'end' : 'middle';
    const dx = anchor === 'start' ? r + 5 : anchor === 'end' ? -(r + 5) : 0;
    const dy = anchor === 'middle' ? (Math.sin(angle) > 0 ? r + 13 : -(r + 7)) : 4;
    group.append(svgEl('text', { x: x + dx, y: y + dy, 'text-anchor': anchor }, node.label));
    nodeGroup.append(group);
  });

  svg.append(edges, nodeGroup);
  const centre = svgEl('g', { class: 'graph-center' });
  centre.append(svgEl('circle', { cx, cy, r: 42, fill: '#1e2a3d', stroke: '#6ea8fe', 'stroke-width': 2 }));
  for (const [i, line] of wrapLabel(centreLabel).entries()) {
    centre.append(svgEl('text', { x: cx, y: cy + 4 + i * 14 - (wrapLabel(centreLabel).length - 1) * 7, 'text-anchor': 'middle' }, line));
  }
  svg.append(centre);
  return svg;
}

function wrapLabel(label) {
  const words = String(label).split(' ');
  if (words.length < 3) return words.length === 2 ? words : [label];
  return [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')];
}

export async function graphView({ params, query }) {
  const [graph, timeline] = await Promise.all([
    api(`/api/entities/${params.id}/graph?${new URLSearchParams(
      Object.fromEntries([...query].filter(([k]) => ['window', 'half_life'].includes(k)))
    )}`),
    api(`/api/entities/${params.id}/timeline?months=120`),
  ]);

  // Years available from the timeline, for the §46 slider.
  const years = [...new Set(timeline.timeline.map((p) => p.month.slice(0, 4)))].sort();
  const container = h('div', { class: 'graph-wrap' });
  const caption = h('div', { class: 'small muted', style: { padding: '0.5rem 0.2rem 0' } });

  const showCurrent = () => {
    container.replaceChildren(drawGraph(graph.center.label, graph.nodes.map((n) => ({
      association_id: n.association_id,
      label: n.label,
      size: n.size,
      sentiment: n.sentiment,
      detail: `PIAS ${fmt.score(n.size)}, current ${fmt.score(n.current)}`,
    }))));
    caption.textContent = 'Node size and edge thickness: PIAS over the selected window. Edge colour: sentiment. Click a node for its evidence.';
  };

  const showYear = (year) => {
    const months = timeline.timeline.filter((p) => p.month.startsWith(year));
    const totals = new Map();
    for (const point of months) {
      for (const a of point.associations) {
        const entry = totals.get(a.association_id) ?? { label: a.label, evidence: 0, association_id: a.association_id };
        entry.evidence += a.evidence;
        totals.set(a.association_id, entry);
      }
    }
    const rows = [...totals.values()].sort((a, b) => b.evidence - a.evidence).slice(0, 18);
    const max = Math.max(1, ...rows.map((r) => r.evidence));
    const sentimentByLabel = new Map(graph.nodes.map((n) => [n.label, n.sentiment]));

    if (!rows.length) {
      container.replaceChildren(h('div', { class: 'empty' }, `No dated evidence in ${year}.`));
      caption.textContent = '';
      return;
    }
    container.replaceChildren(drawGraph(`${graph.center.label} · ${year}`, rows.map((r) => ({
      association_id: r.association_id,
      label: r.label,
      size: (r.evidence / max) * 100,
      sentiment: sentimentByLabel.get(r.label) ?? 'unknown',
      detail: `${year}: evidence weight ${r.evidence.toFixed(2)}`,
    }))));
    caption.textContent = `Entity state as observed in ${year}: node size is that year's share of association evidence weight, not the current PIAS.`;
  };

  const slider = h('input', {
    type: 'range', min: 0, max: String(years.length), value: String(years.length), step: 1,
    oninput: (e) => {
      const index = Number(e.target.value);
      yearLabel.textContent = index === years.length ? 'Now (model)' : years[index];
      if (index === years.length) showCurrent();
      else showYear(years[index]);
    },
  });
  const yearLabel = h('span', { class: 'mono', style: { minWidth: '6.5rem', display: 'inline-block' } }, 'Now (model)');

  showCurrent();

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, `${graph.center.label} — association graph`),
        h('div', { class: 'sub' }, `${graph.nodes.length} associations`))
    ),
    disclaimer(),
    timeControl(query),
    h('div', { class: 'panel' },
      h('h2', {}, 'Entity graph'),
      h('div', { class: 'panel-body' },
        container,
        caption,
        years.length
          ? h('div', { class: 'toolbar', style: { marginTop: '0.9rem' } },
              h('span', { class: 'small dim' }, years[0]),
              h('div', { style: { flex: '1 1 auto' } }, slider),
              h('span', { class: 'small dim' }, 'now'),
              yearLabel
            )
          : null
      )
    )
  );
}

/** §47 — association share by month. */
export async function timelineView({ params }) {
  const { timeline } = await api(`/api/entities/${params.id}/timeline?months=120`);
  if (!timeline.length) {
    return h('div', {}, h('h1', {}, 'Timeline'), h('div', { class: 'panel' }, h('div', { class: 'empty' }, 'No dated evidence yet.')));
  }

  const labels = new Map();
  for (const point of timeline) for (const a of point.associations) labels.set(a.label, (labels.get(a.label) ?? 0) + a.evidence);
  const top = [...labels.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([label]) => label);

  const rows = timeline.map((point) => {
    const bars = h('div', { class: 'timeline-bars' });
    let other = 0;
    for (const a of point.associations) {
      if (!top.includes(a.label)) { other += a.share; continue; }
      bars.append(h('div', {
        style: { width: `${(a.share * 100).toFixed(2)}%`, background: colourFor(a.label) },
        title: `${point.month} — ${a.label}: ${fmt.pct(a.share)} of the month's evidence (${a.documents} documents)`,
      }));
    }
    if (other > 0.001) bars.append(h('div', { style: { width: `${(other * 100).toFixed(2)}%`, background: '#333944' }, title: 'other associations' }));
    return h('div', { class: 'timeline-row' },
      h('span', { class: 'month' }, point.month),
      bars,
      h('span', { class: 'small dim', style: { width: '3.5rem', textAlign: 'right' } }, point.associations.reduce((a, b) => a + b.documents, 0))
    );
  });

  return h('div', {},
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Timeline'),
      h('div', { class: 'sub' }, 'Association share of each month’s evidence weight. This is the picture of current-state replacement (§47).'))),
    disclaimer(),
    h('div', { class: 'panel' },
      h('h2', {}, 'Association share by month'),
      h('div', { class: 'panel-body' },
        h('div', { class: 'legend' }, top.map((label) =>
          h('span', {}, h('i', { style: { background: colourFor(label) } }), label))),
        rows
      )
    )
  );
}
