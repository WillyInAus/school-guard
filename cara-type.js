// CARA type: "General curriculum activity" or "VET course or activity".
//
// One CARA system: same records, checks, approvals and projects. The type
// only changes which extra fields are shown and asked for. It never changes
// the risk rating, never requires a SWMS, never authorises construction work
// and never confirms trainer/student competency or qualification compliance.
//
// Existing CARAs have no type (NULL) until someone confirms it on edit; we do
// not guess from the title. Switching type keeps every field's data: fields
// that don't apply are hidden, not cleared.

const TYPES = {
  general: {
    label: 'General curriculum activity',
    desc: 'A class activity in a subject such as Design and Technologies, IDT, Science or Hospitality studies. Keeps the form short and activity-focused. You can still add projects.',
  },
  vet: {
    label: 'VET course or activity',
    desc: 'Training and assessment for a nationally recognised qualification (e.g. a Certificate II). Adds qualification, units, delivery context, trainer/assessor and training-safety details. Projects are usually needed.',
  },
};
const DELIVERY_CONTEXTS = ['School-based training', 'Simulated workplace', 'Workplace / placement', 'Mixed'];

const TYPE_FIELDS = [
  ['cara_type', 'CARA type'], ['room_id', 'Location (room)'], ['location_detail', 'Location detail'],
  ['vet_units', 'VET units'], ['delivery_context', 'Delivery context'], ['trainer_competencies', 'Trainer/assessor competencies'],
  ['vet_safety_requirements', 'Training and assessment safety requirements'], ['vet_codes_checked', 'Qualification/unit codes checked'],
];

const typeLabel = (t) => (TYPES[t] ? TYPES[t].label : 'Type not set');

function choicePageHtml(escapeHtml) {
  return `
    <a class="back-link" href="/cara">← Back to CARA Records</a>
    <h1 class="page-title">New CARA</h1>
    <p class="page-subtitle" style="margin-bottom:20px;">What are you planning?</p>
    <div class="type-choice">
      ${Object.entries(TYPES).map(([k, t]) => `
        <a class="type-card" href="/cara/new?type=${k}">
          <strong>${escapeHtml(t.label)}</strong>
          <span>${escapeHtml(t.desc)}</span>
        </a>`).join('')}
    </div>
    <p class="form-section-hint">Both use the same safety checks and approval. You can change the type later while the CARA is a draft.</p>`;
}

// Type selector shown at the top of the form.
function selectorHtml(r, escapeHtml, preset) {
  const cur = (r && r.cara_type) || preset || '';
  return `
    <div class="type-bar" id="cara_type_bar">
      <label for="cara_type">What are you planning?</label>
      <select id="cara_type" name="cara_type">
        ${cur ? '' : '<option value="" selected>— Choose (not set yet) —</option>'}
        ${Object.entries(TYPES).map(([k, t]) => `<option value="${k}"${cur === k ? ' selected' : ''}>${escapeHtml(t.label)}</option>`).join('')}
      </select>
      <p class="form-section-hint" id="cara_type_note">${cur ? '' : 'This CARA was created before types existed. Choose the type that fits; nothing is changed until you save.'}</p>
    </div>`;
}

// Location + VET details (placed after the Class group section).
async function detailsHtml(pool, r, escapeHtml) {
  const v = (k) => escapeHtml(r && r[k] != null ? String(r[k]) : '');
  const rooms = (await pool.query('SELECT id, name FROM rooms WHERE archived = false ORDER BY name')).rows;
  return `
        <div class="form-section-title">Location</div>
        <div class="cohort-grid">
          <div class="form-row">
            <label for="room_id">Room / area</label>
            <select id="room_id" name="room_id"><option value="">— Not in the room list —</option>${rooms.map((x) => `<option value="${x.id}"${r && Number(r.room_id) === x.id ? ' selected' : ''}>${escapeHtml(x.name)}</option>`).join('')}</select>
          </div>
          <div class="form-row" style="grid-column: span 2;">
            <label for="location_detail">Location detail</label>
            <input type="text" id="location_detail" name="location_detail" value="${v('location_detail')}" placeholder="e.g. IDT metal workshop and welding bays">
          </div>
        </div>

        <div class="vet-section" id="vet_section" data-show-for="vet">
          <div class="form-section-title">VET details</div>
          <p class="form-section-hint">Enter codes and titles yourself from the training package (training.gov.au). PracReady and the AI never fill these in. Choosing VET does not change the risk rating or confirm any competency.</p>
          <div class="form-row">
            <label for="vet_units">Units of competency (one per line: code and title)</label>
            <textarea id="vet_units" name="vet_units" rows="3" placeholder="e.g. MEMPE001 Use engineering workshop machines">${v('vet_units')}</textarea>
          </div>
          <div class="form-row">
            <label for="delivery_context">Delivery context</label>
            <select id="delivery_context" name="delivery_context"><option value="">— Choose —</option>${DELIVERY_CONTEXTS.map((d) => `<option${r && r.delivery_context === d ? ' selected' : ''}>${escapeHtml(d)}</option>`).join('')}</select>
          </div>
          <div class="form-row">
            <label for="trainer_competencies">Trainer/assessor competencies and verification references</label>
            <textarea id="trainer_competencies" name="trainer_competencies" rows="2" placeholder="Credentials required for these units and where they are verified (e.g. RTO trainer matrix ref).">${v('trainer_competencies')}</textarea>
          </div>
          <div class="form-row">
            <label for="vet_safety_requirements">Training and assessment safety requirements</label>
            <textarea id="vet_safety_requirements" name="vet_safety_requirements" rows="3" placeholder="Safety requirements from the units / RTO assessment conditions that apply to this activity.">${v('vet_safety_requirements')}</textarea>
          </div>
          <p class="form-section-hint">Record required inductions and student competency checks under <strong>Induction and instruction</strong> below.</p>
          <label class="checkbox-row"><input type="checkbox" name="vet_codes_checked" value="true"${r && r.vet_codes_checked ? ' checked' : ''}> I have checked the qualification and unit codes and titles against training.gov.au</label>
        </div>
        <input type="hidden" name="cara_type_fields" value="1">
        <script>
        (function () {
          var sel = document.getElementById('cara_type'); if (!sel) return;
          var note = document.getElementById('cara_type_note');
          var NOTES = {
            general: 'General curriculum: the VET details section is hidden (anything already entered there is kept). Adding projects is optional.',
            vet: 'VET: also fill in the VET details, and use "Course / subject" for the qualification code and title. Projects usually need their own documents.'
          };
          function apply() {
            var t = sel.value;
            document.querySelectorAll('[data-show-for]').forEach(function (el) { el.style.display = el.dataset.showFor === t ? '' : 'none'; });
            document.querySelectorAll('[data-label-vet]').forEach(function (el) { el.textContent = t === 'vet' ? el.dataset.labelVet : el.dataset.labelGeneral; });
            if (note && t) note.textContent = NOTES[t];
          }
          sel.addEventListener('change', apply); apply();
        })();
        </script>`;
}

const clean = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\r\n?/g, '\n').trim();
  return s || null;
};

// Only fields present in the form are updated, so a form that doesn't show
// these fields can't wipe them.
function fromBody(b) {
  if (!b || b.cara_type_fields !== '1') return null;
  const roomId = parseInt(b.room_id, 10);
  return {
    cara_type: TYPES[b.cara_type] ? b.cara_type : null,
    room_id: Number.isInteger(roomId) && roomId > 0 ? roomId : null,
    location_detail: clean(b.location_detail),
    vet_units: clean(b.vet_units),
    delivery_context: DELIVERY_CONTEXTS.includes(b.delivery_context) ? b.delivery_context : null,
    trainer_competencies: clean(b.trainer_competencies),
    vet_safety_requirements: clean(b.vet_safety_requirements),
    vet_codes_checked: b.vet_codes_checked === 'true',
  };
}

async function save(pool, id, t) {
  if (!t) return;
  await pool.query(
    `UPDATE cara_records SET cara_type=$1, room_id=$2, location_detail=$3, vet_units=$4, delivery_context=$5,
       trainer_competencies=$6, vet_safety_requirements=$7, vet_codes_checked=$8 WHERE id=$9`,
    [t.cara_type, t.room_id, t.location_detail, t.vet_units, t.delivery_context, t.trainer_competencies, t.vet_safety_requirements, t.vet_codes_checked, id]
  );
}

// Format checks only: codes are not verified against an official source here.
const QUAL_CODE = /\b[A-Z]{2,4}\d{5}\b/;
const UNIT_CODE = /^\s*[A-Z]{4,}\d{3,4}[A-Z]?\b/;

module.exports = { TYPES, DELIVERY_CONTEXTS, TYPE_FIELDS, typeLabel, choicePageHtml, selectorHtml, detailsHtml, fromBody, save, QUAL_CODE, UNIT_CODE };
