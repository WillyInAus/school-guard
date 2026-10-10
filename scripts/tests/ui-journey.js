// Browser check of the staged CARA form: Back/Next keep what was typed, Save
// draft keeps the stage, and screenshots of each stage and the overview.
// Needs the local test server (see cara-projects.test.js) and Chromium.
//   SHOTS=/path node scripts/tests/ui-journey.js
const crypto = require('crypto');
const puppeteer = require('puppeteer-core');
const { Client } = require('pg');
const BASE = process.env.TEST_BASE || 'http://localhost:3098';
const DB = process.env.TEST_DB || 'postgresql://postgres:testpass@127.0.0.1:5432/sg_proj';
const SHOTS = process.env.SHOTS || '/tmp/shots';
const tok = (id) => { const p = `${id}.${Date.now() + 3600e3}`; return `${p}.${crypto.createHmac('sha256', 'testsecret').update(p).digest('hex')}`; };
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m); } };

(async () => {
  const db = new Client({ connectionString: DB }); await db.connect();
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setCookie({ name: 'staff_session', value: tok(3), url: BASE });
  const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });
  const val = (id) => page.$eval(`#${id}`, (e) => e.value);
  const click = (sel) => page.$eval(sel, (e) => e.click());

  await page.goto(`${BASE}/cara/new`, { waitUntil: 'networkidle0' });
  await click('input[name="cara_type"][value="general"]');
  await page.type('#activity_name', 'Year 9 sheet-metal toolbox');
  await page.type('#year_level', 'Year 9');
  await page.type('#activity_brief', 'Students mark out, cut with tin snips and the guillotine, fold on the pan brake and rivet a small toolbox.');
  await shot('cara-1-describe');
  await click('#stage_next');
  ok(await page.$eval('section[data-stage="2"]', (s) => !s.hidden), 'Next shows stage 2');
  await page.$$eval('input[name="tool_ids"]', (els) => els[0] && els[0].click());
  await page.type('#materials', '0.8 mm galvanised sheet, pop rivets');
  await page.$$eval('input[name="q_construction_work"][value="No"]', (els) => els[0].click());
  await page.evaluate(() => window.screeningRefresh && window.screeningRefresh());
  await shot('cara-2-select');
  await click('#stage_back');
  ok(await page.$eval('section[data-stage="1"]', (s) => !s.hidden), 'Back shows stage 1');
  ok((await val('activity_name')) === 'Year 9 sheet-metal toolbox' && (await val('activity_brief')).startsWith('Students mark out'), 'Back keeps stage 1 values');
  await click('#stage_next');
  ok((await val('materials')) === '0.8 mm galvanised sheet, pop rivets', 'returning to stage 2 keeps materials');
  await click('#stage_next');
  await shot('cara-3-draft');
  await click('#stage_next');
  await shot('cara-4-check');
  await click('.stage-btn[data-go="2"]');
  ok(await page.$eval('section[data-stage="2"]', (s) => !s.hidden), 'progress indicator jumps straight to a stage');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), click('#stage_save')]);
  ok(/\/cara\/\d+\/edit\?stage=2&saved=1/.test(page.url()), 'Save draft returns to the current stage');
  const id = Number(page.url().match(/cara\/(\d+)/)[1]);
  const row = (await db.query('SELECT activity_name, activity_brief, materials, screening, year_level FROM cara_records WHERE id=$1', [id])).rows[0];
  ok(row.activity_name === 'Year 9 sheet-metal toolbox' && row.year_level === 'Year 9' && row.materials.includes('pop rivets') && row.screening.construction_work === 'No', 'everything typed across stages was saved');
  ok(await page.$eval('section[data-stage="2"]', (s) => !s.hidden) && (await val('materials')).includes('pop rivets'), 'resumed at stage 2 with values');
  // Issue link jumps to the right stage
  await page.goto(`${BASE}/cara/${id}/edit#supervision_notes`, { waitUntil: 'networkidle0' });
  ok(await page.$eval('section[data-stage="3"]', (s) => !s.hidden), 'an issue link to a field opens the stage that holds it');

  // Overviews
  for (const [n, p] of [['overview-draft', `/cara/${id}`], ['overview-construction', '/cara/1'], ['overview-vet-eng', '/cara/3']]) {
    await page.goto(BASE + p, { waitUntil: 'networkidle0' }); await shot(n);
  }
  // Mobile
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(`${BASE}/cara/${id}/edit?stage=1`, { waitUntil: 'networkidle0' }); await shot('mobile-cara-1');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  ok(!overflow, 'no horizontal scroll at phone width');
  await page.setViewport({ width: 1280, height: 900 });

  // Project stages
  const pid = (await db.query("SELECT id FROM cara_projects WHERE status <> 'Archived' ORDER BY id LIMIT 1")).rows[0];
  await page.goto(`${BASE}/cara/1/projects/new`, { waitUntil: 'networkidle0' });
  await page.type('#name', 'Practice brick wall');
  await page.type('#description', 'Lay a practice brick wall to 600 mm that is taken down afterwards.');
  await shot('project-1-describe');
  await click('#stage_next'); await shot('project-2-equipment');
  await click('#stage_next'); await shot('project-3-draft');
  await click('#stage_next'); await shot('project-4-check');
  await click('#stage_back'); await click('#stage_back'); await click('#stage_back');
  ok((await val('name')) === 'Practice brick wall', 'project Back keeps the name');
  if (pid) { await page.goto(`${BASE}/projects/${pid.id}`, { waitUntil: 'networkidle0' }); await shot('project-detail'); }

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
