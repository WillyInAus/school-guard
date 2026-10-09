// Project rules checklist: the conditional questions asked on a CARA project,
// which answers point to a POSSIBLE legal SWMS trigger (high risk
// construction work), and the sources those rules come from.
//
// This is a maintained checklist, not a legal determination. It only flags
// things for a human reviewer: every trigger shows the supporting answer, the
// source and the reviewer's confirmation. The AI never decides these.
//
// Maintenance: when Queensland law, codes of practice or departmental CARA
// guidelines change, update SOURCES (url + reviewed date) and the rules below,
// and bump RULES_VERSION. Each project records the rules version it was
// assessed against.

const RULES_VERSION = '2026-10-10';

const SOURCES = {
  whs_reg: {
    title: 'Work Health and Safety Regulation 2011 (Qld) — Chapter 6 Construction work: s289 meaning of construction work, s291 meaning of high risk construction work, s299 SWMS',
    url: 'https://www.legislation.qld.gov.au/view/html/inforce/current/sl-2011-0240',
    reviewed: '2026-10-10',
    note: 'Version in force 29 March 2026 checked via the Queensland Legislation site. List of s291 categories taken from the model regulations as reproduced in the Construction Work Code of Practice (below); confirm wording against the Qld regulation itself.',
  },
  wsq_swms: {
    title: 'WorkSafe Queensland — Safe work method statements (guide)',
    url: 'https://worksafe.qld.gov.au/resources/guides/safe-work-method-statements',
    reviewed: '2026-10-10',
    note: 'Page last updated 15 Sep 2023. A PCBU carrying out high risk construction work must ensure a SWMS is prepared before the work starts. Examples: risk of falling more than 2 m; trench deeper than 1.5 m.',
  },
  cop_construction: {
    title: 'Construction Work Code of Practice (model code, reproduces reg 291 list and reg 289 exclusions)',
    url: 'https://www.legislation.gov.au/F2016L00394/asmade/2016-03-30/text/original/epub/OEBPS/document_1/document_1.html',
    reviewed: '2026-10-10',
    note: 'Used for the wording of the high risk construction work categories and construction work exclusions.',
  },
  wsq_silica: {
    title: 'WorkSafe Queensland — Managing respirable crystalline silica dust exposure in construction and manufacturing of construction elements Code of Practice 2022',
    url: 'https://www.worksafe.qld.gov.au/laws-and-compliance/codes-of-practice/managing-respirable-crystalline-silica-dust-exposure-in-construction-and-manufacturing-of-construction-elements-code-of-practice-2022',
    reviewed: '2026-10-10',
    note: 'Commenced 1 May 2023 (under review after 1 Sep 2024 crystalline silica changes). Construction work in an area that may have an RCS-contaminated atmosphere is high risk construction work requiring a SWMS (s3.1.1). Covers cutting, grinding, drilling of concrete, brick, block, tile.',
  },
  doe_workshop: {
    title: 'Department of Education (Qld) — CARA guideline: Practical workshop activities',
    url: 'https://education.qld.gov.au/curriculum/stages-of-schooling/CARA/activity-guidelines/practical-workshop-activities',
    reviewed: '2026-10-10',
    note: 'Guideline review date 24 Sep 2025. Risk level set by the highest-risk plant/equipment/materials. No SWMS guidance. Faith Lutheran is not a state school; DoE guidelines used as good-practice reference.',
  },
  doe_ag_construction: {
    title: 'Department of Education (Qld) — CARA guideline: Agricultural activities (construction)',
    url: 'https://education.qld.gov.au/curriculum/stages-of-schooling/CARA/activity-guidelines/agricultural-activities-construction',
    reviewed: '2026-10-10',
    note: 'Guideline review date 24 Sep 2025. Lists concreting, fencing and construction of floors/sheds as High risk curriculum activities. A CARA risk level is not the same as a legal high risk construction work trigger.',
  },
};

// Answer values: 'Yes' | 'No' | 'Unsure' | '' (unanswered)
// critical: unanswered/Unsure blocks submission or approval until resolved.
// trigger: answering Yes (or Unsure) flags a POSSIBLE high risk construction
//          work category under s291 -> reviewer must confirm.
// showIf: only asked when another answer is Yes or Unsure.
const QUESTIONS = [
  { key: 'cutting', group: 'Dust and materials', critical: true,
    text: 'Will students cut, grind, drill, chase, scabble or polish concrete, brick, block, tile, stone, render or mortar?' },
  { key: 'dry_cutting', group: 'Dust and materials', critical: true, showIf: 'cutting',
    text: 'Could any of that cutting or grinding be done DRY (no water suppression and no on-tool dust extraction)?',
    trigger: 'contaminated_atmosphere', triggerSource: 'wsq_silica' },
  { key: 'engineered_stone', group: 'Dust and materials', critical: true, showIf: 'cutting',
    text: 'Will any engineered stone be cut or processed?',
    note: 'Engineered stone benchtops, panels and slabs are prohibited from manufacture, supply, processing and installation (national ban from 1 July 2024; in force in Queensland from 1 September 2024). Do not proceed; ask the WHS Coordinator.' },
  { key: 'chemicals', group: 'Dust and materials', critical: false,
    text: 'Will students use cement, lime, mortar, adhesives, grout, sealers, solvents or other hazardous chemicals?',
    note: 'List each product and its SDS reference in Materials.' },
  { key: 'manual_handling', group: 'Dust and materials', critical: false,
    text: 'Will students lift or carry heavy or awkward items (e.g. bricks/blocks in bulk, 20 kg bags, sheets, formwork)?' },
  { key: 'fall_2m', group: 'Heights', critical: true,
    text: 'Could any person fall more than 2 metres (scaffold, trestles, roof, ladder, edge, pit or excavation)?',
    trigger: 'fall_2m', triggerSource: 'wsq_swms' },
  { key: 'heights_any', group: 'Heights', critical: false,
    text: 'Will anyone work off the ground at all (ladder, step platform, trestle, scaffold) even below 2 metres?' },
  { key: 'excavation', group: 'Excavation and services', critical: true,
    text: 'Will there be any digging or excavation (footings, trenches, post holes, set-downs)?' },
  { key: 'trench_1_5m', group: 'Excavation and services', critical: true, showIf: 'excavation',
    text: 'Will any trench, shaft or excavation be deeper than 1.5 metres, or will work be in or near a tunnel?',
    trigger: 'trench_1_5m', triggerSource: 'cop_construction' },
  { key: 'services', group: 'Excavation and services', critical: true,
    text: 'Is the work on or near energised electrical services, pressurised gas mains or piping, or chemical, fuel or refrigerant lines (including buried services)?',
    trigger: 'services', triggerSource: 'cop_construction' },
  { key: 'services_located', group: 'Excavation and services', critical: true, showIf: 'excavation',
    text: 'Have underground services been located and marked before digging (e.g. Before You Dig / site plans)? Answer "No" if not yet done.' },
  { key: 'mobile_plant', group: 'Plant and traffic', critical: true,
    text: 'Will powered mobile plant move in or near the work area (e.g. excavator, skid steer, forklift, tractor, ride-on mower, concrete truck)?',
    trigger: 'mobile_plant', triggerSource: 'cop_construction' },
  { key: 'traffic', group: 'Plant and traffic', critical: true,
    text: 'Is the work on or next to a road, driveway, car park or other area in use by vehicles?',
    trigger: 'traffic_corridor', triggerSource: 'cop_construction' },
  { key: 'structural', group: 'Structures', critical: true,
    text: 'Does the work involve demolishing a load-bearing element, or structural alterations/repairs needing temporary support to prevent collapse?',
    trigger: 'structural', triggerSource: 'cop_construction' },
  { key: 'asbestos', group: 'Structures', critical: true,
    text: 'Could the work disturb asbestos (e.g. existing buildings, sheeting or ground built or filled before 1990)?',
    trigger: 'asbestos', triggerSource: 'cop_construction' },
  { key: 'tilt_up', group: 'Structures', critical: true,
    text: 'Does the work involve tilt-up or precast concrete elements?',
    trigger: 'tilt_up', triggerSource: 'cop_construction' },
  { key: 'confined_space', group: 'Environment', critical: true,
    text: 'Is any work in or near a confined space (pit, tank, enclosed void)?',
    trigger: 'confined_space', triggerSource: 'cop_construction' },
  { key: 'atmosphere', group: 'Environment', critical: true,
    text: 'Could the work area have a contaminated or flammable atmosphere (fumes, solvent vapour, fuel, dust) for reasons other than dry cutting?',
    trigger: 'contaminated_atmosphere', triggerSource: 'cop_construction' },
  { key: 'water', group: 'Environment', critical: true,
    text: 'Is work carried out in or near water or other liquid with a risk of drowning (including open pits or excavations that may fill with water)?',
    trigger: 'water', triggerSource: 'cop_construction' },
  { key: 'temperature', group: 'Environment', critical: false,
    text: 'Is work done in an area with artificial extremes of temperature (e.g. cool room, kiln or furnace area)?',
    trigger: 'temperature', triggerSource: 'cop_construction' },
  { key: 'other_listed', group: 'Environment', critical: false,
    text: 'Does the work involve explosives, diving, or work on a telecommunication tower?',
    trigger: 'other_listed', triggerSource: 'cop_construction' },
];

// The s291 categories a question can point to (wording per the model list).
const TRIGGERS = {
  fall_2m: 'Work that involves a risk of a person falling more than 2 metres',
  trench_1_5m: 'Work carried out in or near a shaft or trench with an excavated depth greater than 1.5 metres, or in or near a tunnel',
  services: 'Work carried out on or near pressurised gas distribution mains or piping; chemical, fuel or refrigerant lines; or energised electrical installations or services',
  mobile_plant: 'Work carried out in an area at a workplace in which there is any movement of powered mobile plant',
  traffic_corridor: 'Work carried out on, in or adjacent to a road, railway, shipping lane or other traffic corridor in use by traffic other than pedestrians',
  structural: 'Demolition of a load-bearing element, or structural alterations or repairs requiring temporary support to prevent collapse',
  asbestos: 'Work that involves, or is likely to involve, the disturbance of asbestos',
  tilt_up: 'Work that involves tilt-up or precast concrete',
  confined_space: 'Work carried out in or near a confined space',
  contaminated_atmosphere: 'Work carried out in an area that may have a contaminated or flammable atmosphere (includes respirable crystalline silica from dry cutting — silica Code of Practice s3.1.1)',
  water: 'Work carried out in or near water or other liquid that involves a risk of drowning',
  temperature: 'Work carried out in an area in which there are artificial extremes of temperature',
  other_listed: 'Work involving explosives, diving work, or work on a telecommunication tower',
};

const ACTIVITY_CLASSES = ['Needs review', 'Educational practice / simulation', 'Actual construction work', 'Other vocational activity'];
const DOC_PURPOSES = ['Not yet decided', 'Project safe work procedure', 'SWMS for training/assessment', 'Legally required SWMS'];
const PRACTICE_TYPES = ['Unsure', 'Temporary educational practice', 'Permanent installation for use'];
const STATUSES = ['Draft', 'Awaiting review', 'Approved', 'Superseded', 'Archived'];

// Project templates: a starting point only. Nothing here is asserted as fact
// about a real project; it pre-fills empty boxes and highlights questions.
const TEMPLATES = {
  sawhorse: { label: 'Sawhorse / carpentry item', description: 'Students mark out, cut and assemble a timber sawhorse using hand and portable power tools.', materials: 'Structural pine (e.g. 90x45 MGP10), screws/nails, PVA adhesive', focus: ['manual_handling'] },
  wall_frame: { label: 'Simulated wall frame', description: 'Students set out, cut and assemble a small timber wall frame (plates, studs, noggins) at ground level, then dismantle it.', materials: 'Pine framing timber, nails/framing connectors', focus: ['heights_any', 'manual_handling'] },
  brick_block: { label: 'Brick and block laying', description: 'Students mix mortar and lay bricks/blocks to a practice wall, then clean down and dismantle.', materials: 'Bricks/blocks, mortar (cement, lime, sand), water', focus: ['cutting', 'chemicals', 'manual_handling'] },
  concreting: { label: 'Concreting', description: 'Students set out and build formwork, place, screed and finish a small concrete slab or path.', materials: 'Formwork timber, pegs, reinforcing mesh, premixed bagged concrete or delivered concrete, curing compound', focus: ['excavation', 'chemicals', 'mobile_plant', 'manual_handling', 'cutting'] },
  tiling: { label: 'Tiling', description: 'Students prepare a practice board/wall, cut tiles, lay with adhesive and grout.', materials: 'Ceramic tiles, tile adhesive, grout, sealer, backing board', focus: ['cutting', 'chemicals'] },
  fencing: { label: 'Fencing / landscaping', description: 'Students set out and install fence posts/rails or landscape edging.', materials: 'Posts, rails, concrete, fixings', focus: ['excavation', 'services', 'mobile_plant'] },
  custom: { label: 'Custom project', description: '', materials: '', focus: [] },
};

function visibleQuestions(answers) {
  const a = answers || {};
  return QUESTIONS.filter((q) => !q.showIf || a[q.showIf] === 'Yes' || a[q.showIf] === 'Unsure');
}

// Deterministic evaluation of the checklist. Returns everything the UI and
// PDF need; never returns a legal conclusion, only flags.
function evaluate(project) {
  const a = project.answers || {};
  const confirmations = project.trigger_reviews || {};
  const qs = visibleQuestions(a);
  const unanswered = qs.filter((q) => q.critical && !a[q.key]);
  const unsure = qs.filter((q) => a[q.key] === 'Unsure');
  const triggers = [];
  for (const q of qs) {
    if (!q.trigger) continue;
    const ans = a[q.key];
    if (ans !== 'Yes' && ans !== 'Unsure') continue;
    let t = triggers.find((x) => x.key === q.trigger);
    if (!t) {
      t = { key: q.trigger, label: TRIGGERS[q.trigger], answers: [], source: SOURCES[q.triggerSource], confirmation: confirmations[q.trigger] || null };
      triggers.push(t);
    }
    t.answers.push({ question: q.text, answer: ans });
  }
  const unconfirmedTriggers = triggers.filter((t) => !t.confirmation || !t.confirmation.decision);
  const confirmedApplies = triggers.filter((t) => t.confirmation && t.confirmation.decision === 'Applies');
  const stops = qs.filter((q) => q.key === 'engineered_stone' && a[q.key] === 'Yes');
  const excavationNoServices = a.excavation === 'Yes' && a.services_located === 'No';

  const flags = [];
  if (stops.length) flags.push({ level: 'stop', text: 'Engineered stone work is prohibited (in force in Queensland from 1 September 2024). Do not proceed; ask the WHS Coordinator.' });
  if (excavationNoServices) flags.push({ level: 'bad', text: 'Digging is planned but underground services have not been located yet.' });
  if (unanswered.length) flags.push({ level: 'bad', text: `${unanswered.length} critical question${unanswered.length === 1 ? '' : 's'} unanswered.` });
  if (unsure.length) flags.push({ level: 'mid', text: `${unsure.length} answer${unsure.length === 1 ? ' is' : 's are'} "Unsure" — a reviewer must resolve ${unsure.length === 1 ? 'it' : 'them'}.` });
  if (project.practice_type === 'Permanent installation for use') flags.push({ level: 'mid', text: 'Permanent installation for use: the work may be "construction work" (WHS Regulation s289), not only educational practice. Needs reviewer classification.' });
  if (project.practice_type === 'Unsure' || !project.practice_type) flags.push({ level: 'mid', text: 'Temporary practice vs permanent installation not decided.' });
  if (unconfirmedTriggers.length) flags.push({ level: 'mid', text: `${unconfirmedTriggers.length} possible high risk construction work trigger${unconfirmedTriggers.length === 1 ? '' : 's'} not yet confirmed by a reviewer.` });

  // Suggested (not decided) classification, shown next to the human choice.
  let suggestedClass = 'Needs review';
  if (project.practice_type === 'Temporary educational practice' && !unsure.length && !unanswered.length && !triggers.length) suggestedClass = 'Educational practice / simulation';

  const blocking = [];
  if (stops.length) blocking.push('Engineered stone answered Yes.');
  if (unanswered.length) blocking.push('Answer all critical questions.');
  if (excavationNoServices) blocking.push('Locate underground services before digging (or change the answer when done).');
  return { questions: qs, unanswered, unsure, triggers, unconfirmedTriggers, confirmedApplies, flags, suggestedClass, blocking };
}

// Extra conditions only checked at approval time (reviewer decisions).
function approvalBlockers(project) {
  const ev = evaluate(project);
  const out = [...ev.blocking];
  if (ev.unsure.length) out.push('Resolve every "Unsure" answer (change it to Yes or No).');
  if (ev.unconfirmedTriggers.length) out.push('Confirm whether each possible high risk construction work trigger applies.');
  if (!project.activity_class || project.activity_class === 'Needs review') out.push('Set the activity classification (it is still "Needs review").');
  if (!project.doc_purpose || project.doc_purpose === 'Not yet decided') out.push('Choose the document purpose.');
  if (ev.confirmedApplies.length && project.activity_class === 'Actual construction work' && project.doc_purpose !== 'Legally required SWMS') {
    out.push('A high risk construction work trigger was confirmed for actual construction work, so the document purpose must be "Legally required SWMS" (or revisit the classification).');
  }
  if (!project.emergency_confirmed) out.push('Confirm the location-specific emergency and first aid details.');
  return out;
}

module.exports = {
  RULES_VERSION, SOURCES, QUESTIONS, TRIGGERS, ACTIVITY_CLASSES, DOC_PURPOSES, PRACTICE_TYPES, STATUSES, TEMPLATES,
  visibleQuestions, evaluate, approvalBlockers,
};
