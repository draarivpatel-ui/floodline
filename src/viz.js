const NS = 'http://www.w3.org/2000/svg';
const UI_FONT = "'Gill Sans','Gill Sans MT','Trebuchet MS',sans-serif";
const MONO_FONT = "Menlo,Consolas,monospace";

function el(tag, attrs = {}, parent) {
  const node = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  parent?.appendChild(node);
  return node;
}

function drawText(parent, x, y, content, attrs = {}) {
  const node = el('text', { x, y, 'font-family': UI_FONT, ...attrs }, parent);
  node.textContent = content;
  return node;
}

function pathFromNodes(nodes, ids) {
  const map = new Map(nodes.map(node => [node.id, node]));
  return ids.map((id, index) => {
    const node = map.get(id);
    return `${index === 0 ? 'M' : 'L'}${node.x.toFixed(1)},${node.y.toFixed(1)}`;
  }).join(' ');
}

// The channel is authored un-sheared, then skewed by the same rule presets.js applies to nodes.
function shearMatrix(shear) {
  return `matrix(1 0 ${(shear / 200).toFixed(4)} 1 ${(-shear).toFixed(1)} 0)`;
}

export function renderMap(svg, model, view, origin, minute) {
  const graph = model.preset.graph;
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const shear = graph.shear ?? 0;
  const stage = view.stage;
  const bankfull = model.active.channel.bankfull;
  const overbank = Math.max(0, stage - bankfull);

  svg.textContent = '';
  svg.setAttribute('viewBox', '0 0 840 415');
  svg.setAttribute('role', 'img');
  const title = el('title', {}, svg);
  title.textContent = 'Synthetic training basin map';
  const wetCount = graph.edges.filter(edge => (view.depths.get(edge.id) ?? 0) > 0).length;
  const desc = el('desc', {}, svg);
  desc.textContent = `Stylized fictional basin at storm minute ${minute}: ${wetCount} of ${graph.edges.length} roads flooded, ${view.dry ? 'a dry modeled route is shown' : 'no dry modeled route is available'}.`;

  const defs = el('defs', {}, svg);
  const hatch = el('pattern', { id: 'park-hatch', width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
  el('rect', { width: 7, height: 7, fill: '#163a38' }, hatch);
  el('line', { x1: 0, y1: 0, x2: 0, y2: 7, stroke: '#27514b', 'stroke-width': 1.6 }, hatch);

  el('rect', { x: 0, y: 0, width: 840, height: 415, fill: '#112f31' }, svg);

  const grid = el('g', { stroke: '#1c4643', 'stroke-width': 0.5, 'aria-hidden': 'true' }, svg);
  for (let x = 84; x < 840; x += 84) el('line', { x1: x, y1: 0, x2: x, y2: 415 }, grid);
  for (let y = 83; y < 415; y += 83) el('line', { x1: 0, y1: y, x2: 840, y2: y }, grid);

  const terrain = el('g', { 'aria-hidden': 'true' }, svg);
  el('path', { d: 'M-20,60 C120,20 240,42 330,86 C430,20 560,10 690,40 C770,58 830,40 870,30 L870,-30 L-20,-30 Z', fill: '#173f3c' }, terrain);
  el('path', { d: 'M-20,300 C90,330 190,300 290,330 C400,380 520,350 640,370 C740,390 810,370 870,390 L870,445 L-20,445 Z', fill: '#173f3c' }, terrain);
  const contours = el('g', { fill: 'none', stroke: '#2c5a52', 'stroke-width': 1, opacity: 0.75, 'aria-hidden': 'true' }, svg);
  el('path', { d: 'M-10,84 C110,50 240,66 340,108 C450,44 570,34 700,62 C780,78 840,60 880,52' }, contours);
  el('path', { d: 'M-10,112 C100,82 230,96 330,136 C440,74 560,62 700,88 C780,104 840,88 880,80' }, contours);
  el('path', { d: 'M-10,286 C100,318 200,286 300,318 C410,368 530,336 650,356 C750,376 820,356 880,376' }, contours);
  el('path', { d: 'M-10,258 C110,292 210,258 310,292 C420,342 540,310 660,330 C760,350 830,330 880,350' }, contours);

  const parks = el('g', { 'aria-hidden': 'true' }, svg);
  el('path', { d: 'M120,150 L210,140 L236,196 L150,214 Z', fill: 'url(#park-hatch)', stroke: '#2f5f57', 'stroke-width': 1 }, parks);
  el('path', { d: 'M600,236 L706,222 L734,286 L628,300 Z', fill: 'url(#park-hatch)', stroke: '#2f5f57', 'stroke-width': 1 }, parks);

  const channel = el('g', { transform: shearMatrix(shear), 'aria-hidden': 'true' }, svg);
  const bed = 'M322,-26 C352,68 414,138 428,208 C442,278 482,342 502,441';
  if (overbank > 0) {
    el('path', { d: bed, fill: 'none', stroke: '#409eaa', 'stroke-width': Math.min(219, 34 + overbank * 90), 'stroke-linecap': 'round', opacity: Math.min(0.4, 0.16 + overbank * 0.12) }, channel);
  }
  el('path', { d: bed, fill: 'none', stroke: '#2b7d8b', 'stroke-width': 34, 'stroke-linecap': 'round' }, channel);
  el('path', { d: bed, fill: 'none', stroke: '#409eaa', 'stroke-width': 24, 'stroke-linecap': 'round' }, channel);
  el('path', { d: bed, fill: 'none', stroke: '#57b7c4', 'stroke-width': 1.2, 'stroke-dasharray': '2 7', opacity: 0.8 }, channel);

  const roads = el('g', {}, svg);
  for (const edge of graph.edges) {
    const a = nodes.get(edge.a);
    const b = nodes.get(edge.b);
    el('line', {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      stroke: '#6d8a7c', 'stroke-width': edge.bridge ? 3.4 : 2.4,
      'stroke-linecap': 'round', opacity: 0.85,
    }, roads);
  }
  const wet = el('g', {}, svg);
  for (const edge of graph.edges) {
    const depth = view.depths.get(edge.id) ?? 0;
    if (depth <= 0) continue;
    const a = nodes.get(edge.a);
    const b = nodes.get(edge.b);
    el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: '#0c2a29', 'stroke-width': 7, 'stroke-linecap': 'round' }, wet);
    el('line', {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: '#ffb279',
      'stroke-width': 3.4, 'stroke-dasharray': '8 5', 'stroke-linecap': 'round',
    }, wet);
  }
  if (view.naive) {
    el('path', {
      d: pathFromNodes(graph.nodes, view.naive.nodes), fill: 'none',
      stroke: '#efdfae', 'stroke-width': 2.2, 'stroke-dasharray': '4 5',
      'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: 0.95,
    }, roads);
  }
  if (view.dry) {
    const d = pathFromNodes(graph.nodes, view.dry.nodes);
    el('path', { d, fill: 'none', stroke: '#0c2a29', 'stroke-width': 8.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, roads);
    el('path', {
      d, fill: 'none', stroke: view.tripDry === true ? '#bdeba7' : '#8fbf83', 'stroke-width': 4.6,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      'stroke-dasharray': view.tripDry === true ? 'none' : '10 6',
    }, roads);
  }

  const places = el('g', {}, svg);
  for (const node of graph.nodes) {
    if (node.type === 'junction') {
      el('circle', { cx: node.x, cy: node.y, r: 2.2, fill: '#8aa396' }, places);
      continue;
    }
    const anchorRight = node.x > 640;
    const lx = anchorRight ? node.x - 12 : node.x + 12;
    const anchor = anchorRight ? 'end' : 'start';
    if (node.type === 'shelter') {
      el('circle', { cx: node.x, cy: node.y, r: 8, fill: '#123c3a', stroke: '#bdeba7', 'stroke-width': 2 }, places);
      el('path', { d: `M${node.x - 4},${node.y} h8 M${node.x},${node.y - 4} v8`, stroke: '#bdeba7', 'stroke-width': 2.4 }, places);
      drawText(places, lx, node.y + 3.5, node.label, { 'font-size': 11.5, 'font-weight': 'bold', fill: '#d9f2c4', 'text-anchor': anchor });
    } else if (node.type === 'school') {
      el('line', { x1: node.x, y1: node.y, x2: node.x, y2: node.y - 13, stroke: '#e8efe6', 'stroke-width': 1.6 }, places);
      el('path', { d: `M${node.x},${node.y - 13} l9,3.4 l-9,3.4 Z`, fill: '#ffb279' }, places);
      el('circle', { cx: node.x, cy: node.y, r: 3, fill: '#e8efe6' }, places);
      drawText(places, lx, node.y + 15, node.label, { 'font-size': 10.5, fill: '#e8efe6', 'text-anchor': anchor });
    } else if (node.type === 'home') {
      el('path', { d: `M${node.x - 6},${node.y + 1} l6,-6 l6,6 v6 h-12 Z`, fill: '#dce8dd', stroke: '#112f31', 'stroke-width': 1 }, places);
      drawText(places, lx, node.y + 4, node.label, { 'font-size': 10.5, fill: '#e8efe6', 'text-anchor': anchor });
    }
  }
  const roadLabels = el('g', {}, svg);
  for (const [id, color] of [['underpass', '#ffb279'], ['ridge-bridge', '#bdeba7']]) {
    const edge = graph.edges.find(item => item.id === id);
    if (!edge) continue;
    const a = nodes.get(edge.a);
    const b = nodes.get(edge.b);
    drawText(roadLabels, (a.x + b.x) / 2, (a.y + b.y) / 2 - 10, edge.label, {
      'font-size': 12, fill: color, 'text-anchor': 'middle',
      'paint-order': 'stroke', stroke: '#112f31', 'stroke-width': 3,
    });
  }

  const originNode = nodes.get(origin);
  if (originNode) {
    el('circle', { cx: originNode.x, cy: originNode.y, r: 13, fill: 'none', stroke: '#bdeba7', 'stroke-width': 2.2, 'stroke-dasharray': '3 3' }, places);
    drawText(places, originNode.x, originNode.y - 20, 'START', {
      'font-size': 9, 'font-weight': 'bold', fill: '#bdeba7', 'text-anchor': 'middle', 'letter-spacing': '0.16em',
    });
  }

  const legend = el('g', { 'aria-hidden': 'true' }, svg);
  el('rect', { x: 12, y: 12, width: 168, height: 88, fill: '#0c302f', stroke: '#3d6a5f', 'stroke-width': 1, opacity: 0.92 }, legend);
  const legendRows = [
    ['#bdeba7', 'none', 4.4, 'Dry modeled route'],
    ['#efdfae', '4 4', 2.2, 'Shortest route'],
    ['#ffb279', '7 4', 3.2, 'Flooded road'],
    ['#409eaa', 'none', 4.4, 'Channel'],
  ];
  legendRows.forEach(([color, dash, width, label], i) => {
    const y = 28 + i * 19;
    el('line', { x1: 22, y1: y, x2: 50, y2: y, stroke: color, 'stroke-width': width, 'stroke-dasharray': dash, 'stroke-linecap': 'round' }, legend);
    drawText(legend, 58, y + 3.5, label, { 'font-size': 10, fill: '#dce8dd' });
  });

  const ornament = el('g', { 'aria-hidden': 'true' }, svg);
  drawText(ornament, 828, 24, 'N', { 'font-size': 12, 'font-weight': 'bold', fill: '#9db4a6', 'text-anchor': 'end' });
  el('path', { d: 'M822,32 l6,-14 l6,14 l-6,-4 Z', fill: '#9db4a6', transform: 'translate(-6 6)' }, ornament);
  const barY = 398;
  el('line', { x1: 700, y1: barY, x2: 750, y2: barY, stroke: '#9db4a6', 'stroke-width': 3 }, ornament);
  for (const [x, label] of [[700, '0'], [725, '100'], [750, '200 m']]) {
    el('line', { x1: x, y1: barY - 4, x2: x, y2: barY + 4, stroke: '#9db4a6', 'stroke-width': 1.4 }, ornament);
    drawText(ornament, x, barY - 8, label, { 'font-size': 9, fill: '#9db4a6', 'text-anchor': 'middle', 'font-family': MONO_FONT });
  }
  drawText(ornament, 650, 398, 'SYNTHETIC TRAINING BASIN', {
    'font-size': 8.5, fill: '#5d8276', 'text-anchor': 'end', 'letter-spacing': '0.2em',
  });
  drawText(ornament, 12, 404, `storm minute ${Math.round(minute)}`, {
    'font-size': 9, fill: '#5d8276', 'font-family': MONO_FONT,
  });
}

function niceCeil(value) {
  if (value <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(value));
  for (const mult of [1, 2, 2.5, 5, 10]) if (mult * mag >= value) return mult * mag;
  return 10 * mag;
}

export function renderHydrograph(svg, model, minute) {
  const sim = model.active;
  const W = 840;
  const H = 168;
  const m = { left: 48, right: 60, top: 14, bottom: 30 };
  const pw = W - m.left - m.right;
  const ph = H - m.top - m.bottom;
  const tMax = 360;
  const qMax = niceCeil(Math.max(sim.peakQ, model.baseline.peakQ, sim.bankfullQ) * 1.06);
  const sMax = niceCeil(Math.max(sim.peakStage, sim.channel.bankfull) * 1.06);
  const x = t => m.left + (t / tMax) * pw;
  const yq = v => m.top + ph - (v / qMax) * ph;
  const ys = v => m.top + ph - (v / sMax) * ph;

  svg.textContent = '';
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  const title = el('title', {}, svg);
  title.textContent = 'Discharge and stage hydrograph';
  const desc = el('desc', {}, svg);
  desc.textContent = `Modeled discharge in cubic meters per second and stage in meters over ${tMax} minutes, cursor at minute ${minute}.`;

  el('rect', { x: 0, y: 0, width: W, height: H, fill: '#fffdf7' }, svg);
  const grid = el('g', { stroke: '#e2e3d3', 'stroke-width': 1, 'aria-hidden': 'true' }, svg);
  for (let t = 0; t <= tMax; t += 60) el('line', { x1: x(t), y1: m.top, x2: x(t), y2: m.top + ph }, grid);
  const qTicks = 4;
  for (let i = 0; i <= qTicks; i += 1) {
    const v = (qMax / qTicks) * i;
    el('line', { x1: m.left, y1: yq(v), x2: m.left + pw, y2: yq(v) }, grid);
    drawText(svg, m.left - 8, yq(v) + 3.5, String(Number(v.toFixed(2))), { 'font-size': 9.5, fill: '#465f57', 'text-anchor': 'end', 'font-family': MONO_FONT });
    const sv = (sMax / qTicks) * i;
    drawText(svg, m.left + pw + 8, ys(sv) + 3.5, String(Number(sv.toFixed(2))), { 'font-size': 9.5, fill: '#b06a3a', 'text-anchor': 'start', 'font-family': MONO_FONT });
  }
  for (let t = 0; t <= tMax; t += 60) {
    drawText(svg, x(t), m.top + ph + 16, String(t), { 'font-size': 9.5, fill: '#465f57', 'text-anchor': 'middle', 'font-family': MONO_FONT });
  }
  drawText(svg, m.left, m.top - 4, 'discharge m³/s', { 'font-size': 9.5, fill: '#2f7f8a' });
  const stageLabel = drawText(svg, m.left + pw, m.top - 4, 'stage m', { 'font-size': 9.5, fill: '#b06a3a' });
  stageLabel.setAttribute('text-anchor', 'end');
  const axisLabel = drawText(svg, m.left + pw / 2, H - 4, 'minutes from storm start', { 'font-size': 9.5, fill: '#465f57' });
  axisLabel.setAttribute('text-anchor', 'middle');

  const upto = Math.min(sim.q.length - 1, tMax);
  const series = (values, mapY) => {
    let d = `M${x(0).toFixed(1)},${mapY(values[0]).toFixed(1)}`;
    for (let i = 1; i <= upto; i += 1) d += `L${x(i).toFixed(1)},${mapY(values[i]).toFixed(1)}`;
    return d;
  };

  if (model.baseline !== model.active) {
    el('path', { d: series(model.baseline.q, yq), fill: 'none', stroke: '#8fa094', 'stroke-width': 1.2, 'stroke-dasharray': '4 4' }, svg);
    drawText(svg, m.left + pw - 4, yq(model.baseline.peakQ) - 6, 'before mitigation', { 'font-size': 9, fill: '#8fa094', 'text-anchor': 'end' });
  }

  const qPath = series(sim.q, yq);
  el('path', { d: `${qPath}L${x(upto).toFixed(1)},${yq(0).toFixed(1)}L${x(0).toFixed(1)},${yq(0).toFixed(1)}Z`, fill: '#409eaa', opacity: 0.18 }, svg);
  el('path', { d: qPath, fill: 'none', stroke: '#2f7f8a', 'stroke-width': 1.9 }, svg);
  el('path', { d: series(sim.stage, ys), fill: 'none', stroke: '#d97b3f', 'stroke-width': 1.3, 'stroke-dasharray': '5 4' }, svg);

  const bankY = yq(sim.bankfullQ);
  el('line', { x1: m.left, y1: bankY, x2: m.left + pw, y2: bankY, stroke: '#a8563c', 'stroke-width': 1.1, 'stroke-dasharray': '7 5' }, svg);
  drawText(svg, m.left + 6, bankY - 4, `bankfull ${Number(sim.bankfullQ.toFixed(2))} m³/s`, { 'font-size': 9, fill: '#a8563c' });

  if (sim.peakMinute <= tMax) {
    el('circle', { cx: x(sim.peakMinute), cy: yq(sim.peakQ), r: 3.4, fill: '#142b2b' }, svg);
    drawText(svg, x(sim.peakMinute) + 7, yq(sim.peakQ) - 6, 'peak', { 'font-size': 9, fill: '#142b2b' });
  }

  const cx = x(Math.min(Math.max(minute, 0), tMax));
  el('line', { x1: cx, y1: m.top, x2: cx, y2: m.top + ph, stroke: '#142b2b', 'stroke-width': 1.4 }, svg);
  const qNow = sim.q[Math.min(Math.round(minute), sim.q.length - 1)];
  if (minute <= tMax) el('circle', { cx, cy: yq(qNow), r: 3, fill: '#142b2b' }, svg);
}

const HOUR_MARKS = [0, 60, 120, 180, 240, 300, 360];

// One strip per vulnerable zone: green while a departure at that storm minute
// can still be verified dry, red once departures can no longer be verified.
export function renderCutoffChart(svg, matrix, minute, selectedOrigin) {
  const W = 840;
  const m = { left: 118, right: 16, top: 14, bottom: 30 };
  const rowH = 32;
  const rows = matrix.rows;
  const H = m.top + rows.length * rowH + m.bottom;
  const pw = W - m.left - m.right;
  const tMax = matrix.tMax;
  const x = t => m.left + (t / tMax) * pw;

  svg.textContent = '';
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  const title = el('title', {}, svg);
  title.textContent = 'Evacuation cutoff timeline';
  const cut = rows.filter(row => row.firstCut !== null)
    .map(row => `${row.label} minute ${row.firstCut}`).join(', ');
  const desc = el('desc', {}, svg);
  desc.textContent = cut
    ? `Departure feasibility per zone over ${tMax} storm minutes. First failed departures: ${cut}.`
    : `Every zone can be verified dry through all ${tMax} storm minutes.`;

  el('rect', { x: 0, y: 0, width: W, height: H, fill: '#fffdf7' }, svg);
  const grid = el('g', { stroke: '#e2e3d3', 'stroke-width': 1, 'aria-hidden': 'true' }, svg);
  for (const mark of HOUR_MARKS) {
    el('line', { x1: x(mark), y1: m.top, x2: x(mark), y2: m.top + rows.length * rowH }, grid);
    drawText(svg, x(mark), m.top + rows.length * rowH + 16, `${mark / 60}h`, {
      'font-size': 9.5, fill: '#465f57', 'text-anchor': 'middle', 'font-family': MONO_FONT,
    });
  }
  const axis = drawText(svg, m.left + pw / 2, H - 3, 'hours from storm start', {
    'font-size': 9.5, fill: '#465f57',
  });
  axis.setAttribute('text-anchor', 'middle');

  rows.forEach((row, i) => {
    const gy = m.top + i * rowH;
    const g = el('g', { 'data-origin': row.origin }, svg);
    el('rect', { x: 0, y: gy, width: W, height: rowH, fill: 'transparent' }, g);
    drawText(g, m.left - 8, gy + rowH / 2 + 3.5, row.label, {
      'font-size': 10.5, fill: '#142b2b', 'text-anchor': 'end',
      'font-weight': row.origin === selectedOrigin ? 'bold' : 'normal',
    });
    el('rect', {
      x: m.left, y: gy + 9, width: pw, height: rowH - 18,
      fill: '#efece0', stroke: '#c3c9b9', 'stroke-width': 0.75,
    }, g);
    let runStart = 0;
    for (let t = 1; t <= row.feasible.length; t += 1) {
      if (t === row.feasible.length || row.feasible[t] !== row.feasible[runStart]) {
        el('rect', {
          x: x(runStart), y: gy + 9, width: Math.max(1, x(t) - x(runStart)), height: rowH - 18,
          fill: row.feasible[runStart] ? '#2d6e51' : '#a8563c',
        }, g);
        runStart = t;
      }
    }
    if (row.firstCut !== null) {
      const fx = x(row.firstCut);
      el('path', {
        d: `M${fx.toFixed(1)},${gy + 4} l4,6 h-8 Z`, fill: '#a8563c',
      }, g);
      const anchor = row.firstCut > tMax * 0.72 ? 'end' : 'start';
      drawText(g, fx + (anchor === 'end' ? -6 : 6), gy + 9, `min ${row.firstCut}`, {
        'font-size': 9, fill: '#a8563c', 'text-anchor': anchor, 'font-family': MONO_FONT,
      });
    }
    if (row.lastSafe === null) {
      drawText(g, x(4), gy + rowH / 2 + 3.5, 'no safe modeled departure', {
        'font-size': 9.5, fill: '#fffdf7', 'font-weight': 'bold',
      });
    }
  });

  const cx = x(Math.min(Math.max(minute, 0), tMax));
  el('line', {
    x1: cx, y1: m.top - 4, x2: cx, y2: m.top + rows.length * rowH,
    stroke: '#142b2b', 'stroke-width': 1.4,
  }, svg);
}
