// Teacher journeys through the four-stage CARA and project workflow.
// Same local setup as cara-projects.test.js (test server on 3098, mock AI on
// 4010, seed.sql loaded). Run on a freshly seeded database:
//   TEST_DB=... node scripts/tests/journeys.test.js
const crypto = require('crypto');
const fs = require('fs');
const { Client } = require('pg');
const rules = require('../../project-rules');
const BASE = process.env.TEST_BASE || 'http://localhost:3098';
const DB = process.env.TEST_DB || 'postgresql://postgres:testpass@127.0.0.1:5432/sg_proj';
const AI_LOG = process.env.AI_LOG || '/tmp/ai-requests.log';
const tok = (id) => { const p = `${id}.${Date.now() + 3600e3}`; return `${p}.${crypto.createHmac('sha256', 'testsecret').update(p).digest('hex')}`; };
const U = { admin: tok(1), approver: tok(2), teacher: tok(3) };
let pass = 0, fail = 0;
const ok = (cond, msg, extra) => { if (cond) { pass++; console.log('PASS', msg); } else { fail++; console.log('FAIL', msg, extra ? `\n     ${String(extra).slice(0, 600)}` : ''); } };
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const html = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const idOf = (r) => Number(String(r.loc || '').match(/\/(?:cara|projects)\/(\d+)/)[1]);

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

// Screening answers: every question answered No, with overrides.
const screen = (over = {}) => ({ screening_fields: '1', ...Object.fromEntries(rules.QUESTIONS.map((q) => [`q_${q.key}`, 'No'])), ...Object.fromEntries(Object.entries(over).map(([k, v]) => [`q_${k}`, v])) });
// Stage 3 and 4 content a teacher writes by hand (no AI).
const handWritten = {
  activity_scope: 'Students mark out, cut, fold and rivet a small sheet-metal toolbox from 0.8 mm galvanised steel.',
  environmental_hazards: 'Noise from folding and riveting', environmental_controls: 'Hearing protection when the guillotine is used',
  facilities_hazards: 'Sharp edges on cut sheet', facilities_controls: 'Deburr all edges; leather gloves when handling sheet',
  student_hazards: 'First use of the guillotine', student_controls: 'Demonstration and one-to-one induction before first use',
  supervision_notes: 'Direct supervision for the guillotine and pan brake. Teacher present in the workshop at all times.',
  supervisor_qualification: 'Qualified Design and Technologies teacher with current workshop induction.',
  induction_instruction: 'Workshop induction and guillotine induction recorded in PracReady before use.',
  facilities_equipment: 'IDT workshop with guarded guillotine, pan brake and benches.',
  emergency_first_aid: 'Raise the alarm and call 000 in an emergency. Notify sick bay.',
  first_aid_kit_location: 'IDT workshop, wall by the door', first_aid_person: 'Teacher T', emergency_confirmed: 'true',
  consent_required: 'false', submitted_by: 'Teacher T', edited_by: 'Teacher T', risk_level: 'Medium', risk_basis: 'Guillotine and sharp edges, controlled by induction and direct supervision.',
};
const describeGeneral = {
  cara_type_fields: '1', cara_type: 'general', activity_name: 'Year 9 sheet-metal toolbox', class_unit: 'Year 9 Design and Technologies', year_level: 'Year 9', class_size: '22',
  age_range: '14–15', course: 'Design and Technologies', prior_experience: 'Completed the Year 8 workshop induction.', room_id: '1', location_detail: 'IDT Workshop benches',
  activity_brief: 'Students mark out, cut with tin snips and the guillotine, fold on the pan brake and rivet a small toolbox.', edited_by: 'Teacher T', submitted_by: 'Teacher T',
};

(async () => {
  const db = new Client({ connectionString: DB }); await db.connect();
  const approvedBefore = (await db.query('SELECT id, status, updated_at FROM cara_records WHERE id = 2')).rows[0];

  // ===== A. General curriculum sheet-metal activity, saved stage by stage, no AI =====
  let r = await req('teacher', 'POST', '/cara', { ...describeGeneral, stage: '1' });
  ok(r.status === 302 && /\/cara\/\d+\/edit\?stage=1&saved=1$/.test(r.loc), 'stage 1 "Save draft" creates the CARA and returns to the same stage', r.loc);
  const sm = idOf(r);
  let row = (await db.query('SELECT status, risk_level, activity_brief, cara_type FROM cara_records WHERE id=$1', [sm])).rows[0];
  ok(row.status === 'Draft' && row.risk_level === null && row.activity_brief.startsWith('Students mark out') && row.cara_type === 'general', 'incomplete draft saved without a risk rating; description and type kept');
  r = await req('teacher', 'GET', `/cara/${sm}/edit?stage=1&saved=1`);
  ok(r.text.includes('Draft saved.') && r.text.includes('id="stage_input" value="1"') && r.text.includes('Year 9 sheet-metal toolbox') && r.text.includes('Completed the Year 8 workshop induction.'), 'resume: saved message, same stage, entered values shown');
  ok(r.text.includes('1. Describe') && r.text.includes('Tools and equipment') && r.text.includes('Draft and review') && r.text.includes('Check and submit'), 'four stages shown in the progress indicator');
  r = await req('teacher', 'GET', `/cara/${sm}`);
  ok(r.text.includes('Activity risk not set') && html(r.text).includes('Hazard screening'), 'overview shows the risk as not set and screening as outstanding');
  // Stage 2 (tools, materials, screening)
  r = await req('teacher', 'POST', `/cara/${sm}/edit`, { ...describeGeneral, stage: '2', tool_ids: ['3'], materials: '0.8 mm galvanised sheet, pop rivets', sds_refs: 'Galvanised steel SDS (supplier, 2024)', ...screen({ construction_work: 'No', cutting: 'Yes', sharp_edges: 'Yes', noise: 'Yes' }) });
  ok(r.status === 302 && r.loc.endsWith(`/cara/${sm}/edit?stage=2&saved=1`), 'stage 2 "Save draft" returns to stage 2', r.loc);
  row = (await db.query('SELECT activity_brief, materials, screening FROM cara_records WHERE id=$1', [sm])).rows[0];
  ok(row.activity_brief.startsWith('Students mark out') && row.materials.includes('pop rivets') && row.screening.construction_work === 'No', 'stage 1 data kept after saving stage 2; screening stored');
  // Stage 3 + 4 by hand
  r = await req('teacher', 'POST', `/cara/${sm}/edit`, { ...describeGeneral, tool_ids: ['3'], materials: '0.8 mm galvanised sheet, pop rivets', sds_refs: 'Galvanised steel SDS (supplier, 2024)', ...screen({ construction_work: 'No', cutting: 'Yes', sharp_edges: 'Yes', noise: 'Yes' }), ...handWritten, stage: '4', after: 'submit' });
  ok(r.status === 302 && r.loc.endsWith(`/cara/${sm}#submit`), '"Check and submit" goes to the overview submit panel', r.loc);
  r = await req('teacher', 'GET', `/cara/${sm}`);
  let t = html(r.text);
  ok(!t.includes('Could any person fall more than 2 metres') && !/screening:unanswered|Hazard screening: answer/.test(t), 'construction "No": construction follow-ups are not required for the sheet-metal activity', t.match(/<div class="chk-groups">[\s\S]{0,1500}/));
  ok(t.includes('Sign and submit') && t.indexOf('ws-next') < t.indexOf('id="projects"') && t.indexOf('id="projects"') < t.indexOf('id="submit"') && t.indexOf('id="submit"') < t.indexOf('id="full"'), 'overview order: next action, projects, checks/actions, full assessment');
  ok((await db.query("SELECT COUNT(*)::int n FROM cara_ai_reviews WHERE cara_id=$1", [sm])).rows[0].n === 0, 'manual drafting: completed without any AI request');
  r = await req('teacher', 'POST', `/cara/${sm}/submit`, { teacher_signature: SIG });
  ok(r.status === 302, 'teacher signs and submits', r.text);
  r = await req('approver', 'POST', `/cara/${sm}/approve`, { approver: 'Approver B' });
  ok(r.status === 302 && (await db.query('SELECT status FROM cara_records WHERE id=$1', [sm])).rows[0].status === 'Approved', 'general sheet-metal CARA approved', html(r.text).slice(0, 800));
  ok((await db.query('SELECT COUNT(*)::int n FROM cara_versions WHERE cara_id=$1', [sm])).rows[0].n === 1, 'approved version recorded');

  // ===== B. Editing an approved record: back to Draft, approved version kept =====
  r = await req('teacher', 'POST', `/cara/${sm}/edit`, { ...describeGeneral, tool_ids: ['3'], materials: '0.8 mm galvanised sheet, pop rivets, aluminium sheet', sds_refs: 'Galvanised steel SDS (supplier, 2024)', ...screen({ construction_work: 'No', cutting: 'Yes', sharp_edges: 'Yes', noise: 'Yes' }), ...handWritten, stage: '2' });
  row = (await db.query('SELECT status FROM cara_records WHERE id=$1', [sm])).rows[0];
  ok(row.status === 'Draft', 'editing an approved CARA returns it to Draft');
  r = await req('teacher', 'GET', `/cara/${sm}/pdf?version=1&preview=html`);
  ok(r.status === 200 && r.text.includes('approved version 1'), 'approved version 1 still exportable');
  r = await req('teacher', 'GET', `/cara/${sm}/pdf?preview=html`);
  ok(r.text.includes('DRAFT'), 'current export is labelled draft');
  // Changing a screening answer re-opens the related check without deleting text
  await req('teacher', 'POST', `/cara/${sm}/edit`, { ...describeGeneral, tool_ids: ['3'], materials: '0.8 mm galvanised sheet', ...screen({ construction_work: 'No', cutting: 'Yes', chemicals: 'Unsure' }), ...handWritten });
  r = await req('teacher', 'GET', `/cara/${sm}`);
  t = html(r.text);
  ok(/Unsure/.test(t) && t.includes('Decisions for the reviewer'), 'an "Unsure" answer becomes a reviewer decision');
  row = (await db.query('SELECT supervision_notes FROM cara_records WHERE id=$1', [sm])).rows[0];
  ok(row.supervision_notes.startsWith('Direct supervision for the guillotine'), 'changing an answer does not delete entered text');
  // Saving without the screening fields (e.g. older form) keeps the answers
  await db.query("UPDATE cara_records SET screening = '{\"construction_work\":\"No\",\"cutting\":\"Yes\"}'::jsonb WHERE id=$1", [sm]);
  await req('teacher', 'POST', `/cara/${sm}/edit`, { activity_name: 'Year 9 sheet-metal toolbox', risk_level: 'Medium', edited_by: 'Teacher T' });
  ok((await db.query('SELECT screening FROM cara_records WHERE id=$1', [sm])).rows[0].screening.cutting === 'Yes', 'a save without screening fields does not wipe the answers');

  // ===== C. Unresolved hazards and unapproved equipment =====
  const draftPera = (await db.query("INSERT INTO pera_records (activity_name,class_unit,risk_level,status,supervision_level) VALUES ('Guillotine — Plant & Equipment Risk Assessment','Metalwork','High','Draft','Direct supervision') RETURNING id")).rows[0].id;
  r = await req('teacher', 'POST', '/cara', { ...describeGeneral, activity_name: 'Year 10 sheet-metal tray', tool_ids: [String(draftPera), '3'], ...screen({ construction_work: 'No', cutting: 'Unsure', chemicals: '' }), ...handWritten, stage: '4' });
  const un = idOf(r);
  r = await req('teacher', 'GET', `/cara/${un}`);
  t = html(r.text);
  ok(t.includes('equipment assessment') && t.includes('needs an authorised approver') && t.includes('Guillotine'), 'unapproved equipment grouped as an approver item, not a teacher fix');
  ok(t.includes('Waiting for') || t.includes('Complete '), 'next action does not ask the teacher to approve equipment themselves');
  r = await req('teacher', 'POST', `/cara/${un}/submit`, { teacher_signature: SIG });
  ok(r.status === 400, 'cannot submit with unanswered hazard questions and unapproved equipment');
  r = await req('teacher', 'GET', `/cara/${un}/edit?stage=2`);
  ok(r.text.includes('id="stage_input" value="2"') && r.text.includes('Guillotine') && /not approved|Draft/.test(r.text), 'stage 2 shows the selected equipment with its approval status');
  ok(r.text.includes('Tools and equipment') && !/PERA used/.test(r.text), '"PERA used" renamed to "Tools and equipment"');

  // ===== D. AI failure and retry =====
  r = await req('teacher', 'POST', '/cara/ai/draft', { ...describeGeneral, activity_name: 'FAIL-AI test', ...screen({ construction_work: 'No' }) });
  let d = JSON.parse(r.text);
  ok(!d.ok && /busy|try again/i.test(d.error), 'AI failure returns a useful retry message', r.text);
  r = await req('teacher', 'GET', `/cara/${sm}/edit`);
  ok(r.text.includes('Nothing you entered has been lost'), 'the form tells the teacher nothing was lost when AI fails');
  fs.writeFileSync(AI_LOG, '');
  r = await req('teacher', 'POST', '/cara/ai/draft', { ...describeGeneral, students_notes: 'STUDENT-SECRET', ...screen({ construction_work: 'No', cutting: 'Yes' }) });
  d = JSON.parse(r.text);
  const sent = fs.readFileSync(AI_LOG, 'utf8');
  ok(d.ok && sent.includes('tin snips') && sent.includes('Hazard') && !sent.includes('STUDENT-SECRET'), 'retry works; AI gets the description and hazard answers but not the Students box');

  // ===== E. VET hospitality: construction questions do not dominate =====
  r = await req('teacher', 'POST', '/cara', { cara_type_fields: '1', cara_type: 'vet', activity_name: 'SIT20322 café service', class_unit: 'Hospitality', course: 'SIT20322 Certificate II in Hospitality', delivery_context: 'Simulated workplace',
    activity_brief: 'Students prepare espresso drinks and toasted sandwiches in the training café using knives, the coffee machine and a sandwich press.', edited_by: 'Teacher T', stage: '1' });
  const hc = idOf(r);
  r = await req('teacher', 'GET', `/cara/${hc}/edit?stage=2`);
  ok(r.text.includes('Qualification code and title') || r.text.includes('Qualification'), 'VET course label shown for the course field');
  const relHosp = rules.relevantKeys ? rules.relevantKeys({ description: 'Students prepare espresso drinks and toasted sandwiches using knives, the coffee machine and a sandwich press' }) : null;
  ok(!relHosp || !['fall_2m', 'excavation', 'mobile_plant', 'structural'].some((k) => relHosp.has(k)), 'hospitality description does not make construction questions relevant', [...(relHosp || [])]);
  const evH = rules.evaluate({ answers: { construction_work: 'No' }, project_type: null, description: 'café service' });
  ok(!evH.unanswered.some((q) => ['fall_2m', 'excavation', 'tilt_up', 'traffic'].includes(q.key || q)), 'with construction "No", construction follow-ups are not required');
  const evU = rules.evaluate({ answers: {}, project_type: null, description: 'café service' });
  ok(evU.unanswered.some((q) => (q.key || q) === 'construction_work'), 'the work-type question is always asked (unanswered is never "No")');

  // ===== F. VET engineering project: making a product =====
  r = await req('teacher', 'POST', '/cara/3/edit', { activity_name: 'Vet Engineering CERT II', class_unit: 'Grad', risk_level: 'High', edited_by: 'Teacher T', cara_type_fields: '1', cara_type: 'vet', course: 'MEM20422 Certificate II in Engineering Pathways', room_id: '1', location_detail: 'IDT Workshop' });
  r = await req('teacher', 'GET', '/cara/3/projects/new');
  ok(r.text.includes('Use parent details') && r.text.includes('Change the location for this project'), 'project starts from the parent class and location');
  for (const opt of ['Educational practice or simulation', 'Making a product for use', 'Installation or work on a structure/site', 'Unsure']) ok(r.text.includes(`>${opt}<`) || r.text.includes(`value="${opt}"`), `practice option offered: ${opt}`);
  ok(!r.text.includes('Temporary educational practice') && !r.text.includes('Permanent installation for use'), 'temporary/permanent question replaced');
  r = await req('teacher', 'POST', '/cara/3/projects', { cara_id: 3, name: 'Steel hook rack', project_type: '', description: 'Cut, drill and weld a wall hook rack for students to take home.', practice_type: 'Making a product for use',
    loc_mode: 'parent', room_id: '2', pera_ids: ['4'], edited_by: 'Teacher T', ...screen({ construction_work: 'No', cutting: 'Yes', hot_work: 'Yes' }), stage: '2' });
  ok(r.status === 302 && /\/projects\/\d+\/edit\?stage=2&saved=1$/.test(r.loc), 'project "Save draft" returns to the same stage', r.loc);
  const eng = idOf(r);
  let pr = (await db.query('SELECT room_id, location_detail, practice_type, doc_purpose FROM cara_projects WHERE id=$1', [eng])).rows[0];
  ok(pr.room_id === 1 && pr.location_detail === 'IDT Workshop', '"Use parent details" stores the parent location (posted room ignored)', JSON.stringify(pr));
  ok(pr.practice_type === 'Making a product for use' && pr.doc_purpose === 'Not yet decided', 'product for use stored; document purpose not decided for the teacher');
  r = await req('teacher', 'GET', `/projects/${eng}/edit?stage=4`);
  ok(r.text.includes('Suggested from the screening: <strong id="purpose_suggest">Project safe work procedure'), 'keeping a product is not treated as construction: suggests a safe work procedure');
  ok(r.text.includes('Same location as the parent CARA.'), 'same-location note shown');

  // ===== G. Construction simulation and a permanent school path =====
  r = await req('teacher', 'POST', '/cara/1/projects', { cara_id: 1, name: 'Practice slab', project_type: 'concreting', description: 'Form and pour a practice slab that is broken up afterwards.', practice_type: 'Educational practice or simulation',
    loc_mode: 'change', room_id: '2', pera_ids: ['2'], edited_by: 'Teacher T', ...screen({ construction_work: 'Yes', mobile_plant: 'Yes' }) });
  const sim = idOf(r);
  r = await req('teacher', 'GET', `/projects/${sim}/edit?stage=4`);
  ok(r.text.includes('purpose_suggest">SWMS for training/assessment'), 'construction simulation suggests a SWMS for training/assessment');
  r = await req('teacher', 'POST', '/cara/1/projects', { cara_id: 1, name: 'Path to the ag plot', project_type: 'concreting', description: 'Excavate and pour a permanent concrete path for the school.', practice_type: 'Installation or work on a structure/site',
    loc_mode: 'change', room_id: '2', location_detail: 'Agriculture plot', pera_ids: ['2'], edited_by: 'Teacher T', ...screen({ construction_work: 'Yes', excavation: 'Yes', services: 'Yes', mobile_plant: 'Yes' }),
    first_aid_kit_location: 'Shed by the construction area gate', first_aid_person: 'Teacher T', emergency_confirmed: 'true' });
  const path = idOf(r);
  pr = (await db.query('SELECT doc_purpose, emergency_confirmed, location_detail FROM cara_projects WHERE id=$1', [path])).rows[0];
  ok(pr.location_detail === 'Agriculture plot', 'changed location stored for the project');
  ok(pr.emergency_confirmed === false, 'emergency arrangements copied for a different location are not accepted without confirming for that location');
  r = await req('teacher', 'GET', `/projects/${path}/edit?stage=4`);
  ok(r.text.includes('Potential legally required SWMS — reviewer decision needed') && r.text.includes('Different location from the parent CARA'), 'permanent path: potential legally required SWMS flagged for a reviewer; different location noted');
  ok(pr.doc_purpose === 'Not yet decided', 'document purpose is not set automatically');
  // Confirming for the new location works
  await req('teacher', 'POST', `/projects/${path}/edit`, { cara_id: 1, name: 'Path to the ag plot', project_type: 'concreting', description: 'Excavate and pour a permanent concrete path for the school.', practice_type: 'Installation or work on a structure/site',
    loc_mode: 'change', room_id: '2', location_detail: 'Agriculture plot', pera_ids: ['2'], edited_by: 'Teacher T', ...screen({ construction_work: 'Yes', excavation: 'Yes', services: 'Yes', mobile_plant: 'Yes' }),
    first_aid_kit_location: 'Ag plot shed', first_aid_person: 'Teacher T', emergency_confirmed: 'true', emergency_loc: '2|Agriculture plot' });
  ok((await db.query('SELECT emergency_confirmed FROM cara_projects WHERE id=$1', [path])).rows[0].emergency_confirmed === true, 'confirmation for the new location is recorded');
  // Moving the project again clears the confirmation
  await req('teacher', 'POST', `/projects/${path}/edit`, { cara_id: 1, name: 'Path to the ag plot', project_type: 'concreting', description: 'Excavate and pour a permanent concrete path for the school.', practice_type: 'Installation or work on a structure/site',
    loc_mode: 'change', room_id: '2', location_detail: 'Front oval', pera_ids: ['2'], edited_by: 'Teacher T', ...screen({ construction_work: 'Yes', excavation: 'Yes', services: 'Yes', mobile_plant: 'Yes' }),
    first_aid_kit_location: 'Ag plot shed', first_aid_person: 'Teacher T', emergency_confirmed: 'true', emergency_loc: '2|Agriculture plot' });
  ok((await db.query('SELECT emergency_confirmed FROM cara_projects WHERE id=$1', [path])).rows[0].emergency_confirmed === false, 'changing the project location again requires a fresh emergency confirmation');
  r = await req('teacher', 'POST', `/projects/${path}/submit`); ok(r.status === 400, 'project cannot be submitted until emergency arrangements are confirmed');

  // ===== H. Project equipment outside the parent CARA =====
  r = await req('teacher', 'GET', `/projects/${eng}/edit?stage=2`);
  r = await req('teacher', 'POST', `/projects/${eng}/edit`, { cara_id: 3, name: 'Steel hook rack', description: 'Cut, drill and weld a wall hook rack for students to take home.', practice_type: 'Making a product for use',
    loc_mode: 'parent', pera_ids: ['4', '1'], edited_by: 'Teacher T', ...screen({ construction_work: 'No', cutting: 'Yes', hot_work: 'Yes' }) });
  r = await req('teacher', 'GET', `/projects/${eng}/edit?stage=2`);
  ok(/not in (the )?CARA/i.test(r.text), 'stage 2 marks equipment that is not in the parent CARA');
  r = await req('teacher', 'GET', '/cara/3');
  ok(html(r.text).includes("Uses equipment not in the CARA's PERA list: Brick saw") && r.text.includes('Projects needing a CARA review'), 'parent CARA flagged for review; grouped as a projects item');

  // ===== I. Legacy practice values still display =====
  await db.query("UPDATE cara_projects SET practice_type='Permanent installation for use' WHERE id=$1", [sim]);
  r = await req('teacher', 'GET', `/projects/${sim}/edit?stage=1`);
  ok(r.status === 200 && (r.text.includes('value="Installation or work on a structure/site" selected') || r.text.includes('value="Installation or work on a structure/site" checked')), 'older "Permanent installation" value maps to the new installation option');

  // ===== J. Pages still load =====
  for (const p of ['/cara', '/admin/approvals', `/cara/${sm}`, `/cara/${hc}`, '/cara/new', `/projects/${eng}`]) {
    r = await req('admin', 'GET', p); ok(r.status === 200, `page loads: ${p}`, r.text.slice(0, 300));
  }
  r = await req('teacher', 'GET', `/cara/${un}/pdf`); ok(r.status === 200 && r.type === 'application/pdf', 'PDF renders for a CARA with no risk rating');

  const after = (await db.query('SELECT id, status, updated_at FROM cara_records WHERE id = 2')).rows[0];
  ok(JSON.stringify(after) === JSON.stringify(approvedBefore), 'unrelated approved CARA untouched');

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
