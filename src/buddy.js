export const LANGUAGES = ['en', 'es'];

const DIALOG_TEXT = {
  en: {
    language: 'Language', languages: { en: 'English', es: 'Español' },
    copy: 'Copy text', print: 'Print card', close: 'Close',
    plainText: 'Plain text for SMS or WhatsApp',
  },
  es: {
    language: 'Idioma', languages: { en: 'Inglés', es: 'Español' },
    copy: 'Copiar texto', print: 'Imprimir tarjeta', close: 'Cerrar',
    plainText: 'Texto sin formato para SMS o WhatsApp',
  },
};

export function buddyDialogText(language) {
  return DIALOG_TEXT[LANGUAGES.includes(language) ? language : 'en'];
}

function localizedTierLabel(label, language) {
  if (language !== 'es') return label;
  return label.replace(/^(\d+)-yr$/, '$1 años').replace(/^custom\b/, 'personalizado');
}

const TEXT = {
  en: {
    title: 'Neighborhood buddy card',
    training: 'TRAINING EXERCISE ONLY',
    tier: (label, scale, modeLabel) => `Storm tier ${label} (rain scale x${scale}), ${modeLabel} travel`,
    pairTitle: (zone, buddy) => `${zone} paired with ${buddy}`,
    save: buddy => `Save the ${buddy} contact offline; text or call before storm minute 0.`,
    cutBefore: (zone, minute) => `Call or text before storm minute ${minute}: that is the first minute ${zone} can no longer verify a dry trip.`,
    neverCuts: zone => `${zone} keeps a verified dry window for the whole six-hour exercise; confirm contact on the hour anyway.`,
    lastSafe: (zone, minute, modeLabel) => `The last verified dry ${modeLabel} departure from ${zone} is storm minute ${minute}.`,
    noWindow: zone => `${zone} has no verified dry departure in this run. The plan is to shelter in place, stay above the ground floor, and keep contact.`,
    zoneCutsFirst: (zone, zoneMin, buddy) => `${zone} cuts first at minute ${zoneMin}, so ${buddy} should call ${zone} before then.`,
    buddyCutsFirst: (buddy, buddyMin, zone) => `${buddy} cuts first at minute ${buddyMin}, so ${zone} should call ${buddy} before then.`,
    zoneStaysOpen: (zone, buddy, buddyMin) => `${zone} never loses its verified window, so its callers focus on ${buddy} before minute ${buddyMin}.`,
    buddyStaysOpen: (buddy, zone) => `${buddy} never loses its verified window, so it is the safer caller for ${zone}.`,
    sameCut: minute => `Both zones cut at minute ${minute}: call before then and again after the peak.`,
    bothOpen: 'Both zones keep a verified dry window for the whole exercise; still confirm contact on the hour.',
    households: (zone, n, buddy, m) => `The exercise counts ${n} households in ${zone} and ${m} in ${buddy}.`,
    before: 'Text or call your buddy before the rain starts, again before your zone\'s first cut minute, and once more after the peak passes.',
    flood: 'Never enter floodwater to reach a buddy. If the road is flooded, stay put and wait for official help.',
    notice: 'Fictional simulation only. Not an evacuation instruction. Follow official emergency alerts.',
    car: 'by car',
    pedestrian: 'on foot',
  },
  es: {
    title: 'Tarjeta de apoyo entre vecinos',
    training: 'SOLO PARA PRÁCTICA',
    tier: (label, scale, modeLabel) => `Nivel de tormenta ${label} (escala de lluvia x${scale}), viaje ${modeLabel}`,
    pairTitle: (zone, buddy) => `${zone} en pareja con ${buddy}`,
    save: buddy => `Guarde el contacto de ${buddy} sin conexión; escriba o llame antes del minuto 0 de la tormenta.`,
    cutBefore: (zone, minute) => `Llame o escriba antes del minuto ${minute} de la tormenta: es el primer minuto en que ${zone} ya no puede verificar un trayecto seco.`,
    neverCuts: zone => `${zone} conserva una ventana seca verificada durante todo el ejercicio de seis horas; confirme el contacto cada hora de todos modos.`,
    lastSafe: (zone, minute, modeLabel) => `La última salida seca verificada de ${zone} ${modeLabel} es en el minuto ${minute} de la tormenta.`,
    noWindow: zone => `${zone} no tiene una salida seca verificada en esta simulación. El plan es permanecer en el lugar, subir a un piso alto y mantener el contacto.`,
    zoneCutsFirst: (zone, zoneMin, buddy) => `${zone} se corta primero en el minuto ${zoneMin}, así que ${buddy} debe llamar a ${zone} antes de entonces.`,
    buddyCutsFirst: (buddy, buddyMin, zone) => `${buddy} se corta primero en el minuto ${buddyMin}, así que ${zone} debe llamar a ${buddy} antes de entonces.`,
    zoneStaysOpen: (zone, buddy, buddyMin) => `${zone} nunca pierde su ventana verificada, así que sus llamadas se centran en ${buddy} antes del minuto ${buddyMin}.`,
    buddyStaysOpen: (buddy, zone) => `${buddy} nunca pierde su ventana verificada, así que es quien llama con más seguridad para ${zone}.`,
    sameCut: minute => `Ambas zonas se cortan en el minuto ${minute}: llame antes de entonces y otra vez después del pico.`,
    bothOpen: 'Ambas zonas conservan una ventana seca verificada durante todo el ejercicio; aun así confirme el contacto cada hora.',
    households: (zone, n, buddy, m) => `El ejercicio cuenta ${n} hogares en ${zone} y ${m} en ${buddy}.`,
    before: 'Escriba o llame a su vecino antes de que empiece la lluvia, otra vez antes del primer minuto de corte de su zona, y una vez más después del pico.',
    flood: 'Nunca entre en aguas de inundación para llegar a un vecino. Si el camino está inundado, quédese en su lugar y espere ayuda oficial.',
    notice: 'Simulación ficticia. No es una orden de evacuación. Siga las alertas oficiales de emergencia.',
    car: 'en automóvil',
    pedestrian: 'a pie',
  },
};

function labelOf(graph, id) {
  return graph.nodes.find(node => node.id === id)?.label ?? id;
}

// Default mutual-aid pairing: each zone is paired with its nearest other zone
// by map distance, so suggested buddies can physically reach each other.
export function suggestBuddies(graph, origins) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const out = new Map();
  for (const id of origins) {
    const self = nodes.get(id);
    if (!self) continue;
    let best = null;
    let bestD = Infinity;
    for (const other of origins) {
      if (other === id) continue;
      const node = nodes.get(other);
      if (!node) continue;
      const d = Math.hypot(self.x - node.x, self.y - node.y);
      if (d < bestD) { bestD = d; best = other; }
    }
    if (best) out.set(id, best);
  }
  return out;
}

// One checklist block per zone, every timing read straight from the cutoff
// matrix so a tier, mode or mitigation change rewrites the plan honestly.
export function buddyModel({ graph, matrix, tierLabel, scale, mode, assignments, language }) {
  const lang = LANGUAGES.includes(language) ? language : 'en';
  const t = TEXT[lang];
  const modeLabel = t[mode] ?? t.car;
  const times = new Map((matrix?.rows ?? []).map(row => [row.origin, row]));
  const card = { lang, title: t.title, training: t.training, tier: t.tier(localizedTierLabel(tierLabel, lang), scale, modeLabel), pairs: [], shared: [t.before, t.flood, t.notice] };
  for (const row of matrix?.rows ?? []) {
    const zoneId = row.origin;
    const buddyId = assignments?.[zoneId];
    const buddy = times.get(buddyId);
    const zone = row.label ?? labelOf(graph, zoneId);
    const buddyLabel = buddy?.label ?? labelOf(graph, buddyId);
    const items = [t.save(buddyLabel)];
    if (row.firstCut === null) items.push(t.neverCuts(zone));
    else items.push(t.cutBefore(zone, row.firstCut));
    if (row.lastSafe === null) items.push(t.noWindow(zone));
    else items.push(t.lastSafe(zone, row.lastSafe, modeLabel));
    if (buddy) {
      const z = row.firstCut;
      const b = buddy.firstCut;
      if (z === null && b === null) items.push(t.bothOpen);
      else if (z === null) items.push(t.zoneStaysOpen(zone, buddyLabel, b));
      else if (b === null) items.push(t.buddyStaysOpen(buddyLabel, zone));
      else if (z < b) items.push(t.zoneCutsFirst(zone, z, buddyLabel));
      else if (b < z) items.push(t.buddyCutsFirst(buddyLabel, b, zone));
      else items.push(t.sameCut(z));
    }
    const zh = row.households ?? 0;
    const bh = buddy?.households ?? 0;
    if (zh > 0 || bh > 0) items.push(t.households(zone, zh, buddyLabel, bh));
    card.pairs.push({ zone, buddy: buddyLabel, items });
  }
  return card;
}

// Plain-text export for SMS, WhatsApp or a printed fridge copy.
export function buddyText(card) {
  const lines = [
    `${card.title.toUpperCase()} - ${card.training}`,
    card.tier,
    '',
  ];
  for (const pair of card.pairs) {
    lines.push(`${pair.zone} <> ${pair.buddy}`);
    for (const item of pair.items) lines.push(`  - ${item}`);
    lines.push('');
  }
  for (const item of card.shared) lines.push(`- ${item}`);
  return lines.join('\n');
}

function add(parent, tag, className, text) {
  const el = parent.ownerDocument.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  parent.appendChild(el);
  return el;
}

// Builds the printable card with textContent only; no markup from model data.
export function renderBuddy(target, card) {
  target.textContent = '';
  target.lang = card.lang;
  add(target, 'h1', 'card-title', card.title);
  add(target, 'p', 'card-training', card.training);
  add(target, 'p', 'card-status', card.tier);
  for (const pair of card.pairs) {
    add(target, 'h2', 'buddy-pair', pair.zone + ' <> ' + pair.buddy);
    const list = add(target, 'ul', 'card-legs');
    for (const item of pair.items) add(list, 'li', null, item);
  }
  const shared = add(target, 'ul', 'card-legs buddy-shared');
  for (const item of card.shared) add(shared, 'li', null, item);
}
