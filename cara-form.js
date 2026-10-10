// CARA form in four stages: 1 Describe, 2 Select, 3 Draft and review,
// 4 Check and submit. It is ONE form (same field names and save routes as
// before); stages only show/hide sections, so moving Back/Next never loses
// what was typed, "Save draft" works at any stage, and issue links can jump
// straight to a field. Required checks are still enforced on the server at
// approval (cara-checks.js); drafts can be incomplete.

const caraType = require('./cara-type');
const caraSafety = require('./cara-safety');
const aiPrivacy = require('./ai-privacy');
const screening = require('./screening-ui');
const checks = require('./cara-checks');

const STAGES = ['Describe', 'Select', 'Draft and review', 'Check and submit'];

// Which stage each field lives in (used for issue links and progress).
const STAGE_OF_FIELD = {
  cara_type: 1, activity_name: 1, class_unit: 1, year_level: 1, class_size: 1, age_range: 1, prior_experience: 1, course: 1,
  delivery_context: 1, room_id: 1, location_detail: 1, activity_brief: 1,
  tool_search: 2, tool_ids: 2, materials: 2, sds_refs: 2, screening: 2,
  activity_scope: 3, environmental_hazards: 3, environmental_controls: 3, facilities_hazards: 3, facilities_controls: 3,
  student_hazards: 3, student_controls: 3, induction_instruction: 3, supervision_notes: 3, supervisor_qualification: 3,
  facilities_equipment: 3, students_notes: 3, emergency_first_aid: 3, vet_section: 3, vet_units: 3, trainer_competencies: 3,
  vet_safety_requirements: 3,
  risk_level: 4, risk_basis: 4, consent_required: 4, emergency_confirm: 4, first_aid_kit_location: 4, first_aid_person: 4, submitted_by: 4,
};

const EXAMPLES = {
  general: { name: 'e.g. Year 9 Design Tech — sheet-metal toolbox', brief: 'e.g. Students mark out, cut and fold sheet metal to make a small toolbox, using snips, the guillotine and the pan brake, then rivet it together.' },
  vet: { name: 'e.g. Cert II Engineering — fabrication practicals', brief: 'e.g. Students cut, drill and MIG weld steel brackets in the welding bays, then grind and paint them, as part of their fabrication units.' },
};

function issueGroups(issues) {
  const open = checks.openIssues(issues || []);
  return {
    unsafe: open.filter((i) => i.key.startsWith('unsafe:')),
    teacher: open.filter((i) => i.level === 'block' && !i.key.startsWith('unsafe:') && !i.key.startsWith('pera:unapproved') && !i.key.startsWith('project:')),
    equipment: open.filter((i) => i.key.startsWith('pera:unapproved')),
    projects: open.filter((i) => i.key.startsWith('project:')),
    reviewer: open.filter((i) => i.level === 'review'),
    resolved: (issues || []).filter((i) => i.resolved),
  };
}

// Link to the field (in the staged form) or to a section of the overview.
function issueHref(caraId, i) {
  if (i.field === 'projects') return `/cara/${caraId}#projects`;
  if (i.key.startsWith('pera:unapproved')) return `/pera/${i.key.split(':')[2]}`;
  return `/cara/${caraId}/edit#${i.field}`;
}

function groupedIssuesHtml(caraId, issues, escapeHtml, { reviewer, resolveForms }) {
  const g = issueGroups(issues);
  const li = (i) => `<li><a href="${issueHref(caraId, i)}">${escapeHtml(i.text)}</a>${resolveForms && reviewer && i.level === 'review' ? `
      <form method="post" action="/cara/${caraId}/issues/resolve" class="chk-resolve"><input type="hidden" name="key" value="${escapeHtml(i.key)}">
        <input type="text" name="note" placeholder="Reviewer decision and reason" required aria-label="Reviewer decision and reason">
        <button class="btn btn-secondary btn-sm" type="submit">Record decision</button></form>` : ''}</li>`;
  const block = (title, sub, list, cls, open = true) => (list.length ? `
    <details class="chk-group ${cls}"${open ? ' open' : ''}><summary><strong>${title}</strong> <span class="chk-count">${list.length}</span> <span class="chk-sub">${sub}</span></summary>
      <ul class="chk-list">${list.map(li).join('')}</ul></details>` : '');
  const total = g.teacher.length + g.equipment.length + g.projects.length + g.reviewer.length;
  return `
    ${g.unsafe.length ? `<div class="chk-alert" role="alert"><strong>Unsafe first aid wording — must be corrected.</strong><ul>${g.unsafe.map(li).join('')}</ul></div>` : ''}
    ${total ? `<div class="chk-groups">
      ${block('Details to complete', 'you can fix these', g.teacher, 'chk-g-teacher')}
      ${block(g.equipment.length === 1 ? 'Equipment assessment awaiting approval' : `${g.equipment.length} equipment assessments awaiting approval`, 'needs an authorised approver', g.equipment, 'chk-g-equipment', false)}
      ${block('Projects needing a CARA review', 'record the review on this CARA', g.projects, 'chk-g-projects')}
      ${block('Decisions for the reviewer', 'a reviewer records these', g.reviewer, 'chk-g-reviewer')}
    </div>` : (g.unsafe.length ? '' : '<div class="chk-panel chk-ok">All checks are complete.</div>')}
    ${g.resolved.length ? `<details class="chk-resolved"><summary>${g.resolved.length} reviewer decision${g.resolved.length === 1 ? '' : 's'} recorded</summary><ul>${g.resolved.map((i) => `<li>${escapeHtml(i.text)}<br><em>${escapeHtml(i.resolved.note)} — ${escapeHtml(i.resolved.by)}</em></li>`).join('')}</ul></details>` : ''}`;
}

async function toolPickerHtml(pool, caraId, linkedIds, escapeHtml, riskBadgeClass) {
  const { rows } = await pool.query(
    `SELECT DISTINCT pr.id, pr.activity_name, pr.class_unit, pr.risk_level, pr.status, pr.archived FROM pera_records pr
     WHERE pr.archived = false OR pr.id IN (SELECT pera_id FROM cara_tool_links WHERE cara_id = $1)
     ORDER BY pr.class_unit NULLS LAST, pr.activity_name`, [caraId || 0]);
  const groups = new Map();
  for (const t of rows) {
    const k = t.class_unit || 'Other';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const name = (t) => String(t.activity_name).replace(/\s*[—–-]\s*(Plant\s*&\s*Equipment|Safe Operating)\s+Risk Assessment\s*$/i, '');
  return `
    <div class="tool-selected" id="tool_selected" aria-live="polite"></div>
    <div class="tool-picker">
      <div class="tool-picker-search"><input type="text" id="tool_search" placeholder="Search tools and equipment…" aria-label="Search tools and equipment"></div>
      <div class="tool-picker-list" id="tool_picker_list">
        ${[...groups].map(([g, ts]) => `
        <details class="tool-picker-group">
          <summary class="tool-picker-group-label">${escapeHtml(g)} <span class="tool-picker-group-count">(${ts.length})</span></summary>
          <div class="tool-picker-group-items">${ts.map((t) => `
            <div class="tool-picker-item" data-search="${escapeHtml(name(t).toLowerCase())}">
              <input type="checkbox" id="tool_${t.id}" name="tool_ids" value="${t.id}"${linkedIds.has(t.id) ? ' checked' : ''} data-risk="${escapeHtml(t.risk_level)}" data-approved="${!t.archived && t.status === 'Approved' ? '1' : '0'}">
              <label for="tool_${t.id}">${escapeHtml(name(t))}</label>
              ${t.archived ? '<span class="badge badge-draft tool-picker-flag">Archived</span>' : (t.status !== 'Approved' ? '<span class="badge badge-pending tool-picker-flag">Not yet approved</span>' : '')}
              <span class="badge ${riskBadgeClass(t.risk_level)}" title="Equipment rating">${escapeHtml(t.risk_level)}</span>
            </div>`).join('')}
          </div>
        </details>`).join('') || '<div class="tool-picker-item">No equipment assessments yet.</div>'}
      </div>
    </div>`;
}

async function caraFormHtml(o) {
  const { pool, r: rIn, escapeHtml, riskBadgeClass, user, caraAi, approvalText, issues, stage } = o;
  const r = rIn || {};
  const isNew = !r.id;
  const type = r.cara_type || o.presetType || '';
  const v = (k) => escapeHtml(r[k] != null ? String(r[k]) : '');
  const ta = (k, rows = 4, ph = '') => `<textarea id="${k}" name="${k}" rows="${rows}"${ph ? ` placeholder="${escapeHtml(ph)}"` : ''}>${v(k)}</textarea>`;
  const rooms = (await pool.query('SELECT id, name FROM rooms WHERE archived = false ORDER BY name')).rows;
  const linked = new Set(isNew ? [] : (await pool.query('SELECT pera_id FROM cara_tool_links WHERE cara_id = $1', [r.id])).rows.map((x) => x.pera_id));
  const ex = EXAMPLES[type] || EXAMPLES.general;
  const action = isNew ? '/cara' : `/cara/${r.id}/edit`;
  const g = issues ? issueGroups(issues) : null;

  const field = (id, label, input, help) => `<div class="form-row"><label for="${id}">${label}</label>${input}${help ? `<p class="field-help">${help}</p>` : ''}</div>`;

  const stage1 = `
    <section class="stage" data-stage="1" aria-labelledby="stage1_h">
      <h2 class="stage-title" id="stage1_h">1. Describe the activity</h2>
      <fieldset class="type-radios" id="cara_type"><legend>What are you planning?</legend>
        ${Object.entries(caraType.TYPES).map(([k, t]) => `
          <label class="type-radio"><input type="radio" name="cara_type" value="${k}"${type === k ? ' checked' : ''}>
            <span><strong>${escapeHtml(t.label)}</strong><small>${escapeHtml(t.desc)}</small></span></label>`).join('')}
      </fieldset>
      ${!isNew && !r.cara_type ? '<p class="field-help">This CARA was created before types existed. Choose the one that fits.</p>' : ''}
      ${field('activity_name', 'Activity name', `<input type="text" id="activity_name" name="activity_name" required value="${v('activity_name')}" data-ph-general="${escapeHtml(EXAMPLES.general.name)}" data-ph-vet="${escapeHtml(EXAMPLES.vet.name)}" placeholder="${escapeHtml(ex.name)}">`)}
      <div class="cohort-grid">
        ${field('class_unit', 'Class', `<input type="text" id="class_unit" name="class_unit" value="${v('class_unit')}" placeholder="e.g. 11 ENG">`)}
        ${field('year_level', 'Year level', `<input type="text" id="year_level" name="year_level" list="year_level_options" value="${v('year_level')}" placeholder="e.g. Year 11"><datalist id="year_level_options">${['Year 7', 'Year 8', 'Year 9', 'Year 10', 'Year 11', 'Year 12', 'Years 10–11', 'Years 11–12'].map((y) => `<option value="${y}">`).join('')}</datalist>`)}
        ${field('class_size', 'Class size', `<input type="number" id="class_size" name="class_size" min="1" max="999" value="${v('class_size')}" placeholder="e.g. 14">`)}
      </div>
      <div class="cohort-grid">
        ${field('age_range', 'Age range', `<input type="text" id="age_range" name="age_range" value="${v('age_range')}" placeholder="e.g. 16–17">`)}
        <div class="form-row" style="grid-column: span 2;"><label for="course" data-label-general="Course / subject" data-label-vet="Qualification (code and title)">Course / subject</label>
          <input type="text" id="course" name="course" value="${v('course')}" data-ph-general="e.g. Design and Technologies" data-ph-vet="e.g. MEM20422 Certificate II in Engineering Pathways" placeholder="${type === 'vet' ? 'e.g. MEM20422 Certificate II in Engineering Pathways' : 'e.g. Design and Technologies'}">
          <p class="field-help" data-show-for="vet">Enter the code and title from training.gov.au. PracReady and the AI never fill these in.</p></div>
      </div>
      <div data-show-for="vet">${field('delivery_context', 'Delivery context', `<select id="delivery_context" name="delivery_context"><option value="">— Choose —</option>${caraType.DELIVERY_CONTEXTS.map((d) => `<option${r.delivery_context === d ? ' selected' : ''}>${escapeHtml(d)}</option>`).join('')}</select>`)}</div>
      ${field('prior_experience', 'Relevant prior experience', ta('prior_experience', 2, 'e.g. Completed Year 10 metalwork and the general workshop induction; no welding experience yet'), 'What the class has already done or been inducted on.')}
      <div class="cohort-grid">
        ${field('room_id', 'Location', `<select id="room_id" name="room_id"><option value="">— Not in the room list —</option>${rooms.map((x) => `<option value="${x.id}"${Number(r.room_id) === x.id ? ' selected' : ''}>${escapeHtml(x.name)}</option>`).join('')}</select>`)}
        <div class="form-row" style="grid-column: span 2;"><label for="location_detail">Location detail</label><input type="text" id="location_detail" name="location_detail" value="${v('location_detail')}" placeholder="e.g. Metal workshop and welding bays"></div>
      </div>
      ${field('activity_brief', 'What will students actually do?', `<textarea id="activity_brief" name="activity_brief" rows="3" data-ph-general="${escapeHtml(EXAMPLES.general.brief)}" data-ph-vet="${escapeHtml(EXAMPLES.vet.brief)}" placeholder="${escapeHtml(ex.brief)}">${v('activity_brief')}</textarea>`, 'A few plain lines is enough. The full activity scope is drafted in step 3.')}
    </section>`;

  const stage2 = `
    <section class="stage" data-stage="2" aria-labelledby="stage2_h" hidden>
      <h2 class="stage-title" id="stage2_h">2. Select tools, materials and hazards</h2>
      <h3 class="stage-sub" id="tool_ids">Tools and equipment</h3>
      <p class="field-help">Each item links to its equipment risk assessment (PERA). Its rating is for the equipment, not the whole activity.</p>
      ${await toolPickerHtml(pool, r.id, linked, escapeHtml, riskBadgeClass)}
      <div class="equip-info" id="equip_info" aria-live="polite"></div>
      <h3 class="stage-sub">Materials</h3>
      ${field('materials', 'Materials', ta('materials', 2, 'e.g. mild steel flat bar, MIG wire, shielding gas, primer'))}
      ${field('sds_refs', 'Safety data sheet references', ta('sds_refs', 2, 'e.g. Primer — SDS in the workshop SDS folder'))}
      <h3 class="stage-sub" id="screening">Hazard questions</h3>
      ${screening.questionsHtml(r.screening || {}, escapeHtml)}
    </section>`;

  const vetIncomplete = ['vet_units', 'trainer_competencies', 'vet_safety_requirements'].filter((k) => !String(r[k] || '').trim()).length + (r.vet_codes_checked ? 0 : 1);
  const stage3 = `
    <section class="stage" data-stage="3" aria-labelledby="stage3_h" hidden>
      <h2 class="stage-title" id="stage3_h">3. Draft and review</h2>
      ${caraAi.apiEnabled() ? caraAi.draftPanelHtml({ compact: true }) : '<p class="field-help">The AI assistant isn\'t set up on this server. Fill in the sections below yourself.</p>'}
      <details class="draft-group" open><summary>Activity scope</summary>
        ${field('activity_scope', 'Activity scope', ta('activity_scope', 5), 'What students will do, over what period, with which tools, materials and processes.')}
      </details>
      <details class="draft-group" open><summary>Hazards and controls</summary>
        <div class="hz-grid">
          ${field('environmental_hazards', 'Environment hazards', ta('environmental_hazards', 3))}${field('environmental_controls', 'Environment controls', ta('environmental_controls', 3))}
          ${field('facilities_hazards', 'Facilities and equipment hazards', ta('facilities_hazards', 3))}${field('facilities_controls', 'Facilities and equipment controls', ta('facilities_controls', 3))}
          ${field('student_hazards', 'Student-related hazards', ta('student_hazards', 3))}${field('student_controls', 'Student-related controls', ta('student_controls', 3))}
        </div>
      </details>
      <details class="draft-group" open><summary>Induction and supervision</summary>
        ${field('induction_instruction', 'Induction and instruction', ta('induction_instruction', 4), 'Inductions, demonstrations and competency checks students must complete for this activity.')}
        ${field('supervision_notes', 'Supervision', ta('supervision_notes', 4), 'How closely students are supervised for each process or machine, ratios and positioning.')}
        ${field('supervisor_qualification', 'Supervisor qualification', ta('supervisor_qualification', 3), 'Who may supervise and what they must hold. VET trainer/assessor credentials go in VET details.')}
      </details>
      <details class="draft-group" open><summary>Facilities and equipment</summary>
        ${field('facilities_equipment', 'Facilities and equipment', ta('facilities_equipment', 3), 'The room and fixed safety provisions (extraction, screens, e-stops, eyewash, fire equipment).')}
      </details>
      <details class="draft-group" open><summary>Student considerations</summary>
        ${field('students_notes', 'Students', ta('students_notes', 4), 'Class-level considerations. Never sent to the AI.')}
      </details>
      <details class="draft-group" open><summary>Emergency arrangements</summary>
        ${field('emergency_first_aid', 'Emergency and first aid', ta('emergency_first_aid', 4))}
        ${caraSafety.firstAidButtonsHtml('emergency_first_aid', escapeHtml)}
        <p class="field-help">Kit location and first aider are confirmed in step 4.</p>
      </details>
      <details class="draft-group vet-section" id="vet_section" data-show-for="vet" open><summary>VET details <span class="draft-count" id="vet_count">${vetIncomplete ? `${vetIncomplete} to complete` : 'complete'}</span></summary>
        ${field('vet_units', 'Units of competency (one per line: code and title)', ta('vet_units', 3, 'e.g. MEMPE001 Use engineering workshop machines'))}
        ${field('trainer_competencies', 'Trainer/assessor competencies and verification references', ta('trainer_competencies', 2), 'RTO credentials needed to deliver and assess these units, and where they are verified.')}
        ${field('vet_safety_requirements', 'Training and assessment safety requirements', ta('vet_safety_requirements', 3))}
        <label class="checkbox-row"><input type="checkbox" name="vet_codes_checked" value="true"${r.vet_codes_checked ? ' checked' : ''}> I have checked the qualification and unit codes against training.gov.au</label>
      </details>
    </section>`;

  const stage4 = `
    <section class="stage" data-stage="4" aria-labelledby="stage4_h" hidden>
      <h2 class="stage-title" id="stage4_h">4. Check and submit</h2>
      <h3 class="stage-sub">Proposed activity risk</h3>
      <div class="cohort-grid">
        ${field('risk_level', 'Proposed activity risk rating', `<select id="risk_level" name="risk_level"><option value="">— Not set —</option>${['Low', 'Medium', 'High', 'Extreme'].map((l) => `<option${r.risk_level === l ? ' selected' : ''}>${l}</option>`).join('')}</select>`)}
        <div class="form-row" style="grid-column: span 2;"><label for="risk_basis">Basis for this rating</label>${ta('risk_basis', 2, 'e.g. Highest equipment rating is High (MIG welder); controls in step 3 keep the activity at High.')}</div>
      </div>
      <p class="field-help" id="risk_info">The reviewer confirms the final rating when approving. Equipment ratings, the activity rating and legal SWMS triggers are separate.</p>
      <div class="note-box" id="approval_req" data-texts="${escapeHtml(JSON.stringify(approvalText))}">${escapeHtml(approvalText[r.risk_level] || approvalText[''] || '')}</div>
      <label class="checkbox-row" id="consent_required"><input type="checkbox" name="consent_required" value="true"${r.consent_required ? ' checked' : ''}> Parent consent required (required for Extreme, recommended for High)</label>
      <h3 class="stage-sub" id="emergency_confirm">Emergency arrangements for this location</h3>
      <div class="cohort-grid">
        <div class="form-row" style="grid-column: span 2;"><label for="first_aid_kit_location">First aid kit location</label><input type="text" id="first_aid_kit_location" name="first_aid_kit_location" value="${v('first_aid_kit_location')}" placeholder="Where exactly"></div>
        ${field('first_aid_person', 'Person with current first aid', `<input type="text" id="first_aid_person" name="first_aid_person" value="${v('first_aid_person')}" placeholder="Name">`)}
      </div>
      <label class="checkbox-row"><input type="checkbox" name="emergency_confirmed" value="true"${r.emergency_confirmed ? ' checked' : ''}> I have checked these arrangements for this activity's location</label>
      ${field('submitted_by', 'Prepared by', `<input type="text" id="submitted_by" name="submitted_by" value="${escapeHtml(r.submitted_by || (user ? user.name : ''))}">`)}
      <h3 class="stage-sub">Checks</h3>
      ${g ? `<p class="field-help">From the last save. Save draft to refresh.</p>${groupedIssuesHtml(r.id, issues, escapeHtml, { reviewer: false, resolveForms: false })}` : '<p class="field-help">Save the draft to run the checks.</p>'}
    </section>`;

  return `
    <form class="form-card cara-stages" method="post" action="${action}" id="cara_form" data-pretty novalidate>
      <nav class="stage-nav" aria-label="CARA steps"><ol>
        ${STAGES.map((s, i) => `<li><button type="button" class="stage-btn" data-go="${i + 1}" aria-controls="stage${i + 1}_h"><span class="stage-num">${i + 1}</span> ${s}<span class="stage-todo" data-todo="${i + 1}"></span></button></li>`).join('')}
      </ol></nav>
      ${!isNew && r.status && r.status !== 'Draft' ? '<div class="note-box">Saving changes returns this CARA to <strong>Draft</strong>. The approved version is kept and it will need re-approval.</div>' : ''}
      ${o.saved ? '<div class="saved-msg" role="status">Draft saved.</div>' : ''}
      <input type="hidden" name="cara_type_fields" value="1">
      <input type="hidden" name="screening_fields" value="1">
      <input type="hidden" name="stage" id="stage_input" value="${Number(stage) || 1}">
      <input type="hidden" name="after" id="after_input" value="">
      <input type="hidden" name="edited_by" value="${escapeHtml(user ? user.name : '')}">
      ${stage1}${stage2}${stage3}${stage4}
      <div class="stage-bar">
        <button type="button" class="btn btn-secondary" id="stage_back">Back</button>
        <button type="submit" class="btn btn-secondary" id="stage_save">Save draft</button>
        <button type="button" class="btn btn-primary" id="stage_next">Next</button>
        ${isNew ? '' : '<button type="submit" class="btn btn-primary" id="stage_submit" hidden>Save and go to sign &amp; submit</button>'}
        ${isNew ? '<button type="submit" class="btn btn-primary" id="stage_submit" hidden>Save draft and run checks</button>' : ''}
      </div>
    </form>
    ${screening.clientScript({ formId: 'cara_form', textIds: ['activity_brief', 'activity_scope', 'materials', 'activity_name', 'course'], peraName: 'tool_ids', templateId: null })}
    <script>
    (function () {
      var form = document.getElementById('cara_form');
      var stageInput = document.getElementById('stage_input');
      var STAGE_OF = ${JSON.stringify(STAGE_OF_FIELD)};
      var cur = Number(stageInput.value) || 1;
      function typeVal() { var c = form.querySelector('input[name="cara_type"]:checked'); return c ? c.value : ''; }
      function applyType() {
        var t = typeVal();
        form.querySelectorAll('[data-show-for]').forEach(function (el) { el.style.display = el.dataset.showFor === t ? '' : 'none'; });
        form.querySelectorAll('[data-label-vet]').forEach(function (el) { el.textContent = t === 'vet' ? el.dataset.labelVet : el.dataset.labelGeneral; });
        form.querySelectorAll('[data-ph-vet]').forEach(function (el) { el.placeholder = t === 'vet' ? el.dataset.phVet : el.dataset.phGeneral; });
      }
      function filled(n) { var el = form.elements[n]; if (!el) return true; if (el.length && el[0] && el[0].type === 'radio') return !!form.querySelector('input[name="' + n + '"]:checked'); return !!String(el.value || '').trim(); }
      function todo() {
        var vet = typeVal() === 'vet';
        var req = {
          1: ['cara_type', 'activity_name', 'year_level', 'class_size', 'course'].concat(vet ? ['delivery_context'] : []),
          2: [], 3: ['activity_scope', 'induction_instruction', 'supervision_notes', 'supervisor_qualification', 'emergency_first_aid'].concat(vet ? ['vet_units', 'trainer_competencies', 'vet_safety_requirements'] : []),
          4: ['risk_level', 'first_aid_kit_location', 'first_aid_person']
        };
        var counts = {};
        Object.keys(req).forEach(function (s) { counts[s] = req[s].filter(function (n) { return !filled(n); }).length; });
        if (!filled('room_id') && !filled('location_detail')) counts[1]++;
        counts[2] += form.querySelectorAll('.prj-q.prj-q-missing').length + (form.querySelector('input[name="tool_ids"]:checked') ? 0 : 1);
        if (!form.querySelector('input[name="emergency_confirmed"]').checked) counts[4]++;
        if (vet && !form.querySelector('input[name="vet_codes_checked"]').checked) counts[3]++;
        document.querySelectorAll('[data-todo]').forEach(function (el) { var n = counts[el.dataset.todo]; el.textContent = n ? ' · ' + n + ' to do' : ' ✓'; el.className = 'stage-todo' + (n ? ' has-todo' : ' done'); });
        var vc = document.getElementById('vet_count');
        if (vc) { var m = ['vet_units', 'trainer_competencies', 'vet_safety_requirements'].filter(function (n) { return !filled(n); }).length + (form.querySelector('input[name="vet_codes_checked"]').checked ? 0 : 1); vc.textContent = m ? m + ' to complete' : 'complete'; }
      }
      function show(n, focusEl) {
        cur = Math.max(1, Math.min(4, n)); stageInput.value = cur;
        form.querySelectorAll('.stage').forEach(function (s) { s.hidden = Number(s.dataset.stage) !== cur; });
        document.querySelectorAll('.stage-btn').forEach(function (b) { var on = Number(b.dataset.go) === cur; b.classList.toggle('current', on); if (on) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current'); });
        document.getElementById('stage_back').disabled = cur === 1;
        document.getElementById('stage_next').hidden = cur === 4;
        var sub = document.getElementById('stage_submit'); if (sub) sub.hidden = cur !== 4;
        if (focusEl) { var d = focusEl.closest('details'); if (d) d.open = true; focusEl.scrollIntoView({ block: 'center' }); if (focusEl.focus) try { focusEl.focus({ preventScroll: true }); } catch (e) {} }
        else window.scrollTo(0, form.getBoundingClientRect().top + window.scrollY - 80);
        todo();
      }
      document.querySelectorAll('.stage-btn').forEach(function (b) { b.addEventListener('click', function () { show(Number(b.dataset.go)); }); });
      document.getElementById('stage_back').addEventListener('click', function () { show(cur - 1); });
      document.getElementById('stage_next').addEventListener('click', function () { show(cur + 1); });
      var sub = document.getElementById('stage_submit'); if (sub) sub.addEventListener('click', function () { document.getElementById('after_input').value = 'submit'; });
      form.addEventListener('submit', function () { if (!form.querySelector('input[name="activity_name"]').value.trim()) { show(1, form.querySelector('#activity_name')); } });
      form.addEventListener('input', todo); form.addEventListener('change', function (e) { if (e.target.name === 'cara_type') applyType(); todo(); });
      form.addEventListener('screening-updated', todo);
      // Equipment: selected list and rating info
      function equip() {
        var sel = Array.prototype.slice.call(form.querySelectorAll('input[name="tool_ids"]:checked'));
        var box = document.getElementById('tool_selected');
        box.innerHTML = sel.length ? '<strong>Selected (' + sel.length + '):</strong> ' + sel.map(function (c) {
          var l = form.querySelector('label[for="' + c.id + '"]');
          return '<span class="tool-chip-sel' + (c.dataset.approved === '1' ? '' : ' unapproved') + '">' + (l ? l.textContent : '') + ' · ' + c.dataset.risk + (c.dataset.approved === '1' ? '' : ' · not yet approved') + '</span>';
        }).join(' ') : '<span class="field-help">Nothing selected yet. Search or open a category below.</span>';
        var order = { Low: 1, Medium: 2, High: 3, Extreme: 4 }, hi = '';
        sel.forEach(function (c) { if (!hi || order[c.dataset.risk] > order[hi]) hi = c.dataset.risk; });
        document.getElementById('equip_info').textContent = hi ? 'Highest equipment rating: ' + hi + '. The activity risk is set in step 4 after reviewing the activity and its controls.' : '';
      }
      form.addEventListener('change', function (e) { if (e.target.name === 'tool_ids') equip(); });
      document.getElementById('tool_search').addEventListener('input', function () {
        var q = this.value.toLowerCase();
        form.querySelectorAll('.tool-picker-group').forEach(function (g) {
          var any = false;
          g.querySelectorAll('.tool-picker-item[data-search]').forEach(function (it) { var m = it.dataset.search.indexOf(q) >= 0; it.style.display = m ? '' : 'none'; if (m) any = true; });
          g.open = !!q && any; g.style.display = !q || any ? '' : 'none';
        });
      });
      // Approval requirement follows the proposed rating
      var ar = document.getElementById('approval_req'), texts = JSON.parse(ar.dataset.texts || '{}');
      document.getElementById('risk_level').addEventListener('change', function () { ar.textContent = texts[this.value] || texts[''] || ''; });
      // Age range from year level
      document.getElementById('year_level').addEventListener('change', function () { var ar2 = document.getElementById('age_range'); if (ar2.value.trim()) return; var n = (this.value.match(/\\d+/g) || []).map(Number); if (n.length) ar2.value = (Math.min.apply(null, n) + 5) + '–' + (Math.max.apply(null, n) + 6); });
      applyType(); equip();
      // Jump to a field from an issue link (#field) or open a given stage.
      var hash = decodeURIComponent((location.hash || '').slice(1));
      var target = hash && (document.getElementById(hash) || form.querySelector('[name="' + hash + '"]'));
      if (target) { var st = target.closest('.stage'); show(st ? Number(st.dataset.stage) : (STAGE_OF[hash] || cur), target); } else show(cur);
    })();
    </script>`;
}

// Extra CARA fields introduced with the staged form.
const EXTRA_FIELDS = [
  ['activity_brief', 'What students will do (brief)'], ['materials', 'Materials'], ['sds_refs', 'SDS references'], ['risk_basis', 'Basis for risk rating'],
];
function extraFromBody(b) {
  const clean = (v) => { const t = v == null ? '' : String(v).replace(/\r\n?/g, '\n').trim(); return t || null; };
  const out = {};
  for (const [k] of EXTRA_FIELDS) if (k in b) out[k] = clean(b[k]);
  if (b.screening_fields === '1') {
    const rules = require('./project-rules');
    const answers = {};
    for (const q of rules.QUESTIONS) if (['Yes', 'No', 'Unsure'].includes(b[`q_${q.key}`])) answers[q.key] = b[`q_${q.key}`];
    out.screening = answers;
  }
  return out;
}
async function saveExtra(pool, id, e) {
  const keys = Object.keys(e);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 1}`);
  await pool.query(`UPDATE cara_records SET ${sets.join(', ')} WHERE id = $${keys.length + 1}`, [...keys.map((k) => (k === 'screening' ? JSON.stringify(e[k]) : e[k])), id]);
}

module.exports = { EXTRA_FIELDS, extraFromBody, saveExtra, caraFormHtml, STAGES, STAGE_OF_FIELD, issueGroups, groupedIssuesHtml, issueHref };
