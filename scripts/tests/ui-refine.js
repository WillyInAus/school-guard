// Browser checks for the stage refinements, plus screenshots.
//   SHOTS=/path node scripts/tests/ui-refine.js   (local test server only)
const crypto = require('crypto');
const puppeteer = require('puppeteer-core');
const { Client } = require('pg');
const BASE = process.env.TEST_BASE || 'http://localhost:3098';
const DB = process.env.TEST_DB || 'postgresql://postgres:testpass@127.0.0.1:5432/sg_proj';
const SHOTS = process.env.SHOTS || '/tmp/shots';
const tok = (id) => { const p = `${id}.${Date.now() + 3600e3}`; return `${p}.${crypto.createHmac('sha256', 'testsecret').update(p).digest('hex')}`; };
let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m, x !== undefined ? `\n     ${JSON.stringify(x).slice(0, 400)}` : ''); } };

(async () => {
  const db = new Client({ connectionString: DB }); await db.connect();
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setCookie({ name: 'staff_session', value: tok(3), url: BASE });
  const shot = (n, full = true) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: full });
  const click = (sel) => page.$eval(sel, (e) => e.click());
  const visible = (sel) => page.$eval(sel, (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length)).catch(() => false);
  const todos = () => page.$$eval('[data-todo]', (els) => els.map((e) => e.textContent.trim()));
  const radio = (k, v) => page.$eval(`input[name="q_${k}"][value="${v}"]`, (e) => e.click());

  // New form: status, not counts
  await page.goto(`${BASE}/cara/new`, { waitUntil: 'networkidle0' });
  let t = await todos();
  ok(t.every((x) => /Not started|In progress|Ready/.test(x)) && !t.some((x) => /\d/.test(x)), 'new form progress shows status, not counts', t);
  ok(await page.$eval('section[data-stage="2"]', (s) => s.inert && s.hidden), 'hidden stages are inert');
  // Keyboard: Tab through the page; focus never lands in a hidden stage
  let leaked = false;
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(() => !!(document.activeElement && document.activeElement.closest('.stage[hidden]')))) { leaked = true; break; }
  }
  ok(!leaked, 'keyboard navigation skips hidden stages');
  await shot('r1-stage1-new');
  await click('input[name="cara_type"][value="general"]');
  await page.type('#activity_name', 'Year 9 sheet-metal toolbox');
  t = await todos();
  ok(t[0].includes('In progress'), 'stage 1 becomes "In progress" once started', t);
  await click('#stage_next');
  ok(await page.evaluate(() => document.activeElement && document.activeElement.id === 'stage2_h'), 'focus moves to the stage heading after Next');

  // Progressive screening
  ok(!(await visible('#q_fall_2m')) && !(await visible('#q_excavation')), 'construction follow-ups hidden before the work-type answer');
  ok(await visible('#q_chemicals') && await visible('#q_heights_any'), 'general hazard questions visible');
  await radio('construction_work', 'Yes');
  ok(await visible('#q_fall_2m') && await visible('#q_excavation'), '"Yes" reveals construction follow-ups');
  await shot('r2-stage2-construction-yes');
  await radio('fall_2m', 'Yes');
  await radio('construction_work', 'No');
  ok(!(await visible('#q_fall_2m')), '"No" hides them again');
  ok(await page.$eval('input[name="q_fall_2m"][value="Yes"]', (e) => e.checked), 'the hidden answer is kept, not deleted');
  await radio('construction_work', 'Unsure');
  ok(await visible('#q_fall_2m') && await visible('#q_construction_work .prj-unsure-note'), '"Unsure" shows the follow-ups and stays visibly unresolved');
  await radio('construction_work', 'No');

  // AI readiness
  await click('#stage_next');
  ok(await page.$eval('#ai_draft_btn', (b) => b.disabled), 'Generate draft is disabled until minimum inputs are given');
  const msg = await page.$eval('#ai_draft_ready', (e) => e.textContent);
  ok(/what students will actually do/.test(msg) && /tools and equipment/.test(msg) && /fill in the sections yourself/.test(msg), 'message names the missing inputs and keeps manual drafting', msg);
  ok(!(await page.$eval('#activity_scope', (e) => e.disabled)), 'manual fields stay available');
  await shot('r3-stage3-ai-not-ready');
  await page.$eval('#ai_draft_ready a[href="#activity_brief"]', (a) => a.click());
  ok(await page.$eval('section[data-stage="1"]', (s) => !s.hidden) && await page.evaluate(() => document.activeElement.id === 'activity_brief'), 'readiness link opens stage 1 at the description');
  await page.type('#activity_brief', 'Students mark out, cut and fold a sheet-metal toolbox.');
  await click('.stage-btn[data-go="2"]');
  await click('#no_equipment');
  await click('.stage-btn[data-go="3"]');
  ok(!(await page.$eval('#ai_draft_btn', (b) => b.disabled)), 'ticking "No tools or equipment" with a description enables Generate draft');

  // Stage 4: Save draft and run checks
  await click('.stage-btn[data-go="4"]');
  ok(await page.$eval('#stage_check', (b) => !b.hidden && b.classList.contains('btn-primary') && /run checks/.test(b.textContent)), 'stage 4 primary action is "Save draft and run checks"');
  ok(await page.$eval('#risk_basis', (e) => !/Highest equipment rating/.test(e.placeholder)), 'risk basis example does not anchor to equipment');
  await shot('r4-stage4-before-checks');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), click('#stage_check')]);
  ok(/edit\?stage=4&checked=1#checks$/.test(page.url()), 'checks run and return to stage 4', page.url());
  ok(await page.$eval('section[data-stage="4"]', (s) => !s.hidden), 'stage 4 shown with results');
  t = await todos();
  ok(t.some((x) => /to fix/.test(x)), 'after checks, stages show items to fix', t);
  await shot('r5-stage4-checks');
  const id = Number(page.url().match(/cara\/(\d+)/)[1]);
  // Follow an issue link, change something, come back
  await page.$eval('#chk_teacher a[href="#supervision_notes"]', (a) => a.click());
  ok(await page.$eval('section[data-stage="3"]', (s) => !s.hidden) && await page.evaluate(() => document.activeElement.id === 'supervision_notes'), 'issue link opens the right stage and field');
  await page.type('#supervision_notes', 'Teacher present at all times.');
  await click('.stage-btn[data-go="4"]');
  ok(await page.$eval('#checks_note', (e) => /changed something/.test(e.textContent)), 'stage 4 says the checks are out of date after a change');
  ok(await page.$eval('#supervision_notes', (e) => e.value) === 'Teacher present at all times.', 'returning to stage 4 keeps what was typed');

  // Complete everything, run checks, sign and submit in stage 4
  await db.query(`UPDATE cara_records SET class_unit='9 IDT', year_level='Year 9', class_size=22, course='Design and Technologies', room_id=1,
    activity_scope='Students mark out, cut, fold and rivet a small sheet-metal toolbox over three lessons.', induction_instruction='Workshop induction and demonstration.',
    supervision_notes='Teacher present at all times; direct supervision for the guillotine.', supervisor_qualification='Qualified D&T teacher.',
    emergency_first_aid='Raise the alarm and call 000. Notify sick bay.', first_aid_kit_location='IDT workshop door', first_aid_person='Teacher T', emergency_confirmed=true,
    risk_level='Medium', risk_basis='Sharp edges; unlikely with gloves and deburring, minor if it happens.', screening='{"construction_work":"No","chemicals":"No","manual_handling":"No","heights_any":"No","confined_space":"No","atmosphere":"No","water":"No","temperature":"No","sharp_edges":"No","noise":"No"}'::jsonb
    WHERE id=$1`, [id]);
  await page.goto(`${BASE}/cara/${id}/edit?stage=4`, { waitUntil: 'networkidle0' });
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), click('#stage_check')]);
  const ready = await page.$('#cara_submit_form_btn');
  ok(!!ready, 'when nothing is left to fix, stage 4 offers sign and submit', await page.$eval('#checks', (e) => e.parentElement.innerText.slice(0, 600)).catch(() => ''));
  if (ready) {
    ok(await page.$eval('#stage_check', (b) => b.classList.contains('btn-secondary')), 'one primary action: Submit (run checks becomes secondary)');
    await page.$eval('#cara_submit_form_pad', (c) => c.scrollIntoView());
    await shot('r6-stage4-ready');
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => null), click('#cara_submit_form_btn')]);
    ok(await page.$eval('#cara_submit_form_msg', (e) => /sign/.test(e.textContent)).catch(() => false), 'submitting without signing shows an inline message (no browser alert)');
    const box = await (await page.$('#cara_submit_form_pad')).boundingBox();
    await page.mouse.move(box.x + 20, box.y + 40); await page.mouse.down(); await page.mouse.move(box.x + 120, box.y + 80, { steps: 5 }); await page.mouse.up();
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), click('#cara_submit_form_btn')]);
    ok((await db.query('SELECT status FROM cara_records WHERE id=$1', [id])).rows[0].status === 'Pending approval', 'signed and submitted from stage 4');
  }

  // Overview (blocked example with unapproved equipment)
  const blocked = (await db.query("SELECT id FROM cara_records WHERE activity_name='Scroll saw puzzles' LIMIT 1")).rows[0];
  if (blocked) { await page.goto(`${BASE}/cara/${blocked.id}`, { waitUntil: 'networkidle0' }); await shot('r7-overview-blocked'); }
  // Mobile
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(`${BASE}/cara/${id}/edit?stage=2`, { waitUntil: 'networkidle0' });
  ok(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'no horizontal scroll at phone width');
  await shot('r8-mobile-stage2');

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
