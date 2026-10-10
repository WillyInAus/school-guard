// Layout check for the CARA and project pages at laptop and phone sizes.
// Takes screenshots and reports form width, horizontal overflow, clipped or
// overlapping controls, and whether the sticky action bar hides content.
//   OUT=/dir LABEL=before node scripts/tests/layout-shots.js
// Needs the local test server (see cara-projects.test.js) with the journeys
// data loaded (run journeys.test.js first).
const crypto = require('crypto');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { Client } = require('pg');
const BASE = process.env.TEST_BASE || 'http://localhost:3098';
const DB = process.env.TEST_DB || 'postgresql://postgres:testpass@127.0.0.1:5432/sg_proj';
const OUT = process.env.OUT || '/tmp/layout';
const LABEL = process.env.LABEL || 'after';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
fs.mkdirSync(OUT, { recursive: true });
const tok = (id) => { const p = `${id}.${Date.now() + 3600e3}`; return `${p}.${crypto.createHmac('sha256', 'testsecret').update(p).digest('hex')}`; };

// zoom 1.25 = browser zoom 125%: CSS viewport shrinks, pixels scale up.
const SIZES = [
  { name: '1366x768', w: 1366, h: 768, zoom: 1 },
  { name: '1440x900', w: 1440, h: 900, zoom: 1 },
  { name: '1366x768-125', w: 1366, h: 768, zoom: 1.25 },
  { name: '1440x900-125', w: 1440, h: 900, zoom: 1.25 },
  { name: 'mobile-390', w: 390, h: 844, zoom: 1, mobile: true },
];

let problems = 0;
const report = [];

(async () => {
  const db = new Client({ connectionString: DB }); await db.connect();
  const cara = (await db.query("SELECT id FROM cara_records WHERE cara_type='vet' AND archived=false ORDER BY id LIMIT 1")).rows[0].id;
  const prj = (await db.query("SELECT id, cara_id FROM cara_projects WHERE status <> 'Archived' ORDER BY id LIMIT 1")).rows[0];
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setCookie({ name: 'staff_session', value: tok(1), url: BASE });

  const PAGES = [
    { key: 'cara-s1', url: `/cara/${cara}/edit?stage=1` },
    { key: 'cara-s2', url: `/cara/${cara}/edit?stage=2`, prep: async () => { await page.evaluate(() => { const g = document.querySelector('.tool-picker-group'); if (g) g.open = true; const y = document.querySelector('input[name="q_construction_work"][value="Yes"]'); if (y) y.click(); }); } },
    { key: 'cara-s3', url: `/cara/${cara}/edit?stage=3` },
    { key: 'cara-s4', url: `/cara/${cara}/edit?stage=4&checked=1` },
    { key: 'cara-overview', url: `/cara/${cara}` },
    { key: 'prj-s1', url: `/projects/${prj.id}/edit?stage=1` },
    { key: 'prj-s2', url: `/projects/${prj.id}/edit?stage=2` },
    { key: 'prj-s3', url: `/projects/${prj.id}/edit?stage=3` },
    { key: 'prj-s4', url: `/projects/${prj.id}/edit?stage=4` },
    { key: 'prj-overview', url: `/projects/${prj.id}` },
  ];

  for (const s of SIZES) {
    if (ONLY && !ONLY.includes(s.name)) continue;
    await page.setViewport({ width: Math.round(s.w / s.zoom), height: Math.round(s.h / s.zoom), deviceScaleFactor: s.zoom, isMobile: !!s.mobile, hasTouch: !!s.mobile });
    for (const p of PAGES) {
      await page.goto(BASE + p.url, { waitUntil: 'networkidle0' });
      if (p.prep) await p.prep();
      await new Promise((r) => setTimeout(r, 150));
      const m = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const form = document.querySelector('form.cara-stages') || document.querySelector('.ws-page') || document.querySelector('.content > *:not(script)');
        const fr = form ? form.getBoundingClientRect() : null;
        const content = document.querySelector('.content').getBoundingClientRect();
        // Visible controls/text that stick out past the viewport or their card.
        const clipped = [];
        document.querySelectorAll('input, select, textarea, button, .btn, .stage-btn, .chk-list a, .badge, label').forEach((el) => {
          if (!el.offsetParent || el.closest('[hidden]')) return;
          const r = el.getBoundingClientRect();
          if (r.width && (r.right > vw + 1 || r.left < -1)) clipped.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} ${Math.round(r.left)}–${Math.round(r.right)}`);
        });
        // Progress buttons: label wrapped onto more than 2 lines?
        const navWrap = [...document.querySelectorAll('.stage-btn')].map((b) => {
          const lh = parseFloat(getComputedStyle(b).lineHeight) || 18;
          const lbl = b.querySelector('.stage-lbl') || b;
          return Math.round((lbl.getBoundingClientRect().height) / lh);
        });
        // Overlapping sibling fields within grids
        const overlaps = [];
        document.querySelectorAll('.cohort-grid, .hz-grid, .stage-bar').forEach((g) => {
          const kids = [...g.children].filter((k) => k.offsetParent && getComputedStyle(k).display !== 'none');
          for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
            const a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
            if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps.push(`${g.className}: ${i}/${j}`);
          }
        });
        // Sticky bar must not hide the field that has focus after scrolling
        // to the last input in the visible stage.
        let barHides = false;
        const bar = document.querySelector('.stage-bar');
        const vis = document.querySelector('.stage:not([hidden])');
        if (bar && vis) {
          const ins = [...vis.querySelectorAll('input:not([type=hidden]), textarea, select')].filter((x) => x.offsetParent);
          const last = ins[ins.length - 1];
          if (last) {
            last.focus();
            const lr = last.getBoundingClientRect(), br = bar.getBoundingClientRect();
            const nav = document.querySelector('.bottom-nav');
            const navTop = nav && getComputedStyle(nav).display !== 'none' ? nav.getBoundingClientRect().top : Infinity;
            barHides = (lr.bottom > br.top + 1 && lr.top < br.bottom) || br.bottom > navTop + 1 || br.bottom > window.innerHeight + 1;
          }
        }
        return {
          vw, scrollW: document.documentElement.scrollWidth, formW: fr ? Math.round(fr.width) : null,
          leftMargin: fr ? Math.round(fr.left - content.left) : null, rightMargin: fr ? Math.round(vw - fr.right) : null,
          clipped: clipped.slice(0, 6), navLines: navWrap, overlaps: overlaps.slice(0, 4), barHides,
        };
      });
      const issues = [];
      if (m.scrollW > m.vw + 1) issues.push(`horizontal scroll (${m.scrollW} > ${m.vw})`);
      if (m.clipped.length) issues.push(`clipped: ${m.clipped.join(', ')}`);
      if (m.overlaps.length) issues.push(`overlap: ${m.overlaps.join(', ')}`);
      if (m.barHides) issues.push('action bar hides the focused field or is off-screen');
      if (m.navLines.some((n) => n > 3)) issues.push(`progress labels wrap to ${Math.max(...m.navLines)} lines`);
      problems += issues.length;
      report.push(`${LABEL} ${s.name.padEnd(13)} ${p.key.padEnd(14)} form ${String(m.formW).padStart(4)}px  margins ${m.leftMargin}/${m.rightMargin}  nav lines [${m.navLines.join(',')}]  ${issues.length ? 'ISSUES: ' + issues.join('; ') : 'ok'}`);
      await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); window.scrollTo(0, 0); });
      await page.screenshot({ path: `${OUT}/${LABEL}-${s.name}-${p.key}.png`, fullPage: false });
    }
  }
  console.log(report.join('\n'));
  console.log(`\n${problems} layout issue(s)`);
  await browser.close(); await db.end();
})().catch((e) => { console.error(e); process.exit(1); });
