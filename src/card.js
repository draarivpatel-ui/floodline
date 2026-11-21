export const LANGUAGES = ['en', 'es'];

const TEXT = {
  en: {
    title: 'Family evacuation card',
    training: 'TRAINING EXERCISE ONLY',
    from: 'From',
    to: 'To',
    statusDry: 'DRY ROUTE AT STORM MINUTE',
    statusWetTrip: 'NO USABLE TRIP AT STORM MINUTE',
    statusUnreachable: 'UNREACHABLE AT STORM MINUTE',
    cutoffOpen: 'No modeled closure during this run',
    cutoffPast: 'Departure cutoff is not available for the current continuous window',
    cutoffAt: value => `Depart by storm minute ${value}`,
    follow: (road, place) => `Follow ${road} toward ${place}`,
    travel: mode => mode === 'car' ? 'By car' : 'On foot',
    wetTrip: 'No usable trip on the displayed route: it floods during travel. Do not enter floodwater.',
    fallback: 'No dry exit in this exercise. Do not enter floodwater. Follow official directions and move to higher ground if instructed.',
    warning: 'Never enter floodwater. If you reach a flooded road, turn around. Follow official emergency instructions.',
    notice: 'Fictional simulation only. Not an evacuation instruction. Follow official emergency alerts.',
  },
  es: {
    title: 'Tarjeta familiar de evacuación',
    training: 'SOLO PARA PRÁCTICA',
    from: 'Desde',
    to: 'Hacia',
    statusDry: 'RUTA SECA EN EL MINUTO',
    statusWetTrip: 'SIN TRAYECTO ÚTIL EN EL MINUTO',
    statusUnreachable: 'INACCESIBLE EN EL MINUTO',
    cutoffOpen: 'Sin cierre modelado durante esta simulación',
    cutoffPast: 'El límite de salida no está disponible para la ventana continua actual',
    cutoffAt: value => `Salga antes del minuto ${value} de la tormenta`,
    follow: (road, place) => `Siga ${road} hacia ${place}`,
    travel: mode => mode === 'car' ? 'En automóvil' : 'A pie',
    wetTrip: 'No hay trayecto útil en la ruta mostrada: se inunda durante el viaje. No entre en aguas de inundación.',
    fallback: 'No hay salida seca en este ejercicio. No entre en aguas de inundación. Siga las indicaciones oficiales y diríjase a un lugar más alto si se lo indican.',
    warning: 'Nunca entre en aguas de inundación. Si llega a un camino cubierto de agua, dé la vuelta. Siga las instrucciones oficiales de emergencia.',
    notice: 'Simulación ficticia. No es una orden de evacuación. Siga las alertas oficiales de emergencia.',
  },
};

function round(value, digits = 1) {
  return Number(value.toFixed(digits));
}

// All times count from storm start, never from the local clock.
export function cardModel(model, minute, origin, mode, view, language) {
  const lang = LANGUAGES.includes(language) ? language : 'en';
  const t = TEXT[lang];
  const originNode = model.preset.graph.nodes.find(node => node.id === origin);
  const card = {
    lang,
    title: t.title,
    training: t.training,
    origin: originNode?.label ?? origin,
    shelter: null,
    status: '',
    cutoff: null,
    legs: [],
    warning: `${t.warning} ${t.notice}`,
  };
  if (!view.dry) {
    card.status = `${t.statusUnreachable} ${round(minute)}`;
    card.warning = `${t.fallback} ${t.notice}`;
    return card;
  }
  if (!view.tripDry) {
    card.status = `${t.statusWetTrip} ${round(minute)}`;
    card.warning = `${t.wetTrip} ${t.notice}`;
    return card;
  }
  card.status = `${t.statusDry} ${round(minute)} · ${t.travel(mode)}`;
  card.shelter = view.dry.shelter.label;
  if (view.departureCutoff === null) {
    card.cutoff = t.cutoffOpen;
  } else if (view.departureCutoff < minute) {
    card.cutoff = t.cutoffPast;
  } else {
    const fmt = new Intl.NumberFormat(lang, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
    card.cutoff = t.cutoffAt(fmt.format(Math.floor(view.departureCutoff * 10) / 10));
  }
  card.legs = view.dry.edges.map((edge, index) => {
    const next = model.preset.graph.nodes.find(node => node.id === view.dry.nodes[index + 1]);
    return t.follow(edge.label, next?.label ?? view.dry.nodes[index + 1]);
  });
  return card;
}

function add(parent, tag, className, text) {
  const el = parent.ownerDocument.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  parent.appendChild(el);
  return el;
}

// Builds the printable card with textContent only; no markup from model data.
export function renderCard(target, card) {
  target.textContent = '';
  target.lang = card.lang;
  const t = TEXT[card.lang] ?? TEXT.en;
  add(target, 'h1', 'card-title', card.title);
  add(target, 'p', 'card-training', card.training);
  const meta = add(target, 'p', 'card-meta');
  const strongFrom = add(meta, 'strong', null, `${t.from}: `);
  strongFrom.after(card.origin);
  if (card.shelter) {
    const strongTo = add(meta, 'strong', 'card-to', `${t.to}: `);
    strongTo.after(card.shelter);
  }
  add(target, 'p', 'card-status', card.status);
  if (card.cutoff) add(target, 'p', 'card-cutoff', card.cutoff);
  if (card.legs.length) {
    const list = add(target, 'ol', 'card-legs');
    for (const leg of card.legs) add(list, 'li', null, leg);
  }
  add(target, 'p', 'card-warning', card.warning);
}
