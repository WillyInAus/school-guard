// Refinements to the four-stage CARA workflow: progress status, progressive
// screening, AI readiness, checks and submission in stage 4, single
// equipment list, risk guidance and labels. Same local setup as
// cara-projects.test.js; run on a freshly seeded database.
const crypto = require('crypto');
const { Client } = require('pg');
const rules = require('../../project-rules');
const BASE = process.env.TEST_BASE || 'http://localhost:3098';
const DB = process.env.TEST_DB || 'postgresql://postgres:testpass@127.0.0.1:5432/sg_proj';
const tok = (id) => { const p = `${id}.${Date.now() + 3600e3}`; return `${p}.${crypto.createHmac('sha256', 'testsecret').update(p).digest('hex')}`; };
const U = { admin: tok(1), approver: tok(2), teacher: tok(3), other: tok(4) };
let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m, x ? `\n     ${String(x).slice(0, 700)}` : ''); } };
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const html = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const idOf = (r) => Number(String(r.loc || '').match(/\/cara\/(\d+)/)[1]);
async function req(who, method, p, form) {
  const opts = { method, redirect: 'manual', headers: { Cookie: `staff_session=${U[who]}` } };
  if (form) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) [].concat(v).forEach((x) => q.append(k, x));
    opts.body = q.toString(); opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  const r = await fetch(BASE + p, opts);
  const type = r.headers.get('content-type') || '';
  return { status: r.status, loc: r.headers.get('location'), text: type.includes('pdf') ? '' : await r.text(), type };
}
const screen = (over = {}) => ({ screening_fields: '1', ...Object.fromEntries(Object.entries(over).map(([k, v]) => [`q_${k}`, v])) });
const base = {
  cara_type_fields: '1', cara_type: 'general', no_equipment_field: '1', activity_name: 'Year 10 bench hook', class_unit: '10 IDT', year_level: 'Year 10', class_size: '20', course: 'Design and Technologies',
  room_id: '1', activity_brief: 'Students cut and glue a pine bench hook using tenon saws and a bench vice.', edited_by: 'Teacher T', submitted_by: 'Teacher T',
};
const complete = {
  activity_scope: 'Students mark out, cut and glue a pine bench hook over two lessons using tenon saws and bench vices.',
  induction_instruction: 'Hand tool demonstration and workshop induction before use.', supervision_notes: 'Teacher present in the workshop at all times; general supervision for hand tools.',
  supervisor_qualification: 'Qualified Design and Technologies teacher.', emergency_first_aid: 'Raise the alarm and call 000 in an emergency. Notify sick bay.',
  first_aid_kit_location: 'IDT workshop by the door', first_aid_person: 'Teacher T', emergency_confirmed: 'true', risk_level: 'Low', risk_basis: 'Hand tools only; cuts unlikely with clamping and supervision and would need first aid at most.',
};
const allNo = () => Object.fromEntries(rules.QUESTIONS.map((q) => [q.key, 'No']));

(async () => {
  const db = new Client({ connectionString: DB }); await db.connect();
  const approvedBefore = (await db.query('SELECT id, status, updated_at FROM cara_records WHERE id = 2')).rows[0];

  // ===== 1. New form: simple status, no counts =====
  let r = await req('teacher', 'GET', '/cara/new');
  ok(!/\d+ to (do|fix)/.test(r.text.replace(/<script[\s\S]*?<\/script>/g, '')) && r.text.includes('data-server=""'), 'new form shows no issue counts before checks are run');
  ok(r.text.includes('class="req-mark"') && r.text.includes('needed before you can submit'), 'mandatory fields are marked');
  ok(r.text.includes('<option value="">Select a location</option>') && r.text.includes('<option value="other">Other location</option>'), 'location defaults to "Select a location", with a separate "Other location"');
  ok(r.text.includes('Does the activity involve building') && !r.text.includes('Does the project involve'), 'CARA screening asks about "the activity"');
  ok(/data-stage="2"[^>]*hidden inert/.test(r.text) && /data-stage="4"[^>]*hidden inert/.test(r.text), 'hidden stages are inert (no keyboard focus)');
  ok(r.text.includes('tabindex="-1">1. Describe the activity'), 'stage headings can take focus after navigation');
  r = await req('teacher', 'GET', '/cara/1/projects/new');
  ok(r.text.includes('Does the project involve building'), 'project screening keeps "the project"');

  // ===== 2. Progressive screening =====
  const vis = (a) => rules.visibleQuestions(a).map((q) => q.key);
  ok(!vis({}).includes('fall_2m') && !vis({}).includes('excavation') && vis({}).includes('construction_work'), 'construction follow-ups hidden until the work-type question is answered');
  ok(!vis({ construction_work: 'No' }).includes('fall_2m'), '"No" keeps construction follow-ups hidden');
  ok(vis({ construction_work: 'Yes' }).includes('fall_2m') && vis({ construction_work: 'Unsure' }).includes('fall_2m'), '"Yes" or "Unsure" reveals construction follow-ups');
  ok(['chemicals', 'manual_handling', 'heights_any', 'confined_space', 'atmosphere'].every((k) => vis({ construction_work: 'No' }).includes(k)), 'general hazard questions stay available whatever the construction answer');
  ok(!vis({ construction_work: 'Unsure', cutting: 'No' }).includes('dry_cutting') && vis({ construction_work: 'Unsure', cutting: 'Yes' }).includes('dry_cutting'), 'follow-ups chain from their parent answer');
  let ev = rules.evaluate({ answers: {}, description: 'x' });
  ok(ev.unanswered.some((q) => q.key === 'construction_work'), 'unanswered work-type question is required, never treated as "No"');
  ev = rules.evaluate({ answers: { construction_work: 'Unsure' }, description: 'x' });
  ok(ev.unsure.some((q) => q.key === 'construction_work') && ev.unanswered.some((q) => q.key === 'fall_2m'), '"Unsure" stays unresolved and still requires the follow-ups');

  r = await req('teacher', 'POST', '/cara', { ...base, tool_ids: ['3'], ...screen({ construction_work: 'Yes', fall_2m: 'Yes' }), stage: '2' });
  const c1 = idOf(r);
  r = await req('teacher', 'GET', `/cara/${c1}`);
  ok(html(r.text).includes('falling more than 2 metres') || html(r.text).includes('more than 2 m'), 'Yes to construction + fall over 2 m flags the trigger for the reviewer');
  await req('teacher', 'POST', `/cara/${c1}/edit`, { ...base, tool_ids: ['3'], ...screen({ ...allNo(), construction_work: 'No', fall_2m: 'Yes' }), stage: '2' });
  let row = (await db.query('SELECT screening FROM cara_records WHERE id=$1', [c1])).rows[0];
  ok(row.screening.fall_2m === 'Yes' && row.screening.construction_work === 'No', 'changing an earlier answer keeps the hidden follow-up answer (not deleted)');
  r = await req('teacher', 'GET', `/cara/${c1}`);
  ok(!/falling more than 2 metres/.test(html(r.text)), 'with construction "No", the hidden follow-up no longer creates a trigger');
  await req('teacher', 'POST', `/cara/${c1}/edit`, { ...base, tool_ids: ['3'], ...screen({ ...allNo(), construction_work: 'Yes', fall_2m: 'Yes' }), stage: '2' });
  r = await req('teacher', 'GET', `/cara/${c1}`);
  ok(/falling more than 2 metres|more than 2 m/.test(html(r.text)), 'switching back to "Yes" recalculates the trigger');
  r = await req('teacher', 'POST', '/cara', { ...base, activity_name: 'Gate unanswered', tool_ids: ['3'], ...screen({}), stage: '2' });
  r = await req('teacher', 'GET', `/cara/${idOf(r)}`);
  ok(html(r.text).includes('answer whether the activity involves construction-type work') && r.text.includes('edit#q_construction_work'), 'unanswered gate gives one clear item that links to the question');

  // ===== 3. AI readiness =====
  r = await req('teacher', 'POST', '/cara/ai/draft', { activity_name: 'Empty' });
  let d = JSON.parse(r.text);
  ok(r.status === 400 && !d.ok && d.missing.length === 3 && /what students will actually do/.test(d.error) && /tools and equipment/.test(d.error), 'server refuses a draft without minimum inputs and names what is missing', r.text);
  r = await req('teacher', 'POST', '/cara/ai/draft', { ...base, no_equipment: 'true', ...screen({ construction_work: 'No' }) });
  d = JSON.parse(r.text);
  ok(d.ok, 'an activity with "No tools or equipment are used" can be drafted', r.text);
  r = await req('teacher', 'GET', `/cara/${c1}/edit?stage=3`);
  ok(r.text.includes('id="ai_draft_ready"') && r.text.includes('Activity scope'), 'stage 3 shows the readiness message area and the manual fields');

  // ===== 4. No-equipment choice =====
  r = await req('teacher', 'POST', '/cara', { ...base, activity_name: 'Design sketching', activity_brief: 'Students sketch design ideas on paper at their desks.', no_equipment: 'true', ...screen({ ...allNo() }), stage: '2' });
  const ne = idOf(r);
  ok((await db.query('SELECT no_equipment FROM cara_records WHERE id=$1', [ne])).rows[0].no_equipment === true, '"No tools or equipment" is saved');
  r = await req('teacher', 'GET', `/cara/${ne}`);
  ok(!html(r.text).includes('Tools and equipment: select what is used'), 'no-equipment activity is not asked for equipment');
  await req('teacher', 'POST', `/cara/${ne}/edit`, { ...base, activity_name: 'Design sketching', no_equipment: 'true', tool_ids: ['3'], ...screen({ ...allNo() }), stage: '2' });
  ok((await db.query('SELECT no_equipment FROM cara_records WHERE id=$1', [ne])).rows[0].no_equipment === false, 'selecting equipment clears "No tools or equipment"');
  r = await req('teacher', 'POST', '/cara', { ...base, activity_name: 'Nothing chosen', ...screen({ ...allNo() }), stage: '2' });
  r = await req('teacher', 'GET', `/cara/${idOf(r)}`);
  ok(html(r.text).includes('Tools and equipment: select what is used, or tick "No tools or equipment are used"'), 'neither equipment nor the no-equipment choice is a teacher item');

  // ===== 5. Checks and submission in stage 4 =====
  r = await req('teacher', 'POST', '/cara', { ...base, activity_name: 'Bench hook — checks', tool_ids: ['3'], ...screen({ ...allNo() }), stage: '4', after: 'checks' });
  const ck = idOf(r);
  ok(/\/cara\/\d+\/edit\?stage=4&checked=1#checks$/.test(r.loc), '"Save draft and run checks" returns to stage 4 with the checks', r.loc);
  r = await req('teacher', 'GET', `/cara/${ck}/edit?stage=4&checked=1`);
  let t = html(r.text);
  ok(t.includes('Draft saved and checked') && t.includes('id="stage_input" value="4"') && t.includes('Details to complete'), 'checks are shown grouped within stage 4');
  ok(/<a href="#activity_scope">/.test(t) && /<a href="#supervision_notes">/.test(t) && !/href="\/cara\/\d+\/edit#/.test(t.split('id="checks"')[1] || ''), 'issue links stay on the form and point to the field');
  ok(t.includes("Can't submit yet:") && !t.includes('id="cara_submit_form_pad"'), 'submission is not offered while items are open');
  ok(/data-server="[1-9]/.test(t), 'after checks, stages show the number of items to fix');
  ok((await db.query('SELECT status FROM cara_records WHERE id=$1', [ck])).rows[0].status === 'Draft', 'saving and checking does not submit');
  r = await req('teacher', 'POST', `/cara/${ck}/submit`, { teacher_signature: SIG });
  ok(r.status === 400 && html(r.text).includes('Activity scope'), 'server refuses submission while required information is unresolved', r.text);
  r = await req('teacher', 'POST', `/cara/${ck}/edit`, { ...base, activity_name: 'Bench hook — checks', tool_ids: ['3'], ...screen({ ...allNo() }), ...complete, stage: '4', after: 'checks' });
  r = await req('teacher', 'GET', `/cara/${ck}/edit?stage=4&checked=1`);
  t = html(r.text);
  ok(t.includes('Ready to submit.') && t.includes('id="cara_submit_form" method="post" action="/cara/' + ck + '/submit"') && t.includes('id="cara_submit_form_btn"'), 'when eligible, sign and submit within stage 4', t.match(/id="checks"[\s\S]{0,1500}/));
  ok(t.includes('not approved until a reviewer approves it'), 'submitting is clearly not approval');
  r = await req('other', 'POST', `/cara/${ck}/submit`, { teacher_signature: SIG });
  ok(r.status === 403, 'another teacher cannot submit it');
  r = await req('teacher', 'POST', `/cara/${ck}/submit`, { teacher_signature: SIG });
  ok(r.status === 302 && (await db.query('SELECT status FROM cara_records WHERE id=$1', [ck])).rows[0].status === 'Pending approval', 'teacher submits from stage 4');
  r = await req('teacher', 'POST', `/cara/${ck}/submit`, { teacher_signature: SIG });
  ok(r.status === 400, 'an already submitted CARA cannot be submitted again');

  // ===== 5b. Reviewer decision: approve or send back =====
  r = await req('approver', 'GET', `/cara/${ck}`);
  t = html(r.text);
  ok(t.includes('class="review-decision"') && t.includes('Send back for more work') && t.includes(`action="/cara/${ck}/approve"`) && !/<button type="submit" class="btn btn-primary" disabled>Approve/.test(t), 'reviewer sees Approve and Send back side by side');
  ok(!t.includes('style="width:100%;">Approve'), 'Approve button is not full width');
  r = await req('teacher', 'GET', `/cara/${ck}`);
  t = html(r.text);
  ok(t.includes('Waiting for approval') && !t.includes(`action="/cara/${ck}/approve"`), 'teacher sees "Waiting for approval", not the reviewer buttons');
  r = await req('approver', 'POST', `/cara/${ck}/reject`, { review_notes: '' });
  ok(r.status === 400, 'sending back needs a note');
  r = await req('approver', 'POST', `/cara/${ck}/reject`, { review_notes: 'Add the guillotine supervision ratio.' });
  ok(r.status === 302 && (await db.query('SELECT status FROM cara_records WHERE id=$1', [ck])).rows[0].status === 'Changes requested', 'reviewer sends it back for more work');
  r = await req('teacher', 'GET', `/cara/${ck}`);
  t = html(r.text);
  ok(t.includes('Sent back for changes:') && t.includes('Add the guillotine supervision ratio.') && t.includes(`href="/cara/${ck}/edit"`), 'teacher sees the reviewer notes and a link to make the changes');
  await req('teacher', 'POST', `/cara/${ck}/edit`, { ...base, activity_name: 'Bench hook — checks', tool_ids: ['3'], ...screen({ ...allNo() }), ...complete, supervision_notes: 'Teacher present at all times; 1:10 ratio at the guillotine.', stage: '4', after: 'checks' });
  ok((await db.query('SELECT status FROM cara_records WHERE id=$1', [ck])).rows[0].status === 'Draft', 'editing after it was sent back returns it to Draft');
  r = await req('teacher', 'POST', `/cara/${ck}/submit`, { teacher_signature: SIG });
  ok(r.status === 302 && (await db.query('SELECT status FROM cara_records WHERE id=$1', [ck])).rows[0].status === 'Pending approval', 'teacher resubmits');
  r = await req('approver', 'GET', '/cara/3');
  ok(!html(r.text).includes('<h3>Optional AI review</h3>\n        </div>\n      </div>'), 'no empty AI review box');

  // ===== 6. Equipment warnings once =====
  const draftPera = (await db.query("INSERT INTO pera_records (activity_name,class_unit,risk_level,status,supervision_level) VALUES ('Scroll saw — Plant & Equipment Risk Assessment','Woodwork','Medium','Draft','Direct supervision') RETURNING id")).rows[0].id;
  r = await req('teacher', 'POST', '/cara', { ...base, activity_name: 'Scroll saw puzzles', tool_ids: [String(draftPera)], ...screen({ ...allNo() }), ...complete, stage: '4' });
  const eq = idOf(r);
  r = await req('teacher', 'GET', `/cara/${eq}`);
  t = html(r.text);
  const top = t.split('id="full"')[0];
  ok((top.match(/Scroll saw" is not approved/g) || []).length === 1 && !top.includes('These PERAs need'), 'the unapproved equipment is listed once on the overview', (top.match(/.{60}Scroll saw.{60}/g) || []).join('\n'));
  ok(top.includes('Waiting for equipment approval') === false || top.includes('href="#chk_equipment"'), 'review section links to the equipment group');
  ok(top.includes("Can't submit yet:") && top.includes('href="#chk_equipment"') && top.includes('needs an authorised approver, not you'), 'submission-blocked message links to the approver group; teacher and approver tasks separate');
  ok(!top.includes('Automatic checks'), 'no second, separate list of automatic checks on the overview');

  // ===== 7. Risk guidance (Queensland Department of Education levels) =====
  r = await req('teacher', 'GET', `/cara/${eq}/edit?stage=4`);
  t = html(r.text);
  ok(t.includes('Queensland Department of Education risk levels') && t.includes('<strong>inherent</strong> risk') && t.includes('Some chance of an incident occurring which would result in an injury requiring first aid.') && t.includes('managing-risks-in-school-curriculum-activities-procedure'), 'stage 4 shows the DoE risk levels, rated on inherent risk, with the source');
  ok(t.includes('Activity risk level (inherent, before controls)') && t.includes('Risk remaining with controls (optional)') && t.includes('does not change the approval requirement'), 'inherent and residual risk are clearly separate; inherent drives approval');
  ok(t.includes('inform the review but do not set this rating') && !t.includes('Highest equipment rating is High'), 'equipment ratings do not set the activity rating');
  ok(t.includes('Medium: the HOD, HOSES or HOC must give documented approval'), 'approval requirements follow the DoE procedure');
  await req('teacher', 'POST', `/cara/${eq}/edit`, { ...base, activity_name: 'Scroll saw puzzles', tool_ids: [String(draftPera)], ...screen({ ...allNo() }), ...complete, risk_level: 'Extreme', residual_risk: 'Medium', consent_required: 'false', stage: '4' });
  r = await req('teacher', 'GET', `/cara/${eq}`);
  t = html(r.text);
  ok(t.includes('Extreme risk: parent/carer consent is mandatory') && t.includes('Risk remaining with controls:</strong> Medium'), 'Extreme without consent is blocked; residual risk shown to the reviewer');
  ok((await db.query('SELECT residual_risk FROM cara_records WHERE id=$1', [eq])).rows[0].residual_risk === 'Medium', 'residual risk saved');
  await req('teacher', 'POST', `/cara/${eq}/edit`, { ...base, activity_name: 'Scroll saw puzzles', tool_ids: [String(draftPera)], ...screen({ ...allNo() }), ...complete, risk_level: 'Low', residual_risk: 'High', stage: '4' });
  r = await req('teacher', 'GET', `/cara/${eq}`);
  ok(html(r.text).includes('higher than the inherent risk'), 'a residual risk above the inherent risk is flagged');
  r = await req('teacher', 'GET', `/cara/${eq}/pdf?preview=html`);
  ok(r.text.includes('Activity risk (inherent)') && r.text.includes('With controls: High'), 'PDF labels inherent risk and shows the risk with controls');

  // ===== 8. Existing records =====
  for (const p of ['/cara/3', '/cara/3/edit', '/cara/3/edit?stage=4&checked=1', '/cara', '/admin/approvals']) { r = await req('admin', 'GET', p); ok(r.status === 200, `existing pages load: ${p}`); }
  const after = (await db.query('SELECT id, status, updated_at FROM cara_records WHERE id = 2')).rows[0];
  ok(JSON.stringify(after) === JSON.stringify(approvedBefore), 'unrelated approved CARA untouched');

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
