// Deterministic pre-approval checks for CARAs and projects. No AI.
//
// Two kinds of issue:
// - 'block'  : must be fixed by editing the record (placeholders left in,
//              required information missing, unsafe first aid wording,
//              emergency arrangements not confirmed, open project reviews).
// - 'review' : needs a reviewer's recorded decision (possible supervision
//              conflict, activity risk below an equipment rating). The
//              reviewer's decision is tied to the exact issue text, so if the
//              underlying content changes the issue comes back.
// Drafts can always be saved; these checks gate approval on the server.

const firstAid = require('./first-aid');
const caraType = require('./cara-type');

// A scope must describe what students will do, not just name the course.
const STOP = new Set(['the', 'and', 'of', 'in', 'a', 'an', 'to', 'for', 'with', 'vet', 'year', 'yr', 'students', 'student', 'unit', 'course', 'class']);
function scopeTooThin(r) {
  const scope = String(r.activity_scope || '').trim();
  if (!scope) return false; // reported as missing instead
  const words = scope.toLowerCase().match(/[a-z0-9]+/g) || [];
  if (words.length < 8) return true;
  const ref = `${r.course || ''} ${r.class_unit || ''} ${r.activity_name || ''}`.toLowerCase();
  const content = words.filter((w) => !STOP.has(w));
  // Words that say something about the actual work (not the course name, not filler).
  const FILLER = /^(this|that|term|semester|week|weeks|practical|practicals|units?|activities|activity|tasks?|work|various|other|etc|will|be|are|is|as|part|program|programme|pathways?|certificate|cert|ii|iii|iv|i|qualification|training|assessment|school|lessons?|class|classes|on|at|by|from|their|they|all|some|undertake|complete|completing|do|doing|\d+)$/;
  const informative = content.filter((w) => !ref.includes(w) && !FILLER.test(w));
  return informative.length < 4;
}

// ---------- Placeholders ----------
// Placeholders are things like [Year level], [Number], [location],
// [school's induction process], [confirm: name], [X]. Legitimate brackets
// such as [1], [AS/NZS 1336], [MEM20422], [see SOP 4] or [Appendix A] are not.
const PLACEHOLDER_WORDS = /\b(confirm|insert|enter|add|describe|list|specify|select|choose|fill|tbc|tbd|tba|placeholder|e\.?g\.?|name|names|number|date|time|location|locations|room|year level|age range|age|course|class size|teacher|supervisor|school'?s?|person|details?|here|todo|xx+|coordinator|team|contact|phone|system|process|procedure|staff|title|qualification|provider|organisation|address)\b/i;
const LEGIT_BRACKET = /^(\d+([,-]\s*\d+)*|[A-Z]{2,}[\/A-Z]*\s?[-\d][\w.\-:]*|(as|as\/nzs|iso|sop|swms|pera|cara|prj|s|r|reg|clause|appendix|table|figure|fig|see|ref)\b.*|https?:\/\/.*)$/i;

function isPlaceholder(inner) {
  const s = inner.trim();
  if (!s) return true;
  if (/^(x+|n|\?+|\.{2,}|_+|-+)$/i.test(s)) return true;
  if (LEGIT_BRACKET.test(s)) return false;
  return PLACEHOLDER_WORDS.test(s);
}

function findPlaceholders(text) {
  const out = [];
  const re = /\[([^\[\]\n]{0,100})\]/g;
  let m;
  while ((m = re.exec(String(text || '')))) if (isPlaceholder(m[1])) out.push(m[0]);
  return [...new Set(out)];
}

// ---------- Supervision ----------
// 3 direct, 2 close/visual, 1 general/same room, 0 independent.
function supervisionLevel(text) {
  const t = String(text || '');
  if (/\b(unsupervised|without supervision|independent(ly)?|on their own)\b/i.test(t)) return 0;
  if (/\bdirect\b|\bconstant\b|arm'?s? (length|reach)|\bone[- ]on[- ]one\b/i.test(t)) return 3;
  if (/\bclose (general )?supervision\b|\bline of sight\b|\bvisual supervision\b/i.test(t)) return 2;
  if (/\bgeneral supervision\b|\bsame[- ]room\b|\bin the (same )?room\b|\bnormal workshop supervision\b|\bnearby\b/i.test(t)) return 1;
  return null;
}
const LEVEL_NAME = ['independent use', 'general / same-room supervision', 'close supervision', 'direct supervision'];

const TOOLISH = /\b(power tools?|drills?|grinders?|sanders?|saws?|lathes?|mill(ing)?|welders?|welding|machines?|machinery|routers?|guillotines?|shears?|press(es)?|plasma|oxy|mixers?|nail guns?|compressors?)\b/i;
const BLANKET_DIRECT = /\b(all|every|any|other)\b[^.\n]*\b(equipment|machines?|machinery|tools|plant)\b[^.\n]*\bdirect supervision\b/i;

// Words to recognise a PERA's equipment in free text ("Pedestal drill — Plant & ..." -> "pedestal drill", "drill").
function equipmentTerms(name) {
  const base = String(name || '').replace(/\s*[—–-]\s*(Plant\s*&\s*Equipment|Safe Operating)\s+Risk Assessment\s*$/i, '').toLowerCase();
  const words = base.replace(/[(),/]/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !/^(and|with|for|the|hand|held|portable|electric|power|bench|machine|tool|tools)$/.test(w));
  const terms = [base.trim()];
  const last = words[words.length - 1];
  if (last) terms.push(last.replace(/s$/, ''));
  return [...new Set(terms.filter(Boolean))];
}

// Returns [{key, text}] possible conflicts between supervision statements and
// PERA requirements. `texts` = [{label, text}].
function supervisionConflicts(texts, peras) {
  const out = [];
  const sentences = [];
  for (const t of texts) for (const s of firstAid.splitSentences(t.text)) sentences.push({ label: t.label, s });
  // 1. Blanket "all equipment ... direct supervision" vs a weaker statement for named equipment.
  const blanket = sentences.find((x) => BLANKET_DIRECT.test(x.s));
  if (blanket) {
    for (const x of sentences) {
      if (x === blanket) continue;
      const lvl = supervisionLevel(x.s);
      // Statements about low-risk hand tools are the exception the blanket rule already allows.
      if (lvl !== null && lvl < 3 && TOOLISH.test(x.s) && !/\bhand tools?\b|\blow[- ]risk\b/i.test(x.s)) {
        out.push({ key: `conflict:blanket:${x.s.slice(0, 60)}`, text: `Supervision statements may contradict each other: "${blanket.s}" (${blanket.label}) and "${x.s}" (${x.label}).` });
      }
    }
  }
  // 2. PERA requires a higher level than the text gives that equipment.
  for (const p of peras || []) {
    const need = supervisionLevel(`${p.supervision_level || ''} ${p.required_supervision || ''}`);
    if (need === null) continue;
    const terms = equipmentTerms(p.activity_name);
    for (const x of sentences) {
      const low = x.s.toLowerCase();
      if (!terms.some((t) => t && new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?\\b`).test(low))) continue;
      const lvl = supervisionLevel(x.s);
      if (lvl !== null && lvl < need) {
        out.push({ key: `conflict:pera:${p.id}:${x.s.slice(0, 40)}`, text: `PERA "${terms[0]}" requires ${LEVEL_NAME[need]}, but ${x.label} says: "${x.s}".` });
      }
    }
  }
  const seen = new Set();
  return out.filter((o) => (seen.has(o.text) ? false : seen.add(o.text)));
}

// ---------- CARA ----------
const CARA_TEXT_FIELDS = [
  ['activity_scope', 'Activity scope'], ['location_detail', 'Location detail'],
  ['vet_units', 'VET units'], ['trainer_competencies', 'Trainer/assessor competencies'], ['vet_safety_requirements', 'Training and assessment safety requirements'], ['prior_experience', 'Prior experience'], ['students_notes', 'Students'],
  ['emergency_first_aid', 'Emergency and first aid'], ['induction_instruction', 'Induction and instruction'],
  ['supervision_notes', 'Supervision'], ['supervisor_qualification', 'Supervisor qualification'], ['facilities_equipment', 'Facilities and equipment'],
  ['environmental_hazards', 'Environmental hazards'], ['environmental_controls', 'Environmental control measures'],
  ['facilities_hazards', 'Facilities and equipment hazards'], ['facilities_controls', 'Facilities and equipment control measures'],
  ['student_hazards', 'Student hazards'], ['student_controls', 'Student control measures'],
];
const RISK_ORDER = { Low: 1, Medium: 2, High: 3, Extreme: 4 };
const blank = (v) => v === null || v === undefined || !String(v).trim();

// ctx: { peras: [{id, activity_name, risk_level, status, archived, supervision_level, required_supervision}],
//        projectReviews: [{id, name, reasons: []}] }
function caraIssues(r, ctx = {}) {
  const issues = [];
  const add = (key, level, text, field) => issues.push({ key, level, text, field });
  const peras = ctx.peras || [];

  const required = [
    ['activity_scope', 'Activity scope is empty.'], ['year_level', 'Class group: year level is missing.'],
    ['class_size', 'Class group: class size is missing.'], ['supervision_notes', 'Supervision is empty.'],
    ['induction_instruction', 'Induction and instruction is empty.'], ['emergency_first_aid', 'Emergency and first aid is empty.'],
    ['supervisor_qualification', 'Supervisor qualification is empty.'],
  ];
  for (const [k, msg] of required) if (blank(r[k])) add(`missing:${k}`, 'block', msg, k);
  if (blank(r.course) && blank(r.class_unit)) add('missing:course', 'block', 'Class group: course / subject is missing.', 'course');
  if (!caraType.TYPES[r.cara_type]) add('missing:cara_type', 'block', 'Choose whether this is a general curriculum activity or a VET course (top of the form).', 'cara_type');
  if (scopeTooThin(r)) add('scope:thin', 'block', 'Activity scope only names the course or activity. Describe what students will actually do, with which tools, materials and processes.', 'activity_scope');
  if (!r.room_id && blank(r.location_detail)) add('missing:location', 'block', 'Location is missing.', 'room_id');
  if (r.cara_type === 'vet') {
    if (!caraType.QUAL_CODE.test(String(r.course || ''))) add('vet:qualification', 'block', 'VET: enter the qualification code and title in "Qualification (code and title)", e.g. MEM20422 Certificate II in Engineering Pathways.', 'course');
    const units = String(r.vet_units || '').split('\n').map((x) => x.trim()).filter(Boolean);
    if (!units.length) add('vet:units', 'block', 'VET: list the units of competency (code and title).', 'vet_units');
    const noCode = units.filter((u) => !caraType.UNIT_CODE.test(u.replace(/^[-•*]\s*/, '')));
    if (noCode.length) add('vet:unit-codes', 'block', `VET: these unit lines have no unit code: ${noCode.slice(0, 3).join('; ')}`, 'vet_units');
    if (blank(r.delivery_context)) add('vet:delivery', 'block', 'VET: choose the delivery context.', 'delivery_context');
    if (blank(r.trainer_competencies)) add('vet:trainer', 'block', 'VET: record the trainer/assessor competencies and where they are verified.', 'trainer_competencies');
    if (blank(r.vet_safety_requirements)) add('vet:safety', 'block', 'VET: record the training and assessment safety requirements.', 'vet_safety_requirements');
    if (!r.vet_codes_checked) add('vet:codes-checked', 'block', 'VET: confirm the qualification and unit codes were checked against training.gov.au.', 'vet_section');
    if (/Workplace|Mixed/.test(r.delivery_context || '')) add('vet:workplace', 'review', 'VET delivery includes a workplace or placement. The host workplace has its own WHS duties; a reviewer should confirm placement arrangements (agreement, host induction, supervision) are in place.', 'delivery_context');
  }
  if (!peras.length) add('missing:peras', 'review', 'No equipment (PERA) is linked. Confirm the activity uses no plant or equipment.', 'tool_search');

  for (const [h, c, label] of [['environmental_hazards', 'environmental_controls', 'Environmental'], ['facilities_hazards', 'facilities_controls', 'Facilities and equipment'], ['student_hazards', 'student_controls', 'Student']]) {
    if (!blank(r[h]) && blank(r[c])) add(`missing:${c}`, 'block', `${label} hazards are listed but there are no control measures.`, c);
  }

  for (const [k, label] of CARA_TEXT_FIELDS) {
    const ph = findPlaceholders(r[k]);
    if (ph.length) add(`placeholder:${k}`, 'block', `${label} still has placeholder${ph.length === 1 ? '' : 's'} to fill in: ${ph.slice(0, 4).join(', ')}${ph.length > 4 ? '…' : ''}`, k);
    for (const f of firstAid.scanUnsafe(r[k])) add(`unsafe:${k}:${f.id}`, 'block', `Unsafe first aid wording in ${label}: "${f.sentence}" — ${f.message}`, k);
  }

  if (!r.emergency_confirmed) add('emergency:unconfirmed', 'block', 'Emergency arrangements not confirmed for this location (first aid kit location and first aider).', 'emergency_confirm');
  else {
    if (blank(r.first_aid_kit_location)) add('emergency:kit', 'block', 'First aid kit location is missing.', 'first_aid_kit_location');
    if (blank(r.first_aid_person)) add('emergency:person', 'block', 'Person with current first aid is missing.', 'first_aid_person');
  }

  for (const p of peras) if (p.archived || p.status !== 'Approved') add(`pera:unapproved:${p.id}`, 'block', `PERA "${firstAid && String(p.activity_name).replace(/\s*[—–-]\s*Plant & Equipment Risk Assessment$/, '')}" is not approved.`, 'tool_search');

  const highest = peras.reduce((m, p) => (RISK_ORDER[p.risk_level] > RISK_ORDER[m.risk_level || 'Low'] ? p : m), {});
  if (highest.risk_level && RISK_ORDER[r.risk_level] < RISK_ORDER[highest.risk_level]) {
    add('risk:below-equipment', 'review', `Activity risk level (${r.risk_level}) is lower than the highest equipment rating (${highest.risk_level}, ${String(highest.activity_name).replace(/\s*[—–-]\s*Plant & Equipment Risk Assessment$/, '')}). Equipment ratings and the activity rating are different things; a reviewer must confirm the lower activity rating is justified, or raise it.`, 'risk_level');
  }

  for (const c of supervisionConflicts([
    { label: 'Supervision', text: r.supervision_notes }, { label: 'Induction and instruction', text: r.induction_instruction },
  ], peras)) add(c.key, 'review', c.text, 'supervision_notes');

  for (const pr of ctx.projectReviews || []) {
    if (pr.reasons.length) add(`project:${pr.id}`, 'block', `Project "${pr.name}" may go beyond this CARA and the CARA review hasn't been recorded: ${pr.reasons.join('; ')}`, 'projects');
  }
  return applyResolutions(issues, r.issue_resolutions);
}

// A reviewer's decision counts only while the issue text is unchanged.
function applyResolutions(issues, resolutions) {
  const res = resolutions || {};
  return issues.map((i) => {
    const d = res[i.key];
    return d && d.basis === i.text && i.level === 'review' ? { ...i, resolved: d } : i;
  });
}
const openIssues = (issues) => issues.filter((i) => !i.resolved);

module.exports = { scopeTooThin, findPlaceholders, isPlaceholder, supervisionLevel, supervisionConflicts, equipmentTerms, caraIssues, applyResolutions, openIssues, CARA_TEXT_FIELDS, LEVEL_NAME };
