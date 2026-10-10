// With linked projects and SWMS screening switched off (default; the test
// server runs WITHOUT PROJECTS_ENABLED=1). Run on a freshly seeded database:
//   PROJECTS_ENABLED=0 <start server> ; node scripts/tests/no-projects.test.js
const crypto = require('crypto');
const { Client } = require('pg');
const rules = require('../../project-rules');
const BASE = process.env.TEST_BASE || 'http://localhost:3098';
const DB = process.env.TEST_DB || 'postgresql://postgres:testpass@127.0.0.1:5432/sg_proj';
const tok = (id) => { const p = `${id}.${Date.now() + 3600e3}`; return `${p}.${crypto.createHmac('sha256', 'testsecret').update(p).digest('hex')}`; };
const U = { admin: tok(1), approver: tok(2), teacher: tok(3) };
let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m, x ? `\n     ${String(x).slice(0, 500)}` : ''); } };
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const html = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
async function req(who, method, p, form) {
  const opts = { method, redirect: 'manual', headers: { Cookie: `staff_session=${U[who]}` } };
  if (form) { const q = new URLSearchParams(); for (const [k, v] of Object.entries(form)) [].concat(v).forEach((x) => q.append(k, x)); opts.body = q.toString(); opts.headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
  const r = await fetch(BASE + p, opts); const type = r.headers.get('content-type') || '';
  return { status: r.status, loc: r.headers.get('location'), text: type.includes('pdf') ? '' : await r.text(), type };
}
const nonConstruction = rules.QUESTIONS.filter((q) => q.key !== 'construction_work' && q.hideIfNo !== 'construction_work' && !['dry_cutting', 'engineered_stone', 'trench_1_5m', 'services_located'].includes(q.key));
const screen = () => ({ screening_fields: '1', ...Object.fromEntries(nonConstruction.map((q) => [`q_${q.key}`, 'No'])) });
const full = {
  cara_type_fields: '1', cara_type: 'general', no_equipment_field: '1', activity_name: 'Year 10 bench hook', class_unit: '10 IDT', year_level: 'Year 10', class_size: '20', course: 'Design and Technologies',
  room_id: '1', activity_brief: 'Students cut and glue a pine bench hook using tenon saws.', edited_by: 'Teacher T', submitted_by: 'Teacher T', tool_ids: ['3'],
  activity_scope: 'Students mark out, cut and glue a pine bench hook over two lessons using tenon saws and bench vices.',
  induction_instruction: 'Hand tool demonstration.', supervision_notes: 'Teacher present at all times; general supervision for hand tools.',
  supervisor_qualification: 'Qualified D&T teacher.', emergency_first_aid: 'Raise the alarm and call 000. Notify sick bay.',
  first_aid_kit_location: 'IDT workshop door', first_aid_person: 'Teacher T', emergency_confirmed: 'true', risk_level: 'Low', risk_basis: 'Hand tools only.',
};

(async () => {
  const db = new Client({ connectionString: DB }); await db.connect();
  // An existing project record (from before the switch) stays in the database.
  const pid = (await db.query("INSERT INTO cara_projects (cara_id, name, practice_type, created_by_staff_id) VALUES (1, 'Old project', 'Unsure', 3) RETURNING id")).rows[0].id;
  await db.query('INSERT INTO cara_project_peras (project_id, pera_id) VALUES ($1, 1)', [pid]);

  let r = await req('teacher', 'GET', '/cara/1');
  ok(r.status === 200 && !r.text.includes('Projects under this CARA') && !r.text.includes('Add project') && !/may go beyond this CARA/.test(r.text), 'CARA page has no projects section or project checks');
  r = await req('teacher', 'GET', '/cara/1/projects/new'); ok(r.status === 404 && r.text.includes('Projects are switched off'), 'adding a project is switched off');
  r = await req('teacher', 'GET', `/projects/${pid}`); ok(r.status === 404, 'project pages are switched off');
  r = await req('teacher', 'POST', '/cara/1/projects', { name: 'x' }); ok(r.status === 404, 'project routes refuse posts too');
  ok((await db.query('SELECT COUNT(*)::int n FROM cara_projects WHERE id=$1', [pid])).rows[0].n === 1, 'existing project records are kept');

  r = await req('teacher', 'GET', '/cara/new');
  const t = html(r.text);
  ok(!t.includes('construction-type work') && !t.includes('fall more than 2 metres') && !t.includes('digging or excavation'), 'no construction / SWMS screening questions');
  ok(t.includes('hazardous chemicals') && t.includes('lift or carry heavy'), 'general hazard questions are still asked');
  ok(!/SWMS/.test(t) && !/project/i.test(t.replace(/<script[\s\S]*?<\/script>/g, '').replace(/Does the project/g, '')), 'no SWMS or project wording on the new CARA form', (t.match(/.{40}(SWMS|[Pp]roject).{40}/) || [])[0]);

  // A full CARA without any construction answers can be submitted and approved.
  r = await req('teacher', 'POST', '/cara', { ...full, ...screen(), stage: '4', after: 'checks' });
  const id = Number(r.loc.match(/cara\/(\d+)/)[1]);
  r = await req('teacher', 'GET', `/cara/${id}`);
  ok(!html(r.text).includes('Hazard screening') && !/construction/i.test(html(r.text).split('id="full"')[0]), 'no construction screening items in the checks', (html(r.text).match(/.{60}(Hazard screening|construction).{60}/i) || [])[0]);
  r = await req('teacher', 'POST', `/cara/${id}/submit`, { teacher_signature: SIG }); ok(r.status === 302, 'CARA submits without construction answers');
  r = await req('approver', 'POST', `/cara/${id}/approve`, { approver: 'Approver B' });
  ok(r.status === 302 && (await db.query('SELECT status FROM cara_records WHERE id=$1', [id])).rows[0].status === 'Approved', 'CARA approves');
  r = await req('teacher', 'GET', `/cara/${id}/pdf?preview=html`);
  ok(!/SWMS|Linked projects/.test(r.text), 'PDF has no SWMS or projects section');

  // Earlier construction answers are kept (hidden), not deleted, on save.
  await db.query(`UPDATE cara_records SET screening = screening || '{"construction_work":"Yes","fall_2m":"Yes"}'::jsonb, status='Draft' WHERE id=$1`, [id]);
  await req('teacher', 'POST', `/cara/${id}/edit`, { ...full, ...screen(), q_chemicals: 'Yes', stage: '2' });
  const sc = (await db.query('SELECT screening FROM cara_records WHERE id=$1', [id])).rows[0].screening;
  ok(sc.construction_work === 'Yes' && sc.fall_2m === 'Yes' && sc.chemicals === 'Yes', 'hidden construction answers are kept when the CARA is saved', JSON.stringify(sc));
  r = await req('teacher', 'GET', `/cara/${id}`);
  ok(!/high risk construction work|SWMS/i.test(html(r.text)), 'kept construction answers do not create SWMS items');

  r = await req('admin', 'GET', '/admin/approvals');
  ok(r.status === 200 && !r.text.includes('Projects awaiting review') && !r.text.includes('href="#projects"'), 'approvals page has no projects section');
  r = await req('admin', 'GET', '/admin/content-review'); ok(r.status === 200 && !r.text.includes('href="/projects/'), 'content review lists CARAs only');
  for (const p of ['/cara', '/cara/3', '/cara/3/edit', '/cara/3/pdf?preview=html']) { r = await req('admin', 'GET', p); ok(r.status === 200, `page loads: ${p}`); }

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
