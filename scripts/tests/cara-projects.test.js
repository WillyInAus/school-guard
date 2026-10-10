// End-to-end checks for CARA approval checks, first aid safety, AI privacy and
// linked projects. Runs against a LOCAL test server + test database only:
//   1. createdb, start mock:  node scripts/tests/mock-anthropic.js
//   2. start app:  DATABASE_URL=... DATABASE_SSL=false SESSION_SECRET=testsecret PORT=3098 \
//        ANTHROPIC_API_KEY=test ANTHROPIC_BASE_URL=http://127.0.0.1:4010 node server.js
//   3. psql $DATABASE_URL -f scripts/tests/seed.sql
//   4. TEST_DB=... node scripts/tests/cara-projects.test.js
const crypto = require('crypto');
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const { Client } = require('pg');
const BASE = process.env.TEST_BASE || 'http://localhost:3098';
const DB = process.env.TEST_DB || 'postgresql://postgres:testpass@127.0.0.1:5432/sg_proj';
const AI_LOG = process.env.AI_LOG || '/tmp/ai-requests.log';
const tok = (id) => { const p = `${id}.${Date.now() + 3600e3}`; return `${p}.${crypto.createHmac('sha256', 'testsecret').update(p).digest('hex')}`; };
const U = { admin: tok(1), approver: tok(2), teacher: tok(3), other: tok(4) };
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('PASS', msg); } else { fail++; console.log('FAIL', msg); } };
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function req(who, method, p, form) {
  const opts = { method, redirect: 'manual', headers: { Cookie: `staff_session=${U[who]}` } };
  if (form) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) [].concat(v).forEach((x) => q.append(k, x));
    opts.body = q.toString(); opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  const r = await fetch(BASE + p, opts);
  const type = r.headers.get('content-type') || '';
  const text = type.includes('pdf') ? '' : await r.text();
  return { status: r.status, loc: r.headers.get('location'), text, type };
}
const html = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const QS = ['construction_work', 'cutting', 'chemicals', 'manual_handling', 'hot_work', 'gas_cylinders', 'rotating_machinery', 'noise', 'sharp_edges', 'fall_2m', 'heights_any', 'excavation', 'services', 'mobile_plant', 'traffic', 'structural', 'asbestos', 'tilt_up', 'confined_space', 'atmosphere', 'water', 'temperature', 'other_listed'];
const allNo = () => Object.fromEntries(QS.map((q) => [`q_${q}`, 'No']));
const QS_ALL = ['construction_work', 'cutting', 'chemicals', 'manual_handling', 'fall_2m', 'heights_any', 'excavation', 'services', 'mobile_plant', 'traffic', 'structural', 'asbestos', 'tilt_up', 'confined_space', 'atmosphere', 'water', 'temperature', 'other_listed'];
const fullCara = {
  screening_fields: '1', ...Object.fromEntries(QS_ALL.map((q) => [`q_${q}`, 'No'])), q_construction_work: 'Yes',
  activity_name: 'Cert II Construction', class_unit: 'Construction', risk_level: 'High', course: 'CPC20220 Certificate II in Construction Pathways',
  year_level: 'Year 11', class_size: '14', age_range: '16–17', prior_experience: 'Completed Year 10 IDT and workshop induction.',
  activity_scope: 'Students build practice projects (brick wall, sawhorse, small slab).', students_notes: 'SECRET-STUDENT-XYZ medical plan for J. Smith',
  supervision_notes: 'Direct supervision for all powered equipment. Teacher present at all times.', supervisor_qualification: 'Trade-qualified teacher with current first aid.',
  induction_instruction: 'Workshop and machine inductions before use; competency sign-off in PracReady.', facilities_equipment: 'Outdoor construction area with shade and water.',
  emergency_first_aid: 'Raise the alarm and call 000 in an emergency. Notify sick bay.', first_aid_kit_location: 'Shed by the construction area gate', first_aid_person: 'Teacher T', emergency_confirmed: 'true',
  environmental_hazards: 'Sun exposure', environmental_controls: 'Shade, hats, water', facilities_hazards: 'Mixer entanglement', facilities_controls: 'Guards in place',
  student_hazards: 'Inexperience', student_controls: 'Supervision and induction', consent_required: 'true', submitted_by: 'Teacher T', edited_by: 'Teacher T', tool_ids: ['3', '2'],
  cara_type_fields: '1', cara_type: 'vet', room_id: '2', location_detail: 'Outdoor construction area',
  vet_units: 'CPCCWHS2001 Apply WHS requirements, policies and procedures in the construction industry', delivery_context: 'School-based training',
  trainer_competencies: 'TAE40116 plus current construction industry skills; RTO trainer matrix ref TM-12', vet_safety_requirements: 'General construction induction (white card) completed before practical work.', vet_codes_checked: 'true',
};

(async () => {
  const db = new Client({ connectionString: DB }); await db.connect();
  const approvedBefore = (await db.query("SELECT id, status, updated_at FROM cara_records WHERE id = 2")).rows[0];

  // ===== 1. Unsafe first aid =====
  let r = await req('approver', 'GET', '/cara/3');
  ok(html(r.text).includes('Unsafe first aid wording in Emergency and first aid: "- For severe burns, apply cool water or ice."'), 'existing CARA: unsafe burns wording detected');
  ok(r.text.includes('Unsafe first aid wording — must be corrected.') && r.text.includes('Correct the unsafe first aid wording'), 'unsafe wording shown prominently with a clear next step');
  const audit = execFileSync('node', [path.join(__dirname, '..', 'audit-cara-content.js')], { env: { ...process.env, DATABASE_URL: DB, DATABASE_SSL: 'false' } }).toString();
  ok(audit.includes('CARA #3') && audit.includes('UNSAFE FIRST AID') && audit.includes('first appeared: edit on'), 'audit script lists affected record and where the wording first appeared');
  ok(!audit.includes('CARA #2 '), 'audit script does not list clean records');
  r = await req('approver', 'GET', '/admin/content-review');
  ok(r.status === 200 && r.text.includes('Proposed correction') && r.text.includes('An admin can apply this correction'), 'content review page shows proposed correction (approver cannot apply)');
  r = await req('approver', 'POST', '/admin/content-review/cara/3/fix', { field: 'emergency_first_aid' });
  ok(r.status === 403, 'approver cannot apply a content correction');
  let c3 = (await db.query('SELECT emergency_first_aid, status FROM cara_records WHERE id=3')).rows[0];
  ok(c3.emergency_first_aid.includes('ice') && c3.status === 'Approved', 'nothing is changed until an admin applies the correction');
  r = await req('admin', 'POST', '/admin/content-review/cara/3/fix', { field: 'emergency_first_aid' });
  c3 = (await db.query('SELECT emergency_first_aid, status, review_notes FROM cara_records WHERE id=3')).rows[0];
  ok(!/apply cool water or ice/.test(c3.emergency_first_aid) && c3.emergency_first_aid.includes('at least 20 minutes. Do not use ice.'), 'correction replaces unsafe line with reviewed burns wording');
  ok(c3.emergency_first_aid.includes('[AS/NZS 1336]'), 'correction keeps the rest of the teacher text');
  ok(c3.status === 'Draft' && /re-approval|resubmit/i.test(c3.review_notes), 'corrected approved CARA returns to Draft for re-approval');
  const log3 = (await db.query("SELECT summary FROM cara_change_log WHERE cara_id=3 AND brief='Safety correction'")).rows[0];
  ok(log3 && log3.summary.includes('apply cool water or ice') && log3.summary.includes('Approved → Draft'), 'correction logged with old text, new text and status change');

  // ===== 2. Placeholders and missing information =====
  r = await req('approver', 'GET', '/cara/3');
  const t3 = html(r.text);
  ok(!t3.includes('Unsafe first aid wording'), 'after correction, the reviewed wording itself is not flagged as unsafe');
  ok(t3.includes('[Year level]') && t3.includes("[school's induction process]") && t3.includes('[location]'), 'placeholders listed as issues');
  ok(!/placeholders?[^<]*\[AS\/NZS 1336\]/.test(t3), 'legitimate bracket reference [AS/NZS 1336] not treated as a placeholder');
  ok(t3.includes('Class group: class size is missing') && t3.includes('Emergency arrangements not confirmed'), 'missing class info and unconfirmed emergency arrangements listed');
  ok(t3.includes('href="/cara/3/edit#supervision_notes"'), 'issues link to the relevant field');

  // ===== 3. Supervision conflicts and risk terminology =====
  ok(t3.includes('Supervision statements may contradict each other') && t3.includes('PERA "pedestal drill" requires direct supervision'), 'contradictory supervision and weaker-than-PERA supervision flagged');
  ok(t3.includes('Reviewer decision and reason'), 'reviewer can record a decision on conflicts');
  r = await req('teacher', 'POST', '/cara/3/issues/resolve', { key: 'x', note: 'y' });
  ok(r.status === 403, 'teacher cannot resolve reviewer issues');
  r = await req('approver', 'POST', '/cara/3/issues/resolve', { key: 'missing:class_size', note: 'fine' });
  ok(r.status === 400, 'blocking issues (missing info) cannot be waved through by a reviewer');

  // ===== 4. CARA draft saves, approval blocked server-side =====
  r = await req('teacher', 'POST', '/cara/1/edit', { activity_name: 'Cert II Construction', risk_level: 'High', edited_by: 'Teacher T', activity_scope: 'Incomplete [describe]' });
  ok(r.status === 302, 'incomplete draft can still be saved');
  await db.query("UPDATE cara_records SET status='Pending approval' WHERE id=1");
  r = await req('approver', 'POST', '/cara/1/approve', { approver: 'Approver B' });
  ok(r.status === 400 && html(r.text).includes('Activity scope still has placeholder'), 'server blocks CARA approval with unresolved items (direct POST)');
  await db.query("UPDATE cara_records SET status='Draft' WHERE id=1");

  // ===== 5. AI: privacy, unsafe first aid, weaker supervision =====
  fs.writeFileSync(AI_LOG, '');
  r = await req('teacher', 'POST', '/cara/ai/draft', { ...fullCara, supervision_notes: 'Direct supervision.\nJ. Smith has epilepsy and an individual support plan.', students_notes: 'SHOULD-NOT-BE-SENT' });
  let d = JSON.parse(r.text);
  let sent = fs.readFileSync(AI_LOG, 'utf8');
  ok(d.ok && !sent.includes('SHOULD-NOT-BE-SENT') && !sent.includes('SECRET-STUDENT'), 'CARA AI request excludes the Students box');
  ok(!sent.includes('epilepsy') && !sent.includes('J. Smith'), 'CARA AI request drops lines with individual student/medical details from other fields');
  ok(sent.includes('Year 11') && sent.includes('Class size'), 'CARA AI request includes class-level details');
  ok(d.notes.some((n) => /not sent to the AI/.test(n)), 'teacher is told a line was withheld');
  ok(!(d.suggestions.emergency_first_aid || '').includes('ice') && d.notes.some((n) => /unsafe first aid/i.test(n)), 'unsafe first aid in an AI suggestion is removed and flagged');
  ok(d.notes.some((n) => /Check before using/.test(n)), 'AI supervision suggestion that contradicts itself is flagged, not accepted');
  const caraRow = (await db.query('SELECT emergency_first_aid FROM cara_records WHERE id=1')).rows[0];
  ok(!String(caraRow.emergency_first_aid || '').includes('Raise the alarm and call 000.'), 'AI suggestions are never written to the record');
  fs.writeFileSync(AI_LOG, '');
  await db.query("UPDATE cara_records SET supervision_notes = E'Direct supervision.\\nJ. Smith has epilepsy and an individual support plan.' WHERE id=1");
  r = await req('teacher', 'POST', '/cara/1/ai/check');
  sent = fs.readFileSync(AI_LOG, 'utf8');
  ok(sent.length > 0 && !sent.includes('SECRET-STUDENT') && !sent.includes('epilepsy'), 'CARA AI check (from saved record) uses the allowlist and redaction');
  for (const k of ['students_notes', 'teacher_signature', 'submitted_by']) ok(!new RegExp(`"${k}"|${k}:`).test(sent), `AI request has no ${k} field`);
  r = await req('teacher', 'GET', '/cara/1/edit');
  ok(r.text.includes('What information is sent?') && r.text.includes('Sent to the AI: the activity description') && r.text.includes('Not sent: the Students box'), 'CARA form has a short privacy line with details of what is sent');

  // ===== 6. Projects =====
  r = await req('teacher', 'GET', '/cara/3/projects/new');
  ok(r.text.includes('Engineering (suggested)') && r.text.includes('Welding') && r.text.includes('Machining'), 'engineering CARA suggests engineering templates');
  r = await req('teacher', 'GET', '/cara/1/projects/new');
  ok(r.text.includes('Construction (suggested)') && r.text.includes('<optgroup label="Engineering">') && r.text.includes('Welding'), 'construction CARA suggests construction templates; others still available');
  ok(r.text.includes('Most relevant to this activity') && r.text.includes('Hazard screening (Queensland)'), 'questionnaire shows relevant questions first and a Queensland screening section');
  ok(r.text.includes('What information is sent?') && r.text.includes("Not sent: the CARA's Students box") && r.text.includes('never sent'), 'project form privacy wording is accurate');

  const brick = { cara_id: 1, name: 'Brick and block laying', project_type: 'brick_block', description: 'Practice wall', practice_type: 'Temporary educational practice',
    room_id: 2, pera_ids: ['1', '3'], edited_by: 'Teacher T', in_cara_scope: 'Unsure', q_construction_work: 'Unsure', q_cutting: 'Yes', q_dry_cutting: 'Unsure', q_engineered_stone: 'No',
    work_steps_json: JSON.stringify([{ step: 'Set out wall', hazards: 'Trips', controls: 'Housekeeping' }]) };
  r = await req('teacher', 'POST', '/cara/1/projects', brick); const p1 = Number(r.loc.split('/').pop());
  r = await req('teacher', 'POST', '/cara/1/projects', { cara_id: 1, name: 'Sawhorse', project_type: 'sawhorse', practice_type: 'Temporary educational practice', pera_ids: ['3'], in_cara_scope: 'Yes', edited_by: 'Teacher T', ...allNo() });
  const p2 = Number(r.loc.split('/').pop());
  r = await req('teacher', 'POST', '/cara/1/projects', { cara_id: 1, name: 'Concreting', project_type: 'concreting', practice_type: 'Unsure', pera_ids: ['2'], edited_by: 'Teacher T' });
  const p3 = Number(r.loc.split('/').pop());
  ok((await db.query('SELECT COUNT(*)::int n FROM cara_projects WHERE cara_id=1')).rows[0].n === 3, 'multiple projects linked to one CARA');
  r = await req('teacher', 'GET', '/cara/1');
  ok(html(r.text).includes("Uses equipment not in the CARA's PERA list: Brick saw"), 'equipment outside the parent CARA flags a review');
  ok(r.text.includes('may go beyond this CARA'), 'open project reviews appear in the CARA approval checks');

  r = await req('teacher', 'GET', `/projects/${p1}`);
  ok(html(r.text).includes('Work carried out in an area that may have a contaminated or flammable atmosphere') && r.text.includes('<strong>Needs review</strong>'), 'critical "Unsure" leaves classification unresolved');
  r = await req('teacher', 'POST', `/projects/${p1}/submit`); ok(r.status === 400, 'cannot submit with critical questions unanswered');
  r = await req('teacher', 'GET', `/projects/${p2}`);
  ok(!r.text.includes('Could any of that cutting or grinding be done DRY'), 'follow-up question hidden when parent answer is No');

  fs.writeFileSync(AI_LOG, '');
  r = await req('teacher', 'POST', '/projects/ai/draft', { ...brick, pera_ids: ['1', '3', '4'], scope_exclusions: 'TEACHER TEXT', description: 'Practice wall\nStudent Jack has asthma', students_notes: 'NOPE' });
  d = JSON.parse(r.text); sent = fs.readFileSync(AI_LOG, 'utf8');
  ok(d.ok && !sent.includes('SECRET-STUDENT') && !sent.includes('NOPE') && !sent.includes('asthma'), 'project AI request excludes Students box and individual details');
  ok(!(d.suggestions.emergency_notes || '').includes('ice') && d.notes.some((n) => /unsafe first aid/i.test(n)), 'project AI unsafe first aid removed');
  ok(d.notes.some((n) => /pedestal drill/i.test(n) && /direct supervision/.test(n)), 'project AI suggestion weaker than PERA supervision is flagged');
  ok(d.suggestions.cara_change_proposal && (await db.query('SELECT scope_exclusions FROM cara_projects WHERE id=$1', [p1])).rows[0].scope_exclusions === null, 'AI suggestions (incl. CARA changes) are not applied');
  ok((await db.query("SELECT COUNT(*)::int n FROM cara_ai_reviews WHERE kind='project_draft'")).rows[0].n >= 1, 'project AI drafts are recorded in the AI usage log');

  const full = { ...brick, ...allNo(), q_construction_work: 'Yes', q_cutting: 'Yes', q_dry_cutting: 'No', q_engineered_stone: 'No', q_mobile_plant: 'Yes', in_cara_scope: 'Yes',
    first_aid_kit_location: 'Outdoor area shed', first_aid_person: 'Teacher T', emergency_confirmed: 'true', doc_purpose: 'SWMS for training/assessment', scope_exclusions: 'Practice wall only' };
  await req('teacher', 'POST', `/projects/${p1}/edit`, full);
  r = await req('teacher', 'POST', `/projects/${p1}/submit`); ok(r.status === 302, 'project submitted for review');
  await req('approver', 'POST', `/projects/${p1}/trigger`, { trigger: 'mobile_plant', decision: 'Does not apply', note: 'Stationary mixer only' });
  await req('approver', 'POST', `/projects/${p1}/classify`, { activity_class: 'Educational practice / simulation', doc_purpose: 'SWMS for training/assessment', note: 'Temporary practice wall' });
  r = await req('approver', 'POST', `/projects/${p1}/approve`, { approver: 'Approver B' });
  ok(r.status === 400 && html(r.text).includes('The parent CARA is "Draft"'), 'project cannot be approved while the parent CARA is not approved');

  // Complete and approve the parent CARA through the real routes
  r = await req('teacher', 'POST', '/cara/1/edit', fullCara); ok(r.status === 302, 'teacher completes the CARA');
  for (const pid of [p1, p2, p3]) await req('teacher', 'POST', `/projects/${pid}/cara-reviewed`);
  await req('teacher', 'POST', '/cara/1/submit', { teacher_signature: SIG });
  r = await req('approver', 'POST', '/cara/1/approve', { approver: 'Approver B' });
  ok(r.status === 302 && (await db.query('SELECT status FROM cara_records WHERE id=1')).rows[0].status === 'Approved', 'CARA approves once all checks pass');

  r = await req('teacher', 'POST', `/projects/${p1}/approve`, { approver: 'Approver B' }); ok(r.status === 403, 'teacher cannot approve a project');
  r = await req('approver', 'POST', `/projects/${p1}/approve`, { approver: 'Approver B' });
  let pr = (await db.query('SELECT status, version, approver, approved_at FROM cara_projects WHERE id=$1', [p1])).rows[0];
  ok(r.status === 302 && pr.status === 'Approved' && pr.version === 1 && pr.approver === 'Approver B' && pr.approved_at, 'project approved; reviewer, version and date recorded');

  // Parent CARA edited -> back to Draft -> approved project is not authorised
  await req('teacher', 'POST', '/cara/1/edit', { ...fullCara, activity_scope: 'Students build practice projects (brick wall, sawhorse, small slab, tiling board).' });
  r = await req('teacher', 'GET', `/projects/${p1}`);
  ok(r.text.includes('Approved, but not authorised for use'), 'approved project shows it is not authorised while the parent CARA is not approved');
  r = await req('teacher', 'GET', `/projects/${p1}/pdf?preview=html`);
  ok(r.text.includes('NOT AUTHORISED FOR USE'), 'project export shows it is not authorised');

  // Material change after approval + classification reset
  await req('teacher', 'POST', `/projects/${p1}/edit`, { ...full, q_traffic: 'Yes' });
  pr = (await db.query('SELECT status, version FROM cara_projects WHERE id=$1', [p1])).rows[0];
  ok(pr.status === 'Draft' && pr.version === 2, 'change after approval returns project to Draft as version 2');
  r = await req('teacher', 'GET', `/projects/${p1}`);
  ok(r.text.includes('classification is back to') || r.text.includes('Answers have changed since then'), 'changing an answer returns the classification to Needs review');
  ok((await db.query('SELECT COUNT(*)::int n FROM cara_project_versions WHERE project_id=$1 AND version=1', [p1])).rows[0].n === 1, 'approved version 1 kept');
  r = await req('teacher', 'GET', `/projects/${p1}/pdf?version=1&preview=html`);
  ok(r.text.includes('Version 1') && r.text.includes('SWMS for training/assessment') && r.text.includes('CARA-0001'), 'earlier version export shows version, purpose and parent reference');

  // Distinct document purposes
  await req('approver', 'POST', `/projects/${p2}/classify`, { activity_class: 'Actual construction work', doc_purpose: 'Project safe work procedure' });
  const purposes = (await db.query('SELECT DISTINCT doc_purpose FROM cara_projects')).rows.map((x) => x.doc_purpose);
  ok(purposes.includes('Project safe work procedure') && purposes.includes('SWMS for training/assessment'), 'safe work procedure and training SWMS kept as distinct purposes');
  await db.query("UPDATE cara_projects SET answers = answers || '{\"fall_2m\":\"Yes\",\"construction_work\":\"Yes\"}'::jsonb, trigger_reviews = '{}'::jsonb WHERE id=$1", [p2]);
  await req('approver', 'POST', `/projects/${p2}/trigger`, { trigger: 'fall_2m', decision: 'Applies', note: 'Scaffold over 2 m' });
  await db.query("UPDATE cara_projects SET status='Awaiting review', emergency_confirmed=true, class_basis=NULL WHERE id=$1", [p2]);
  r = await req('approver', 'POST', `/projects/${p2}/approve`, { approver: 'Approver B' });
  ok(r.status === 400 && html(r.text).includes('must be "Legally required SWMS"'), 'confirmed trigger on actual construction work requires the legally required SWMS purpose');

  // Draft exports identify unresolved information
  r = await req('teacher', 'GET', `/projects/${p3}/pdf?preview=html`);
  ok(r.text.includes('DRAFT — NOT APPROVED') && r.text.includes('Unresolved items'), 'draft project export lists unresolved items');
  r = await req('teacher', 'GET', '/cara/3/pdf?preview=html');
  ok(r.text.includes('Unresolved items') && r.text.includes('[Year level]'), 'draft CARA export lists unresolved items');
  r = await req('teacher', 'GET', `/projects/${p1}/pdf`); ok(r.status === 200 && r.type === 'application/pdf', 'project PDF renders');
  r = await req('teacher', 'GET', '/cara/1/pdf'); ok(r.status === 200 && r.type === 'application/pdf', 'CARA PDF renders');

  // ===== 7. CARA type: general curriculum / VET =====
  r = await req('teacher', 'GET', '/cara/new');
  ok(r.text.includes('What are you planning?') && r.text.includes('name="cara_type" value="general"') && r.text.includes('name="cara_type" value="vet"') && r.text.includes('1. Describe the activity'), 'New CARA starts at step 1 with the general/VET choice (no separate landing page)');
  r = await req('teacher', 'GET', '/cara/new?type=general');
  ok(r.text.includes('name="cara_type" value="general" checked') && r.text.includes('id="vet_section" data-show-for="vet"'), 'general preselected; VET details only shown for VET');
  r = await req('teacher', 'GET', '/cara/3');
  ok(r.status === 200 && r.text.includes('Type not set') && html(r.text).includes('Choose whether this is a general curriculum activity or a VET course'), 'existing CARA stays accessible; type shown as not set and must be confirmed');
  r = await req('teacher', 'GET', '/cara/3/edit');
  ok(r.status === 200 && r.text.includes('created before types existed') && (await db.query('SELECT cara_type FROM cara_records WHERE id=3')).rows[0].cara_type === null, 'existing CARA editable and not auto-classified from its title');

  // General curriculum construction activity: same screening when the work triggers it
  r = await req('teacher', 'POST', '/cara', { activity_name: 'Year 9 Design Tech garden shed', class_unit: 'Year 9 Design and Technologies', risk_level: 'High', cara_type_fields: '1', cara_type: 'general',
    activity_scope: 'Students frame and clad a small garden shed on the school agriculture plot using drop saws and nail guns.', submitted_by: 'Teacher T', tool_ids: ['3'] });
  const gc = Number(r.loc.split('/').pop());
  ok((await db.query('SELECT cara_type FROM cara_records WHERE id=$1', [gc])).rows[0].cara_type === 'general', 'general curriculum CARA created with its type stored');
  r = await req('teacher', 'GET', `/cara/${gc}`);
  ok(!/<[^>]*>\s*VET details\s*</.test(r.text) && !r.text.includes('vet_units') && !html(r.text).includes('VET: '), 'general curriculum CARA shows no VET fields or VET checks');
  ok(r.text.includes('Optional: add projects'), 'projects are optional for general curriculum');
  r = await req('teacher', 'POST', `/cara/${gc}/projects`, { cara_id: gc, name: 'Shed frame', project_type: 'wall_frame', practice_type: 'Permanent installation for use', pera_ids: ['3'], edited_by: 'Teacher T', q_construction_work: 'Yes', q_fall_2m: 'Yes' });
  const gp = Number(r.loc.split('/').pop());
  r = await req('teacher', 'GET', `/projects/${gp}`);
  ok(html(r.text).includes('Possible trigger:</strong> Work that involves a risk of a person falling more than 2 metres'), 'general curriculum construction project still gets the construction screening and trigger');

  // VET hospitality: no construction questions
  r = await req('teacher', 'POST', '/cara', { activity_name: 'SIT20322 kitchen practicals', class_unit: 'Hospitality', course: 'SIT20322 Certificate II in Hospitality', risk_level: 'Medium', cara_type_fields: '1', cara_type: 'vet',
    activity_scope: 'Students prepare and cook menu items in the training kitchen using knives, fryers and ovens, then clean down.', submitted_by: 'Teacher T' });
  const hc = Number(r.loc.split('/').pop());
  r = await req('teacher', 'GET', `/cara/${hc}/projects/new`);
  ok(r.text.includes('Hospitality (suggested)') && r.text.includes('Commercial kitchen'), 'hospitality VET course suggests the hospitality template');
  r = await req('teacher', 'POST', `/cara/${hc}/projects`, { cara_id: hc, name: 'Cafe menu', project_type: 'kitchen', description: 'Cook with fryers and ovens', practice_type: 'Temporary educational practice', edited_by: 'Teacher T', q_construction_work: 'No', q_temperature: 'Yes', q_hot_cooking: 'Yes' });
  const hp = Number(r.loc.split('/').pop());
  r = await req('teacher', 'GET', `/projects/${hp}`);
  const ht = html(r.text);
  ok(!ht.includes('Could any person fall more than 2 metres') && !ht.includes('trench') && !ht.includes('powered mobile plant move'), 'VET hospitality project does not get construction questions');
  ok(ht.includes('No possible high risk construction work triggers'), 'cool room (temperature) answer does not create a construction SWMS trigger outside construction work');
  ok(ht.includes('Will gas cooking appliances be used?'), 'hospitality-specific questions are asked');
  const hcRow = (await db.query('SELECT risk_level FROM cara_records WHERE id=$1', [hc])).rows[0];
  ok(hcRow.risk_level === 'Medium', 'choosing VET does not change the risk rating');
  ok((await db.query('SELECT doc_purpose, activity_class FROM cara_projects WHERE id=$1', [hp])).rows[0].doc_purpose === 'Not yet decided', 'choosing VET does not set a SWMS document purpose');
  r = await req('teacher', 'GET', `/cara/${hc}`);
  ok(html(r.text).includes('VET: list the units of competency') && html(r.text).includes('VET: confirm the qualification and unit codes were checked'), 'VET CARA requires units and code check before approval');
  ok(r.text.includes('VET courses usually involve several projects'), 'projects section is prominent for VET');

  // Scope sufficiency
  await db.query("UPDATE cara_records SET activity_scope = 'VET Certificate II in Hospitality' WHERE id=$1", [hc]);
  r = await req('teacher', 'GET', `/cara/${hc}`);
  ok(html(r.text).includes('Activity scope only names the course'), 'a course title alone is not accepted as the activity scope');

  // Changing type keeps data
  await req('teacher', 'POST', `/cara/${hc}/edit`, { activity_name: 'SIT20322 kitchen practicals', risk_level: 'Medium', edited_by: 'Teacher T', cara_type_fields: '1', cara_type: 'vet', course: 'SIT20322 Certificate II in Hospitality', vet_units: 'SITHCCC027 Prepare dishes using basic methods of cookery', delivery_context: 'Simulated workplace' });
  await req('teacher', 'POST', `/cara/${hc}/edit`, { activity_name: 'SIT20322 kitchen practicals', risk_level: 'Medium', edited_by: 'Teacher T', cara_type_fields: '1', cara_type: 'general', course: 'SIT20322 Certificate II in Hospitality', vet_units: 'SITHCCC027 Prepare dishes using basic methods of cookery', delivery_context: 'Simulated workplace' });
  const hc2 = (await db.query('SELECT cara_type, vet_units, delivery_context FROM cara_records WHERE id=$1', [hc])).rows[0];
  ok(hc2.cara_type === 'general' && hc2.vet_units.startsWith('SITHCCC027') && hc2.delivery_context === 'Simulated workplace', 'changing type to general keeps the VET data');
  r = await req('teacher', 'GET', `/cara/${hc}/pdf?preview=html`);
  ok(!r.text.includes('VET details'), 'general curriculum export has no VET section');

  // VET export, approved versions
  r = await req('teacher', 'GET', '/cara/1/pdf?preview=html');
  ok(r.text.includes('VET details') && r.text.includes('CPCCWHS2001') && r.text.includes('School-based training'), 'VET export shows qualification, units and delivery context');
  const v1 = (await db.query('SELECT version FROM cara_versions WHERE cara_id=1')).rows;
  ok(v1.length === 1 && v1[0].version === 1, 'approved CARA version kept');
  r = await req('teacher', 'GET', '/cara/1/pdf?version=1&preview=html');
  ok(r.text.includes('approved version 1') && r.text.includes('small slab).'), 'earlier approved CARA version exportable with its original scope');

  // AI with VET details
  fs.writeFileSync(AI_LOG, '');
  await req('teacher', 'POST', '/cara/ai/draft', { ...fullCara });
  sent = fs.readFileSync(AI_LOG, 'utf8');
  ok(sent.includes('VET course or activity') && sent.includes('CPCCWHS2001') && /never invent/i.test(sent), 'AI gets the CARA type and teacher-entered VET details, with no-invention rules');
  ok(!sent.includes('TM-12') && !sent.includes('SECRET-STUDENT'), 'AI request excludes trainer details and the Students box');

  // Permissions
  r = await req('other', 'POST', `/projects/${p2}/edit`, { cara_id: 1, name: 'Hacked', edited_by: 'O' }); ok(r.status === 403, 'another teacher cannot edit the project');
  r = await req('other', 'GET', '/cara/1/projects/new'); ok(r.status === 403, 'another teacher cannot add projects to the CARA');
  r = await req('teacher', 'POST', `/projects/${p1}/trigger`, { trigger: 'traffic_corridor', decision: 'Does not apply', note: 'x' }); ok(r.status === 403, 'teacher cannot confirm triggers');

  const after = (await db.query("SELECT id, status, updated_at FROM cara_records WHERE id = 2")).rows[0];
  ok(JSON.stringify(after) === JSON.stringify(approvedBefore), 'unrelated approved CARA untouched');

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
