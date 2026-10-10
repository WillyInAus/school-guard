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

const RULES_VERSION = '2026-10-10b';
// These rules are QUEENSLAND rules (WHS Regulation 2011 (Qld) and WorkSafe
// Queensland codes). Other states/territories differ (e.g. fall heights,
// codes of practice) and need their own rule set.
const JURISDICTION = 'Queensland';

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
  { key: 'construction_work', group: 'Type of work', critical: true,
    text: 'Does the project involve building, altering, repairing, demolishing or excavating a structure or ground (construction-type work), even as practice?',
    note: 'Making products in a workshop, cooking or servicing vehicles is not construction-type work. Answering Yes does not decide that it is legally construction work; it switches on the construction screening questions for the reviewer.' },
  { key: 'cutting', group: 'Dust and materials', critical: 'construction', hideIfNo: 'construction_work',
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
  { key: 'hot_work', group: 'Workshop processes', critical: 'relevant', onlyWhenRelevant: true,
    text: 'Will students weld, plasma or oxy-cut, braze, or grind/cut metal producing sparks or hot metal?' },
  { key: 'welding_fumes', group: 'Workshop processes', critical: 'relevant', showIf: 'hot_work',
    text: 'Will welding or cutting fumes be removed by working local exhaust ventilation at each bay?',
    note: 'Answer "No" or "Unsure" if extraction is not confirmed for every bay. Consider the atmosphere question below too.' },
  { key: 'gas_cylinders', group: 'Workshop processes', critical: 'relevant', onlyWhenRelevant: true,
    text: 'Will compressed gas cylinders be used (oxygen, acetylene, LPG, shielding gas)?' },
  { key: 'rotating_machinery', group: 'Workshop processes', critical: false, onlyWhenRelevant: true,
    text: 'Will students use rotating machinery (lathe, mill, drill press, grinder, saw)?' },
  { key: 'noise', group: 'Workshop processes', critical: false, onlyWhenRelevant: true,
    text: 'Is the work likely to be noisy (grinding, cutting, hammering sheet metal, compressors)?' },
  { key: 'sharp_edges', group: 'Workshop processes', critical: false, onlyWhenRelevant: true,
    text: 'Will students handle sheet metal, swarf or other sharp-edged material?' },
  { key: 'hot_cooking', group: 'Kitchen and service', critical: 'relevant', onlyWhenRelevant: true,
    text: 'Will students use hot oil, deep fryers, ovens, grills, steam or boiling liquids?' },
  { key: 'food_equipment', group: 'Kitchen and service', critical: 'relevant', onlyWhenRelevant: true,
    text: 'Will students use knives, slicers, mandolines, mixers or other powered food equipment?' },
  { key: 'gas_appliances', group: 'Kitchen and service', critical: 'relevant', onlyWhenRelevant: true,
    text: 'Will gas cooking appliances be used?' },
  { key: 'wet_floors', group: 'Kitchen and service', critical: false, onlyWhenRelevant: true,
    text: 'Will floors be wet or greasy during the activity?' },
  { key: 'food_served', group: 'Kitchen and service', critical: false, onlyWhenRelevant: true,
    text: 'Will food be served to other people (food safety and allergen information needed)?' },
  { key: 'vehicle_raised', group: 'Vehicles', critical: 'relevant', onlyWhenRelevant: true,
    text: 'Will anyone work under or beside a vehicle raised on a hoist, jack or stands?' },
  { key: 'engine_running', group: 'Vehicles', critical: 'relevant', onlyWhenRelevant: true,
    text: 'Will engines be run indoors (exhaust fumes) or will students work near hot engine/exhaust parts?' },
  { key: 'vehicle_electrical', group: 'Vehicles', critical: 'relevant', onlyWhenRelevant: true,
    text: 'Will students work on batteries, hybrid/electric vehicle high-voltage systems or vehicle electrical circuits?' },
  { key: 'vehicles_moving', group: 'Vehicles', critical: false, onlyWhenRelevant: true,
    text: 'Will vehicles be driven or moved inside the workshop or work area?' },
  { key: 'fall_2m', group: 'Heights', critical: 'construction', hideIfNo: 'construction_work',
    text: 'Could any person fall more than 2 metres (scaffold, trestles, roof, ladder, edge, pit or excavation)?',
    trigger: 'fall_2m', triggerSource: 'wsq_swms' },
  { key: 'heights_any', group: 'Heights', critical: false,
    text: 'Will anyone work off the ground at all (ladder, step platform, trestle, scaffold) even below 2 metres?' },
  { key: 'excavation', group: 'Excavation and services', critical: 'construction', hideIfNo: 'construction_work',
    text: 'Will there be any digging or excavation (footings, trenches, post holes, set-downs)?' },
  { key: 'trench_1_5m', group: 'Excavation and services', critical: true, showIf: 'excavation',
    text: 'Will any trench, shaft or excavation be deeper than 1.5 metres, or will work be in or near a tunnel?',
    trigger: 'trench_1_5m', triggerSource: 'cop_construction' },
  { key: 'services', group: 'Excavation and services', critical: 'construction', hideIfNo: 'construction_work',
    text: 'Is the work on or near energised electrical services, pressurised gas mains or piping, or chemical, fuel or refrigerant lines (including buried services)?',
    trigger: 'services', triggerSource: 'cop_construction' },
  { key: 'services_located', group: 'Excavation and services', critical: true, showIf: 'excavation',
    text: 'Have underground services been located and marked before digging (e.g. Before You Dig / site plans)? Answer "No" if not yet done.' },
  { key: 'mobile_plant', group: 'Plant and traffic', critical: 'construction', hideIfNo: 'construction_work',
    text: 'Will powered mobile plant move in or near the work area (e.g. excavator, skid steer, forklift, tractor, ride-on mower, concrete truck)?',
    trigger: 'mobile_plant', triggerSource: 'cop_construction' },
  { key: 'traffic', group: 'Plant and traffic', critical: 'construction', hideIfNo: 'construction_work',
    text: 'Is the work on or next to a road, driveway, car park or other area in use by vehicles?',
    trigger: 'traffic_corridor', triggerSource: 'cop_construction' },
  { key: 'structural', group: 'Structures', critical: 'construction', hideIfNo: 'construction_work',
    text: 'Does the work involve demolishing a load-bearing element, or structural alterations/repairs needing temporary support to prevent collapse?',
    trigger: 'structural', triggerSource: 'cop_construction' },
  { key: 'asbestos', group: 'Structures', critical: 'construction', hideIfNo: 'construction_work',
    text: 'Could the work disturb asbestos (e.g. existing buildings, sheeting or ground built or filled before 1990)?',
    trigger: 'asbestos', triggerSource: 'cop_construction' },
  { key: 'tilt_up', group: 'Structures', critical: 'construction', hideIfNo: 'construction_work',
    text: 'Does the work involve tilt-up or precast concrete elements?',
    trigger: 'tilt_up', triggerSource: 'cop_construction' },
  { key: 'confined_space', group: 'Environment', critical: 'construction',
    text: 'Is any work in or near a confined space (pit, tank, enclosed void)?',
    trigger: 'confined_space', triggerSource: 'cop_construction' },
  { key: 'atmosphere', group: 'Environment', critical: 'construction',
    text: 'Could the work area have a contaminated or flammable atmosphere (fumes, solvent vapour, fuel, dust) for reasons other than dry cutting?',
    trigger: 'contaminated_atmosphere', triggerSource: 'cop_construction' },
  { key: 'water', group: 'Environment', critical: 'construction',
    text: 'Is work carried out in or near water or other liquid with a risk of drowning (including open pits or excavations that may fill with water)?',
    trigger: 'water', triggerSource: 'cop_construction' },
  { key: 'temperature', group: 'Environment', critical: 'construction',
    text: 'Is work done in an area with artificial extremes of temperature (e.g. cool room, kiln or furnace area)?',
    trigger: 'temperature', triggerSource: 'cop_construction' },
  { key: 'other_listed', group: 'Environment', critical: 'construction', hideIfNo: 'construction_work',
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
// What the work is for. Guides screening only; it never decides the legal
// classification. Keeping a finished product does not make it construction work.
const PRACTICE_TYPES = ['Unsure', 'Educational practice or simulation', 'Making a product for use', 'Installation or work on a structure/site'];
// Older projects used these values; they are read as the new ones.
const LEGACY_PRACTICE = { 'Temporary educational practice': 'Educational practice or simulation', 'Permanent installation for use': 'Installation or work on a structure/site' };
const practiceOf = (v) => LEGACY_PRACTICE[v] || (PRACTICE_TYPES.includes(v) ? v : 'Unsure');

// Stored document purposes and how they are shown.
const DOC_PURPOSE_LABELS = { 'Legally required SWMS': 'Potential legally required SWMS — reviewer decision needed' };
const purposeLabel = (v) => DOC_PURPOSE_LABELS[v] || v;
const STATUSES = ['Draft', 'Awaiting review', 'Approved', 'Superseded', 'Archived'];

// Project templates: a starting point only. Nothing here is asserted as fact
// about a real project; it pre-fills empty boxes and highlights questions.
// Templates are a starting point only: they pre-fill empty boxes and mark
// questions as "likely relevant". A template never decides legal SWMS
// requirements; those come only from the screening answers.
const TEMPLATE_GROUPS = ['Engineering', 'Construction', 'Hospitality', 'Automotive', 'Other'];
const TEMPLATES = {
  fabrication: { group: 'Engineering', label: 'Engineering / fabrication', description: 'Students mark out, cut, drill and join steel components to make a small fabricated item.', materials: 'Mild steel flat bar/angle, fasteners, paint/primer', focus: ['hot_work', 'rotating_machinery', 'noise', 'sharp_edges', 'manual_handling'] },
  welding: { group: 'Engineering', label: 'Welding', description: 'Students set up and weld practice joints using MIG/MMAW in welding bays.', materials: 'Mild steel plate, welding wire/electrodes, shielding gas', focus: ['hot_work', 'welding_fumes', 'gas_cylinders', 'atmosphere', 'noise'] },
  sheet_metal: { group: 'Engineering', label: 'Sheet-metal work', description: 'Students mark out, cut (guillotine/snips), fold (pan brake) and join light-gauge sheet metal.', materials: 'Galvanised or mild steel sheet, rivets, spot welds', focus: ['sharp_edges', 'noise', 'hot_work', 'rotating_machinery'] },
  machining: { group: 'Engineering', label: 'Machining', description: 'Students turn, face and drill parts on the metal lathe and use the milling machine.', materials: 'Mild steel / aluminium bar stock, cutting fluid', focus: ['rotating_machinery', 'sharp_edges', 'noise', 'chemicals'] },
  assembly: { group: 'Engineering', label: 'Assembly / fitting', description: 'Students assemble, fit and fasten components using hand and portable power tools.', materials: 'Prepared components, fasteners, lubricants', focus: ['manual_handling', 'rotating_machinery'] },
  sawhorse: { group: 'Construction', label: 'Construction / carpentry item (e.g. sawhorse)', description: 'Students mark out, cut and assemble a timber sawhorse using hand and portable power tools.', materials: 'Structural pine (e.g. 90x45 MGP10), screws/nails, PVA adhesive', focus: ['construction_work', 'manual_handling'] },
  wall_frame: { group: 'Construction', label: 'Simulated wall frame', description: 'Students set out, cut and assemble a small timber wall frame (plates, studs, noggins) at ground level, then dismantle it.', materials: 'Pine framing timber, nails/framing connectors', focus: ['construction_work', 'heights_any', 'manual_handling'] },
  brick_block: { group: 'Construction', label: 'Brick and block laying', description: 'Students mix mortar and lay bricks/blocks to a practice wall, then clean down and dismantle.', materials: 'Bricks/blocks, mortar (cement, lime, sand), water', focus: ['construction_work', 'cutting', 'chemicals', 'manual_handling'] },
  concreting: { group: 'Construction', label: 'Concreting', description: 'Students set out and build formwork, place, screed and finish a small concrete slab or path.', materials: 'Formwork timber, pegs, reinforcing mesh, premixed bagged concrete or delivered concrete, curing compound', focus: ['construction_work', 'excavation', 'chemicals', 'mobile_plant', 'manual_handling', 'cutting'] },
  tiling: { group: 'Construction', label: 'Tiling', description: 'Students prepare a practice board/wall, cut tiles, lay with adhesive and grout.', materials: 'Ceramic tiles, tile adhesive, grout, sealer, backing board', focus: ['construction_work', 'cutting', 'chemicals'] },
  fencing: { group: 'Construction', label: 'Fencing / landscaping', description: 'Students set out and install fence posts/rails or landscape edging.', materials: 'Posts, rails, concrete, fixings', focus: ['construction_work', 'excavation', 'services', 'mobile_plant'] },
  kitchen: { group: 'Hospitality', label: 'Commercial kitchen / food preparation', description: 'Students prepare, cook and plate food in the training kitchen using knives, stovetops, ovens and fryers, then clean down.', materials: 'Food ingredients, cooking oil, cleaning and sanitising chemicals', focus: ['hot_cooking', 'food_equipment', 'gas_appliances', 'wet_floors', 'food_served', 'chemicals', 'manual_handling'] },
  vehicle_service: { group: 'Automotive', label: 'Light vehicle servicing', description: 'Students carry out basic servicing on light vehicles: checking and changing fluids, tyres and wheels, and inspecting brakes, using hoists or jacks and stands.', materials: 'Engine oil, coolant, brake fluid, parts cleaner, tyres', focus: ['vehicle_raised', 'engine_running', 'vehicle_electrical', 'vehicles_moving', 'chemicals', 'manual_handling', 'noise'] },
  custom: { group: 'Other', label: 'Custom project', description: '', materials: '', focus: [] },
};

// Suggest template groups from the parent CARA's course/subject and activity
// text. Teachers can still pick any template.
function suggestedGroups(text) {
  const t = String(text || '');
  const out = [];
  if (/\b(MEM\d|engineer|metal|fabricat|weld|machin|fitting|sheet[- ]?metal|boilermak)/i.test(t)) out.push('Engineering');
  if (/\b(CPC\d|construct|carpent|build|brick|block ?lay|concret|til(e|ing)|landscap|fenc)/i.test(t)) out.push('Construction');
  if (/\b(SIT\d|hospitality|kitchen|cookery|culinary|food|catering|cafe|barista)/i.test(t)) out.push('Hospitality');
  if (/\b(AUR\d|automotive|vehicle|motor|mechanic|car servic)/i.test(t)) out.push('Automotive');
  return out;
}

// Answers that drive classification. Changing any of these (or the
// temporary/permanent answer) after a reviewer classified the project
// returns the classification to "Needs review".
function classificationBasis(p) {
  const a = p.answers || {};
  return JSON.stringify([practiceOf(p.practice_type), ...QUESTIONS.filter((q) => q.trigger || q.critical).map((q) => `${q.key}=${a[q.key] || ''}`)]);
}

const RELEVANCE_MAP = [
  [/fryer|oven|grill|stove|cook|boil|steam|kitchen/, ['hot_cooking', 'gas_appliances', 'wet_floors']],
  [/\bknife|\bknives|slicer|mandoline|food processor|stand mixer|planetary mixer|dough mixer|food mixer/, ['food_equipment']],
  [/serv(e|ing) food|cafe|catering|customers/, ['food_served']],
  [/\bhoists?\b|\bjacks?\b|\bvehicles?\b|\bengines?\b|exhaust|\btyres?\b|\bbrakes\b|\bbrake (?:pads?|discs?|rotors?|calipers?|fluid|lines?)|car servic/, ['vehicle_raised', 'engine_running', 'vehicles_moving']],
  [/battery|batteries|hybrid|electric vehicle|\bev\b|high[- ]voltage/, ['vehicle_electrical']],
  [/build|construct|frame|framing|wall|slab|footing|brick|block|concrete|til(e|ing)|fence|shed|deck|demolish|renovat/, ['construction_work']],
  [/weld|plasma|oxy|braz|grind|spark|mig|tig|arc/, ['hot_work', 'welding_fumes', 'gas_cylinders']],
  [/cylinder|acetylene|lpg|argon|shielding gas/, ['gas_cylinders']],
  [/lathe|mill|drill|saw|grinder|router/, ['rotating_machinery', 'noise']],
  [/sheet|guillotine|snips|swarf/, ['sharp_edges']],
  [/concrete|brick|block|tile|mortar|render|stone|paver/, ['cutting', 'chemicals', 'manual_handling']],
  [/dig|trench|footing|post hole|excavat/, ['excavation', 'services']],
  [/ladder|scaffold|trestle|roof|platform|height/, ['heights_any', 'fall_2m']],
  [/excavator|bobcat|skid steer|forklift|tractor|truck|ride-on/, ['mobile_plant']],
  [/cement|adhesive|grout|solvent|paint|sealer|chemical|fluid/, ['chemicals']],
];

// Questions most relevant to this project: template focus plus questions
// matching the description, tools and materials. All questions remain.
function relevantKeys(p, toolNames) {
  if (practiceOf(p.practice_type) === 'Installation or work on a structure/site') { /* construction_work is asked first anyway */ }
  const t = `${p.description || ''} ${p.materials || ''} ${p.conditions || ''} ${(toolNames || []).join(' ')}`.toLowerCase();
  const keys = new Set(((TEMPLATES[p.project_type] || {}).focus) || []);
  const map = RELEVANCE_MAP;
  for (const [re, ks] of map) if (re.test(t)) ks.forEach((k) => keys.add(k));
  return keys;
}

// Construction screening applies unless the teacher has said the work is not
// construction-type. Unanswered never means "No".
const constructionApplies = (a) => (a || {}).construction_work !== 'No';

// p (optional) = project, used to work out which "only when relevant"
// questions apply (template, description, materials, equipment).
function visibleQuestions(answers, p) {
  const a = answers || {};
  const rel = p ? relevantKeys(p, (p.peras || []).map((x) => x.activity_name)) : null;
  return QUESTIONS.filter((q) => {
    if (q.showIf && a[q.showIf] !== 'Yes' && a[q.showIf] !== 'Unsure') return false;
    if (q.hideIfNo && a[q.hideIfNo] === 'No') return false;
    if (q.onlyWhenRelevant && !a[q.key] && !(rel && rel.has(q.key))) return false;
    return true;
  });
}
function isCritical(q, a, rel) {
  if (q.critical === true) return true;
  if (q.critical === 'construction') return constructionApplies(a);
  if (q.critical === 'relevant') return !!(rel && rel.has(q.key));
  return false;
}

// Deterministic evaluation of the checklist. Returns everything the UI and
// PDF need; never returns a legal conclusion, only flags.
function evaluate(project) {
  const a = project.answers || {};
  const confirmations = project.trigger_reviews || {};
  const rel = relevantKeys(project, (project.peras || []).map((x) => x.activity_name));
  const qs = visibleQuestions(a, project);
  const unanswered = qs.filter((q) => isCritical(q, a, rel) && !a[q.key]);
  const unsure = qs.filter((q) => a[q.key] === 'Unsure');
  const triggers = [];
  for (const q of qs) {
    // Legal high risk construction work triggers only arise for construction work.
    if (!q.trigger || !constructionApplies(a)) continue;
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
  const practice = practiceOf(project.practice_type);
  if (practice === 'Installation or work on a structure/site') flags.push({ level: 'mid', text: 'Installation or work on a structure/site: this may be "construction work" (WHS Regulation s289), not only educational practice. Needs reviewer classification.' });
  if (practice === 'Unsure') flags.push({ level: 'mid', text: 'What the work is for (practice, a product, or an installation) is not decided yet.' });
  if (unconfirmedTriggers.length) flags.push({ level: 'mid', text: `${unconfirmedTriggers.length} possible high risk construction work trigger${unconfirmedTriggers.length === 1 ? '' : 's'} not yet confirmed by a reviewer.` });

  // Suggested (not decided) classification, shown next to the human choice.
  let suggestedClass = 'Needs review';
  // Hidden or unanswered questions are never treated as "No".
  const anyUnanswered = qs.some((q) => !a[q.key]);
  if (practice === 'Educational practice or simulation' && !unsure.length && !anyUnanswered && !triggers.length) suggestedClass = 'Educational practice / simulation';
  // Suggested document purpose (after screening). A reviewer decides.
  let suggestedPurpose = 'Project safe work procedure';
  if (triggers.length && practice !== 'Educational practice or simulation') suggestedPurpose = 'Legally required SWMS';
  else if (triggers.length || (a.construction_work === 'Yes')) suggestedPurpose = 'SWMS for training/assessment';

  const blocking = [];
  if (stops.length) blocking.push('Engineered stone answered Yes.');
  if (unanswered.length) blocking.push('Answer all critical questions.');
  if (excavationNoServices) blocking.push('Locate underground services before digging (or change the answer when done).');
  return { questions: qs, unanswered, unsure, triggers, unconfirmedTriggers, confirmedApplies, flags, suggestedClass, suggestedPurpose, blocking };
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
  JURISDICTION, TEMPLATE_GROUPS, RELEVANCE_MAP, constructionApplies, isCritical, practiceOf, purposeLabel, LEGACY_PRACTICE, suggestedGroups, classificationBasis, relevantKeys,
  RULES_VERSION, SOURCES, QUESTIONS, TRIGGERS, ACTIVITY_CLASSES, DOC_PURPOSES, PRACTICE_TYPES, STATUSES, TEMPLATES,
  visibleQuestions, evaluate, approvalBlockers,
};
