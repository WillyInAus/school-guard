// CARA projects: project-level safety documents linked to a parent CARA
// (e.g. a Cert II Construction CARA with Sawhorse, Simulated wall, Brick and
// block laying, Concreting and Tiling projects).
//
// Key rules (see also project-rules.js):
// - Linking a project never implies the parent CARA covers it. Anything that
//   may sit outside the CARA (equipment not in the CARA, teacher not sure the
//   CARA scope describes it, possible high risk construction work, permanent
//   installation) shows a "CARA needs review" flag on the CARA until someone
//   with authority records that the CARA has been reviewed for those reasons.
// - Activity classification, document purpose and workflow status are kept
//   separate. CARA risk ratings are not legal triggers. Possible legal SWMS
//   triggers come from a source-linked checklist and must be confirmed by a
//   reviewer; ambiguous cases stay "Needs review". The AI never classifies.
// - AI drafting only suggests; nothing is written until the teacher clicks
//   "Use this". The parent CARA's Students box is never read for AI requests.
// - Any change to an approved project returns it to Draft as a new version;
//   earlier approved versions are kept as snapshots.

const rules = require('./project-rules');
const pdf = require('./cara-pdf');
const { cohortSummary } = require('./cara-cohort');
const checks = require('./cara-checks');
const firstAid = require('./first-aid');
const aiPrivacy = require('./ai-privacy');
const caraSafety = require('./cara-safety');

const PROJECT_TEXT_FIELDS = [
  ['description', 'What students will do'], ['scope_exclusions', 'Scope and exclusions'], ['materials', 'Materials'], ['sds_refs', 'SDS references'],
  ['conditions', 'Other conditions and hazards'], ['ppe', 'PPE'], ['induction_supervision', 'Induction, supervision and competency'],
  ['emergency_notes', 'Emergency considerations'], ['first_aid_kit_location', 'First aid kit location'], ['first_aid_person', 'First aid person'],
];

const CONTENT_FIELDS = [
  ['name', 'Project name'], ['project_type', 'Project type'], ['description', 'Description'],
  ['practice_type', 'Temporary/permanent'], ['room_id', 'Room'], ['location_detail', 'Location detail'],
  ['materials', 'Materials'], ['sds_refs', 'SDS references'], ['conditions', 'Project-specific conditions and hazards'],
  ['in_cara_scope', 'Described in CARA scope'], ['doc_purpose', 'Document purpose'],
  ['scope_exclusions', 'Scope and exclusions'], ['ppe', 'PPE'], ['induction_supervision', 'Induction, supervision and competency'],
  ['first_aid_kit_location', 'First aid kit location'], ['first_aid_person', 'First aid person'], ['emergency_notes', 'Emergency considerations'],
  ['emergency_confirmed', 'Emergency details confirmed'],
  ['open_questions', 'Outstanding questions and assumptions'], ['cara_change_proposal', 'Suggested CARA changes'],
];

module.exports = function registerCaraProjects(app, deps) {
  const {
    pool, page, escapeHtml, requireRole, canManageOwnRecord, formatDate, formatDateTime, riskBadgeClass, caraAi, BRAND,
  } = deps;

  const isReviewer = (u) => u && ['admin', 'approver', 'system_admin'].includes(u.role);
  const clean = (v) => {
    if (v === null || v === undefined) return null;
    const s = String(v).replace(/\r\n?/g, '\n').trim();
    return s || null;
  };
  const pick = (v, list, dflt) => (list.includes(v) ? v : dflt);
  const ref = (p) => `PRJ-${String(p.id).padStart(4, '0')}`;
  const caraRef = (id) => `CARA-${String(id).padStart(4, '0')}`;
  const nl2 = (s) => escapeHtml(s || '');

  async function loadCara(id) {
    // Explicit column list: the Students notes are never loaded here.
    const { rows } = await pool.query(
      `SELECT id, activity_name, class_unit, activity_scope, risk_level, status, archived, created_by_staff_id,
              supervision_notes, supervisor_qualification, induction_instruction, facilities_equipment, emergency_first_aid,
              environmental_hazards, environmental_controls, facilities_hazards, facilities_controls,
              student_hazards, student_controls, year_level, course, class_size, age_range, prior_experience,
              cara_type, location_detail, vet_units, delivery_context, vet_safety_requirements
       FROM cara_records WHERE id = $1`, [id]);
    return rows[0] || null;
  }
  async function caraPeraIds(caraId) {
    const { rows } = await pool.query('SELECT pera_id FROM cara_tool_links WHERE cara_id = $1', [caraId]);
    return rows.map((r) => r.pera_id);
  }
  async function loadProject(id) {
    const { rows } = await pool.query(
      `SELECT p.*, r.name AS room_name FROM cara_projects p LEFT JOIN rooms r ON r.id = p.room_id WHERE p.id = $1`, [id]);
    if (!rows[0]) return null;
    const p = rows[0];
    const peras = await pool.query(
      `SELECT pr.id, pr.activity_name, pr.risk_level, pr.status, pr.archived, pr.supervision_level, pr.required_supervision
       FROM cara_project_peras l JOIN pera_records pr ON pr.id = l.pera_id WHERE l.project_id = $1 ORDER BY pr.activity_name`, [id]);
    p.peras = peras.rows;
    return p;
  }
  const canEdit = (user, project, cara) => user && (canManageOwnRecord(user, project || {}) || (cara && canManageOwnRecord(user, cara)));

  async function log(projectId, by, action, summary) {
    await pool.query('INSERT INTO cara_project_log (project_id, changed_by, action, summary) VALUES ($1,$2,$3,$4)', [projectId, by, action, summary || null]);
  }

  // Reasons the parent CARA may not cover this project (computed live).
  function caraReviewReasons(p, caraPeras) {
    const reasons = [];
    const inCara = new Set(caraPeras.map(Number));
    const extra = (p.peras || []).filter((x) => !inCara.has(Number(x.id)));
    if (extra.length) reasons.push(`Uses equipment not in the CARA's PERA list: ${extra.map((x) => pdf.toolName(x.activity_name)).join(', ')}`);
    if (p.in_cara_scope === 'No') reasons.push('Teacher says the CARA scope does not describe this project');
    if (p.in_cara_scope !== 'No' && p.in_cara_scope !== 'Yes') reasons.push('Not yet confirmed that the CARA scope describes this project');
    const ev = rules.evaluate(p);
    for (const t of ev.triggers) reasons.push(`Possible high risk construction work: ${t.label}`);
    if (p.practice_type === 'Permanent installation for use') reasons.push('Permanent installation for use (may be construction work)');
    if (p.cara_change_proposal && p.cara_change_proposal.trim()) reasons.push('Has suggested CARA changes (not applied)');
    return reasons;
  }
  function caraReviewOpen(p, caraPeras) {
    const reasons = caraReviewReasons(p, caraPeras);
    const cleared = (p.cara_review_cleared && p.cara_review_cleared.reasons) || [];
    return reasons.filter((r) => !cleared.includes(r));
  }

  // Basis for a trigger confirmation: if the supporting answers change, the
  // reviewer's confirmation no longer counts.
  function triggerBasis(p, key) {
    return rules.visibleQuestions(p.answers, p).filter((q) => q.trigger === key).map((q) => `${q.key}=${(p.answers || {})[q.key] || ''}`).join(';');
  }
  function withValidConfirmations(p) {
    const tr = {};
    for (const [k, v] of Object.entries(p.trigger_reviews || {})) {
      if (v && v.basis === triggerBasis(p, k)) tr[k] = v;
    }
    // A reviewer's classification only stands while the answers it was
    // based on are unchanged.
    const classStale = p.activity_class !== 'Needs review' && p.class_basis && p.class_basis !== rules.classificationBasis(p);
    return { ...p, trigger_reviews: tr, activity_class: classStale ? 'Needs review' : p.activity_class, class_stale: !!classStale };
  }

  // All approval checks for a project (deterministic). Review-level issues can
  // be resolved by a reviewer's recorded decision tied to the issue text.
  function projectIssues(p, cara) {
    const out = [];
    const add = (key, level, text, field) => out.push({ key, level, text, field });
    for (const b of rules.approvalBlockers(p)) {
      const field = /question|Unsure|services|Engineered/i.test(b) ? 'screening' : /trigger/i.test(b) ? '#triggers' : /classification|document purpose/i.test(b) ? '#review' : /emergency/i.test(b) ? 'emergency_notes' : 'name';
      add(`rule:${b.slice(0, 50)}`, 'block', b, field);
    }
    if (p.class_stale) add('class:stale', 'block', 'Screening answers changed after the reviewer classified this project, so the classification is back to "Needs review".', '#review');
    for (const [k, label] of PROJECT_TEXT_FIELDS) {
      const ph = checks.findPlaceholders(p[k]);
      if (ph.length) add(`placeholder:${k}`, 'block', `${label} still has placeholder${ph.length === 1 ? '' : 's'}: ${ph.slice(0, 4).join(', ')}`, k);
      for (const f of firstAid.scanUnsafe(p[k])) add(`unsafe:${k}:${f.id}`, 'block', `Unsafe first aid wording in ${label}: "${f.sentence}" — ${f.message}`, k);
    }
    (p.work_steps || []).forEach((st, i) => {
      const t = `${st.step}\n${st.hazards}\n${st.controls}`;
      const ph = checks.findPlaceholders(t);
      if (ph.length) add(`placeholder:step${i}`, 'block', `Work step ${i + 1} still has placeholders: ${ph.slice(0, 3).join(', ')}`, 'prj_steps');
      for (const f of firstAid.scanUnsafe(t)) add(`unsafe:step${i}:${f.id}`, 'block', `Unsafe first aid wording in work step ${i + 1}: "${f.sentence}"`, 'prj_steps');
    });
    if (p.open_questions && p.open_questions.trim()) add('open-questions', 'block', 'Outstanding questions and assumptions are not resolved. Answer them in the right sections, then clear that box.', 'open_questions');
    if (!cara || cara.status !== 'Approved') add('parent:unapproved', 'block', `The parent CARA is "${cara ? cara.status : 'missing'}". It must be approved before this project can be approved.`, '#parent');
    for (const x of p.peras || []) if (x.archived || x.status !== 'Approved') add(`pera:${x.id}`, 'block', `PERA "${pdf.toolName(x.activity_name)}" is not approved.`, 'prj_pera_list');
    const texts = [{ label: 'this project (induction/supervision)', text: p.induction_supervision }, ...(p.work_steps || []).map((st, i) => ({ label: `work step ${i + 1}`, text: st.controls }))];
    if (cara && cara.supervision_notes) texts.push({ label: 'the parent CARA (Supervision)', text: cara.supervision_notes });
    for (const c of checks.supervisionConflicts(texts, p.peras || [])) add(c.key, 'review', c.text, 'induction_supervision');
    return checks.applyResolutions(out, p.issue_resolutions);
  }
  const authorised = (p, cara) => p.status === 'Approved' && cara && cara.status === 'Approved' && (p.peras || []).every((x) => !x.archived && x.status === 'Approved');

  // ---------- Panel on the CARA page ----------
  async function caraPanelHtml(cara, user) {
    const { rows } = await pool.query(
      `SELECT p.*, r.name AS room_name FROM cara_projects p LEFT JOIN rooms r ON r.id = p.room_id WHERE p.cara_id = $1 ORDER BY p.status = 'Archived', p.created_at`, [cara.id]);
    const caraPeras = await caraPeraIds(cara.id);
    for (const p of rows) {
      p.peras = (await pool.query(`SELECT pr.id, pr.activity_name FROM cara_project_peras l JOIN pera_records pr ON pr.id = l.pera_id WHERE l.project_id = $1`, [p.id])).rows;
      p.open = p.status === 'Archived' ? [] : caraReviewOpen(p, caraPeras);
    }
    const flagged = rows.filter((p) => p.open.length);
    const canAdd = !cara.archived && canEdit(user, null, cara);
    const canClear = isReviewer(user) || canManageOwnRecord(user, cara);
    const statusCls = (s) => ({ Draft: 'badge-draft', 'Awaiting review': 'badge-pending', Approved: 'badge-approved', Archived: 'badge-draft' }[s] || 'badge-draft');
    const list = rows.length ? `
      <div class="prj-table-wrap"><table class="prj-table">
        <thead><tr><th>Project</th><th>Type</th><th>Classification</th><th>Document</th><th>Status</th><th>CARA</th></tr></thead>
        <tbody>${rows.map((p) => `
          <tr>
            <td><a href="/projects/${p.id}">${escapeHtml(p.name)}</a><div class="prj-sub">${escapeHtml(ref(p))}${p.room_name ? ` · ${escapeHtml(p.room_name)}` : ''}</div></td>
            <td>${escapeHtml((rules.TEMPLATES[p.project_type] || {}).label || p.project_type || '—')}</td>
            <td>${escapeHtml(p.activity_class)}</td>
            <td>${escapeHtml(p.doc_purpose)}</td>
            <td><span class="badge ${statusCls(p.status)}">${escapeHtml(p.status)}</span> <span class="prj-sub">v${p.version}</span></td>
            <td>${p.open.length ? '<span class="badge badge-changes">Needs review</span>' : (p.status === 'Archived' ? '—' : '<span class="badge badge-approved">OK</span>')}</td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="detail-value">No projects linked yet.</p>';

    const flagHtml = flagged.length ? `
      <div class="cara-unapproved prj-flag">
        <strong>CARA needs review.</strong> ${flagged.length === 1 ? 'A linked project may' : `${flagged.length} linked projects may`} go beyond what this CARA covers. Update the CARA if needed, then record the review.
        ${flagged.map((p) => `
          <div class="prj-flag-item">
            <a href="/projects/${p.id}">${escapeHtml(p.name)}</a>
            <ul>${p.open.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
            ${p.cara_change_proposal ? `<details><summary>Suggested CARA changes (not applied)</summary><div class="pretty-text detail-value">${nl2(p.cara_change_proposal)}</div></details>` : ''}
            ${canClear ? `<form method="post" action="/projects/${p.id}/cara-reviewed" onsubmit="return confirm('Record that the CARA has been reviewed and covers these points for this project?');">
              <button class="btn btn-secondary btn-sm" type="submit">CARA reviewed for this project</button></form>` : ''}
          </div>`).join('')}
      </div>` : '';

    return `
      <div class="detail-section prj-panel${cara.cara_type === 'vet' ? ' prj-panel-vet' : ''}" id="projects">
        <div class="prj-panel-head">
          <div class="detail-label">Projects under this CARA</div>
          ${canAdd ? `<a class="btn btn-primary btn-sm" href="/cara/${cara.id}/projects/new">Add project</a>` : ''}
        </div>
        <p class="form-section-hint">${cara.cara_type === 'vet'
          ? '<strong>VET courses usually involve several projects.</strong> Each project needs its own scope, hazards and controls, and may mean this CARA has to be updated. Linking a project does not mean this CARA already covers its risks.'
          : 'Optional: add projects if this activity includes distinct projects (e.g. separate builds). Each project has its own safety document; linking one does not mean this CARA already covers its risks.'}</p>
        ${flagHtml}
        ${list}
      </div>`;
  }

  // ---------- Form ----------
  async function formHtml({ cara, p, action, user }) {
    const rooms = (await pool.query('SELECT id, name FROM rooms WHERE archived = false ORDER BY name')).rows;
    const peras = (await pool.query(`SELECT id, activity_name, class_unit, risk_level, status FROM pera_records WHERE archived = false ORDER BY class_unit NULLS LAST, activity_name`)).rows;
    const inCara = new Set((await caraPeraIds(cara.id)).map(Number));
    const selected = new Set((p.peras || []).map((x) => Number(x.id)));
    const a = p.answers || {};
    const opt = (list, v) => list.map((x) => `<option value="${escapeHtml(x)}"${x === v ? ' selected' : ''}>${escapeHtml(x)}</option>`).join('');

    const peraItem = (t) => `
      <div class="tool-picker-item" data-search="${escapeHtml(t.activity_name.toLowerCase())}">
        <input type="checkbox" id="pp_${t.id}" name="pera_ids" value="${t.id}"${selected.has(t.id) ? ' checked' : ''}>
        <label for="pp_${t.id}">${escapeHtml(pdf.toolName(t.activity_name))}</label>
        ${t.status !== 'Approved' ? '<span class="badge badge-pending tool-picker-flag">Not yet approved</span>' : ''}
        <span class="badge ${riskBadgeClass(t.risk_level)}">${escapeHtml(t.risk_level)}</span>
      </div>`;
    const caraList = peras.filter((t) => inCara.has(t.id));
    const others = new Map();
    for (const t of peras.filter((x) => !inCara.has(x.id))) {
      const k = t.class_unit || 'Other';
      if (!others.has(k)) others.set(k, []);
      others.get(k).push(t);
    }
    const peraPicker = `
      <div class="tool-picker">
        <div class="tool-picker-search"><input type="text" placeholder="Search equipment..." oninput="prjFilter(this.value)"></div>
        <div class="tool-picker-list" id="prj_pera_list">
          <details class="tool-picker-group" open><summary class="tool-picker-group-label">In this CARA <span class="tool-picker-group-count">(${caraList.length})</span></summary>
            <div class="tool-picker-group-items">${caraList.map(peraItem).join('') || '<div class="tool-picker-item">None linked to the CARA.</div>'}</div></details>
          ${[...others].map(([g, ts]) => `<details class="tool-picker-group"><summary class="tool-picker-group-label">${escapeHtml(g)} <span class="tool-picker-group-count">(${ts.length})</span></summary>
            <div class="tool-picker-group-items">${ts.map(peraItem).join('')}</div></details>`).join('')}
        </div>
      </div>
      <p class="form-section-hint">Equipment outside the CARA's list flags the CARA for review.</p>`;

    const groups = [...new Set(rules.QUESTIONS.map((q) => q.group))];
    const questionsHtml = `
      <fieldset class="prj-qgroup prj-qrelevant" id="prj_relevant"><legend>Most relevant to this project</legend>
        <p class="form-section-hint prj-relevant-empty">Choose a template and describe the project, tools and materials above to bring the relevant questions here.</p>
      </fieldset>
      <div class="prj-screen-head"><strong>Hazard screening (${escapeHtml(rules.JURISDICTION)})</strong> — answer every question marked <span class="prj-crit">*</span>. Use "Unsure" if you don't know; it stays unresolved until a reviewer settles it. Unanswered questions are never treated as "No".</div>
      ` + groups.map((g, gi) => `
      <fieldset class="prj-qgroup" id="prj_g${gi}"><legend>${escapeHtml(g)}</legend>
        ${rules.QUESTIONS.filter((q) => q.group === g).map((q) => `
          <div class="prj-q" data-q="${q.key}" data-home="prj_g${gi}" data-critical="${q.critical === true ? 'yes' : (q.critical || 'no')}"${q.showIf ? ` data-show-if="${q.showIf}"` : ''}${q.hideIfNo ? ` data-hide-if-no="${q.hideIfNo}"` : ''}${q.onlyWhenRelevant ? ' data-only-relevant="1"' : ''}>
            <div class="prj-q-text">${escapeHtml(q.text)} <span class="prj-crit" title="Must be answered">*</span></div>
            <div class="prj-q-opts">${['Yes', 'No', 'Unsure'].map((v) => `
              <label><input type="radio" name="q_${q.key}" value="${v}"${a[q.key] === v ? ' checked' : ''}> ${v}</label>`).join('')}</div>
            ${q.note ? `<div class="prj-q-note">${escapeHtml(q.note)}</div>` : ''}
          </div>`).join('')}
      </fieldset>`).join('') + `
      <details class="prj-qgroup prj-more" id="prj_more"><summary>More hazard questions (not matched to this project — open if any apply)</summary></details>`;

    const suggested = rules.suggestedGroups(`${cara.course || ''} ${cara.class_unit || ''} ${cara.activity_name || ''} ${cara.activity_scope || ''}`);
    const order = [...suggested, ...rules.TEMPLATE_GROUPS.filter((g) => !suggested.includes(g))];
    const current = p.project_type || (suggested[0] === 'Engineering' ? 'fabrication' : 'custom');
    const templateOptions = order.map((g) => `<optgroup label="${escapeHtml(suggested.includes(g) ? `${g} (suggested)` : g)}">${Object.entries(rules.TEMPLATES).filter(([, t]) => t.group === g)
      .map(([k, t]) => `<option value="${k}"${current === k ? ' selected' : ''}>${escapeHtml(t.label)}</option>`).join('')}</optgroup>`).join('');

    const steps = Array.isArray(p.work_steps) ? p.work_steps : [];
    const caraSummary = `
      <details class="prj-cara-ref"><summary>Parent CARA: ${escapeHtml(caraRef(cara.id))} ${escapeHtml(cara.activity_name)} (${escapeHtml(cara.risk_level)} risk, ${escapeHtml(cara.status)})</summary>
        <div class="detail-section"><div class="detail-label">Activity scope</div><div class="detail-value pretty-text">${nl2(cara.activity_scope || '—')}</div></div>
        <div class="detail-section"><div class="detail-label">Supervision</div><div class="detail-value pretty-text">${nl2(cara.supervision_notes || '—')}</div></div>
        <div class="detail-section"><div class="detail-label">Emergency and first aid (CARA)</div><div class="detail-value pretty-text">${nl2(cara.emergency_first_aid || '—')}</div></div>
      </details>`;

    return `
      <form class="form-card prj-form" method="post" action="${action}" id="prj_form" style="max-width:860px;">
        ${caraSummary}
        <input type="hidden" name="cara_id" value="${cara.id}">

        <div class="form-section-title">Project</div>
        <div class="cohort-grid">
          <div class="form-row" style="grid-column: span 2;">
            <label for="name">Project name</label>
            <input type="text" id="name" name="name" required value="${nl2(p.name)}" placeholder="e.g. Brick and block laying">
          </div>
          <div class="form-row">
            <label for="project_type">Type / template</label>
            <select id="project_type" name="project_type">${templateOptions}</select>
            ${suggested.length ? `<p class="form-section-hint">Suggested for ${escapeHtml(cara.course || cara.class_unit || 'this course')}: ${escapeHtml(suggested.join(', '))} templates. Any template can be used; a template never decides SWMS requirements.</p>` : ''}
          </div>
        </div>
        <div class="form-row">
          <label for="description">What students will do</label>
          <textarea id="description" name="description" rows="3">${nl2(p.description)}</textarea>
        </div>
        <div class="form-row">
          <label for="practice_type">Is this temporary practice or a permanent installation?</label>
          <select id="practice_type" name="practice_type">${opt(rules.PRACTICE_TYPES, p.practice_type || 'Unsure')}</select>
          <p class="form-section-hint">Temporary practice = built for learning/assessment and then dismantled. Permanent = left in place for people to use.</p>
        </div>
        <div class="form-row">
          <label for="in_cara_scope">Does the parent CARA's activity scope already describe this project's work?</label>
          <select id="in_cara_scope" name="in_cara_scope">${opt(['Unsure', 'Yes', 'No'], p.in_cara_scope || 'Unsure')}</select>
        </div>

        <div class="form-section-title">Location</div>
        <div class="cohort-grid">
          <div class="form-row">
            <label for="room_id">Room / area</label>
            <select id="room_id" name="room_id"><option value="">— Not in the room list —</option>${rooms.map((r) => `<option value="${r.id}"${Number(p.room_id) === r.id ? ' selected' : ''}>${escapeHtml(r.name)}</option>`).join('')}</select>
          </div>
          <div class="form-row" style="grid-column: span 2;">
            <label for="location_detail">Location detail</label>
            <input type="text" id="location_detail" name="location_detail" value="${nl2(p.location_detail)}" placeholder="e.g. outdoor slab area behind the IDT workshop">
          </div>
        </div>

        <div class="form-section-title">Equipment (PERAs)</div>
        ${peraPicker}

        <div class="form-section-title">Materials and SDS</div>
        <div class="form-row">
          <label for="materials">Materials</label>
          <textarea id="materials" name="materials" rows="2">${nl2(p.materials)}</textarea>
        </div>
        <div class="form-row">
          <label for="sds_refs">Safety data sheet references</label>
          <textarea id="sds_refs" name="sds_refs" rows="2" placeholder="e.g. Cement GP – SDS in ChemWatch / workshop SDS folder, issued [date]">${nl2(p.sds_refs)}</textarea>
        </div>

        <div class="form-section-title" id="screening">Hazard questions</div>
        ${questionsHtml}
        <div class="form-row">
          <label for="conditions">Other project-specific conditions and hazards</label>
          <textarea id="conditions" name="conditions" rows="3">${nl2(p.conditions)}</textarea>
        </div>

        ${caraAi.apiEnabled() ? `
        <div class="ai-draft-panel" id="prj_ai_panel">
          <div class="ai-draft-text"><strong>AI assistant</strong>
            <span>Fill in the project, equipment and questions above, then generate suggested wording for the sections below. Nothing is filled in until you choose <em>Use this</em>.</span>
            <span class="ai-privacy-note">Sent to the AI: this project's details and answers, the selected PERAs, and the parent CARA's activity, hazard, supervision and emergency text, its type and VET details, and class-level details (year level, course, class size, age range, prior experience). Not sent: the CARA's Students box, trainer/assessor details, names or signatures. Lines that look like individual student or medical details are removed first.</span></div>
          <button type="button" class="btn btn-secondary" id="prj_ai_btn">Generate project draft</button>
          <div class="ai-draft-status" id="prj_ai_status" role="status" aria-live="polite"></div>
        </div>` : ''}

        <div class="form-section-title">Scope and exclusions</div>
        <div class="form-row"><textarea id="scope_exclusions" name="scope_exclusions" rows="3">${nl2(p.scope_exclusions)}</textarea></div>

        <div class="form-section-title">Work sequence, hazards and controls</div>
        <div id="prj_steps" class="prj-steps"></div>
        <button type="button" class="btn btn-secondary btn-sm" id="prj_add_step">Add step</button>
        <input type="hidden" name="work_steps_json" id="work_steps_json">

        <div class="form-section-title">PPE</div>
        <div class="form-row"><textarea id="ppe" name="ppe" rows="2">${nl2(p.ppe)}</textarea></div>

        <div class="form-section-title">Induction, supervision and competency</div>
        <div class="form-row"><textarea id="induction_supervision" name="induction_supervision" rows="3">${nl2(p.induction_supervision)}</textarea></div>

        <div class="form-section-title">Emergency and first aid for this location</div>
        <p class="form-section-hint">Record what you have actually checked for this location. Nothing here is filled in automatically.</p>
        <div class="cohort-grid">
          <div class="form-row" style="grid-column: span 2;"><label for="first_aid_kit_location">First aid kit location</label>
            <input type="text" id="first_aid_kit_location" name="first_aid_kit_location" value="${nl2(p.first_aid_kit_location)}" placeholder="Where exactly, for this location"></div>
          <div class="form-row"><label for="first_aid_person">Person with current first aid</label>
            <input type="text" id="first_aid_person" name="first_aid_person" value="${nl2(p.first_aid_person)}" placeholder="Name"></div>
        </div>
        <div class="form-row"><label for="emergency_notes">Other emergency considerations and first aid</label>
          <textarea id="emergency_notes" name="emergency_notes" rows="4">${nl2(p.emergency_notes)}</textarea></div>
        ${caraSafety.firstAidButtonsHtml('emergency_notes', escapeHtml)}
        <label class="checkbox-row"><input type="checkbox" name="emergency_confirmed" value="true"${p.emergency_confirmed ? ' checked' : ''}> I have confirmed these emergency and first aid details for this location</label>

        <div class="form-section-title">Outstanding questions and assumptions</div>
        <div class="form-row"><textarea id="open_questions" name="open_questions" rows="3">${nl2(p.open_questions)}</textarea></div>

        <div class="form-section-title">Suggested changes to the parent CARA</div>
        <p class="form-section-hint">Not applied to the CARA. Anything here flags the CARA for review.</p>
        <div class="form-row"><textarea id="cara_change_proposal" name="cara_change_proposal" rows="3">${nl2(p.cara_change_proposal)}</textarea></div>

        <div class="form-section-title">Document purpose</div>
        <div class="form-row">
          <select id="doc_purpose" name="doc_purpose">${opt(rules.DOC_PURPOSES, p.doc_purpose || 'Not yet decided')}</select>
          <p class="form-section-hint">The reviewer confirms this. Choosing a purpose does not decide whether a SWMS is legally required.</p>
        </div>

        ${p.status === 'Approved' ? '<div class="cara-unapproved">This project is approved. Saving changes returns it to Draft as a new version; the approved version is kept.</div>' : ''}
        <div class="form-row"><label for="edited_by">Your name</label>
          <input type="text" id="edited_by" name="edited_by" required value="${escapeHtml(user ? user.name : '')}"></div>
        <div class="form-actions"><button type="submit" class="btn btn-primary">Save project</button></div>
      </form>
      <script>
      (function () {
        var form = document.getElementById('prj_form');
        var TEMPLATES = ${JSON.stringify(rules.TEMPLATES).replace(/</g, '\\u003c')};
        var RELEVANCE = ${JSON.stringify(rules.RELEVANCE_MAP.map(([re, ks]) => [re.source, ks])).replace(/</g, '\\u003c')};
        var steps = ${JSON.stringify(steps).replace(/</g, '\\u003c')};
        window.prjFilter = function (q) {
          q = q.toLowerCase();
          document.querySelectorAll('#prj_pera_list .tool-picker-item[data-search]').forEach(function (el) { el.style.display = el.dataset.search.indexOf(q) >= 0 ? '' : 'none'; });
          if (q) document.querySelectorAll('#prj_pera_list details').forEach(function (d) { d.open = true; });
        };
        // Conditional questions
        function ans(k) { var c = form.querySelector('input[name="q_' + k + '"]:checked'); return c ? c.value : ''; }
        function refreshQuestions() {
          var tpl = TEMPLATES[document.getElementById('project_type').value] || { focus: [] };
          // Relevant questions: template focus + words in description, materials, conditions and ticked equipment.
          var words = ['description', 'materials', 'conditions'].map(function (id) { return (document.getElementById(id) || {}).value || ''; }).join(' ');
          form.querySelectorAll('input[name="pera_ids"]:checked').forEach(function (c) { var l = form.querySelector('label[for="' + c.id + '"]'); if (l) words += ' ' + l.textContent; });
          words = words.toLowerCase();
          var rel = {}; tpl.focus.forEach(function (k) { rel[k] = 1; });
          RELEVANCE.forEach(function (r) { if (new RegExp(r[0]).test(words)) r[1].forEach(function (k) { rel[k] = 1; }); });
          var construction = ans('construction_work') !== 'No'; // unanswered never means No
          var box = document.getElementById('prj_relevant'), more = document.getElementById('prj_more');
          document.querySelectorAll('.prj-q').forEach(function (el) {
            var key = el.dataset.q, parentKey = el.dataset.showIf;
            var isRel = rel[key] || (parentKey && rel[parentKey]);
            var shown = true;
            if (parentKey) { var pv = ans(parentKey); shown = pv === 'Yes' || pv === 'Unsure'; }
            if (el.dataset.hideIfNo && ans(el.dataset.hideIfNo) === 'No') shown = false;
            el.style.display = shown ? '' : 'none';
            var target = isRel ? box : (el.dataset.onlyRelevant && !ans(key) ? more : document.getElementById(el.dataset.home));
            if (el.parentNode !== target) target.appendChild(el);
            var crit = el.dataset.critical === 'yes' || (el.dataset.critical === 'construction' && construction) || (el.dataset.critical === 'relevant' && isRel);
            el.classList.toggle('prj-q-critical', crit);
            el.classList.toggle('prj-q-missing', crit && shown && !ans(key));
          });
          box.querySelector('.prj-relevant-empty').style.display = box.querySelector('.prj-q') ? 'none' : '';
          document.querySelectorAll('.prj-qgroup[id^="prj_g"]').forEach(function (g) {
            var any = Array.prototype.some.call(g.querySelectorAll('.prj-q'), function (q) { return q.style.display !== 'none'; });
            g.style.display = any ? '' : 'none';
          });
          more.style.display = more.querySelector('.prj-q') ? '' : 'none';
        }
        form.addEventListener('change', function (e) { if (e.target.name && (e.target.name.indexOf('q_') === 0 || e.target.id === 'project_type' || e.target.name === 'pera_ids')) refreshQuestions(); });
        ['description', 'materials', 'conditions'].forEach(function (id) { var t = document.getElementById(id); if (t) t.addEventListener('blur', refreshQuestions); });
        document.getElementById('project_type').addEventListener('change', function () {
          var t = TEMPLATES[this.value]; if (!t) return;
          var d = document.getElementById('description'), m = document.getElementById('materials');
          if (!d.value.trim() && t.description) d.value = t.description;
          if (!m.value.trim() && t.materials) m.value = t.materials;
        });
        refreshQuestions();

        // Work steps editor
        var box = document.getElementById('prj_steps');
        function row(s) {
          s = s || { step: '', hazards: '', controls: '' };
          var d = document.createElement('div'); d.className = 'prj-step';
          d.innerHTML = '<div class="prj-step-num"></div>' +
            '<label>Step<textarea rows="3" data-k="step"></textarea></label>' +
            '<label>Hazards<textarea rows="3" data-k="hazards"></textarea></label>' +
            '<label>Controls<textarea rows="3" data-k="controls"></textarea></label>' +
            '<button type="button" class="btn btn-secondary btn-sm prj-step-del" title="Remove step">Remove</button>';
          ['step', 'hazards', 'controls'].forEach(function (k) { d.querySelector('[data-k="' + k + '"]').value = s[k] || ''; });
          d.querySelector('.prj-step-del').onclick = function () { d.remove(); renumber(); };
          box.appendChild(d); renumber();
        }
        function renumber() { box.querySelectorAll('.prj-step-num').forEach(function (n, i) { n.textContent = (i + 1) + '.'; }); }
        function readSteps() {
          return Array.prototype.map.call(box.querySelectorAll('.prj-step'), function (d) {
            return { step: d.querySelector('[data-k=step]').value, hazards: d.querySelector('[data-k=hazards]').value, controls: d.querySelector('[data-k=controls]').value };
          }).filter(function (s) { return (s.step + s.hazards + s.controls).trim(); });
        }
        window.prjSetSteps = function (list, append) { if (!append) box.innerHTML = ''; (list || []).forEach(row); };
        window.prjReadSteps = readSteps;
        (steps.length ? steps : [null]).forEach(row);
        document.getElementById('prj_add_step').onclick = function () { row(); };
        form.addEventListener('submit', function () { document.getElementById('work_steps_json').value = JSON.stringify(readSteps()); });

        // AI draft: suggestions only, applied by "Use this".
        var btn = document.getElementById('prj_ai_btn'); if (!btn) return;
        var statusEl = document.getElementById('prj_ai_status');
        function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
        function suggestBox(target, title, text, onUse, onAdd) {
          var b = el('div', 'ai-suggest'); b.appendChild(el('div', 'ai-suggest-title', title));
          b.appendChild(el('div', 'ai-suggest-body', text));
          var r = el('div', 'ai-suggest-actions');
          var u = el('button', 'btn btn-primary btn-sm', 'Use this'); u.type = 'button'; u.onclick = function () { onUse(); b.remove(); }; r.appendChild(u);
          if (onAdd) { var ad = el('button', 'btn btn-secondary btn-sm', 'Add to mine'); ad.type = 'button'; ad.onclick = function () { onAdd(); b.remove(); }; r.appendChild(ad); }
          var n = el('button', 'btn btn-secondary btn-sm', 'Dismiss'); n.type = 'button'; n.onclick = function () { b.remove(); }; r.appendChild(n);
          b.appendChild(r); target.insertAdjacentElement('afterend', b);
        }
        btn.addEventListener('click', function () {
          var fd = new FormData(form);
          fd.set('work_steps_json', JSON.stringify(readSteps()));
          var params = new URLSearchParams();
          fd.forEach(function (v, k) { if (typeof v === 'string') params.append(k, v); });
          if (!(fd.get('name') || '').trim()) { statusEl.textContent = 'Enter the project name first.'; return; }
          btn.disabled = true; statusEl.textContent = 'Thinking… this can take up to a minute.';
          fetch('/projects/ai/draft', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(), credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              btn.disabled = false;
              if (!d.ok) { statusEl.textContent = d.error || 'Something went wrong.'; return; }
              document.querySelectorAll('.ai-suggest').forEach(function (n) { n.remove(); });
              var s = d.suggestions || {}, count = 0;
              ['scope_exclusions', 'ppe', 'induction_supervision', 'emergency_notes', 'open_questions', 'cara_change_proposal'].forEach(function (k) {
                if (!s[k]) return; var f = document.getElementById(k); if (!f) return; count++;
                suggestBox(f.closest('.form-row') || f, 'Suggested', s[k], function () { f.value = s[k]; },
                  f.value.trim() ? function () { f.value = f.value.trim() + '\\n' + s[k]; } : null);
              });
              if (s.work_steps && s.work_steps.length) {
                count++;
                var text = s.work_steps.map(function (w, i) { return (i + 1) + '. ' + w.step + '\\n   Hazards: ' + w.hazards + '\\n   Controls: ' + w.controls; }).join('\\n\\n');
                var hasSteps = readSteps().length > 0;
                suggestBox(document.getElementById('prj_add_step'), 'Suggested work sequence (' + s.work_steps.length + ' steps)', text,
                  function () { window.prjSetSteps(s.work_steps, false); }, hasSteps ? function () { window.prjSetSteps(s.work_steps, true); } : null);
              }
              statusEl.innerHTML = '';
              statusEl.appendChild(el('div', null, count ? count + ' suggestion' + (count === 1 ? '' : 's') + ' added below the matching sections. Review each one before using it.' : 'No changes suggested.'));
              if ((d.notes || []).length) { var ul = el('ul', 'ai-draft-notes'); d.notes.forEach(function (m) { ul.appendChild(el('li', null, m)); }); statusEl.appendChild(ul); }
            })
            .catch(function () { btn.disabled = false; statusEl.textContent = 'Could not reach the AI assistant. Try again.'; });
        });
      })();
      </script>`;
  }

  function fromBody(b) {
    const answers = {};
    for (const q of rules.QUESTIONS) {
      const v = b[`q_${q.key}`];
      if (['Yes', 'No', 'Unsure'].includes(v)) answers[q.key] = v;
    }
    let steps = [];
    try {
      steps = JSON.parse(b.work_steps_json || '[]');
    } catch (e) { steps = []; }
    steps = (Array.isArray(steps) ? steps : []).slice(0, 40).map((s) => ({
      step: String((s && s.step) || '').slice(0, 2000), hazards: String((s && s.hazards) || '').slice(0, 3000), controls: String((s && s.controls) || '').slice(0, 3000),
    })).filter((s) => (s.step + s.hazards + s.controls).trim());
    const roomId = parseInt(b.room_id, 10);
    return {
      name: clean(b.name), project_type: rules.TEMPLATES[b.project_type] ? b.project_type : 'custom', description: clean(b.description),
      practice_type: pick(b.practice_type, rules.PRACTICE_TYPES, 'Unsure'), room_id: Number.isInteger(roomId) && roomId > 0 ? roomId : null,
      location_detail: clean(b.location_detail), materials: clean(b.materials), sds_refs: clean(b.sds_refs), conditions: clean(b.conditions),
      in_cara_scope: pick(b.in_cara_scope, ['Unsure', 'Yes', 'No'], 'Unsure'), doc_purpose: pick(b.doc_purpose, rules.DOC_PURPOSES, 'Not yet decided'),
      scope_exclusions: clean(b.scope_exclusions), ppe: clean(b.ppe), induction_supervision: clean(b.induction_supervision),
      first_aid_kit_location: clean(b.first_aid_kit_location), first_aid_person: clean(b.first_aid_person), emergency_notes: clean(b.emergency_notes),
      emergency_confirmed: b.emergency_confirmed === 'true',
      open_questions: clean(b.open_questions), cara_change_proposal: clean(b.cara_change_proposal),
      answers, work_steps: steps,
      pera_ids: [...new Set([].concat(b.pera_ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))],
    };
  }

  async function savePeras(projectId, ids) {
    await pool.query('DELETE FROM cara_project_peras WHERE project_id = $1', [projectId]);
    if (ids.length) {
      await pool.query(`INSERT INTO cara_project_peras (project_id, pera_id) SELECT $1, x FROM unnest($2::int[]) x
                        WHERE EXISTS (SELECT 1 FROM pera_records WHERE id = x) ON CONFLICT DO NOTHING`, [projectId, ids]);
    }
  }

  // ---------- Routes: create / edit ----------
  app.get('/cara/:caraId/projects/new', async (req, res, next) => {
    try {
      const cara = await loadCara(req.params.caraId);
      if (!cara) return res.status(404).send('CARA not found.');
      if (cara.archived || !canEdit(req.staffUser, null, cara)) return res.status(403).send('You can only add projects to CARAs you can edit. <a href="/cara">Back</a>');
      const body = `
        <a class="back-link" href="/cara/${cara.id}#projects">← Back to ${escapeHtml(cara.activity_name)}</a>
        <h1 class="page-title">Add project</h1>
        <p class="page-subtitle" style="margin-bottom:20px;">Project safety document under ${escapeHtml(caraRef(cara.id))}. Saved as a Draft.</p>
        ${await formHtml({ cara, p: { answers: {}, work_steps: [], peras: [] }, action: `/cara/${cara.id}/projects`, user: req.staffUser })}`;
      res.send(page({ title: 'Add project', active: 'cara', body }));
    } catch (err) { next(err); }
  });

  app.post('/cara/:caraId/projects', async (req, res, next) => {
    try {
      const cara = await loadCara(req.params.caraId);
      if (!cara) return res.status(404).send('CARA not found.');
      if (cara.archived || !canEdit(req.staffUser, null, cara)) return res.status(403).send('Not allowed.');
      const f = fromBody(req.body);
      if (!f.name) return res.status(400).send('Project name is required. <a href="javascript:history.back()">Back</a>');
      const by = clean(req.body.edited_by) || req.staffUser.name;
      const { rows } = await pool.query(
        `INSERT INTO cara_projects (cara_id, name, project_type, description, practice_type, room_id, location_detail, materials, sds_refs, conditions,
           in_cara_scope, doc_purpose, answers, rules_version, scope_exclusions, work_steps, ppe, induction_supervision,
           first_aid_kit_location, first_aid_person, emergency_notes, emergency_confirmed, emergency_confirmed_by, emergency_confirmed_at,
           open_questions, cara_change_proposal, created_by_staff_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27) RETURNING id`,
        [cara.id, f.name, f.project_type, f.description, f.practice_type, f.room_id, f.location_detail, f.materials, f.sds_refs, f.conditions,
          f.in_cara_scope, f.doc_purpose, JSON.stringify(f.answers), rules.RULES_VERSION, f.scope_exclusions, JSON.stringify(f.work_steps), f.ppe, f.induction_supervision,
          f.first_aid_kit_location, f.first_aid_person, f.emergency_notes, f.emergency_confirmed, f.emergency_confirmed ? by : null, f.emergency_confirmed ? new Date() : null,
          f.open_questions, f.cara_change_proposal, req.staffUser.id]
      );
      await savePeras(rows[0].id, f.pera_ids);
      await log(rows[0].id, by, 'Created', `Project created under ${caraRef(cara.id)}`);
      res.redirect(`/projects/${rows[0].id}`);
    } catch (err) { next(err); }
  });

  app.get('/projects/:id/edit', async (req, res, next) => {
    try {
      const p = await loadProject(req.params.id);
      if (!p) return res.status(404).send('Project not found.');
      const cara = await loadCara(p.cara_id);
      if (!canEdit(req.staffUser, p, cara) || p.status === 'Archived') return res.status(403).send('You can\'t edit this project. <a href="/projects/' + p.id + '">Back</a>');
      const body = `
        <a class="back-link" href="/projects/${p.id}">← Back to project</a>
        <h1 class="page-title">Edit project</h1>
        <p class="page-subtitle" style="margin-bottom:20px;">${escapeHtml(ref(p))} · version ${p.version} · ${escapeHtml(p.status)}</p>
        ${await formHtml({ cara, p, action: `/projects/${p.id}/edit`, user: req.staffUser })}`;
      res.send(page({ title: `Edit ${p.name}`, active: 'cara', body }));
    } catch (err) { next(err); }
  });

  app.post('/projects/:id/edit', async (req, res, next) => {
    try {
      const before = await loadProject(req.params.id);
      if (!before) return res.status(404).send('Project not found.');
      const cara = await loadCara(before.cara_id);
      if (!canEdit(req.staffUser, before, cara) || before.status === 'Archived') return res.status(403).send('Not allowed.');
      const f = fromBody(req.body);
      if (!f.name) return res.status(400).send('Project name is required. <a href="javascript:history.back()">Back</a>');
      const by = clean(req.body.edited_by) || req.staffUser.name;

      const changed = [];
      for (const [k, label] of CONTENT_FIELDS) {
        const o = before[k] == null ? '' : String(before[k]);
        const n = f[k] == null ? '' : String(f[k]);
        if (o.trim() !== n.trim()) changed.push(label);
      }
      if (JSON.stringify(before.answers || {}) !== JSON.stringify(f.answers)) changed.push('Condition questions');
      if (JSON.stringify(before.work_steps || []) !== JSON.stringify(f.work_steps)) changed.push('Work steps');
      const beforePeras = before.peras.map((x) => x.id).sort().join(',');
      if (beforePeras !== [...f.pera_ids].sort().join(',')) changed.push('Equipment (PERAs)');
      if (!changed.length) return res.redirect(`/projects/${before.id}`);

      // Material change: an approved (or awaiting-review) project goes back
      // to Draft. Approved -> new version number; old snapshot is kept.
      const wasApproved = before.status === 'Approved';
      const newStatus = 'Draft';
      const newVersion = wasApproved ? before.version + 1 : before.version;
      const emergencyBy = f.emergency_confirmed ? (before.emergency_confirmed && !changed.some((c) => /First aid|Emergency/.test(c)) ? before.emergency_confirmed_by : by) : null;

      await pool.query(
        `UPDATE cara_projects SET name=$1, project_type=$2, description=$3, practice_type=$4, room_id=$5, location_detail=$6, materials=$7, sds_refs=$8,
           conditions=$9, in_cara_scope=$10, doc_purpose=$11, answers=$12, rules_version=$13, scope_exclusions=$14, work_steps=$15, ppe=$16,
           induction_supervision=$17, first_aid_kit_location=$18, first_aid_person=$19, emergency_notes=$20, emergency_confirmed=$21,
           emergency_confirmed_by=$22, emergency_confirmed_at=CASE WHEN $21 THEN COALESCE(CASE WHEN $22 = emergency_confirmed_by THEN emergency_confirmed_at END, now()) END,
           open_questions=$23, cara_change_proposal=$24, status=$25, version=$26,
           approver = CASE WHEN $27 THEN NULL ELSE approver END, approver_staff_id = CASE WHEN $27 THEN NULL ELSE approver_staff_id END,
           approved_at = CASE WHEN $27 THEN NULL ELSE approved_at END, updated_at = now()
         WHERE id = $28`,
        [f.name, f.project_type, f.description, f.practice_type, f.room_id, f.location_detail, f.materials, f.sds_refs,
          f.conditions, f.in_cara_scope, f.doc_purpose, JSON.stringify(f.answers), rules.RULES_VERSION, f.scope_exclusions, JSON.stringify(f.work_steps), f.ppe,
          f.induction_supervision, f.first_aid_kit_location, f.first_aid_person, f.emergency_notes, f.emergency_confirmed,
          emergencyBy, f.open_questions, f.cara_change_proposal, newStatus, newVersion, wasApproved, before.id]
      );
      await savePeras(before.id, f.pera_ids);
      await log(before.id, by, 'Edited',
        `Changed: ${changed.join(', ')}${before.status !== 'Draft' ? ` — status ${before.status} → Draft${wasApproved ? ` (now version ${newVersion}; approved version ${before.version} kept)` : ''}` : ''}`);
      res.redirect(`/projects/${before.id}`);
    } catch (err) { next(err); }
  });

  // ---------- Detail page ----------
  app.get('/projects/:id', async (req, res, next) => {
    try {
      const raw = await loadProject(req.params.id);
      if (!raw) return res.status(404).send('Project not found.');
      const p = withValidConfirmations(raw);
      const cara = await loadCara(p.cara_id);
      const user = req.staffUser;
      const caraPeras = await caraPeraIds(cara.id);
      const ev = rules.evaluate(p);
      const issues = projectIssues(p, cara);
      const openIss = checks.openIssues(issues);
      const blockers = openIss.map((i) => i.text);
      const issueLink = (i) => (i.field && i.field.startsWith('#') ? i.field : `/projects/${p.id}/edit#${i.field}`);
      const issuesHtml = issues.length ? `
        <div class="chk-panel" id="approval-checks">
          <div class="chk-head"><strong>Before approval</strong><span>${openIss.filter((i) => i.level === 'block').length} to fix · ${openIss.filter((i) => i.level === 'review').length} for the reviewer</span></div>
          <ul class="chk-list">${openIss.map((i) => `<li class="chk-${i.level}"><a href="${issueLink(i)}">${escapeHtml(i.text)}</a>
            ${i.level === 'review' && reviewer ? `<form method="post" action="/projects/${p.id}/issues/resolve" class="chk-resolve"><input type="hidden" name="key" value="${escapeHtml(i.key)}"><input type="text" name="note" placeholder="Reviewer decision and reason" required><button class="btn btn-secondary btn-sm" type="submit">Record decision</button></form>` : ''}</li>`).join('')}</ul>
          ${issues.some((i) => i.resolved) ? `<details class="chk-resolved"><summary>Reviewer decisions recorded</summary><ul>${issues.filter((i) => i.resolved).map((i) => `<li>${escapeHtml(i.text)}<br><em>${escapeHtml(i.resolved.note)} — ${escapeHtml(i.resolved.by)}</em></li>`).join('')}</ul></details>` : ''}
        </div>` : '<div class="chk-panel chk-ok"><strong>Approval checks:</strong> nothing outstanding.</div>';
      const notAuthorised = p.status === 'Approved' && !authorised(p, cara)
        ? `<div class="chk-alert"><strong>Approved, but not authorised for use:</strong> ${cara.status !== 'Approved' ? `the parent CARA is "${escapeHtml(cara.status)}"` : 'a linked PERA is not approved'}. Do not run this project until that is approved.</div>` : '';
      const openReasons = caraReviewOpen(p, caraPeras);
      const editable = canEdit(user, p, cara) && p.status !== 'Archived';
      const reviewer = isReviewer(user);
      const versions = (await pool.query('SELECT id, version, approved_by, approved_at, superseded_at FROM cara_project_versions WHERE project_id = $1 ORDER BY version DESC', [p.id])).rows;
      const logs = (await pool.query('SELECT * FROM cara_project_log WHERE project_id = $1 ORDER BY changed_at DESC LIMIT 50', [p.id])).rows;
      const peraIds = p.peras.map((x) => x.id);
      const hazards = peraIds.length ? (await pool.query(
        `SELECT h.pera_id, h.description, h.control_measure, h.control_type, h.mandatory, h.risk_level FROM pera_hazards h
         WHERE h.pera_id = ANY($1::int[]) ORDER BY h.mandatory DESC, h.pera_id, h.sort_order`, [peraIds])).rows : [];
      const statusCls = { Draft: 'badge-draft', 'Awaiting review': 'badge-pending', Approved: 'badge-approved', Archived: 'badge-draft' }[p.status];
      const flagCls = { stop: 'prj-flag-stop', bad: 'prj-flag-bad', mid: 'prj-flag-mid' };
      const peraName = (id) => pdf.toolName((p.peras.find((x) => x.id === id) || {}).activity_name || '');

      const answersTable = `
        <table class="prj-table prj-answers"><thead><tr><th>Question</th><th>Answer</th></tr></thead><tbody>
        ${ev.questions.map((q) => {
          const v = (p.answers || {})[q.key];
          return `<tr class="${!v && q.critical ? 'prj-row-missing' : ''}${v === 'Unsure' ? ' prj-row-unsure' : ''}"><td>${escapeHtml(q.text)}${q.critical ? ' <span class="prj-crit">*</span>' : ''}</td><td><strong>${escapeHtml(v || (q.critical ? 'Not answered' : '—'))}</strong></td></tr>`;
        }).join('')}</tbody></table>`;

      const triggersHtml = ev.triggers.length ? ev.triggers.map((t) => `
        <div class="prj-trigger">
          <div class="prj-trigger-head"><strong>Possible trigger:</strong> ${escapeHtml(t.label)}</div>
          <div class="prj-sub">Because: ${t.answers.map((x) => `"${escapeHtml(x.question)}" → ${escapeHtml(x.answer)}`).join('; ')}</div>
          <div class="prj-sub">Source: <a href="${escapeHtml(t.source.url)}" target="_blank" rel="noopener">${escapeHtml(t.source.title)}</a> (checked ${escapeHtml(t.source.reviewed)})</div>
          ${t.confirmation ? `<div class="prj-confirm">Reviewer: <strong>${escapeHtml(t.confirmation.decision)}</strong> — ${escapeHtml(t.confirmation.by)}, ${escapeHtml(formatDate(t.confirmation.at))}${t.confirmation.note ? `<br>${escapeHtml(t.confirmation.note)}` : ''}</div>`
            : '<div class="prj-confirm prj-confirm-missing">Not yet confirmed by a reviewer.</div>'}
          ${reviewer && p.status !== 'Archived' ? `
            <form method="post" action="/projects/${p.id}/trigger" class="prj-inline-form">
              <input type="hidden" name="trigger" value="${escapeHtml(t.key)}">
              <select name="decision" required><option value="">Reviewer decision…</option><option>Applies</option><option>Does not apply</option></select>
              <input type="text" name="note" placeholder="Reason / evidence" required>
              <button class="btn btn-secondary btn-sm" type="submit">Record</button>
            </form>` : ''}
        </div>`).join('') : '<p class="detail-value">No possible high risk construction work triggers from the answers given.</p>';

      const stepsHtml = (p.work_steps || []).length ? `
        <table class="prj-table"><thead><tr><th style="width:4%">#</th><th style="width:28%">Step</th><th>Hazards</th><th>Controls</th></tr></thead><tbody>
          ${p.work_steps.map((s, i) => `<tr><td>${i + 1}</td><td class="pretty-text">${nl2(s.step)}</td><td class="pretty-text">${nl2(s.hazards)}</td><td class="pretty-text">${nl2(s.controls)}</td></tr>`).join('')}
        </tbody></table>` : '<p class="detail-value">No work steps yet.</p>';

      const reviewerPanel = reviewer && p.status !== 'Archived' ? `
        <div class="detail-section prj-review" id="review">
          <div class="detail-label">Reviewer: classification</div>
          <form method="post" action="/projects/${p.id}/classify" class="prj-inline-form">
            <label>Activity classification <select name="activity_class">${rules.ACTIVITY_CLASSES.map((c) => `<option${c === p.activity_class ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('')}</select></label>
            <label>Document purpose <select name="doc_purpose">${rules.DOC_PURPOSES.map((c) => `<option${c === p.doc_purpose ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('')}</select></label>
            <input type="text" name="note" placeholder="Reason (recorded in history)">
            <button class="btn btn-secondary btn-sm" type="submit">Save classification</button>
          </form>
          <p class="form-section-hint">Checklist suggestion: <strong>${escapeHtml(ev.suggestedClass)}</strong>. This is a prompt only; ambiguous cases should stay "Needs review".${p.class_reviewed_by ? ` Last classified by ${escapeHtml(p.class_reviewed_by)}, ${escapeHtml(formatDate(p.class_reviewed_at))}.` : ''}${p.class_stale ? ' <strong>Answers have changed since then.</strong>' : ''}</p>
          ${p.status === 'Awaiting review' ? `
            ${blockers.length ? `<div class="cara-unapproved"><strong>Can't approve yet:</strong><ul>${blockers.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul></div>` : ''}
            <form method="post" action="/projects/${p.id}/approve" class="prj-inline-form">
              <input type="text" name="approver" value="${escapeHtml(user.name)}" required>
              <button class="btn btn-primary" type="submit"${blockers.length ? ' disabled' : ''}>Approve version ${p.version}</button>
            </form>
            <form method="post" action="/projects/${p.id}/request-changes" class="prj-inline-form">
              <input type="text" name="review_notes" placeholder="What needs to change" required style="flex:1;">
              <button class="btn btn-secondary" type="submit">Request changes</button>
            </form>` : ''}
        </div>` : '';

      const submitPanel = editable && p.status === 'Draft' ? `
        <div class="detail-section">
          ${ev.blocking.length ? `<div class="cara-unapproved"><strong>Before submitting:</strong><ul>${ev.blocking.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}${p.emergency_confirmed ? '' : '<li>Confirm the emergency and first aid details for this location.</li>'}</ul></div>` : (p.emergency_confirmed ? '' : '<div class="cara-unapproved"><strong>Before submitting:</strong> confirm the emergency and first aid details for this location.</div>')}
          <form method="post" action="/projects/${p.id}/submit"><button class="btn btn-primary" type="submit"${ev.blocking.length || !p.emergency_confirmed ? ' disabled' : ''}>Submit for review</button></form>
        </div>` : '';

      const body = `
        <a class="back-link" href="/cara/${cara.id}#projects" id="parent">← ${escapeHtml(caraRef(cara.id))} ${escapeHtml(cara.activity_name)} (${escapeHtml(cara.status)})</a>
        <div class="page-header">
          <div>
            <span class="badge ${statusCls}">${escapeHtml(p.status)}</span> <span class="prj-sub">${escapeHtml(ref(p))} · version ${p.version}</span>
            <h1 class="page-title" style="margin-top:10px;">${escapeHtml(p.name)}</h1>
            <p class="page-subtitle">${escapeHtml((rules.TEMPLATES[p.project_type] || {}).label || '')} · ${escapeHtml(p.room_name || 'Room not set')}${p.location_detail ? ` · ${escapeHtml(p.location_detail)}` : ''}</p>
          </div>
          <div class="prj-actions">
            ${editable ? `<a class="btn btn-secondary btn-sm" href="/projects/${p.id}/edit">Edit</a>` : ''}
            <a class="btn btn-secondary btn-sm" href="/projects/${p.id}/pdf">Download PDF</a>
          </div>
        </div>
        ${p.review_notes && p.status === 'Draft' ? `<div class="cara-unapproved"><strong>Changes requested:</strong> ${escapeHtml(p.review_notes)}</div>` : ''}
        ${openReasons.length ? `<div class="cara-unapproved"><strong>Parent CARA needs review</strong> for this project:<ul>${openReasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul><a href="/cara/${cara.id}#projects">Go to the CARA</a></div>` : ''}

        <div class="prj-class-strip">
          <div><span>Activity classification</span><strong>${escapeHtml(p.activity_class)}</strong></div>
          <div><span>Document purpose</span><strong>${escapeHtml(p.doc_purpose)}</strong></div>
          <div><span>Workflow status</span><strong>${escapeHtml(p.status)} (v${p.version})</strong></div>
          <div><span>Temporary / permanent</span><strong>${escapeHtml(p.practice_type)}</strong></div>
        </div>
        <p class="form-section-hint">The CARA risk rating (${escapeHtml(cara.risk_level)}) is separate from legal high risk construction work triggers below.</p>

        ${notAuthorised}
        ${ev.flags.length ? `<div class="prj-flags">${ev.flags.map((f) => `<div class="${flagCls[f.level]}">${escapeHtml(f.text)}</div>`).join('')}</div>` : ''}
        ${p.status !== 'Archived' ? issuesHtml : ''}
        ${submitPanel}
        ${reviewerPanel}

        <div class="detail-grid">
          <div>
            <div class="detail-section"><div class="detail-label">What students will do</div><div class="detail-value pretty-text">${nl2(p.description || '—')}</div></div>
            <div class="detail-section"><div class="detail-label">Scope and exclusions</div><div class="detail-value pretty-text">${nl2(p.scope_exclusions || '—')}</div></div>
            <div class="detail-section"><div class="detail-label">Equipment (PERAs)</div>
              ${p.peras.length ? `<div class="tool-chip-list">${p.peras.map((t) => `<a class="tool-chip" href="/pera/${t.id}"><span class="badge ${riskBadgeClass(t.risk_level)}">${escapeHtml(t.risk_level)}</span> ${escapeHtml(pdf.toolName(t.activity_name))}${caraPeras.includes(t.id) ? '' : ' <span class="badge badge-changes tool-picker-flag">Not in CARA</span>'}</a>`).join('')}</div>` : '<div class="detail-value">None selected.</div>'}</div>
            <div class="detail-section"><div class="detail-label">Materials</div><div class="detail-value pretty-text">${nl2(p.materials || '—')}</div>
              <div class="detail-label" style="margin-top:8px;">SDS references</div><div class="detail-value pretty-text">${nl2(p.sds_refs || '—')}</div></div>
            <div class="detail-section"><div class="detail-label">Work sequence, hazards and controls</div>${stepsHtml}</div>
            ${hazards.length ? `<div class="detail-section"><div class="detail-label">Controls from the PERAs (shared with the CARA)</div>
              <table class="prj-table"><thead><tr><th>Equipment</th><th>Hazard</th><th>Control</th></tr></thead><tbody>
              ${hazards.slice(0, 60).map((h) => `<tr><td>${escapeHtml(peraName(h.pera_id))}</td><td>${escapeHtml(h.description)}</td><td>${escapeHtml(h.control_measure || '')}${h.mandatory ? ' <strong>(mandatory)</strong>' : ''}</td></tr>`).join('')}
              </tbody></table></div>` : ''}
            <div class="detail-section"><div class="detail-label">PPE</div><div class="detail-value pretty-text">${nl2(p.ppe || '—')}</div></div>
            <div class="detail-section"><div class="detail-label">Induction, supervision and competency</div><div class="detail-value pretty-text">${nl2(p.induction_supervision || '—')}</div></div>
            <div class="detail-section"><div class="detail-label">Emergency and first aid (this location)</div>
              <div class="detail-value">First aid kit: ${escapeHtml(p.first_aid_kit_location || 'not recorded')}<br>First aid person: ${escapeHtml(p.first_aid_person || 'not recorded')}<br>
              ${p.emergency_confirmed ? `Confirmed by ${escapeHtml(p.emergency_confirmed_by || '')} on ${escapeHtml(formatDate(p.emergency_confirmed_at))}` : '<strong>Not yet confirmed</strong>'}</div>
              <div class="detail-value pretty-text" style="margin-top:6px;">${nl2(p.emergency_notes || '')}</div></div>
            <div class="detail-section"><div class="detail-label">Outstanding questions and assumptions</div><div class="detail-value pretty-text">${nl2(p.open_questions || '—')}</div></div>
            ${p.cara_change_proposal ? `<div class="detail-section"><div class="detail-label">Suggested changes to the parent CARA (not applied)</div><div class="detail-value pretty-text">${nl2(p.cara_change_proposal)}</div></div>` : ''}
          </div>
          <div>
            <div class="detail-section" id="triggers"><div class="detail-label">Possible legal SWMS triggers (${escapeHtml(rules.JURISDICTION)} high risk construction work)</div>
              <p class="form-section-hint">${escapeHtml(rules.JURISDICTION)} rules checklist (version ${escapeHtml(p.rules_version || rules.RULES_VERSION)}). Flags for a reviewer, not a legal determination. Other states and territories have different rules.</p>
              ${triggersHtml}</div>
            <div class="detail-section"><div class="detail-label">Condition questions</div>${answersTable}</div>
            <div class="detail-section"><div class="detail-label">Approval</div>
              <div class="detail-value">${p.status === 'Approved' ? `Version ${p.version} approved by ${escapeHtml(p.approver || '—')} on ${escapeHtml(formatDate(p.approved_at))}` : 'Not approved'}${p.submitted_by ? `<br>Submitted by ${escapeHtml(p.submitted_by)} on ${escapeHtml(formatDate(p.submitted_at))}` : ''}</div>
              ${versions.length ? `<ul class="prj-versions">${versions.map((v) => `<li>v${v.version} approved by ${escapeHtml(v.approved_by || '—')} ${escapeHtml(formatDate(v.approved_at))}${v.superseded_at ? ` — superseded ${escapeHtml(formatDate(v.superseded_at))}` : ' — current approved version'} · <a href="/projects/${p.id}/pdf?version=${v.version}">PDF</a></li>`).join('')}</ul>` : ''}
            </div>
            ${editable || reviewer ? `<div class="detail-section">
              <form method="post" action="/projects/${p.id}/${p.status === 'Archived' ? 'unarchive' : 'archive'}"${p.status === 'Archived' ? '' : ' onsubmit="return confirm(\'Archive this project?\');"'}>
                <button class="btn btn-secondary btn-sm" type="submit">${p.status === 'Archived' ? 'Restore project' : 'Archive project'}</button></form></div>` : ''}
            <div class="detail-section"><div class="detail-label">History</div>
              ${logs.length ? `<div class="change-log">${logs.map((l) => `<details class="change-log-entry"><summary class="change-log-summary"><span class="change-log-datetime">${formatDateTime(l.changed_at)} — ${escapeHtml(l.changed_by || '')}</span><span class="change-log-brief">${escapeHtml(l.action)}</span></summary><div class="change-log-detail">${escapeHtml(l.summary || '')}</div></details>`).join('')}</div>` : '<div class="detail-value">No history.</div>'}
            </div>
          </div>
        </div>`;
      res.send(page({ title: p.name, active: 'cara', body }));
    } catch (err) { next(err); }
  });

  // ---------- Workflow ----------
  app.post('/projects/:id/submit', async (req, res, next) => {
    try {
      const p = withValidConfirmations(await loadProject(req.params.id) || {});
      if (!p.id) return res.status(404).send('Project not found.');
      const cara = await loadCara(p.cara_id);
      if (!canEdit(req.staffUser, p, cara)) return res.status(403).send('Not allowed.');
      if (p.status !== 'Draft') return res.status(400).send(`This project is "${escapeHtml(p.status)}". <a href="/projects/${p.id}">Back</a>`);
      const ev = rules.evaluate(p);
      const problems = [...ev.blocking, ...(p.emergency_confirmed ? [] : ['Confirm the emergency and first aid details.'])];
      if (problems.length) return res.status(400).send(`Can't submit yet: ${problems.map(escapeHtml).join(' ')} <a href="/projects/${p.id}">Back</a>`);
      await pool.query(`UPDATE cara_projects SET status='Awaiting review', submitted_by=$1, submitted_at=now(), review_notes=NULL, updated_at=now() WHERE id=$2`, [req.staffUser.name, p.id]);
      await log(p.id, req.staffUser.name, 'Submitted', `Version ${p.version} submitted for review`);
      res.redirect(`/projects/${p.id}`);
    } catch (err) { next(err); }
  });

  app.post('/projects/:id/trigger', requireRole('admin', 'approver', 'system_admin'), async (req, res, next) => {
    try {
      const p = await loadProject(req.params.id);
      if (!p) return res.status(404).send('Project not found.');
      const key = req.body.trigger;
      const decision = pick(req.body.decision, ['Applies', 'Does not apply'], null);
      const note = clean(req.body.note);
      if (!rules.TRIGGERS[key] || !decision || !note) return res.status(400).send('Choose a decision and give a reason. <a href="javascript:history.back()">Back</a>');
      const tr = { ...(p.trigger_reviews || {}) };
      tr[key] = { decision, note, by: req.staffUser.name, staff_id: req.staffUser.id, at: new Date().toISOString(), basis: triggerBasis(p, key) };
      await pool.query('UPDATE cara_projects SET trigger_reviews=$1, updated_at=now() WHERE id=$2', [JSON.stringify(tr), p.id]);
      await log(p.id, req.staffUser.name, 'Trigger reviewed', `${rules.TRIGGERS[key]}: ${decision}. ${note}`);
      res.redirect(`/projects/${p.id}`);
    } catch (err) { next(err); }
  });

  app.post('/projects/:id/classify', requireRole('admin', 'approver', 'system_admin'), async (req, res, next) => {
    try {
      const p = await loadProject(req.params.id);
      if (!p) return res.status(404).send('Project not found.');
      const ac = pick(req.body.activity_class, rules.ACTIVITY_CLASSES, p.activity_class);
      const dp = pick(req.body.doc_purpose, rules.DOC_PURPOSES, p.doc_purpose);
      if (ac === p.activity_class && dp === p.doc_purpose && p.class_basis === rules.classificationBasis(p)) return res.redirect(`/projects/${p.id}`);
      await pool.query('UPDATE cara_projects SET activity_class=$1, doc_purpose=$2, class_basis=$3, class_reviewed_by=$4, class_reviewed_at=now(), updated_at=now() WHERE id=$5',
        [ac, dp, rules.classificationBasis(p), req.staffUser.name, p.id]);
      await log(p.id, req.staffUser.name, 'Classified', `Activity classification: ${p.activity_class} → ${ac}; document purpose: ${p.doc_purpose} → ${dp}${clean(req.body.note) ? `. ${clean(req.body.note)}` : ''}`);
      res.redirect(`/projects/${p.id}`);
    } catch (err) { next(err); }
  });

  app.post('/projects/:id/approve', requireRole('admin', 'approver', 'system_admin'), async (req, res, next) => {
    try {
      const raw = await loadProject(req.params.id);
      if (!raw) return res.status(404).send('Project not found.');
      const p = withValidConfirmations(raw);
      if (p.status !== 'Awaiting review') return res.status(400).send(`This project is "${escapeHtml(p.status)}" and isn't waiting for review. <a href="/projects/${p.id}">Back</a>`);
      const cara = await loadCara(p.cara_id);
      const open = checks.openIssues(projectIssues(p, cara));
      if (open.length) return res.status(400).send(`Can't approve yet:<ul>${open.map((i) => `<li>${escapeHtml(i.text)}</li>`).join('')}</ul><a href="/projects/${p.id}">Back</a>`);
      const approver = clean(req.body.approver) || req.staffUser.name;
      const snapshot = { ...p, parent_cara: { id: cara.id, activity_name: cara.activity_name, status: cara.status, risk_level: cara.risk_level }, approved_by: approver, approved_at: new Date().toISOString() };
      await pool.query('UPDATE cara_project_versions SET superseded_at = now() WHERE project_id = $1 AND superseded_at IS NULL', [p.id]);
      await pool.query('INSERT INTO cara_project_versions (project_id, version, snapshot, approved_by) VALUES ($1,$2,$3,$4)', [p.id, p.version, JSON.stringify(snapshot), approver]);
      await pool.query(`UPDATE cara_projects SET status='Approved', approver=$1, approver_staff_id=$2, approved_at=now(), review_notes=NULL, updated_at=now() WHERE id=$3`, [approver, req.staffUser.id, p.id]);
      await log(p.id, req.staffUser.name, 'Approved', `Version ${p.version} approved (approver: ${approver})`);
      res.redirect(`/projects/${p.id}`);
    } catch (err) { next(err); }
  });

  app.post('/projects/:id/request-changes', requireRole('admin', 'approver', 'system_admin'), async (req, res, next) => {
    try {
      const p = await loadProject(req.params.id);
      if (!p) return res.status(404).send('Project not found.');
      const notes = clean(req.body.review_notes);
      if (!notes) return res.status(400).send('Say what needs to change. <a href="javascript:history.back()">Back</a>');
      if (p.status !== 'Awaiting review') return res.status(400).send('Not awaiting review.');
      await pool.query(`UPDATE cara_projects SET status='Draft', review_notes=$1, updated_at=now() WHERE id=$2`, [notes, p.id]);
      await log(p.id, req.staffUser.name, 'Changes requested', notes);
      res.redirect(`/projects/${p.id}`);
    } catch (err) { next(err); }
  });

  for (const action of ['archive', 'unarchive']) {
    app.post(`/projects/:id/${action}`, async (req, res, next) => {
      try {
        const p = await loadProject(req.params.id);
        if (!p) return res.status(404).send('Project not found.');
        const cara = await loadCara(p.cara_id);
        if (!(canEdit(req.staffUser, p, cara) || isReviewer(req.staffUser))) return res.status(403).send('Not allowed.');
        // Restoring returns to Draft (or Approved if the current version was approved and is still the latest snapshot).
        let status = 'Archived';
        if (action === 'unarchive') {
          const v = (await pool.query('SELECT 1 FROM cara_project_versions WHERE project_id=$1 AND version=$2 AND superseded_at IS NULL', [p.id, p.version])).rows[0];
          status = v && p.approved_at ? 'Approved' : 'Draft';
        }
        await pool.query('UPDATE cara_projects SET status=$1, updated_at=now() WHERE id=$2', [status, p.id]);
        await log(p.id, req.staffUser.name, action === 'archive' ? 'Archived' : 'Restored', `Status → ${status}`);
        res.redirect(`/projects/${p.id}`);
      } catch (err) { next(err); }
    });
  }

  app.post('/projects/:id/cara-reviewed', async (req, res, next) => {
    try {
      const p = await loadProject(req.params.id);
      if (!p) return res.status(404).send('Project not found.');
      const cara = await loadCara(p.cara_id);
      if (!(isReviewer(req.staffUser) || canManageOwnRecord(req.staffUser, cara))) return res.status(403).send('Not allowed.');
      const reasons = caraReviewReasons(withValidConfirmations(p), await caraPeraIds(cara.id));
      await pool.query('UPDATE cara_projects SET cara_review_cleared=$1 WHERE id=$2', [JSON.stringify({ reasons, by: req.staffUser.name, at: new Date().toISOString() }), p.id]);
      await log(p.id, req.staffUser.name, 'CARA reviewed', `Recorded that ${caraRef(cara.id)} was reviewed for: ${reasons.join('; ') || '(nothing outstanding)'}`);
      await pool.query('INSERT INTO cara_change_log (cara_id, changed_by, summary, brief) VALUES ($1,$2,$3,$4)',
        [cara.id, req.staffUser.name, `Reviewed for project "${p.name}" (${ref(p)}): ${reasons.join('; ')}`, 'Reviewed for project']);
      res.redirect(`/cara/${cara.id}#projects`);
    } catch (err) { next(err); }
  });

  // ---------- AI project draft ----------
  const PROJECT_SYSTEM = `You help teachers in a Queensland school write project-level safety documents (safe work procedures) for practical VET and Industrial Design and Technology projects (e.g. carpentry, brick and block laying, concreting, tiling). Each project sits under a parent Curriculum Activity Risk Assessment (CARA) and uses equipment covered by Plant & Equipment Risk Assessments (PERAs).
Rules:
- Base hazards and controls on the PERA controls provided. Never relax a PERA control or the CARA's supervision requirements, and never choose a lower supervision level than a PERA requires.
- Never write first aid treatment instructions (how to treat burns, eye injuries, bleeding, electric shock etc.). The school inserts reviewed first aid wording separately.
- For VET use only the qualification and unit codes given; never invent codes, unit titles or assessment requirements.
- Never invent or confirm: staff qualifications, parent consent, student competency, first aid arrangements or who holds first aid, first aid kit locations, equipment availability, or site conditions. Where these matter, write a short [confirm: ...] placeholder or list them as missing information.
- Mark anything you assume with "ASSUMPTION:" at the start of the line.
- Do not decide whether the work is legally "high risk construction work" or whether a SWMS is legally required. You may point out answers that a reviewer should check.
- Do not contradict the parent CARA. If the project needs something the CARA does not cover, say so in cara_suggestions; never claim the CARA has been changed.
- Plain text only, no markdown (no **, #, backticks). Use "- " bullets; a short line ending in ":" may be used as a sub-heading.
- Australian English. Practical, specific, short.
- You never see student information.`;

  const PROJECT_TOOL = {
    name: 'project_draft',
    description: 'Suggested content for a project safety document.',
    input_schema: {
      type: 'object',
      properties: {
        scope_exclusions: { type: 'string', description: 'What is in scope, then "Not included:" with exclusions.' },
        work_steps: {
          type: 'array', description: 'Work sequence in order, 4-12 steps.',
          items: { type: 'object', properties: { step: { type: 'string' }, hazards: { type: 'string' }, controls: { type: 'string' } }, required: ['step', 'hazards', 'controls'] },
        },
        ppe: { type: 'string' },
        induction_supervision: { type: 'string', description: 'Induction, supervision level/ratios and competency sign-off needed, consistent with the CARA and PERAs.' },
        emergency_considerations: { type: 'string', description: 'Emergency considerations specific to this project and location, with [confirm: ...] placeholders. Never state where a first aid kit is or who holds first aid.' },
        missing_information: { type: 'array', items: { type: 'string' }, description: 'Information the teacher must confirm or provide.' },
        assumptions: { type: 'array', items: { type: 'string' } },
        cara_suggestions: { type: 'string', description: 'Suggested additions/changes to the parent CARA, or empty if none.' },
      },
      required: ['work_steps', 'missing_information'],
    },
  };

  app.post('/projects/ai/draft', async (req, res) => {
    try {
      if (!caraAi.apiEnabled()) return res.json({ ok: false, error: 'The AI assistant is not set up on this server yet.' });
      if (caraAi.overLimit(req.staffUser.id)) return res.status(429).json({ ok: false, error: 'Too many AI requests in the last hour. Try again later.' });
      const b = req.body || {};
      const cara = await loadCara(b.cara_id);
      if (!cara || !canEdit(req.staffUser, null, cara)) return res.status(403).json({ ok: false, error: 'You can only draft projects for CARAs you can edit.' });
      const f = fromBody(b);
      if (!f.name) return res.status(400).json({ ok: false, error: 'Enter the project name first.' });
      const peras = await caraAi.loadPeras(f.pera_ids);
      const room = f.room_id ? (await pool.query('SELECT name FROM rooms WHERE id=$1', [f.room_id])).rows[0] : null;
      const clip = caraAi.clip;
      // Explicit allowlist + redaction: only class-level CARA fields; free text
      // is filtered for lines that look like individual student details.
      let removedLines = 0;
      const red = (v) => { const r = aiPrivacy.redact(v); removedLines += r.removed; return r.text; };
      const ca = aiPrivacy.caraForAi(cara);
      removedLines += ca.removed;
      const cs = ca.cara;
      const answerLines = rules.visibleQuestions(f.answers, { ...f, peras }).map((q) => `- ${q.text} → ${f.answers[q.key] || 'Not answered'}`).join('\n');
      // Parent CARA context: explicit allowlist. The Students notes are never
      // loaded (see loadCara) and never sent.
      const caraText = [
        `CARA: ${clip(cs.activity_name, 200)} (activity risk ${cs.risk_level}, status ${cara.status})`,
        `CARA type: ${cs.cara_type === 'vet' ? 'VET course or activity' : cs.cara_type === 'general' ? 'General curriculum activity' : '(not chosen)'}`,
        `Class group: ${clip(cohortSummary(cs), 200) || '(not set)'}`,
        ...(cs.cara_type === 'vet' ? [
          `VET units (entered by the teacher): ${clip(cs.vet_units, 800) || '(none entered)'}`,
          `VET delivery context: ${cs.delivery_context || '(not chosen)'}`,
          `VET training and assessment safety requirements: ${clip(cs.vet_safety_requirements, 1000) || '(none entered)'}`,
        ] : []),
        `Prior experience: ${clip(cs.prior_experience, 600) || '(blank)'}`,
        `Activity scope: ${clip(cs.activity_scope, 2000) || '(blank)'}`,
        `Supervision: ${clip(cs.supervision_notes, 1200) || '(blank)'}`,
        `Supervisor qualification: ${clip(cs.supervisor_qualification, 800) || '(blank)'}`,
        `Induction and instruction: ${clip(cs.induction_instruction, 1200) || '(blank)'}`,
        `Facilities and equipment: ${clip(cs.facilities_equipment, 800) || '(blank)'}`,
        `Environmental hazards / controls: ${clip(cs.environmental_hazards, 800)} / ${clip(cs.environmental_controls, 800)}`,
        `Facilities hazards / controls: ${clip(cs.facilities_hazards, 800)} / ${clip(cs.facilities_controls, 800)}`,
        `Student hazards / controls: ${clip(cs.student_hazards, 800)} / ${clip(cs.student_controls, 800)}`,
      ].join('\n');
      const projectText = [
        `Project: ${clip(f.name, 200)} (type: ${(rules.TEMPLATES[f.project_type] || {}).label || 'Custom'})`,
        `What students will do: ${clip(red(f.description), 1500) || '(blank)'}`,
        `Temporary practice or permanent installation: ${f.practice_type}`,
        `Location: ${room ? room.name : '(room not set)'}${f.location_detail ? ` — ${clip(red(f.location_detail), 300)}` : ''}`,
        `Materials: ${clip(red(f.materials), 800) || '(blank)'}`,
        `SDS references: ${clip(red(f.sds_refs), 500) || '(blank)'}`,
        `Other conditions and hazards: ${clip(red(f.conditions), 1200) || '(blank)'}`,
        `Condition questions:\n${answerLines}`,
        `Existing scope/exclusions: ${clip(red(f.scope_exclusions), 1200) || '(blank)'}`,
        `Existing work steps: ${f.work_steps.length ? f.work_steps.map((s, i) => `${i + 1}. ${clip(red(s.step), 200)}`).join(' | ') : '(none)'}`,
        `Existing PPE: ${clip(red(f.ppe), 600) || '(blank)'}`,
        `Existing induction/supervision: ${clip(red(f.induction_supervision), 800) || '(blank)'}`,
      ].join('\n');
      const userText = `Draft suggested content for this project safety document. Where existing text is already good, you may leave that field out.\n\n=== Parent CARA ===\n${caraText}\n\n=== Project ===\n${projectText}\n\n=== PERAs selected for this project ===\n${caraAi.peraContext(peras)}\n\nRespond only by calling the project_draft tool.`;
      const { result, usage, model, truncated } = await caraAi.callClaude({ userText, tool: PROJECT_TOOL, maxTokens: 8000, system: PROJECT_SYSTEM });
      await caraAi.logUsage({ caraId: cara.id, kind: 'project_draft', staffId: req.staffUser.id, model, usage, result: null });
      const pt = caraAi.plainText;
      const s = {};
      if (pt(result.scope_exclusions)) s.scope_exclusions = pt(result.scope_exclusions).slice(0, 4000);
      if (pt(result.ppe)) s.ppe = pt(result.ppe).slice(0, 3000);
      if (pt(result.induction_supervision)) s.induction_supervision = pt(result.induction_supervision).slice(0, 4000);
      if (pt(result.emergency_considerations)) s.emergency_notes = pt(result.emergency_considerations).slice(0, 3000);
      if (pt(result.cara_suggestions)) s.cara_change_proposal = pt(result.cara_suggestions).slice(0, 3000);
      const missing = (Array.isArray(result.missing_information) ? result.missing_information : []).map(pt).filter(Boolean);
      const assumptions = (Array.isArray(result.assumptions) ? result.assumptions : []).map(pt).filter(Boolean);
      if (missing.length || assumptions.length) {
        s.open_questions = [
          ...(missing.length ? ['Missing information:', ...missing.map((m) => `- ${m}`)] : []),
          ...(assumptions.length ? ['Assumptions:', ...assumptions.map((m) => `- ${m.replace(/^ASSUMPTION:\s*/i, '')}`)] : []),
        ].join('\n').slice(0, 4000);
      }
      if (Array.isArray(result.work_steps)) {
        s.work_steps = result.work_steps.slice(0, 20).map((w) => ({ step: pt(w && w.step).slice(0, 1000), hazards: pt(w && w.hazards).slice(0, 2000), controls: pt(w && w.controls).slice(0, 2000) }))
          .filter((w) => w.step || w.hazards || w.controls);
      }
      const notes = [];
      const strip = (t, label) => {
        const found = firstAid.scanUnsafe(t);
        if (!found.length) return t;
        notes.push(`Removed unsafe first aid wording from the ${label} suggestion (${found[0].message}). Use the reviewed first aid buttons instead.`);
        return firstAid.splitSentences(t).length ? t.split('\n').filter((line) => !found.some((f) => line.includes(f.sentence))).join('\n').trim() : t;
      };
      for (const k of Object.keys(s)) if (typeof s[k] === 'string') s[k] = strip(s[k], k.replace(/_/g, ' '));
      if (s.work_steps) s.work_steps = s.work_steps.map((w, i) => ({ ...w, controls: strip(w.controls, `step ${i + 1}`), hazards: strip(w.hazards, `step ${i + 1}`) }));
      const supTexts = [];
      if (s.induction_supervision) supTexts.push({ label: 'the suggested induction/supervision', text: s.induction_supervision });
      (s.work_steps || []).forEach((w, i) => supTexts.push({ label: `suggested step ${i + 1}`, text: w.controls }));
      for (const c of checks.supervisionConflicts(supTexts, peras)) notes.push(`Check before using: ${c.text}`);
      if (removedLines) notes.push(aiPrivacy.redactedNote(removedLines));
      if (truncated) notes.push('The AI ran out of space before finishing, so some sections may have no suggestion.');
      res.json({ ok: true, suggestions: s, notes });
    } catch (err) {
      console.error('Project AI draft failed:', err.message);
      res.json({ ok: false, error: caraAi.errorMessage(err) });
    }
  });

  // ---------- PDF ----------
  function projectHtml(p, cara, { versionLabel, issues } = {}) {
    const e = pdf.escapeHtml;
    const openIss = issues || [];
    const ev = rules.evaluate(p);
    const approved = p.status === 'Approved' || !!versionLabel;
    const kv = (rows) => rows.map(([l, v]) => `<tr><th>${e(l)}</th><td>${v}</td></tr>`).join('');
    const steps = (p.work_steps || []).length
      ? `<table class="hz"><thead><tr><th style="width:4%">#</th><th style="width:26%">Step</th><th>Hazards</th><th>Controls</th></tr></thead><tbody>
          ${p.work_steps.map((s, i) => `<tr><td>${i + 1}</td><td>${pdf.richText(s.step)}</td><td>${pdf.richText(s.hazards)}</td><td>${pdf.richText(s.controls)}</td></tr>`).join('')}</tbody></table>`
      : '<div class="box"><span class="empty">No work steps recorded.</span></div>';
    const triggers = ev.triggers.length
      ? `<table class="kv">${ev.triggers.map((t) => `<tr><th>${e(t.label)}</th><td>Answers: ${t.answers.map((x) => `${e(x.question)} → <b>${e(x.answer)}</b>`).join('<br>')}<br>Source: ${e(t.source.title)} — ${e(t.source.url)} (checked ${e(t.source.reviewed)})<br>Reviewer: ${t.confirmation ? `<b>${e(t.confirmation.decision)}</b> — ${e(t.confirmation.by)}, ${e(pdf.formatDate(t.confirmation.at))}. ${e(t.confirmation.note || '')}` : '<b>Not confirmed</b>'}</td></tr>`).join('')}</table>`
      : '<div class="box">No possible high risk construction work triggers from the answers given.</div>';
    const answers = `<table class="kv">${ev.questions.map((q) => `<tr><th style="width:70%">${e(q.text)}</th><td><b>${e((p.answers || {})[q.key] || (q.critical ? 'Not answered' : '—'))}</b></td></tr>`).join('')}</table>`;
    const docTitle = p.doc_purpose && p.doc_purpose !== 'Not yet decided' ? p.doc_purpose : 'Project safety document';
    const notice = approved
      ? `<div class="notice" style="background:#EEF6F1;border-color:#9CC9AE;color:#1d4f33;">Approved by the school (${e(p.approver || '')}, ${e(pdf.formatDate(p.approved_at))}). Approval records the school's review; it is not a certification of legal compliance.</div>`
      : `<div class="notice"><b>DRAFT — NOT APPROVED.</b> Status: ${e(p.status)}. Do not use for work until approved. Generating this document does not mean it is approved or legally compliant.</div>`;
    const authNote = approved && !versionLabel && !authorised(p, cara)
      ? `<div class="unresolved"><b>NOT AUTHORISED FOR USE:</b> ${cara.status !== 'Approved' ? `the parent CARA is "${e(cara.status)}"` : 'a linked PERA is not approved'}.</div>` : '';
    const unresolved = !approved && openIss.length
      ? `<div class="unresolved"><b>Unresolved items (${openIss.length})</b><ul>${openIss.slice(0, 15).map((i) => `<li>${e(i.text)}${i.level === 'review' ? ' <i>(reviewer decision needed)</i>' : ''}</li>`).join('')}${openIss.length > 15 ? `<li>…and ${openIss.length - 15} more</li>` : ''}</ul></div>` : '';
    return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${e(ref(p))} ${e(p.name)}</title><style>${pdf.CSS}
${approved ? '' : 'body::before{content:"DRAFT";position:fixed;top:40%;left:18%;font-size:140pt;color:rgba(192,57,43,.08);transform:rotate(-20deg);font-weight:bold;z-index:-1;}'}</style></head><body>
<div class="header">
  ${pdf.LETTERHEAD_DATA_URI ? `<img src="${pdf.LETTERHEAD_DATA_URI}" alt="">` : `<div class="school">${e(pdf.SCHOOL_NAME)}</div>`}
  <div class="doc-id"><div class="type">${e(docTitle)}</div>
    <div>Ref ${e(ref(p))} · Version ${p.version}${versionLabel ? ` (${e(versionLabel)})` : ''} · Parent ${e(caraRef(cara.id))}</div></div>
</div>
<div class="titlebar"><h1>${e(p.name)}</h1><div class="sub">${e(pdf.SCHOOL_NAME)}</div></div>
${notice}
${authNote}
${unresolved}
<table class="meta"><tr>
  <th>Parent CARA</th><td>${e(caraRef(cara.id))} ${e(cara.activity_name)} (${e(cara.risk_level)} risk, ${e(cara.status)})</td>
  <th>Activity classification</th><td>${e(p.activity_class)}</td>
  <th>Document purpose</th><td>${e(p.doc_purpose)}</td>
  <th>Status</th><td>${e(p.status)} v${p.version}</td>
</tr></table>
<h2>1. Project details</h2>
<table class="kv">${kv([
  ['Project type', e((rules.TEMPLATES[p.project_type] || {}).label || p.project_type || '—')],
  ['Location', e([p.room_name, p.location_detail].filter(Boolean).join(' — ') || '—')],
  ['Temporary / permanent', e(p.practice_type)],
  ['What students will do', pdf.richText(p.description)],
  ['Scope and exclusions', pdf.richText(p.scope_exclusions)],
  ['Equipment (PERAs)', e((p.peras || []).map((x) => pdf.toolName(x.activity_name)).join(', ') || '—')],
  ['Materials', pdf.richText(p.materials)],
  ['SDS references', pdf.richText(p.sds_refs)],
  ['Other conditions and hazards', pdf.richText(p.conditions)],
])}</table>
<h2>2. Work sequence, hazards and controls</h2>
${steps}
<h2>3. PPE, induction, supervision and competency</h2>
<table class="kv">${kv([['PPE', pdf.richText(p.ppe)], ['Induction, supervision and competency', pdf.richText(p.induction_supervision)]])}</table>
<h2>4. Emergency and first aid (this location)</h2>
<table class="kv">${kv([
  ['First aid kit', e(p.first_aid_kit_location || 'Not recorded')],
  ['Person with current first aid', e(p.first_aid_person || 'Not recorded')],
  ['Confirmed', p.emergency_confirmed ? e(`${p.emergency_confirmed_by || ''}, ${pdf.formatDate(p.emergency_confirmed_at)}`) : '<b>Not confirmed</b>'],
  ['Other considerations', pdf.richText(p.emergency_notes)],
])}</table>
<h2>5. Possible legal SWMS triggers (${e(rules.JURISDICTION)} rules checklist ${e(p.rules_version || rules.RULES_VERSION)})</h2>
<div class="box" style="font-size:8.5pt;color:#6B6659;">Flags from a maintained checklist for reviewer confirmation. Not a legal determination. The CARA risk rating is separate from these triggers.</div>
${triggers}
<h2>6. Condition questions</h2>
${answers}
<h2>7. Outstanding questions and assumptions</h2>
<div class="box">${pdf.richText(p.open_questions)}</div>
${p.cara_change_proposal ? `<h2>8. Suggested changes to the parent CARA (not applied)</h2><div class="box">${pdf.richText(p.cara_change_proposal)}</div>` : ''}
<div class="section keep"><h2>Review and approval</h2>
<table class="sign"><thead><tr><th>Role</th><th>Name</th><th>Date</th><th>Notes</th></tr></thead><tbody>
  <tr><td class="role">Submitted by</td><td>${e(p.submitted_by || '—')}</td><td>${e(p.submitted_at ? pdf.formatDate(p.submitted_at) : '—')}</td><td>Version ${p.version}</td></tr>
  <tr><td class="role">Approved by</td><td>${approved ? e(p.approver || '—') : '<span class="line">Not approved</span>'}</td><td>${approved ? e(pdf.formatDate(p.approved_at)) : ''}</td><td>${e(p.activity_class)} · ${e(p.doc_purpose)}</td></tr>
</tbody></table></div>
</body></html>`;
  }

  app.get('/projects/:id/pdf', async (req, res, next) => {
    try {
      const raw = await loadProject(req.params.id);
      if (!raw) return res.status(404).send('Project not found.');
      let p = withValidConfirmations(raw);
      const cara = await loadCara(p.cara_id);
      let versionLabel = null;
      if (req.query.version) {
        const v = (await pool.query('SELECT * FROM cara_project_versions WHERE project_id=$1 AND version=$2 ORDER BY id DESC LIMIT 1', [p.id, Number(req.query.version)])).rows[0];
        if (!v) return res.status(404).send('Version not found.');
        p = { ...v.snapshot, status: 'Approved', approver: v.approved_by, approved_at: v.approved_at };
        versionLabel = v.superseded_at ? `superseded ${pdf.formatDate(v.superseded_at)}` : 'current approved version';
      }
      const html = projectHtml(p, cara, { versionLabel, issues: versionLabel ? [] : checks.openIssues(projectIssues(p, cara)) });
      if (req.query.preview === 'html') return res.send(html);
      const safe = (p.name || 'Project').replace(/[^a-z0-9 \-_.]/gi, '').trim() || 'Project';
      const label = p.status === 'Approved' || versionLabel ? `v${p.version}` : 'DRAFT';
      const buf = await pdf.htmlToPdf(html, { footerLeft: `${BRAND} · ${ref(p)} v${p.version} ${p.status === 'Approved' || versionLabel ? '' : 'DRAFT — not approved'} · parent ${caraRef(cara.id)} · Generated ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })}` });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${ref(p)} ${safe} ${label}.pdf"`);
      res.end(buf);
    } catch (err) { next(err); }
  });

  // Short list for the CARA PDF.
  async function projectsForCaraPdf(caraId) {
    const { rows } = await pool.query(`SELECT id, name, status, version, activity_class, doc_purpose FROM cara_projects WHERE cara_id=$1 AND status <> 'Archived' ORDER BY created_at`, [caraId]);
    return rows.map((r) => ({ ...r, ref: ref(r) }));
  }

  app.post('/projects/:id/issues/resolve', requireRole('admin', 'approver', 'system_admin'), async (req, res, next) => {
    try {
      const raw = await loadProject(req.params.id);
      if (!raw) return res.status(404).send('Project not found.');
      const p = withValidConfirmations(raw);
      const cara = await loadCara(p.cara_id);
      const note = clean(req.body.note);
      const issue = projectIssues(p, cara).find((i) => i.key === req.body.key);
      if (!issue || issue.level !== 'review' || !note) return res.status(400).send('That issue must be fixed by editing the project, or the note is missing. <a href="javascript:history.back()">Back</a>');
      const r = { ...(raw.issue_resolutions || {}) };
      r[issue.key] = { basis: issue.text, note, by: req.staffUser.name, at: new Date().toISOString() };
      await pool.query('UPDATE cara_projects SET issue_resolutions=$1 WHERE id=$2', [JSON.stringify(r), p.id]);
      await log(p.id, req.staffUser.name, 'Reviewer decision', `${issue.text}\nDecision: ${note}`);
      res.redirect(`/projects/${p.id}#approval-checks`);
    } catch (err) { next(err); }
  });

  // Projects whose possible extra scope hasn't been reviewed on the CARA.
  async function openReviews(caraId) {
    const { rows } = await pool.query(`SELECT * FROM cara_projects WHERE cara_id = $1 AND status <> 'Archived'`, [caraId]);
    const caraPeras = await caraPeraIds(caraId);
    const out = [];
    for (const p of rows) {
      p.peras = (await pool.query('SELECT pr.id, pr.activity_name FROM cara_project_peras l JOIN pera_records pr ON pr.id = l.pera_id WHERE l.project_id = $1', [p.id])).rows;
      const reasons = caraReviewOpen(p, caraPeras);
      if (reasons.length) out.push({ id: p.id, name: p.name, reasons });
    }
    return out;
  }

  return { caraPanelHtml, projectsForCaraPdf, openReviews };
};
