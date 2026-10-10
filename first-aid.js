// Reviewed first-aid wording for CARAs and project documents, and checks for
// unsafe first-aid instructions in saved or AI-suggested text.
//
// Why: an AI-suggested CARA once said "For severe burns, apply cool water or
// ice". Ice is wrong (Australian guidance: cool running water for at least
// 20 minutes, no ice). Treatment steps must come from this reviewed library,
// not from free AI text. The AI is told not to write treatment steps, and any
// text (saved or suggested) is scanned with UNSAFE_PATTERNS.
//
// Maintenance: re-check each source and update `reviewed` dates at least
// yearly or when guidance changes. Bump LIBRARY_VERSION.

const LIBRARY_VERSION = '2026-10-10';

const SOURCES = {
  healthywa_burns: { title: 'HealthyWA — Burns first aid', url: 'https://www.healthywa.health.wa.gov.au/Articles/A_E/Burns-first-aid', reviewed: '2026-10-10' },
  redcross_burns: { title: 'Australian Red Cross — First aid for burns or scalds', url: 'https://redcross.org.au/firstaid/basics/burn', reviewed: '2026-10-10' },
  healthdirect_eye: { title: 'healthdirect — Eye injuries (last reviewed Feb 2025)', url: 'https://healthdirect.gov.au/eye-injuries', reviewed: '2026-10-10' },
  healthdirect_electric: { title: 'healthdirect — Electric shocks and burns (last reviewed Sep 2025)', url: 'https://healthdirect.gov.au/electric-shocks-and-burns', reviewed: '2026-10-10' },
  healthdirect_wounds: { title: 'healthdirect — Wound, cut and graze treatments (last reviewed Dec 2025)', url: 'https://www.healthdirect.gov.au/wound-cut-and-graze-treatments', reviewed: '2026-10-10' },
};

// Each entry: short, plain-text steps a teacher can insert. Not a substitute
// for first aid training; the person giving first aid follows their training.
const LIBRARY = [
  {
    key: 'burns', title: 'Burns and scalds (incl. welding/hot metal)', sources: ['healthywa_burns', 'redcross_burns'],
    text: [
      'Burns and scalds:',
      '- Cool the burn under cool running water for at least 20 minutes. Do not use ice.',
      '- Remove jewellery or clothing near the burn unless it is stuck to the skin.',
      '- Call 000 if the burn is larger than a 20 cent piece, deep, or on the face, airway, hands or genitals, or if unsure how severe it is.',
      '- Keep the person warm (cover unburnt areas); stop cooling if they become very cold and shiver.',
    ],
  },
  {
    key: 'eye_chemical', title: 'Chemical in the eye', sources: ['healthdirect_eye'],
    text: [
      'Chemical in the eye:',
      '- Call 000.',
      '- Flush the eye with cool water for 20 minutes, holding the eye open and keeping the chemical away from the other eye.',
      '- Do not put drops, ointment or medicines in the eye.',
    ],
  },
  {
    key: 'eye_particle', title: 'Particle or object in the eye', sources: ['healthdirect_eye'],
    text: [
      'Particle or object in the eye:',
      '- Do not rub the eye.',
      '- Do not try to remove an object stuck in the eye; get medical help straight away.',
      '- If gentle flushing does not remove a loose particle, cover the eye and get medical help.',
    ],
  },
  {
    key: 'electric_shock', title: 'Electric shock', sources: ['healthdirect_electric'],
    text: [
      'Electric shock:',
      '- Do not touch the person until the power is off. Switch off at the mains or isolator, or separate them using a dry non-conductive object.',
      '- Call 000 if they lost consciousness, have an irregular heartbeat or abnormal breathing, or fell.',
      '- If not breathing normally, start CPR.',
      '- Treat any electrical burn under cool running water for at least 20 minutes.',
    ],
  },
  {
    key: 'bleeding', title: 'Cuts and bleeding', sources: ['healthdirect_wounds'],
    text: [
      'Cuts and bleeding:',
      '- Press firmly on the wound and wrap it firmly with a pad or clean dressing.',
      '- Do not remove an embedded object; press around it and pad either side.',
      '- Call 000 if blood is spurting, bleeding is severe or will not stop with pressure, or something is stuck in the wound.',
    ],
  },
];

function libraryText(key) {
  const e = LIBRARY.find((x) => x.key === key);
  if (!e) return '';
  const src = e.sources.map((s) => SOURCES[s].title).join('; ');
  return `${e.text.join('\n')}\n(Source: ${src}; school first aid library ${LIBRARY_VERSION})`;
}

// Unsafe or outdated first-aid instructions. Each pattern is checked within a
// sentence/line, so "ice" elsewhere in a document is not a problem.
const UNSAFE_PATTERNS = [
  { id: 'burn_ice', fix: 'burns', re: /\b(burn|burns|burnt|scald|scalds)\b[^.\n]*\bice\b|\bice\b[^.\n]*\b(burn|burns|burnt|scald)\b/i,
    message: 'Burns: ice must not be used. Use cool running water for at least 20 minutes.' },
  { id: 'burn_remedy', fix: 'burns', re: /\b(burn|burns|burnt|scald)\b[^.\n]*\b(butter|toothpaste|oil|flour|egg white|cream|ointment|lotion)\b/i,
    message: 'Burns: do not apply butter, toothpaste, oils, creams or other remedies; cool with running water.' },
  { id: 'burn_short_cooling', fix: 'burns', re: /\b(burn|burns|scald)\b[^.\n]*\b(cool|water)\b[^.\n]*\b([1-9]|1[0-9])\s*(min|mins|minutes)\b/i,
    message: 'Burns: cooling should be at least 20 minutes.' },
  { id: 'eye_rub', fix: 'eye_particle', re: /\brub\b[^.\n]*\beyes?\b|\beyes?\b[^.\n]*\brub\b(?![^.\n]*\b(do not|don't|never|avoid)\b)/i,
    message: 'Eye injuries: do not rub the eye.', unlessNegated: true },
  { id: 'remove_embedded', fix: 'bleeding', re: /\b(remove|pull out|take out)\b[^.\n]*\b(embedded|impaled)\b|\b(remove|pull out|take out)\b[^.\n]*\bobject\b[^.\n]*\bstuck\b/i,
    message: 'Do not remove embedded objects.', unlessNegated: true },
  { id: 'shock_touch', fix: 'electric_shock', re: /\b(pull|grab|touch)\b[^.\n]*\b(person|casualty|student)\b[^.\n]*\b(electric|shock|live)\b/i,
    message: 'Electric shock: do not touch the person until the power is off.', unlessNegated: true },
];

const NEGATION = /\b(do not|don't|never|avoid|must not|no)\b/i;

function splitSentences(text) {
  return String(text || '').replace(/\r\n?/g, '\n').split(/\n|(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

// Returns [{id, message, sentence, fix}] for unsafe instructions in text.
function scanUnsafe(text) {
  const out = [];
  for (const sentence of splitSentences(text)) {
    for (const p of UNSAFE_PATTERNS) {
      if (!p.re.test(sentence)) continue;
      // "Do not use ice" is the correct advice, not a problem.
      if (p.id === 'burn_ice' && /\b(do not|don't|never|no|not|avoid)\b[^.\n]*\bice\b/i.test(sentence)) continue;
      if (p.id === 'burn_remedy' && /\b(do not|don't|never|no|not|avoid)\b/i.test(sentence)) continue;
      if (p.unlessNegated && NEGATION.test(sentence)) continue;
      out.push({ id: p.id, message: p.message, sentence, fix: p.fix });
    }
  }
  return out;
}

// Proposed correction: remove the unsafe sentences and append the reviewed
// library text (once). Returned for a person to review; never auto-applied.
function proposeCorrection(text) {
  const findings = scanUnsafe(text);
  if (!findings.length) return null;
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const kept = [];
  for (const line of lines) {
    let l = line;
    for (const f of findings) l = l.split(f.sentence).join('');
    if (line.trim() && !l.replace(/^\s*[-•*]\s*/, '').trim()) continue; // line was only the unsafe sentence
    kept.push(l.replace(/\s+$/, ''));
  }
  let t = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const keys = [...new Set(findings.map((f) => f.fix))];
  for (const k of keys) {
    if (!t.includes(LIBRARY.find((e) => e.key === k).text[1])) t = `${t}\n\n${libraryText(k)}`.trim();
  }
  return { findings, corrected: t };
}

// Guard: the reviewed library must never trip the unsafe-wording scanner.
for (const e of LIBRARY) {
  const bad = scanUnsafe(e.text.join('\n'));
  if (bad.length) throw new Error(`first-aid.js: library entry "${e.key}" is flagged by its own unsafe check: ${bad[0].sentence}`);
}

module.exports = { LIBRARY_VERSION, SOURCES, LIBRARY, libraryText, scanUnsafe, proposeCorrection, splitSentences };
