// Browser check: placeholders like [confirm: ...] are easy to find.
// Local test server only (see cara-projects.test.js).
const crypto = require('crypto');
const puppeteer = require('puppeteer-core');
const { Client } = require('pg');
const BASE = process.env.TEST_BASE || 'http://localhost:3098';
const DB = process.env.TEST_DB || 'postgresql://postgres:testpass@127.0.0.1:5432/sg_proj';
const SHOTS = process.env.SHOTS || '/tmp/shots';
const tok = (id) => { const p = `${id}.${Date.now() + 3600e3}`; return `${p}.${crypto.createHmac('sha256', 'testsecret').update(p).digest('hex')}`; };
let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m, x !== undefined ? JSON.stringify(x) : ''); } };

(async () => {
  const db = new Client({ connectionString: DB }); await db.connect();
  const long = 'Line one about the room.\n'.repeat(12);
  const id = (await db.query(`INSERT INTO cara_records (activity_name, class_unit, status, created_by_staff_id, cara_type, students_notes, facilities_equipment, supervisor_qualification)
    VALUES ('Placeholder test', '9 IDT', 'Draft', 3, 'general', 'Record incidents in the [school system] within 24 hours.', $1, 'Approved by [confirm: HOD/Deputy Principal].') RETURNING id`,
    [`${long}Eyewash: [Confirm: location of eyewash station]. Kit: [confirm: location of first aid kit].`])).rows[0].id;
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  await page.setCookie({ name: 'staff_session', value: tok(3), url: BASE });

  // From the overview checks list
  await page.goto(`${BASE}/cara/${id}`, { waitUntil: 'networkidle0' });
  const href = await page.$eval('a[href*="#facilities_equipment"]', (a) => a.getAttribute('href'));
  ok(href.includes('?find=') && href.endsWith('#facilities_equipment'), 'overview issue link says which placeholder to find', href);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.$eval('a[href*="#facilities_equipment"]', (a) => a.click())]);
  await new Promise((r) => setTimeout(r, 400));
  let sel = await page.evaluate(() => { const t = document.activeElement; return { name: t.name, text: t.value.slice(t.selectionStart, t.selectionEnd), top: t.scrollTop }; });
  ok(sel.name === 'facilities_equipment' && sel.text === '[Confirm: location of eyewash station]', 'opening the link selects the placeholder in the box', sel);
  ok(sel.top > 0, 'a long box scrolls to the placeholder', sel);
  await page.screenshot({ path: `${SHOTS}/ph-found.png` });
  // Hint chips under each box
  const hints = await page.$$eval('.ph-hint', (els) => els.map((e) => e.dataset.for + ': ' + [...e.querySelectorAll('.ph-chip')].map((b) => b.textContent).join(' | ')));
  ok(hints.some((h) => h.startsWith('students_notes: [school system]')) && hints.some((h) => h.includes('[confirm: location of first aid kit]')) && hints.some((h) => h.startsWith('supervisor_qualification')), 'each box lists the placeholders still in it', hints);
  await page.$eval('.ph-hint[data-for="students_notes"] .ph-chip', (b) => b.click());
  sel = await page.evaluate(() => { const t = document.activeElement; return t.value.slice(t.selectionStart, t.selectionEnd); });
  ok(sel === '[school system]', 'clicking a chip selects that placeholder', sel);
  await page.keyboard.type('Compass incident register');
  ok(!(await page.$('.ph-hint[data-for="students_notes"]')), 'replacing the placeholder removes its hint');
  ok(!(await page.$$eval('.ph-hint', (els) => els.some((e) => /AS\/NZS/.test(e.textContent)))), 'real references are not listed');

  // Formatted (read) view of a box highlights its placeholders
  await page.goto(`${BASE}/cara/${id}/edit?stage=3`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 300));
  const marks = await page.$$eval('.pretty-view .ph-mark', (els) => els.map((e) => e.textContent));
  ok(marks.includes('[Confirm: location of eyewash station]') && marks.includes('[confirm: HOD/Deputy Principal]'), 'placeholders are highlighted in the formatted view', marks);
  await page.$eval('#supervisor_qualification', (e) => e.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: `${SHOTS}/ph-highlight.png` });

  // From the checks inside step 4
  await page.goto(`${BASE}/cara/${id}/edit?stage=4&checked=1`, { waitUntil: 'networkidle0' });
  await page.$eval('#chk_teacher a[href="#supervisor_qualification"]', (a) => a.click());
  await new Promise((r) => setTimeout(r, 300));
  sel = await page.evaluate(() => { const t = document.activeElement; return { name: t.name, text: t.value.slice(t.selectionStart, t.selectionEnd) }; });
  ok(sel.name === 'supervisor_qualification' && sel.text === '[confirm: HOD/Deputy Principal]', 'step 4 issue link selects the placeholder', sel);

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
