// End-to-end checks for CARA projects. Needs a seeded Postgres test DB, scripts/tests/mock-anthropic.js on :4010,
// and the app on :3098 started with ANTHROPIC_API_KEY=test ANTHROPIC_BASE_URL=http://127.0.0.1:4010 SESSION_SECRET=testsecret.
// Seed data: see the pull request description.
// End-to-end checks for CARA projects against the local test server.
const crypto = require('crypto');
const fs = require('fs');
const { Client } = require('pg');
const BASE = 'http://localhost:3098';
const tok = (id) => { const p = `${id}.${Date.now() + 3600e3}`; return `${p}.${crypto.createHmac('sha256', 'testsecret').update(p).digest('hex')}`; };
const U = { admin: tok(1), approver: tok(2), teacher: tok(3), other: tok(4) };
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('PASS', msg); } else { fail++; console.log('FAIL', msg); } };

async function req(who, method, path, form) {
  const opts = { method, redirect: 'manual', headers: { Cookie: `staff_session=${U[who]}` } };
  if (form) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) [].concat(v).forEach((x) => p.append(k, x));
    opts.body = p.toString(); opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  const r = await fetch(BASE + path, opts);
  const text = r.headers.get('content-type') && r.headers.get('content-type').includes('pdf') ? '' : await r.text();
  return { status: r.status, loc: r.headers.get('location'), text, type: r.headers.get('content-type') };
}

const allNo = () => {
  const qs = ['cutting', 'chemicals', 'manual_handling', 'fall_2m', 'heights_any', 'excavation', 'services', 'mobile_plant', 'traffic', 'structural', 'asbestos', 'tilt_up', 'confined_space', 'atmosphere', 'water', 'temperature', 'other_listed'];
  return Object.fromEntries(qs.map((q) => [`q_${q}`, 'No']));
};

(async () => {
  const db = new Client({ connectionString: 'postgresql://postgres:testpass@127.0.0.1:5432/sg_proj' }); await db.connect();
  const before = (await db.query('SELECT id, status, updated_at FROM cara_records ORDER BY id')).rows;

  // --- Multiple projects on one CARA
  let r = await req('teacher', 'GET', '/cara/1/projects/new');
  ok(r.status === 200 && r.text.includes('name="q_cutting"') && r.text.includes('Generate project draft'), 'teacher can open Add project form (questions + AI button shown)');
  ok(!r.text.includes('SECRET-STUDENT-XYZ'), 'project form does not show the CARA Students notes');
  r = await req('other', 'GET', '/cara/1/projects/new');
  ok(r.status === 403, 'another submitter cannot add a project to someone else\'s CARA');

  const brick = { cara_id: 1, name: 'Brick and block laying', project_type: 'brick_block', description: 'Practice wall', practice_type: 'Temporary educational practice',
    room_id: 2, pera_ids: ['1', '3'], edited_by: 'Teacher T', in_cara_scope: 'Unsure', q_cutting: 'Yes', q_dry_cutting: 'Unsure', q_engineered_stone: 'No',
    work_steps_json: JSON.stringify([{ step: 'Set out wall', hazards: 'Trips', controls: 'Housekeeping' }]) };
  r = await req('teacher', 'POST', '/cara/1/projects', brick);
  ok(r.status === 302 && /\/projects\/\d+$/.test(r.loc), 'create project 1 (brick)');
  const p1 = Number(r.loc.split('/').pop());
  r = await req('teacher', 'POST', '/cara/1/projects', { cara_id: 1, name: 'Sawhorse', project_type: 'sawhorse', practice_type: 'Temporary educational practice', pera_ids: ['3'], in_cara_scope: 'Yes', edited_by: 'Teacher T', ...allNo() });
  const p2 = Number(r.loc.split('/').pop());
  r = await req('teacher', 'POST', '/cara/1/projects', { cara_id: 1, name: 'Concreting', project_type: 'concreting', practice_type: 'Unsure', pera_ids: ['2'], edited_by: 'Teacher T' });
  const p3 = Number(r.loc.split('/').pop());
  const cnt = (await db.query('SELECT COUNT(*)::int n FROM cara_projects WHERE cara_id=1')).rows[0].n;
  ok(cnt === 3, `three projects linked to one CARA (got ${cnt})`);

  r = await req('teacher', 'GET', '/cara/1');
  ok(r.text.includes('Projects under this CARA') && r.text.includes('Brick and block laying') && r.text.includes('Sawhorse') && r.text.includes('Concreting'), 'CARA page lists all projects');
  ok(r.text.includes('CARA needs review') && r.text.includes("Uses equipment not in the CARA&#39;s PERA list: Brick saw"), 'CARA flagged: project uses equipment outside the CARA');
  ok(r.text.includes('Possible high risk construction work'), 'CARA flagged: possible high risk construction work from the project');
  ok(r.text.includes('Not yet confirmed that the CARA scope describes this project'), 'linking a project does not imply the CARA covers it (Unsure scope flagged)');

  // --- Shared PERA controls
  r = await req('teacher', 'GET', `/projects/${p1}`);
  ok(r.text.includes('Controls from the PERAs') && r.text.includes('Wet cutting only; P2 respirator'), 'project shows controls shared from its PERAs');
  ok(r.text.includes('Not in CARA'), 'project marks PERAs that are not in the parent CARA');

  // --- Conditional questions & unresolved classification
  ok(r.text.includes('critical questions unanswered') || r.text.includes('critical question unanswered'), 'unanswered critical questions are flagged');
  ok(r.text.includes('Unsure'), 'Unsure answers are shown');
  ok(r.text.includes('Work carried out in an area that may have a contaminated or flammable atmosphere'), 'dry cutting "Unsure" flags the contaminated atmosphere (silica) trigger');
  ok(r.text.includes('Not yet confirmed by a reviewer') && r.text.includes('worksafe.qld.gov.au'), 'trigger shows source link and needs reviewer confirmation');
  ok(r.text.includes('<strong>Needs review</strong>'), 'activity classification stays "Needs review" by default');
  r = await req('teacher', 'POST', `/projects/${p1}/submit`);
  ok(r.status === 400, 'cannot submit while critical questions are unanswered');
  // Hidden follow-up question is not required when parent is No
  r = await req('teacher', 'GET', `/projects/${p2}`);
  ok(!r.text.includes('Could any of that cutting or grinding be done DRY'), 'follow-up question hidden when the parent question is No');

  // --- AI drafting: Students excluded, nothing overwritten
  fs.writeFileSync('/tmp/ai-requests.log', '');
  const aiForm = { ...brick, scope_exclusions: 'TEACHER WROTE THIS', ppe: 'Teacher PPE text', students_notes: 'SHOULD-NOT-BE-SENT-EITHER' };
  r = await req('teacher', 'POST', '/projects/ai/draft', aiForm);
  const d = JSON.parse(r.text);
  ok(d.ok && d.suggestions.work_steps.length === 2 && d.suggestions.ppe, 'AI draft returns suggestions');
  ok(!d.suggestions.scope_exclusions.includes('**'), 'AI suggestions are stripped of markdown');
  ok(d.suggestions.open_questions.includes('Missing information:') && d.suggestions.open_questions.includes('Assumptions:'), 'missing information and assumptions are listed for the teacher');
  ok(d.suggestions.cara_change_proposal === 'Add brick saw to CARA PERAs.', 'AI CARA change is only a suggestion');
  const sent = fs.readFileSync('/tmp/ai-requests.log', 'utf8');
  ok(sent.includes('Practice wall') && sent.includes('Wet cutting only'), 'AI request includes project details and PERA controls');
  ok(!sent.includes('SECRET-STUDENT-XYZ') && !sent.includes('SHOULD-NOT-BE-SENT-EITHER') && !sent.includes('J. Smith'), 'AI request contains no Students information (CARA notes or posted field)');
  const row = (await db.query('SELECT scope_exclusions, ppe FROM cara_projects WHERE id=$1', [p1])).rows[0];
  ok(row.scope_exclusions === null && row.ppe === null, 'AI draft does not write anything to the project');
  r = await req('other', 'POST', '/projects/ai/draft', aiForm);
  ok(r.status === 403, 'AI draft refused for a CARA the user cannot edit');

  // --- Complete project 1, submit, review, approve
  const full = { ...brick, ...allNo(), q_cutting: 'Yes', q_dry_cutting: 'No', q_engineered_stone: 'No', q_mobile_plant: 'Yes', in_cara_scope: 'Yes',
    first_aid_kit_location: 'Outdoor area shed', first_aid_person: 'Teacher T', emergency_confirmed: 'true', doc_purpose: 'SWMS for training/assessment',
    scope_exclusions: 'Practice wall only' };
  r = await req('teacher', 'POST', `/projects/${p1}/edit`, full);
  ok(r.status === 302, 'teacher completes project 1');
  r = await req('teacher', 'POST', `/projects/${p1}/submit`);
  ok(r.status === 302, 'teacher submits project 1 for review');
  r = await req('teacher', 'POST', `/projects/${p1}/approve`, { approver: 'Teacher T' });
  ok(r.status === 403, 'submitter cannot approve');
  r = await req('approver', 'POST', `/projects/${p1}/approve`, { approver: 'Approver B' });
  ok(r.status === 400 && r.text.includes('Confirm whether each possible high risk construction work trigger applies'), 'approval blocked until trigger (mobile plant) is confirmed');
  r = await req('teacher', 'POST', `/projects/${p1}/trigger`, { trigger: 'mobile_plant', decision: 'Does not apply', note: 'x' });
  ok(r.status === 403, 'submitter cannot record trigger decisions');
  r = await req('approver', 'POST', `/projects/${p1}/trigger`, { trigger: 'mobile_plant', decision: 'Does not apply', note: 'Mixer is stationary; no mobile plant in area during class' });
  r = await req('approver', 'POST', `/projects/${p1}/approve`, { approver: 'Approver B' });
  ok(r.status === 400 && r.text.includes('activity classification'), 'approval blocked while classification is "Needs review"');
  await req('approver', 'POST', `/projects/${p1}/classify`, { activity_class: 'Educational practice / simulation', doc_purpose: 'SWMS for training/assessment', note: 'Temporary practice wall' });
  r = await req('approver', 'POST', `/projects/${p1}/approve`, { approver: 'Approver B' });
  ok(r.status === 302, 'approver approves project 1 after confirmations');
  let pr = (await db.query('SELECT status, version, approver, approved_at FROM cara_projects WHERE id=$1', [p1])).rows[0];
  ok(pr.status === 'Approved' && pr.version === 1 && pr.approver === 'Approver B' && pr.approved_at, 'reviewer, date and version recorded');

  // --- Material change after approval
  r = await req('teacher', 'POST', `/projects/${p1}/edit`, { ...full, ppe: 'Added hearing protection' });
  pr = (await db.query('SELECT status, version FROM cara_projects WHERE id=$1', [p1])).rows[0];
  ok(pr.status === 'Draft' && pr.version === 2, 'change after approval returns to Draft as version 2');
  const vers = (await db.query('SELECT version, superseded_at FROM cara_project_versions WHERE project_id=$1', [p1])).rows;
  ok(vers.length === 1 && vers[0].version === 1, 'approved version 1 snapshot retained');
  // Changing a supporting answer invalidates the earlier trigger confirmation
  await req('teacher', 'POST', `/projects/${p1}/edit`, { ...full, ppe: 'Added hearing protection', q_traffic: 'Yes' });
  await req('teacher', 'POST', `/projects/${p1}/submit`);
  r = await req('approver', 'POST', `/projects/${p1}/approve`, { approver: 'Approver B' });
  ok(r.status === 400, 'new trigger (traffic) must be confirmed before re-approval');
  await req('approver', 'POST', `/projects/${p1}/trigger`, { trigger: 'traffic_corridor', decision: 'Does not apply', note: 'Fenced area, no vehicles' });
  r = await req('approver', 'POST', `/projects/${p1}/approve`, { approver: 'Approver B' });
  const vers2 = (await db.query('SELECT version, superseded_at FROM cara_project_versions WHERE project_id=$1 ORDER BY version', [p1])).rows;
  ok(r.status === 302 && vers2.length === 2 && vers2[0].superseded_at && !vers2[1].superseded_at, 'version 2 approved; version 1 marked superseded and kept');
  // Edit answers so the mobile plant basis changes -> confirmation becomes stale
  const tr = (await db.query('SELECT trigger_reviews FROM cara_projects WHERE id=$1', [p1])).rows[0].trigger_reviews;
  ok(tr.mobile_plant && tr.mobile_plant.by === 'Approver B', 'trigger confirmation records reviewer');

  // --- Request changes path & permissions
  await req('teacher', 'POST', `/projects/${p2}/edit`, { cara_id: 1, name: 'Sawhorse', project_type: 'sawhorse', practice_type: 'Temporary educational practice', pera_ids: ['3'], in_cara_scope: 'Yes', edited_by: 'Teacher T', ...allNo(), first_aid_kit_location: 'Workshop wall by door', first_aid_person: 'T', emergency_confirmed: 'true' });
  r = await req('teacher', 'POST', `/projects/${p2}/submit`);
  ok(r.status === 302, 'project 2 submitted');
  r = await req('admin', 'GET', '/admin/approvals');
  ok(r.text.includes('Projects awaiting review') && r.text.includes('Sawhorse'), 'approvals queue lists project awaiting review');
  r = await req('approver', 'POST', `/projects/${p2}/request-changes`, { review_notes: 'Add clamping step' });
  pr = (await db.query('SELECT status, review_notes FROM cara_projects WHERE id=$1', [p2])).rows[0];
  ok(pr.status === 'Draft' && pr.review_notes === 'Add clamping step', 'request changes returns project to Draft with notes');
  r = await req('other', 'POST', `/projects/${p2}/edit`, { cara_id: 1, name: 'Hacked', edited_by: 'O' });
  ok(r.status === 403, 'another submitter cannot edit the project');

  // --- CARA review flag cleared and re-raised
  r = await req('teacher', 'POST', `/projects/${p1}/cara-reviewed`);
  ok(r.status === 302, 'CARA owner records CARA reviewed for project 1');
  r = await req('teacher', 'GET', '/cara/1');
  const flagBox = r.text.includes('CARA needs review') ? r.text.split('CARA needs review')[1].split('prj-table-wrap')[0] : '';
  ok(!flagBox.includes('href="/projects/' + p1 + '"'), 'project 1 no longer flagged after review recorded');
  await req('teacher', 'POST', `/projects/${p1}/edit`, { ...full, ppe: 'Added hearing protection', q_traffic: 'Yes', q_water: 'Yes' });
  r = await req('teacher', 'GET', '/cara/1');
  ok(r.text.includes('drowning'), 'new risk outside the reviewed scope re-flags the CARA');
  const log = (await db.query("SELECT summary FROM cara_change_log WHERE cara_id=1 AND brief='Reviewed for project'")).rows;
  ok(log.length === 1, 'CARA review recorded in the CARA change history');

  // --- Exports
  r = await req('teacher', 'GET', `/projects/${p3}/pdf?preview=html`);
  ok(r.text.includes('DRAFT — NOT APPROVED') && r.text.includes('Generating this document does not mean it is approved or legally compliant'), 'draft export clearly labelled as draft');
  ok(r.text.includes('CARA-0001') && r.text.includes('Outstanding questions'), 'export includes parent CARA reference and outstanding questions');
  r = await req('teacher', 'GET', `/projects/${p1}/pdf?version=1&preview=html`);
  ok(r.text.includes('superseded') && r.text.includes('not a certification of legal compliance'), 'old approved version exportable, labelled superseded, no compliance claim');
  r = await req('teacher', 'GET', `/projects/${p1}/pdf`);
  ok(r.status === 200 && r.type === 'application/pdf', 'project PDF renders');
  r = await req('teacher', 'GET', '/cara/1/pdf?preview=html');
  ok(r.text.includes('Linked projects') && r.text.includes('PRJ-'), 'CARA PDF lists linked projects');

  // --- Existing approved records untouched
  const after = (await db.query('SELECT id, status, updated_at FROM cara_records ORDER BY id')).rows;
  ok(JSON.stringify(after) === JSON.stringify(before), 'existing CARA records unchanged by project work');

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
