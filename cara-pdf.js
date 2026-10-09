// CARA PDF export rendered from a print-styled HTML page by headless Chromium
// (puppeteer-core). Gives proper tables, repeating table headers, clean page
// breaks and a page-numbered footer — far easier to style than hand-placed
// PDFKit drawing. server.js falls back to the old PDFKit export if Chromium
// isn't available (e.g. running outside Docker without it installed).

const fs = require('fs');
const path = require('path');

const SCHOOL_NAME = 'Faith Lutheran College — Plainland';

// Letterhead embedded as a data URI so the page never needs network access.
let LETTERHEAD_DATA_URI = null;
try {
  const buf = fs.readFileSync(path.join(__dirname, 'public', 'Letter Head.png'));
  LETTERHEAD_DATA_URI = `data:image/png;base64,${buf.toString('base64')}`;
} catch (e) {
  // Header falls back to the school name in text.
}

// ---------- Chromium (one shared browser, launched on first use) ----------

const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/opt/pw-browsers/chromium',
].filter(Boolean);

function findChromium() {
  for (const p of CHROMIUM_CANDIDATES) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch (e) { /* try next */ }
  }
  // Playwright-style install dirs, e.g. /opt/pw-browsers/chromium-1194/chrome-linux/chrome
  try {
    for (const d of fs.readdirSync('/opt/pw-browsers')) {
      const p = path.join('/opt/pw-browsers', d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  } catch (e) { /* none */ }
  return null;
}

let browserPromise = null;

async function getBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    if (b && b.connected) return b;
    browserPromise = null;
  }
  const executablePath = findChromium();
  if (!executablePath) throw new Error('Chromium not found (set CHROMIUM_PATH)');
  const puppeteer = require('puppeteer-core');
  browserPromise = puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'],
  });
  const b = await browserPromise.catch((e) => { browserPromise = null; throw e; });
  b.on('disconnected', () => { browserPromise = null; });
  return b;
}

async function htmlToPdf(html, { footerLeft = '' } = {}) {
  const browser = await getBrowser();
  const pg = await browser.newPage();
  try {
    // The page only ever needs inline content; refuse anything else.
    await pg.setJavaScriptEnabled(false);
    await pg.setRequestInterception(true);
    pg.on('request', (r) => (r.url().startsWith('data:') || r.url() === 'about:blank' ? r.continue() : r.abort()));
    await pg.setContent(html, { waitUntil: 'load', timeout: 20000 });
    return await pg.pdf({
      format: 'A4',
      landscape: true,
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `
        <div style="width:100%;font-family:Arial,Helvetica,sans-serif;font-size:7.5px;color:#6B6659;padding:0 12mm;display:flex;justify-content:space-between;">
          <span>${escapeHtml(footerLeft)}</span>
          <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
        </div>`,
      timeout: 30000,
    });
  } finally {
    await pg.close().catch(() => {});
  }
}

// ---------- HTML helpers ----------

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Brisbane' });
}

const BULLET_RE = /^\s*(?:[-•*–·]|\d+[.)])\s+/;

// Turns free text typed into the CARA form into paragraphs and real bullet
// lists: lines starting with "- ", "• ", "* " or "1." become list items, and
// an indented line straight after a bullet is treated as part of that bullet.
function richText(value, { columnsOver = 0 } = {}) {
  if (value == null || !String(value).trim()) return '<span class="empty">—</span>';
  const lines = String(value).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let list = null;
  let para = null;
  const flushList = () => {
    if (!list) return;
    const cls = columnsOver && list.length > columnsOver ? ' class="cols"' : '';
    out.push(`<ul${cls}>${list.map((li) => `<li>${li}</li>`).join('')}</ul>`);
    list = null;
  };
  const flushPara = () => {
    if (!para) return;
    out.push(`<p>${para.join('<br>')}</p>`);
    para = null;
  };
  for (const raw of lines) {
    if (!raw.trim()) { flushList(); flushPara(); continue; }
    if (BULLET_RE.test(raw)) {
      flushPara();
      if (!list) list = [];
      list.push(inlineMd(escapeHtml(raw.replace(BULLET_RE, '').trim())));
    } else if (list && /^\s{2,}/.test(raw)) {
      list[list.length - 1] += ' ' + inlineMd(escapeHtml(raw.trim()));
    } else {
      flushList();
      if (!para) para = [];
      // A short line ending in ":" (e.g. "Induction must cover:") is a
      // sub-heading for the list or text that follows, so show it in bold.
      const line = raw.trim();
      para.push(/:$/.test(line) && line.length <= 150 ? `<strong class="subhead">${escapeHtml(line)}</strong>` : inlineMd(escapeHtml(line)));
    }
  }
  flushList();
  flushPara();
  return out.join('');
}

// PERA names are stored as e.g. "Metal lathe — Plant & Equipment Risk
// Assessment"; the section heading already says that, so show just the tool.
function toolName(name) {
  return String(name || '').replace(/\s*[—–-]\s*(?:Plant\s*&\s*Equipment|Safe Operating)\s+Risk Assessment\s*$/i, '').trim() || String(name || '');
}

// Text saved before the AI was told "no markdown" may contain **bold**.
function inlineMd(escaped) {
  return escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function riskPill(level) {
  const cls = { Low: 'low', Medium: 'med', High: 'high', Extreme: 'ext' }[level] || 'med';
  return `<span class="pill risk-${cls}">${escapeHtml(level || '—')}</span>`;
}

function kvRows(rows) {
  return rows.map(([label, html]) => `<tr><th>${escapeHtml(label)}</th><td>${html}</td></tr>`).join('');
}

// ---------- Template ----------

const CSS = `
@page { size: A4 landscape; margin: 10mm 12mm 14mm 12mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: Arial, Helvetica, "Liberation Sans", sans-serif; font-size: 9.5pt; line-height: 1.35; color: #1a1a1a;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
p { margin: 0 0 4px; } p:last-child { margin-bottom: 0; }
ul { margin: 2px 0 4px; padding-left: 16px; } ul:last-child { margin-bottom: 0; }
li { margin: 0 0 2px; break-inside: avoid; }
ul.cols { columns: 2; column-gap: 24px; }
.empty { color: #9a9488; }
.subhead { color: #1B5E52; }

.header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-bottom: 6px; border-bottom: 2px solid #1B5E52; }
.header img { height: 20mm; width: auto; }
.header .school { font-size: 13pt; font-weight: bold; color: #1B5E52; }
.doc-id { text-align: right; font-size: 8pt; color: #6B6659; line-height: 1.5; }
.doc-id .type { font-size: 12pt; font-weight: bold; color: #1B5E52; letter-spacing: .3px; }

.titlebar { margin-top: 8px; background: #1B5E52; color: #fff; padding: 7px 10px; display: flex; justify-content: space-between; align-items: center; border-radius: 3px; }
.titlebar h1 { margin: 0; font-size: 14pt; }
.titlebar .sub { font-size: 9pt; opacity: .9; }

.notice { margin-top: 6px; padding: 5px 10px; border: 1px solid #E0B252; background: #FFF6E0; color: #6b4a00; font-size: 8.5pt; border-radius: 3px; }

table { width: 100%; border-collapse: collapse; }
th, td { border: 1px solid #D9D3C5; padding: 5px 7px; vertical-align: top; text-align: left; }
tr { break-inside: avoid; }
thead { display: table-header-group; }

.meta { margin-top: 8px; }
.meta th { background: #F2EFE8; color: #1B5E52; font-size: 8pt; text-transform: uppercase; letter-spacing: .3px; width: 1%; white-space: nowrap; }
.meta td { font-size: 9.5pt; }

h2 { font-size: 10.5pt; color: #fff; background: #3E7D71; margin: 12px 0 0; padding: 4px 8px; border-radius: 3px 3px 0 0; break-after: avoid; }
h2 + table, h2 + .box { border-top: none; }
.section { break-inside: auto; }
.box { border: 1px solid #D9D3C5; padding: 6px 8px; }

.kv th { width: 20%; background: #F7F5F1; color: #1B5E52; font-weight: bold; }

.hz thead th { background: #F2EFE8; color: #1B5E52; font-size: 8.5pt; text-transform: uppercase; letter-spacing: .3px; }
.hz td.cat { width: 15%; font-weight: bold; color: #1B5E52; background: #F7F5F1; }
.hz td.h { width: 40%; }
.hz td.c { width: 45%; }

.pera { columns: 3; column-gap: 20px; list-style: none; padding: 0; margin: 0; }
.pera li { padding: 2px 0; }

.pill { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 8pt; font-weight: bold; white-space: nowrap; }
.risk-low { background: #DCEFE2; color: #1d6b37; }
.risk-med { background: #FFF0C2; color: #7a5a00; }
.risk-high { background: #FFDCC2; color: #9a3b00; }
.risk-ext { background: #F8C9C9; color: #8f1111; }
.status { background: #E7E3DA; color: #3f3b33; }
.status-approved { background: #DCEFE2; color: #1d6b37; }

.sign th { background: #F2EFE8; color: #1B5E52; font-size: 8.5pt; text-transform: uppercase; letter-spacing: .3px; }
.sign td { height: 22mm; vertical-align: middle; }
.sign td.role { font-weight: bold; color: #1B5E52; width: 18%; }
.sign img { max-height: 18mm; max-width: 60mm; }
.sign .line { color: #9a9488; }

.yn td, .yn th { width: auto; }
.keep { break-inside: avoid; }
`;

function renderCaraHtml(r, peraRows, { brand = 'PracReady', generatedAt = new Date() } = {}) {
  const statusCls = r.status === 'Approved' ? 'status status-approved' : 'status';
  const ref = `CARA-${String(r.id).padStart(4, '0')}`;
  const yn = (v) => (v === true ? 'Yes' : v === false ? 'No' : '—');

  const header = `
    <div class="header">
      ${LETTERHEAD_DATA_URI ? `<img src="${LETTERHEAD_DATA_URI}" alt="">` : `<div class="school">${escapeHtml(SCHOOL_NAME)}</div>`}
      <div class="doc-id">
        <div class="type">Curriculum Activity Risk Assessment</div>
        <div>Ref ${escapeHtml(ref)} · Last updated ${escapeHtml(formatDate(r.updated_at))}</div>
      </div>
    </div>
    <div class="titlebar">
      <h1>${escapeHtml(r.activity_name || 'Untitled activity')}</h1>
      <div class="sub">${escapeHtml(SCHOOL_NAME)}</div>
    </div>`;

  const notice = r.status !== 'Approved'
    ? `<div class="notice"><b>Not yet approved.</b> Status: ${escapeHtml(r.status)}. This CARA must be approved before the activity runs.</div>`
    : '';

  const meta = `
    <table class="meta">
      <tr>
        <th>Class / unit</th><td>${escapeHtml(r.class_unit || '—')}</td>
        <th>Risk level</th><td>${riskPill(r.risk_level)}</td>
        <th>Status</th><td><span class="pill ${statusCls}">${escapeHtml(r.status)}</span></td>
        <th>Parent consent</th><td>${r.consent_required ? 'Required' : 'Not required'}</td>
        <th>Next review</th><td>${escapeHtml(formatDate(r.next_review_date))}</td>
      </tr>
    </table>`;

  const scope = `
    <div class="section">
      <h2>1. Activity scope</h2>
      <div class="box">${richText(r.activity_scope, { columnsOver: 6 })}</div>
    </div>`;

  const pera = `
    <div class="section keep">
      <h2>2. Plant &amp; equipment risk assessments (PERA) used</h2>
      <div class="box">${peraRows.length
        ? `<ul class="pera">${peraRows.map((t) => `<li>${riskPill(t.risk_level)} ${escapeHtml(toolName(t.activity_name))}</li>`).join('')}</ul>`
        : '<span class="empty">No PERAs linked.</span>'}</div>
    </div>`;

  const people = `
    <div class="section">
      <h2>3. Students, supervision &amp; preparation</h2>
      <table class="kv">${kvRows([
        ['Students', richText(r.students_notes)],
        ['Supervision', richText(r.supervision_notes)],
        ['Supervisor qualification', richText(r.supervisor_qualification)],
        ['Induction and instruction', richText(r.induction_instruction)],
        ['Facilities and equipment', richText(r.facilities_equipment)],
        ['Emergency and first aid', richText(r.emergency_first_aid)],
      ])}</table>
    </div>`;

  const hazards = `
    <div class="section">
      <h2>4. Hazards &amp; control measures</h2>
      <table class="hz">
        <thead><tr><th>Area</th><th>Hazards identified</th><th>Control measures</th></tr></thead>
        <tbody>
          <tr><td class="cat">Environment</td><td class="h">${richText(r.environmental_hazards)}</td><td class="c">${richText(r.environmental_controls)}</td></tr>
          <tr><td class="cat">Facilities &amp; equipment</td><td class="h">${richText(r.facilities_hazards)}</td><td class="c">${richText(r.facilities_controls)}</td></tr>
          <tr><td class="cat">Students</td><td class="h">${richText(r.student_hazards)}</td><td class="c">${richText(r.student_controls)}</td></tr>
        </tbody>
      </table>
    </div>`;

  let n = 5;
  let review = '';
  if (r.reviewed_at || r.review_notes) {
    const rows = [];
    if (r.reviewed_at) {
      rows.push(['Additional hazards identified', yn(r.monitoring_new_hazards)]);
      rows.push(['Control measures effective', yn(r.monitoring_controls_effective)]);
      rows.push(['Further action required', yn(r.monitoring_further_action)]);
      if (r.monitoring_details) rows.push(['Details', richText(r.monitoring_details)]);
      rows.push(['Last reviewed', escapeHtml(formatDate(r.reviewed_at))]);
    }
    if (r.review_notes) rows.push(['Review notes', richText(r.review_notes)]);
    review = `
      <div class="section keep">
        <h2>${n++}. Post-activity monitoring &amp; review</h2>
        <table class="kv">${kvRows(rows)}</table>
      </div>`;
  }

  const sigImg = r.teacher_signature && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(r.teacher_signature)
    ? `<img src="${r.teacher_signature}" alt="Signature">`
    : '<span class="line">No signature captured</span>';
  const approved = r.status === 'Approved';
  const signoff = `
    <div class="section keep">
      <h2>${n++}. Sign-off</h2>
      <table class="sign">
        <thead><tr><th>Role</th><th>Name</th><th>Signature</th><th>Date</th></tr></thead>
        <tbody>
          <tr><td class="role">Prepared by (teacher)</td><td>${escapeHtml(r.submitted_by || '—')}</td><td>${sigImg}</td><td>${escapeHtml(r.signed_at ? formatDate(r.signed_at) : '—')}</td></tr>
          <tr><td class="role">Approved by</td><td>${approved ? escapeHtml(r.approver || '—') : '<span class="line">Pending approval</span>'}</td>
              <td>${approved ? 'Approved electronically in ' + escapeHtml(brand) : ''}</td>
              <td>${approved ? escapeHtml(formatDate(r.approved_at)) : ''}</td></tr>
        </tbody>
      </table>
    </div>`;

  return `<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${escapeHtml(ref)} – ${escapeHtml(r.activity_name || '')}</title>
<style>${CSS}</style></head>
<body>
${header}
${notice}
${meta}
${scope}
${pera}
${people}
${hazards}
${review}
${signoff}
</body></html>`;
}

async function renderCaraPdf(r, peraRows, opts = {}) {
  const html = renderCaraHtml(r, peraRows, opts);
  const generated = (opts.generatedAt || new Date()).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });
  const footerLeft = `${opts.brand || 'PracReady'} · CARA-${String(r.id).padStart(4, '0')} ${r.activity_name || ''} · Generated ${generated}`;
  return htmlToPdf(html, { footerLeft });
}

module.exports = { renderCaraHtml, renderCaraPdf, findChromium };
