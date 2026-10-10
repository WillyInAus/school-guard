// What may be sent to the AI assistant, and a last-line filter for free text.
//
// Sent (class-level only): activity name, class/unit, course, year level,
// class size, age range, prior experience, risk level, scope, supervision,
// qualifications, induction, facilities, hazards and controls, emergency
// arrangements, and the selected PERAs' details.
// Never sent: the Students box, names of staff/students, signatures,
// approver details, review notes, created-by IDs.
//
// Teachers can type anything into any box, so every free-text value is also
// passed through redact(): lines that look like individual student details
// (initial+surname, "student Jack", medical conditions, support plans) are
// removed before sending and the teacher is told how many.

const CARA_AI_ALLOWLIST = [
  'activity_name', 'class_unit', 'course', 'year_level', 'class_size', 'age_range', 'prior_experience',
  'risk_level', 'consent_required', 'activity_scope', 'supervision_notes', 'supervisor_qualification',
  'induction_instruction', 'facilities_equipment', 'emergency_first_aid',
  'environmental_hazards', 'environmental_controls', 'facilities_hazards', 'facilities_controls',
  'student_hazards', 'student_controls',
  // CARA type and teacher-entered VET details (no trainer names: trainer_competencies is not sent)
  'cara_type', 'location_detail', 'vet_units', 'delivery_context', 'vet_safety_requirements',
  'activity_brief', 'materials', 'sds_refs', 'screening_text',
];
// Explicitly excluded (checked in tests): never present in an AI request.
const CARA_AI_EXCLUDED = ['students_notes', 'submitted_by', 'approver', 'teacher_signature', 'review_notes', 'first_aid_person', 'created_by_staff_id', 'edited_by', 'trainer_competencies'];

const PERSONAL_LINE = [
  /\b[A-Z]\.\s?[A-Z][a-z]{2,}\b/, // J. Smith
  /\b(student|students|child|boy|girl|pupil)\s+(named\s+)?[A-Z][a-z]{2,}\b/, // student Jack
  /\b(epilep|seizure|diabet|insulin|asthma|anaphyla|epipen|allerg|adhd|autis|asd\b|dyslex|dyspraxi|anxiety|depress|self[- ]harm|medicat|diagnos|disabilit|impairment|wheelchair|hearing aid|cochlear|pregnan)/i,
  /\b(support plan|medical plan|health plan|behaviou?r plan|individual (education|learning) plan|\biep\b|nccd|health care plan|risk plan for)\b/i,
];

function redact(text) {
  if (text === null || text === undefined) return { text: '', removed: 0 };
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const kept = lines.filter((l) => !PERSONAL_LINE.some((re) => re.test(l)));
  return { text: kept.join('\n'), removed: lines.length - kept.length };
}

// Pick only allowlisted fields and redact their free text.
function caraForAi(row) {
  const out = {};
  let removed = 0;
  for (const k of CARA_AI_ALLOWLIST) {
    const v = row ? row[k] : undefined;
    if (v === undefined || v === null) { out[k] = v; continue; }
    if (typeof v === 'string') {
      const r = redact(v);
      out[k] = r.text;
      removed += r.removed;
    } else out[k] = v;
  }
  return { cara: out, removed };
}

function redactedNote(n) {
  return n ? `${n} line${n === 1 ? ' was' : 's were'} not sent to the AI because ${n === 1 ? 'it looked' : 'they looked'} like individual student or medical details.` : null;
}

const AI_SENT_TEXT = 'Sent to the AI: the activity description, materials, hazard answers, hazard, supervision and emergency text, the selected PERAs, the CARA type, any VET details you entered (qualification, units, delivery context, training safety requirements) and class-level details (year level, course, class size, age range, prior experience). Not sent: the Students box, trainer/assessor details, names or signatures. Lines that look like individual student or medical details are removed first.';

module.exports = { CARA_AI_ALLOWLIST, CARA_AI_EXCLUDED, redact, caraForAi, redactedNote, AI_SENT_TEXT };
