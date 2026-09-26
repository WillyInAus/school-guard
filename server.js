const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { pool, migrate } = require('./db');
const { page, escapeHtml } = require('./views/layout');

// Faith Lutheran College — Plainland letterhead, shown at the top of CARA PDF
// exports (see GET /cara/:id/pdf below). Read once at startup; if the file
// isn't there for some reason, the PDF export falls back to plain text
// instead of failing.
const LETTERHEAD_PATH = path.join(__dirname, 'public', 'Letter Head.png');
let LETTERHEAD_BUFFER = null;
try {
  LETTERHEAD_BUFFER = fs.readFileSync(LETTERHEAD_PATH);
} catch (e) {
  console.warn('Letterhead image not found at', LETTERHEAD_PATH, '— CARA PDFs will use a plain text header instead.');
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.static('public'));

const RISK_LEVELS = ['Low', 'Medium', 'High', 'Extreme'];
const STATUSES = ['Draft', 'Pending approval', 'Approved', 'Changes requested'];

// ---------- Admin auth (shared password) ----------

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_TOKEN = crypto.createHash('sha256').update(`school-guard-admin:${ADMIN_PASSWORD}`).digest('hex');

function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  const parts = header.split(';').map((c) => c.trim());
  const found = parts.find((c) => c.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : null;
}

function requireAdmin(req, res, next) {
  if (ADMIN_PASSWORD && getCookie(req, 'admin_token') === ADMIN_TOKEN) {
    return next();
  }
  res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
}

function riskBadgeClass(level) {
  return {
    Low: 'badge-low',
    Medium: 'badge-medium',
    High: 'badge-high',
    Extreme: 'badge-extreme',
  }[level] || 'badge-draft';
}

function statusBadgeClass(status) {
  return {
    'Draft': 'badge-draft',
    'Pending approval': 'badge-pending',
    'Approved': 'badge-approved',
    'Changes requested': 'badge-changes',
  }[status] || 'badge-draft';
}

function approvalRequirement(riskLevel) {
  if (riskLevel === 'High' || riskLevel === 'Extreme') {
    return 'High and extreme risk activities require principal approval before students may proceed.';
  }
  if (riskLevel === 'Medium') {
    return 'Medium risk activities require HOD or deputy principal approval.';
  }
  return 'Low risk activities do not require additional approval beyond the supervising teacher.';
}

function caraApprovalRequirement(riskLevel) {
  if (riskLevel === 'Extreme') {
    return 'Extreme risk: consider an alternative or modified activity. This CARA must be completed and approved by the principal before proceeding, and parent/carer consent is required.';
  }
  if (riskLevel === 'High') {
    return 'High risk: complete this CARA and obtain approval from the principal or a school leader (DP/HOD/HOSES) before proceeding. Parent/carer consent is highly recommended.';
  }
  if (riskLevel === 'Medium') {
    return 'Medium risk: a CARA record is recommended to document the activity, hazards and control measures.';
  }
  return 'Low risk: document risks and controls as part of your normal unit/lesson planning.';
}

function formatDate(d) {
  if (!d) return '—';
  const date = new Date(d);
  return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Used for the change history tree on a CARA, where each entry needs both a
// date and a time (unlike formatDate, which is date-only). Recorded
// automatically from cara_change_log.changed_at whenever a change is saved.
function formatDateTime(d) {
  if (!d) return '—';
  const date = new Date(d);
  const datePart = date.toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const timePart = date.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${datePart} – ${timePart}`;
}

// Reduces a full field-by-field change summary (as stored in
// cara_change_log.summary, one "Label: old -> new" line per changed field)
// down to a short one-line label for the collapsed row in the change history
// tree. The full summary is still shown in full once the entry is expanded.
// Builds the short one-line label shown in the collapsed row of the change
// history tree, from the list of field labels that actually changed (must be
// collected at the point the diff is computed -- see the "changedLabels"
// arrays below -- since the changed values themselves can contain embedded
// newlines, so the joined multi-line summary text can't be split back into
// "one line per field" after the fact).
function summarizeChangedLabels(labels) {
  if (!labels || labels.length === 0) return 'Updated';
  if (labels.length === 1) return `Updated ${labels[0].toLowerCase()}`;
  if (labels.length === 2) return `Updated ${labels[0].toLowerCase()} and ${labels[1].toLowerCase()}`;
  return `Updated ${labels.length} fields`;
}

// Fallback brief label for change-log rows saved before the "brief" column
// existed. Can only reliably recover the first changed field's label (text
// changes can contain their own newlines, so a full field count isn't safe
// to reconstruct from the stored summary text alone).
function legacyBriefFromSummary(summary) {
  if (!summary) return '';
  if (summary.startsWith('CARA created')) return summary;
  const firstColon = summary.indexOf(':');
  const firstLabel = firstColon === -1 ? summary : summary.slice(0, firstColon).trim();
  return `Updated ${firstLabel.toLowerCase()}`;
}

// Windows-style line endings (\r\n) sometimes end up in saved text (pasted
// from Word/Excel, or older seed data). Browsers silently normalise these to
// \n when displaying HTML, so it's invisible on the CARA/PERA pages — but
// PDFKit's built-in fonts have no glyph for a lone \r and render it as a
// stray "Ð" character at the end of every line. Strip it wherever text is
// saved or rendered to a PDF.
function normalizeText(v) {
  if (v === null || v === undefined) return v;
  return String(v).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// ---------- Dashboard ----------

app.get('/', async (req, res, next) => {
  try {
    const totalResult = await pool.query('SELECT COUNT(*)::int AS count FROM pera_records');
    const pendingResult = await pool.query(
      "SELECT COUNT(*)::int AS count FROM pera_records WHERE status = 'Pending approval'"
    );
    const caraTotalResult = await pool.query('SELECT COUNT(*)::int AS count FROM cara_records WHERE archived = false');
    const caraPendingResult = await pool.query(
      "SELECT COUNT(*)::int AS count FROM cara_records WHERE status = 'Pending approval' AND archived = false"
    );
    const equipmentTotalResult = await pool.query('SELECT COUNT(*)::int AS count FROM equipment_items');
    const equipmentAttentionResult = await pool.query(
      "SELECT COUNT(*)::int AS count FROM equipment_items WHERE status != 'Operational'"
    );

    const body = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Dashboard</h1>
          <p class="page-subtitle">Faith Lutheran College — Plainland</p>
        </div>
      </div>
      <div class="stat-grid">
        <div class="stat-tile">
          <div class="stat-label">PERA records</div>
          <div class="stat-value">${totalResult.rows[0].count}</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">PERAs pending approval</div>
          <div class="stat-value">${pendingResult.rows[0].count}</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">CARA records</div>
          <div class="stat-value">${caraTotalResult.rows[0].count}</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">CARAs pending approval</div>
          <div class="stat-value">${caraPendingResult.rows[0].count}</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">Equipment items</div>
          <div class="stat-value">${equipmentTotalResult.rows[0].count}</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">Equipment needing attention</div>
          <div class="stat-value">${equipmentAttentionResult.rows[0].count}</div>
        </div>
      </div>
      <div class="card" style="padding: 24px;">
        <p style="margin:0;font-size:14px;color:#6B6659;">
          <a href="/pera" style="color:#1B5E52;font-weight:600;">PERA</a> holds the equipment/tool
          risk assessment library (Plant &amp; Equipment Risk Assessments). <a href="/cara" style="color:#1B5E52;font-weight:600;">CARA</a> is where teachers put
          together a Curriculum Activity Risk Assessment for a class or activity, drawing on tools from that library.
          <a href="/equipment" style="color:#1B5E52;font-weight:600;">Equipment</a> is the register of the school's
          actual physical tools and machinery, and can link each item to the PERA that covers it.
        </p>
      </div>
    `;

    res.send(page({ title: 'Dashboard', active: 'dashboard', body }));
  } catch (err) {
    next(err);
  }
});

// ---------- PERA: list ----------

app.get('/pera', async (req, res, next) => {
  try {
    const { risk, q } = req.query;
    const conditions = [];
    const params = [];

    if (risk && RISK_LEVELS.includes(risk)) {
      params.push(risk);
      conditions.push(`risk_level = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      conditions.push(`activity_name ILIKE $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT * FROM pera_records ${where} ORDER BY created_at DESC`,
      params
    );

    const chips = ['All', ...RISK_LEVELS].map((level) => {
      const isActive = level === 'All' ? !risk : risk === level;
      const href = level === 'All' ? '/pera' : `/pera?risk=${encodeURIComponent(level)}`;
      const levelClass = level === 'All' ? '' : ` chip-${level.toLowerCase()}`;
      return `<a class="chip${levelClass}${isActive ? ' active' : ''}" href="${href}">${level}</a>`;
    }).join('');

    let rowsHtml;
    if (result.rows.length === 0) {
      rowsHtml = `<div class="empty-state">No PERA records yet. Click "New PERA" to add the first one.</div>`;
    } else {
      const rows = result.rows.map((r) => `
        <tr class="row-link" onclick="window.location='/pera/${r.id}'">
          <td>${escapeHtml(r.activity_name)}</td>
          <td><span class="badge ${riskBadgeClass(r.risk_level)}">${escapeHtml(r.risk_level)}</span></td>
          <td><span class="badge ${statusBadgeClass(r.status)}">${escapeHtml(r.status)}</span></td>
          <td>${escapeHtml(r.approver || '—')}</td>
          <td>${formatDate(r.next_review_date)}</td>
        </tr>
      `).join('');
      rowsHtml = `
        <table>
          <thead>
            <tr>
              <th>Activity / Unit</th>
              <th>Risk</th>
              <th>Status</th>
              <th>Approver</th>
              <th>Next review</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      `;
    }

    const body = `
      <div class="page-header">
        <div>
          <h1 class="page-title">PERA Records</h1>
          <p class="page-subtitle">Plant and equipment risk assessments (PERA) for tools and machinery used across the school.</p>
        </div>
        <a class="btn btn-primary" href="/pera/new">+ New PERA</a>
      </div>
      <div class="filter-row">
        <form method="get" action="/pera">
          ${risk ? `<input type="hidden" name="risk" value="${escapeHtml(risk)}">` : ''}
          <input class="search-input" type="search" name="q" placeholder="Search activities..." value="${escapeHtml(q || '')}">
        </form>
        <div class="chip-row">${chips}</div>
      </div>
      <div class="card">${rowsHtml}</div>
    `;

    res.send(page({ title: 'PERA Records', active: 'pera', body }));
  } catch (err) {
    next(err);
  }
});

// ---------- PERA: new (form) ----------

app.get('/pera/new', (req, res) => {
  const riskOptions = RISK_LEVELS.map((l) => `<option value="${l}">${l}</option>`).join('');

  const body = `
    <a class="back-link" href="/pera">← Back to PERA Records</a>
    <h1 class="page-title">New PERA</h1>
    <p class="page-subtitle" style="margin-bottom:24px;">This Plant &amp; Equipment Risk Assessment (PERA) will be saved as a Draft until you submit it for approval.</p>
    <form class="form-card" method="post" action="/pera">
      <div class="form-row">
        <label for="activity_name">Activity name</label>
        <input type="text" id="activity_name" name="activity_name" required placeholder="e.g. Angle grinder induction — Yr 11 Metalwork">
      </div>
      <div class="form-row">
        <label for="class_unit">Class / unit</label>
        <input type="text" id="class_unit" name="class_unit" placeholder="e.g. Yr 11 Metalwork, or UEE22020 Cert II Electrotechnology">
      </div>
      <div class="form-row">
        <label for="risk_level">Risk level</label>
        <select id="risk_level" name="risk_level" required>${riskOptions}</select>
      </div>
      <div class="form-row">
        <label for="hazards">Hazards identified</label>
        <textarea id="hazards" name="hazards" placeholder="What could cause harm during this activity?"></textarea>
      </div>
      <div class="form-row">
        <label for="control_measures">Control measures</label>
        <textarea id="control_measures" name="control_measures" placeholder="PPE, guarding checks, supervision ratio, procedures..."></textarea>
      </div>
      <div class="form-row">
        <label for="required_supervision">Required supervision</label>
        <input type="text" id="required_supervision" name="required_supervision" placeholder="e.g. Adult with Design and Technologies qualification, current first aid/CPR">
      </div>
      <div class="form-row checkbox-row">
        <input type="checkbox" id="consent_required" name="consent_required" value="true">
        <label for="consent_required">Parent consent required</label>
      </div>
      <div class="form-row">
        <label for="submitted_by">Submitted by</label>
        <input type="text" id="submitted_by" name="submitted_by" placeholder="Your name" value="Sean Willmott">
      </div>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">Save as draft</button>
        <a class="btn btn-secondary" href="/pera">Cancel</a>
      </div>
    </form>
  `;

  res.send(page({ title: 'New PERA', active: 'pera', body }));
});

// ---------- PERA: create ----------

app.post('/pera', async (req, res, next) => {
  try {
    const {
      activity_name, class_unit, risk_level,
      hazards, control_measures, required_supervision,
      consent_required, submitted_by,
    } = req.body;

    if (!activity_name || !RISK_LEVELS.includes(risk_level)) {
      return res.status(400).send('Activity name and a valid risk level are required.');
    }

    const result = await pool.query(
      `INSERT INTO pera_records
        (activity_name, class_unit, risk_level, hazards, control_measures, required_supervision, consent_required, submitted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        normalizeText(activity_name), normalizeText(class_unit) || null, risk_level,
        normalizeText(hazards) || null, normalizeText(control_measures) || null, normalizeText(required_supervision) || null,
        consent_required === 'true', normalizeText(submitted_by) || null,
      ]
    );

    res.redirect(`/pera/${result.rows[0].id}`);
  } catch (err) {
    next(err);
  }
});

// ---------- PERA: detail ----------

app.get('/pera/:id', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM pera_records WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).send('PERA record not found.');
    }
    const r = result.rows[0];

    let actionsHtml = '';
    if (r.status === 'Draft') {
      actionsHtml = `
        <form method="post" action="/pera/${r.id}/submit">
          <button type="submit" class="btn btn-primary" style="width:100%;">Submit for approval</button>
        </form>
      `;
    } else if (r.status === 'Pending approval' || r.status === 'Changes requested') {
      actionsHtml = `
        <form method="post" action="/pera/${r.id}/approve" style="margin-bottom:10px;">
          <div class="form-row">
            <label for="approver">Approved by</label>
            <input type="text" id="approver" name="approver" placeholder="Name of approver" value="Workplace Health and Safety Officer" required>
          </div>
          <button type="submit" class="btn btn-primary" style="width:100%;">Approve</button>
        </form>
        <form method="post" action="/pera/${r.id}/reject">
          <div class="form-row">
            <label for="review_notes">Notes for changes requested</label>
            <textarea id="review_notes" name="review_notes" placeholder="What needs to change?"></textarea>
          </div>
          <button type="submit" class="btn btn-secondary" style="width:100%;">Request changes</button>
        </form>
      `;
    } else if (r.status === 'Approved') {
      actionsHtml = `
        <div class="detail-section">
          <div class="detail-label">Approved by</div>
          <div class="detail-value">${escapeHtml(r.approver || '—')} on ${formatDate(r.approved_at)}</div>
        </div>
        <div class="detail-section">
          <div class="detail-label">Next review due</div>
          <div class="detail-value">${formatDate(r.next_review_date)}</div>
        </div>
      `;
    }

    const body = `
      <a class="back-link" href="/pera">← Back to PERA Records</a>
      <div class="page-header">
        <div>
          <span class="badge ${riskBadgeClass(r.risk_level)}">${escapeHtml(r.risk_level)} risk</span>
          <h1 class="page-title" style="margin-top:10px;">${escapeHtml(r.activity_name)}</h1>
          <p class="page-subtitle">Submitted by ${escapeHtml(r.submitted_by || 'unknown')}</p>
        </div>
        <span class="badge ${statusBadgeClass(r.status)}">${escapeHtml(r.status)}</span>
      </div>
      <div class="detail-grid">
        <div>
          <div class="detail-section">
            <div class="detail-label">Class / unit</div>
            <div class="detail-value">${escapeHtml(r.class_unit || '—')}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Hazards identified</div>
            <div class="detail-value">${escapeHtml(r.hazards || '—')}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Control measures</div>
            <div class="detail-value">${escapeHtml(r.control_measures || '—')}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Required supervision</div>
            <div class="detail-value">${escapeHtml(r.required_supervision || '—')}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Parent consent required</div>
            <div class="detail-value">${r.consent_required ? 'Yes' : 'No'}</div>
          </div>
          ${r.review_notes ? `
          <div class="detail-section">
            <div class="detail-label">Last review notes</div>
            <div class="detail-value">${escapeHtml(r.review_notes)}</div>
          </div>` : ''}
        </div>
        <div class="card" style="padding:22px;">
          <div class="note-box">${approvalRequirement(r.risk_level)}</div>
          ${actionsHtml}
        </div>
      </div>
    `;

    res.send(page({ title: r.activity_name, active: 'pera', body }));
  } catch (err) {
    next(err);
  }
});

// ---------- PERA: workflow actions ----------

app.post('/pera/:id/submit', async (req, res, next) => {
  try {
    await pool.query(
      "UPDATE pera_records SET status = 'Pending approval', updated_at = now() WHERE id = $1",
      [req.params.id]
    );
    res.redirect(`/pera/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

app.post('/pera/:id/approve', async (req, res, next) => {
  try {
    const { approver } = req.body;
    await pool.query(
      `UPDATE pera_records
       SET status = 'Approved', approver = $1, approved_at = now(),
           next_review_date = (now() + interval '1 year')::date, updated_at = now()
       WHERE id = $2`,
      [approver || null, req.params.id]
    );
    res.redirect(`/pera/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

app.post('/pera/:id/reject', async (req, res, next) => {
  try {
    const { review_notes } = req.body;
    await pool.query(
      `UPDATE pera_records
       SET status = 'Changes requested', review_notes = $1, updated_at = now()
       WHERE id = $2`,
      [review_notes || null, req.params.id]
    );
    res.redirect(`/pera/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// ---------- PERA: legacy URL redirects ----------
// Old "risk-assessments" links (e.g. bookmarks, printed QR codes on
// equipment) keep working after the rename to PERA terminology.

app.get('/risk-assessments', (req, res) => {
  const qs = req.originalUrl.split('?')[1];
  res.redirect(301, qs ? `/pera?${qs}` : '/pera');
});
app.get('/risk-assessments/new', (req, res) => res.redirect(301, '/pera/new'));
app.get('/risk-assessments/:id', (req, res) => res.redirect(301, `/pera/${req.params.id}`));
app.get('/admin/risk-assessments/:id/edit', (req, res) => res.redirect(301, `/admin/pera/${req.params.id}/edit`));

// ================================================================
// CARA (Curriculum Activity Risk Assessments)
// ================================================================

app.get('/cara', async (req, res, next) => {
  try {
    const { risk, q } = req.query;
    const showArchived = req.query.archived === '1';
    const conditions = [];
    const params = [];

    params.push(showArchived);
    conditions.push(`archived = $${params.length}`);

    if (risk && RISK_LEVELS.includes(risk)) {
      params.push(risk);
      conditions.push(`risk_level = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      conditions.push(`activity_name ILIKE $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT * FROM cara_records ${where} ORDER BY created_at DESC`,
      params
    );

    const chips = ['All', ...RISK_LEVELS].map((level) => {
      const isActive = level === 'All' ? !risk : risk === level;
      const chipParams = new URLSearchParams();
      if (level !== 'All') chipParams.set('risk', level);
      if (showArchived) chipParams.set('archived', '1');
      const qs = chipParams.toString();
      const href = `/cara${qs ? `?${qs}` : ''}`;
      const levelClass = level === 'All' ? '' : ` chip-${level.toLowerCase()}`;
      return `<a class="chip${levelClass}${isActive ? ' active' : ''}" href="${href}">${level}</a>`;
    }).join('');

    let rowsHtml;
    if (result.rows.length === 0) {
      rowsHtml = showArchived
        ? `<div class="empty-state">No archived CARA records.</div>`
        : `<div class="empty-state">No CARA records yet. Click "New CARA" to add the first one.</div>`;
    } else {
      const rows = result.rows.map((r) => `
        <tr class="row-link" onclick="window.location='/cara/${r.id}'">
          <td>${escapeHtml(r.activity_name)}</td>
          <td>${escapeHtml(r.class_unit || '—')}</td>
          <td><span class="badge ${riskBadgeClass(r.risk_level)}">${escapeHtml(r.risk_level)}</span></td>
          <td><span class="badge ${statusBadgeClass(r.status)}">${escapeHtml(r.status)}</span></td>
          <td>${escapeHtml(r.submitted_by || '—')}</td>
          <td>${formatDate(r.next_review_date)}</td>
        </tr>
      `).join('');
      rowsHtml = `
        <table>
          <thead>
            <tr>
              <th>Activity / Class</th>
              <th>Class / unit</th>
              <th>Risk</th>
              <th>Status</th>
              <th>Teacher</th>
              <th>Next review</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      `;
    }

    const body = `
      <div class="page-header">
        <div>
          <h1 class="page-title">${showArchived ? 'Archived CARA Records' : 'CARA Records'}</h1>
          <p class="page-subtitle">${showArchived
            ? 'CARA records that have been archived and are hidden from the main list.'
            : 'Curriculum Activity Risk Assessments for classes and activities.'}</p>
        </div>
        ${showArchived
          ? `<a class="btn btn-secondary" href="/cara">← Back to active</a>`
          : `<a class="btn btn-primary" href="/cara/new">+ New CARA</a>`}
      </div>
      <div class="filter-row">
        <form method="get" action="/cara">
          ${risk ? `<input type="hidden" name="risk" value="${escapeHtml(risk)}">` : ''}
          ${showArchived ? `<input type="hidden" name="archived" value="1">` : ''}
          <input class="search-input" type="search" name="q" placeholder="Search activities..." value="${escapeHtml(q || '')}">
        </form>
        <div class="chip-row">${chips}</div>
      </div>
      ${!showArchived ? `<p style="margin:-10px 0 18px;"><a href="/cara?archived=1" style="font-size:13px;color:#6B6659;text-decoration:underline;">View archived CARA records →</a></p>` : ''}
      <div class="card">${rowsHtml}</div>
    `;

    res.send(page({ title: showArchived ? 'Archived CARA Records' : 'CARA Records', active: 'cara', body }));
  } catch (err) {
    next(err);
  }
});

app.get('/cara/new', async (req, res, next) => {
  try {
    const toolsResult = await pool.query(
      `SELECT id, activity_name, class_unit, risk_level FROM pera_records
       WHERE status = 'Approved' ORDER BY class_unit NULLS LAST, activity_name`
    );

    const groups = new Map();
    for (const t of toolsResult.rows) {
      const key = t.class_unit || 'Other';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }

    let toolListHtml = '';
    for (const [group, tools] of groups) {
      toolListHtml += `
        <details class="tool-picker-group">
          <summary class="tool-picker-group-label">${escapeHtml(group)} <span class="tool-picker-group-count">(${tools.length})</span></summary>
          <div class="tool-picker-group-items">
            ${tools.map((t) => `
              <div class="tool-picker-item" data-search="${escapeHtml(t.activity_name.toLowerCase())}">
                <input type="checkbox" id="tool_${t.id}" name="tool_ids" value="${t.id}">
                <label for="tool_${t.id}">${escapeHtml(t.activity_name)}</label>
                <span class="badge ${riskBadgeClass(t.risk_level)}">${escapeHtml(t.risk_level)}</span>
              </div>
            `).join('')}
          </div>
        </details>
      `;
    }
    if (!toolsResult.rows.length) {
      toolListHtml = '<div class="tool-picker-item">No approved PERA records yet.</div>';
    }

    const riskOptions = RISK_LEVELS.map((l) => `<option value="${l}">${l}</option>`).join('');

    const body = `
      <a class="back-link" href="/cara">← Back to CARA Records</a>
      <h1 class="page-title">New CARA</h1>
      <p class="page-subtitle" style="margin-bottom:24px;">Curriculum Activity Risk Assessment for a class or activity. Saved as a Draft until submitted for approval.</p>
      <form class="form-card" method="post" action="/cara" style="max-width:760px;">

        <div class="form-section-title">Activity scope</div>
        <p class="form-section-hint">Describe the activity as it applies to your unit/lesson planning.</p>
        <div class="form-row">
          <label for="activity_name">Activity name</label>
          <input type="text" id="activity_name" name="activity_name" required placeholder="e.g. Yr 10 Metalwork — Wood turning unit">
        </div>
        <div class="form-row">
          <label for="class_unit">Class / unit</label>
          <input type="text" id="class_unit" name="class_unit" placeholder="e.g. Yr 10 Metalwork">
        </div>
        <div class="form-row">
          <label for="activity_scope">Activity scope</label>
          <textarea id="activity_scope" name="activity_scope" placeholder="What will students be doing, over what period, and where does it sit in the unit plan?"></textarea>
        </div>

        <div class="form-section-title">Inherent risk level</div>
        <p class="form-section-hint">Based on the highest-risk hazard or tool involved. Low = document only. Medium = CARA recommended. High = CARA + principal/DP approval, consent recommended. Extreme = CARA + principal approval, consent required.</p>
        <div class="form-row">
          <label for="risk_level">Risk level</label>
          <select id="risk_level" name="risk_level" required>${riskOptions}</select>
        </div>

        <div class="form-section-title">PERA used</div>
        <p class="form-section-hint">Select any equipment already covered by an approved PERA (Plant &amp; Equipment Risk Assessment). If something you need isn't listed, ask your WHS Coordinator to add it first.</p>
        <div class="tool-picker">
          <div class="tool-picker-search">
            <input type="text" id="tool_search" placeholder="Search tools..." oninput="filterTools(this.value)">
          </div>
          <div class="tool-picker-list" id="tool_picker_list">
            ${toolListHtml}
          </div>
        </div>

        <div class="form-section-title">Students</div>
        <p class="form-section-hint">Age/maturity/skill considerations, individual student needs, health plans, sun safety.</p>
        <div class="form-row">
          <textarea id="students_notes" name="students_notes" placeholder="Any student-specific considerations for this activity..."></textarea>
        </div>

        <div class="form-section-title">Emergency and first aid</div>
        <p class="form-section-hint">Pre-filled with standard procedure — edit if this activity needs anything extra (e.g. off-site, remote location, higher-risk equipment).</p>
        <div class="form-row">
          <textarea id="emergency_first_aid" name="emergency_first_aid">If an injury occurs, assess severity and apply first aid. If the injury is reportable, the school's sick bay/nurse station is to be notified immediately. First aid kit is located in the workshop. Supervising teacher holds current first aid/CPR.</textarea>
        </div>

        <div class="form-section-title">Induction and instruction</div>
        <div class="form-row">
          <textarea id="induction_instruction" name="induction_instruction" placeholder="How will supervisors and students be inducted/instructed on safety procedures?"></textarea>
        </div>

        <div class="form-section-title">Consent</div>
        <div class="form-row checkbox-row">
          <input type="checkbox" id="consent_required" name="consent_required" value="true">
          <label for="consent_required">Parent consent required (required for Extreme risk, recommended for High)</label>
        </div>

        <div class="form-section-title">Supervision</div>
        <div class="form-row">
          <textarea id="supervision_notes" name="supervision_notes" placeholder="Number of supervisors, ratios, roles during the activity..."></textarea>
        </div>

        <div class="form-section-title">Supervisor qualification</div>
        <div class="form-row">
          <textarea id="supervisor_qualification" name="supervisor_qualification" placeholder="Qualifications/competencies required of supervisors for this risk level..."></textarea>
        </div>

        <div class="form-section-title">Facilities and equipment</div>
        <div class="form-row">
          <textarea id="facilities_equipment" name="facilities_equipment" placeholder="Location suitability, PPE, equipment sizing/maintenance requirements..."></textarea>
        </div>

        <div class="form-section-title">Hazards and control measures</div>
        <p class="form-section-hint">Considering environmental hazards</p>
        <div class="form-row">
          <label for="environmental_hazards">Hazards</label>
          <textarea id="environmental_hazards" name="environmental_hazards" placeholder="e.g. dust/fumes from machining or welding, noise from machinery, poor ventilation, workshop heat in summer"></textarea>
        </div>
        <div class="form-row">
          <label for="environmental_controls">Control measures</label>
          <textarea id="environmental_controls" name="environmental_controls" placeholder="e.g. dust extraction/ventilation running, hearing protection available, fans/cooling in hot weather, floors kept clear of swarf/sawdust"></textarea>
        </div>

        <p class="form-section-hint">Considering facilities and equipment hazards</p>
        <div class="form-row">
          <label for="facilities_hazards">Hazards</label>
          <textarea id="facilities_hazards" name="facilities_hazards" placeholder="e.g. surface conditions, room layout, anything beyond the tools listed above"></textarea>
        </div>
        <div class="form-row">
          <label for="facilities_controls">Control measures</label>
          <textarea id="facilities_controls" name="facilities_controls" placeholder="e.g. clear walkways, adequate lighting/ventilation, tools stored securely when not in use"></textarea>
        </div>

        <p class="form-section-hint">Considering students</p>
        <div class="form-row">
          <label for="student_hazards">Hazards</label>
          <textarea id="student_hazards" name="student_hazards" placeholder="e.g. fatigue, inexperience, personal items/jewellery"></textarea>
        </div>
        <div class="form-row">
          <label for="student_controls">Control measures</label>
          <textarea id="student_controls" name="student_controls" placeholder="e.g. no loose clothing/jewellery, scheduled breaks, closer supervision for less experienced students"></textarea>
        </div>

        <div class="form-section-title">Submitted by</div>
        <div class="form-row">
          <input type="text" id="submitted_by" name="submitted_by" placeholder="Your name">
        </div>

        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Save as draft</button>
          <a class="btn btn-secondary" href="/cara">Cancel</a>
        </div>
      </form>
      <script>
        function filterTools(query) {
          const q = query.toLowerCase();
          document.querySelectorAll('.tool-picker-group').forEach((group) => {
            let anyVisible = false;
            group.querySelectorAll('.tool-picker-item[data-search]').forEach((item) => {
              const match = item.dataset.search.includes(q);
              item.style.display = match ? '' : 'none';
              if (match) anyVisible = true;
            });
            if (q) {
              group.open = anyVisible;
              group.style.display = anyVisible ? '' : 'none';
            } else {
              group.style.display = '';
            }
          });
        }
      </script>
    `;

    res.send(page({ title: 'New CARA', active: 'cara', body }));
  } catch (err) {
    next(err);
  }
});

app.post('/cara', async (req, res, next) => {
  try {
    const {
      activity_name, class_unit, activity_scope, risk_level,
      students_notes, emergency_first_aid, induction_instruction, consent_required,
      supervision_notes, supervisor_qualification, facilities_equipment,
      environmental_hazards, environmental_controls,
      facilities_hazards, facilities_controls,
      student_hazards, student_controls,
      submitted_by,
    } = req.body;

    if (!activity_name || !RISK_LEVELS.includes(risk_level)) {
      return res.status(400).send('Activity name and a valid risk level are required.');
    }

    const result = await pool.query(
      `INSERT INTO cara_records
        (activity_name, class_unit, activity_scope, risk_level,
         students_notes, emergency_first_aid, induction_instruction, consent_required,
         supervision_notes, supervisor_qualification, facilities_equipment,
         environmental_hazards, environmental_controls,
         facilities_hazards, facilities_controls,
         student_hazards, student_controls,
         submitted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id`,
      [
        normalizeText(activity_name), normalizeText(class_unit) || null, normalizeText(activity_scope) || null, risk_level,
        normalizeText(students_notes) || null, normalizeText(emergency_first_aid) || null, normalizeText(induction_instruction) || null, consent_required === 'true',
        normalizeText(supervision_notes) || null, normalizeText(supervisor_qualification) || null, normalizeText(facilities_equipment) || null,
        normalizeText(environmental_hazards) || null, normalizeText(environmental_controls) || null,
        normalizeText(facilities_hazards) || null, normalizeText(facilities_controls) || null,
        normalizeText(student_hazards) || null, normalizeText(student_controls) || null,
        normalizeText(submitted_by) || null,
      ]
    );

    const caraId = result.rows[0].id;

    const toolIds = [].concat(req.body.tool_ids || []).filter(Boolean);
    if (toolIds.length) {
      const values = toolIds.map((_, i) => `($1, $${i + 2})`).join(',');
      await pool.query(
        `INSERT INTO cara_tool_links (cara_id, pera_id) VALUES ${values} ON CONFLICT DO NOTHING`,
        [caraId, ...toolIds]
      );
    }

    await pool.query(
      'INSERT INTO cara_change_log (cara_id, changed_by, summary, brief) VALUES ($1, $2, $3, $3)',
      [caraId, normalizeText(submitted_by) || null, 'CARA created']
    );

    res.redirect(`/cara/${caraId}`);
  } catch (err) {
    next(err);
  }
});

// ---------- CARA: edit ----------
// Lets a teacher correct or update an existing CARA's content. Any edit that
// actually changes something resets the CARA to Draft and clears its
// signature/approval (the old sign-off no longer reflects the new content),
// and records a field-by-field old -> new summary in cara_change_log, shown
// at the bottom of the CARA detail page.

app.get('/cara/:id/edit', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM cara_records WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).send('CARA record not found.');
    }
    const r = result.rows[0];

    const linkedResult = await pool.query('SELECT pera_id FROM cara_tool_links WHERE cara_id = $1', [req.params.id]);
    const linkedIds = new Set(linkedResult.rows.map((row) => String(row.pera_id)));

    const toolsResult = await pool.query(
      `SELECT DISTINCT pr.id, pr.activity_name, pr.class_unit, pr.risk_level FROM pera_records pr
       WHERE pr.status = 'Approved' OR pr.id IN (SELECT pera_id FROM cara_tool_links WHERE cara_id = $1)
       ORDER BY pr.class_unit NULLS LAST, pr.activity_name`,
      [req.params.id]
    );

    const groups = new Map();
    for (const t of toolsResult.rows) {
      const key = t.class_unit || 'Other';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }

    let toolListHtml = '';
    for (const [group, tools] of groups) {
      const groupHasChecked = tools.some((t) => linkedIds.has(String(t.id)));
      toolListHtml += `
        <details class="tool-picker-group"${groupHasChecked ? ' open' : ''}>
          <summary class="tool-picker-group-label">${escapeHtml(group)} <span class="tool-picker-group-count">(${tools.length})</span></summary>
          <div class="tool-picker-group-items">
            ${tools.map((t) => `
              <div class="tool-picker-item" data-search="${escapeHtml(t.activity_name.toLowerCase())}">
                <input type="checkbox" id="tool_${t.id}" name="tool_ids" value="${t.id}" ${linkedIds.has(String(t.id)) ? 'checked' : ''}>
                <label for="tool_${t.id}">${escapeHtml(t.activity_name)}</label>
                <span class="badge ${riskBadgeClass(t.risk_level)}">${escapeHtml(t.risk_level)}</span>
              </div>
            `).join('')}
          </div>
        </details>
      `;
    }
    if (!toolsResult.rows.length) {
      toolListHtml = '<div class="tool-picker-item">No approved PERA records yet.</div>';
    }

    const riskOptions = RISK_LEVELS.map((l) => `<option value="${l}" ${l === r.risk_level ? 'selected' : ''}>${l}</option>`).join('');

    const resetWarning = r.status !== 'Draft'
      ? `<div class="note-box" style="margin-bottom:20px;">Saving changes will reset this CARA to <strong>Draft</strong> and clear its current signature/approval — it will need to be re-signed and re-approved.</div>`
      : '';

    const body = `
      <a class="back-link" href="/cara/${r.id}">← Back to CARA</a>
      <h1 class="page-title">Edit CARA</h1>
      <p class="page-subtitle" style="margin-bottom:24px;">Changes are recorded in the change history at the bottom of this CARA.</p>
      ${resetWarning}
      <form class="form-card" method="post" action="/cara/${r.id}/edit" style="max-width:760px;">

        <div class="form-section-title" style="margin-top:0;padding-top:0;border-top:none;">Activity scope</div>
        <div class="form-row">
          <label for="activity_name">Activity name</label>
          <input type="text" id="activity_name" name="activity_name" required value="${escapeHtml(r.activity_name)}">
        </div>
        <div class="form-row">
          <label for="class_unit">Class / unit</label>
          <input type="text" id="class_unit" name="class_unit" value="${escapeHtml(r.class_unit || '')}">
        </div>
        <div class="form-row">
          <label for="activity_scope">Activity scope</label>
          <textarea id="activity_scope" name="activity_scope">${escapeHtml(r.activity_scope || '')}</textarea>
        </div>

        <div class="form-section-title">Inherent risk level</div>
        <div class="form-row">
          <label for="risk_level">Risk level</label>
          <select id="risk_level" name="risk_level" required>${riskOptions}</select>
        </div>

        <div class="form-section-title">PERA used</div>
        <p class="form-section-hint">Select any equipment already covered by an approved PERA (Plant &amp; Equipment Risk Assessment). If something you need isn't listed, ask your WHS Coordinator to add it first.</p>
        <div class="tool-picker">
          <div class="tool-picker-search">
            <input type="text" id="tool_search" placeholder="Search tools..." oninput="filterTools(this.value)">
          </div>
          <div class="tool-picker-list" id="tool_picker_list">
            ${toolListHtml}
          </div>
        </div>

        <div class="form-section-title">Students</div>
        <div class="form-row">
          <textarea id="students_notes" name="students_notes">${escapeHtml(r.students_notes || '')}</textarea>
        </div>

        <div class="form-section-title">Emergency and first aid</div>
        <div class="form-row">
          <textarea id="emergency_first_aid" name="emergency_first_aid">${escapeHtml(r.emergency_first_aid || '')}</textarea>
        </div>

        <div class="form-section-title">Induction and instruction</div>
        <div class="form-row">
          <textarea id="induction_instruction" name="induction_instruction">${escapeHtml(r.induction_instruction || '')}</textarea>
        </div>

        <div class="form-section-title">Consent</div>
        <div class="form-row checkbox-row">
          <input type="checkbox" id="consent_required" name="consent_required" value="true" ${r.consent_required ? 'checked' : ''}>
          <label for="consent_required">Parent consent required (required for Extreme risk, recommended for High)</label>
        </div>

        <div class="form-section-title">Supervision</div>
        <div class="form-row">
          <textarea id="supervision_notes" name="supervision_notes">${escapeHtml(r.supervision_notes || '')}</textarea>
        </div>

        <div class="form-section-title">Supervisor qualification</div>
        <div class="form-row">
          <textarea id="supervisor_qualification" name="supervisor_qualification">${escapeHtml(r.supervisor_qualification || '')}</textarea>
        </div>

        <div class="form-section-title">Facilities and equipment</div>
        <div class="form-row">
          <textarea id="facilities_equipment" name="facilities_equipment">${escapeHtml(r.facilities_equipment || '')}</textarea>
        </div>

        <div class="form-section-title">Hazards and control measures</div>
        <p class="form-section-hint">Considering environmental hazards</p>
        <div class="form-row">
          <label for="environmental_hazards">Hazards</label>
          <textarea id="environmental_hazards" name="environmental_hazards">${escapeHtml(r.environmental_hazards || '')}</textarea>
        </div>
        <div class="form-row">
          <label for="environmental_controls">Control measures</label>
          <textarea id="environmental_controls" name="environmental_controls">${escapeHtml(r.environmental_controls || '')}</textarea>
        </div>

        <p class="form-section-hint">Considering facilities and equipment hazards</p>
        <div class="form-row">
          <label for="facilities_hazards">Hazards</label>
          <textarea id="facilities_hazards" name="facilities_hazards">${escapeHtml(r.facilities_hazards || '')}</textarea>
        </div>
        <div class="form-row">
          <label for="facilities_controls">Control measures</label>
          <textarea id="facilities_controls" name="facilities_controls">${escapeHtml(r.facilities_controls || '')}</textarea>
        </div>

        <p class="form-section-hint">Considering students</p>
        <div class="form-row">
          <label for="student_hazards">Hazards</label>
          <textarea id="student_hazards" name="student_hazards">${escapeHtml(r.student_hazards || '')}</textarea>
        </div>
        <div class="form-row">
          <label for="student_controls">Control measures</label>
          <textarea id="student_controls" name="student_controls">${escapeHtml(r.student_controls || '')}</textarea>
        </div>

        <div class="form-section-title">Submitted by</div>
        <div class="form-row">
          <input type="text" id="submitted_by" name="submitted_by" value="${escapeHtml(r.submitted_by || '')}">
        </div>

        <div class="form-section-title">Change record</div>
        <p class="form-section-hint">Your name will be recorded against this edit in the change history below.</p>
        <div class="form-row">
          <label for="edited_by">Your name</label>
          <input type="text" id="edited_by" name="edited_by" required placeholder="Your name">
        </div>

        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Save changes</button>
          <a class="btn btn-secondary" href="/cara/${r.id}">Cancel</a>
        </div>
      </form>
      <script>
        function filterTools(query) {
          const q = query.toLowerCase();
          document.querySelectorAll('.tool-picker-group').forEach((group) => {
            let anyVisible = false;
            group.querySelectorAll('.tool-picker-item[data-search]').forEach((item) => {
              const match = item.dataset.search.includes(q);
              item.style.display = match ? '' : 'none';
              if (match) anyVisible = true;
            });
            if (q) {
              group.open = anyVisible;
              group.style.display = anyVisible ? '' : 'none';
            } else {
              group.style.display = '';
            }
          });
        }
      </script>
    `;

    res.send(page({ title: `Edit — ${r.activity_name}`, active: 'cara', body }));
  } catch (err) {
    next(err);
  }
});

app.post('/cara/:id/edit', async (req, res, next) => {
  try {
    let {
      activity_name, class_unit, activity_scope, risk_level,
      students_notes, emergency_first_aid, induction_instruction, consent_required,
      supervision_notes, supervisor_qualification, facilities_equipment,
      environmental_hazards, environmental_controls,
      facilities_hazards, facilities_controls,
      student_hazards, student_controls,
      submitted_by, edited_by,
    } = req.body;

    activity_name = normalizeText(activity_name);
    class_unit = normalizeText(class_unit);
    activity_scope = normalizeText(activity_scope);
    students_notes = normalizeText(students_notes);
    emergency_first_aid = normalizeText(emergency_first_aid);
    induction_instruction = normalizeText(induction_instruction);
    supervision_notes = normalizeText(supervision_notes);
    supervisor_qualification = normalizeText(supervisor_qualification);
    facilities_equipment = normalizeText(facilities_equipment);
    environmental_hazards = normalizeText(environmental_hazards);
    environmental_controls = normalizeText(environmental_controls);
    facilities_hazards = normalizeText(facilities_hazards);
    facilities_controls = normalizeText(facilities_controls);
    student_hazards = normalizeText(student_hazards);
    student_controls = normalizeText(student_controls);
    submitted_by = normalizeText(submitted_by);

    if (!activity_name || !RISK_LEVELS.includes(risk_level)) {
      return res.status(400).send('Activity name and a valid risk level are required.');
    }
    if (!edited_by || !edited_by.trim()) {
      return res.status(400).send('Your name is required to save an edit.');
    }

    const existingResult = await pool.query('SELECT * FROM cara_records WHERE id = $1', [req.params.id]);
    if (existingResult.rows.length === 0) {
      return res.status(404).send('CARA record not found.');
    }
    const before = existingResult.rows[0];

    const linkedResult = await pool.query('SELECT pera_id FROM cara_tool_links WHERE cara_id = $1', [req.params.id]);
    const beforeToolIds = linkedResult.rows.map((row) => String(row.pera_id));
    const afterToolIds = [].concat(req.body.tool_ids || []).filter(Boolean).map(String);

    const newConsentRequired = consent_required === 'true';

    const fields = [
      ['activity_name', 'Activity name', activity_name],
      ['class_unit', 'Class / unit', class_unit || null],
      ['activity_scope', 'Activity scope', activity_scope || null],
      ['risk_level', 'Risk level', risk_level],
      ['students_notes', 'Students', students_notes || null],
      ['emergency_first_aid', 'Emergency and first aid', emergency_first_aid || null],
      ['induction_instruction', 'Induction and instruction', induction_instruction || null],
      ['supervision_notes', 'Supervision', supervision_notes || null],
      ['supervisor_qualification', 'Supervisor qualification', supervisor_qualification || null],
      ['facilities_equipment', 'Facilities and equipment', facilities_equipment || null],
      ['environmental_hazards', 'Environmental hazards', environmental_hazards || null],
      ['environmental_controls', 'Environmental control measures', environmental_controls || null],
      ['facilities_hazards', 'Facilities and equipment hazards', facilities_hazards || null],
      ['facilities_controls', 'Facilities and equipment control measures', facilities_controls || null],
      ['student_hazards', 'Student hazards', student_hazards || null],
      ['student_controls', 'Student control measures', student_controls || null],
      ['submitted_by', 'Submitted by', submitted_by || null],
    ];

    const displayValue = (v) => ((v === null || v === undefined || String(v).trim() === '') ? '(empty)' : String(v));

    const changeLines = [];
    const changedLabels = [];
    for (const [key, label, newValue] of fields) {
      const oldValue = before[key];
      const oldStr = (oldValue === null || oldValue === undefined) ? '' : String(oldValue);
      const newStr = (newValue === null || newValue === undefined) ? '' : String(newValue);
      if (oldStr.trim() !== newStr.trim()) {
        changeLines.push(`${label}: ${displayValue(oldValue)} → ${displayValue(newValue)}`);
        changedLabels.push(label);
      }
    }

    if (before.consent_required !== newConsentRequired) {
      changeLines.push(`Parent consent required: ${before.consent_required ? 'Yes' : 'No'} → ${newConsentRequired ? 'Yes' : 'No'}`);
      changedLabels.push('Parent consent required');
    }

    const beforeToolSet = new Set(beforeToolIds);
    const afterToolSet = new Set(afterToolIds);
    const addedToolIds = afterToolIds.filter((id) => !beforeToolSet.has(id));
    const removedToolIds = beforeToolIds.filter((id) => !afterToolSet.has(id));
    if (addedToolIds.length || removedToolIds.length) {
      const allIds = [...new Set([...addedToolIds, ...removedToolIds])];
      const namesResult = allIds.length
        ? await pool.query('SELECT id, activity_name FROM pera_records WHERE id = ANY($1::int[])', [allIds])
        : { rows: [] };
      const nameById = new Map(namesResult.rows.map((row) => [String(row.id), row.activity_name]));
      const parts = [];
      if (addedToolIds.length) parts.push(`added ${addedToolIds.map((id) => nameById.get(id) || `#${id}`).join(', ')}`);
      if (removedToolIds.length) parts.push(`removed ${removedToolIds.map((id) => nameById.get(id) || `#${id}`).join(', ')}`);
      changeLines.push(`PERA used: ${parts.join('; ')}`);
      changedLabels.push('PERA used');
    }

    if (changeLines.length === 0) {
      return res.redirect(`/cara/${req.params.id}`);
    }

    await pool.query(
      `UPDATE cara_records SET
         activity_name = $1, class_unit = $2, activity_scope = $3, risk_level = $4,
         students_notes = $5, emergency_first_aid = $6, induction_instruction = $7, consent_required = $8,
         supervision_notes = $9, supervisor_qualification = $10, facilities_equipment = $11,
         environmental_hazards = $12, environmental_controls = $13,
         facilities_hazards = $14, facilities_controls = $15,
         student_hazards = $16, student_controls = $17,
         submitted_by = $18,
         status = 'Draft', teacher_signature = NULL, signed_at = NULL,
         approver = NULL, approved_at = NULL, next_review_date = NULL, review_notes = NULL,
         updated_at = now()
       WHERE id = $19`,
      [
        activity_name, class_unit || null, activity_scope || null, risk_level,
        students_notes || null, emergency_first_aid || null, induction_instruction || null, newConsentRequired,
        supervision_notes || null, supervisor_qualification || null, facilities_equipment || null,
        environmental_hazards || null, environmental_controls || null,
        facilities_hazards || null, facilities_controls || null,
        student_hazards || null, student_controls || null,
        submitted_by || null,
        req.params.id,
      ]
    );

    await pool.query('DELETE FROM cara_tool_links WHERE cara_id = $1', [req.params.id]);
    if (afterToolIds.length) {
      const values = afterToolIds.map((_, i) => `($1, $${i + 2})`).join(',');
      await pool.query(
        `INSERT INTO cara_tool_links (cara_id, pera_id) VALUES ${values} ON CONFLICT DO NOTHING`,
        [req.params.id, ...afterToolIds]
      );
    }

    const briefSummary = summarizeChangedLabels(changedLabels);

    await pool.query(
      'INSERT INTO cara_change_log (cara_id, changed_by, summary, brief) VALUES ($1, $2, $3, $4)',
      [req.params.id, edited_by.trim(), changeLines.join('\n'), briefSummary]
    );

    res.redirect(`/cara/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

app.get('/cara/:id', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM cara_records WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).send('CARA record not found.');
    }
    const r = result.rows[0];

    const toolsResult = await pool.query(
      `SELECT ra.id, ra.activity_name, ra.risk_level
       FROM cara_tool_links l
       JOIN pera_records ra ON ra.id = l.pera_id
       WHERE l.cara_id = $1
       ORDER BY ra.activity_name`,
      [req.params.id]
    );

    const changeLogResult = await pool.query(
      'SELECT * FROM cara_change_log WHERE cara_id = $1 ORDER BY changed_at DESC',
      [req.params.id]
    );

    // Newest first (already ORDER BY changed_at DESC above), each entry
    // collapsed to a single date/time/user/brief-description line by
    // default, expanding to the full field-by-field detail on click.
    const changeLogHtml = changeLogResult.rows.length
      ? `<div class="change-log">${changeLogResult.rows.map((c) => `
          <details class="change-log-entry">
            <summary class="change-log-summary">
              <span class="change-log-datetime">${formatDateTime(c.changed_at)} — ${escapeHtml(c.changed_by || 'Unknown')}</span>
              <span class="change-log-brief">${escapeHtml(c.brief || legacyBriefFromSummary(c.summary))}</span>
            </summary>
            <div class="change-log-detail">${escapeHtml(c.summary)}</div>
          </details>
        `).join('')}</div>`
      : `<div class="detail-value">No edits recorded yet.</div>`;

    const toolChips = toolsResult.rows.length
      ? `<div class="tool-chip-list">${toolsResult.rows.map((t) => `
          <a class="tool-chip" href="/pera/${t.id}">
            <span class="badge ${riskBadgeClass(t.risk_level)}">${escapeHtml(t.risk_level)}</span>
            ${escapeHtml(t.activity_name)}
          </a>
        `).join('')}</div>`
      : `<div class="detail-value">No PERA linked.</div>`;

    let actionsHtml = '';
    if (r.status === 'Draft') {
      actionsHtml = `
        <div class="form-section-title" style="margin-top:0;padding-top:0;border-top:none;">Teacher signature</div>
        <p class="form-section-hint">Sign below to confirm this CARA is accurate before submitting for approval.</p>
        <div class="signature-pad-wrap">
          <canvas id="signature_pad" class="signature-pad" width="400" height="150"></canvas>
        </div>
        <div class="signature-pad-actions">
          <button type="button" class="btn btn-secondary" onclick="window.clearSignature()">Clear</button>
        </div>
        <form method="post" action="/cara/${r.id}/submit" id="cara_submit_form" onsubmit="return window.prepareSignature(event)">
          <input type="hidden" id="teacher_signature" name="teacher_signature">
          <button type="submit" class="btn btn-primary" style="width:100%;">Submit for approval</button>
        </form>
        <script>
          (function () {
            const canvas = document.getElementById('signature_pad');
            const ctx = canvas.getContext('2d');
            ctx.strokeStyle = '#1B5E52';
            ctx.lineWidth = 2;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            let drawing = false;
            let hasDrawn = false;

            function getPos(e) {
              const rect = canvas.getBoundingClientRect();
              const scaleX = canvas.width / rect.width;
              const scaleY = canvas.height / rect.height;
              if (e.touches && e.touches.length) {
                return { x: (e.touches[0].clientX - rect.left) * scaleX, y: (e.touches[0].clientY - rect.top) * scaleY };
              }
              return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
            }

            function start(e) {
              e.preventDefault();
              drawing = true;
              const pos = getPos(e);
              ctx.beginPath();
              ctx.moveTo(pos.x, pos.y);
            }
            function move(e) {
              if (!drawing) return;
              e.preventDefault();
              const pos = getPos(e);
              ctx.lineTo(pos.x, pos.y);
              ctx.stroke();
              hasDrawn = true;
            }
            function stop() {
              drawing = false;
            }

            canvas.addEventListener('mousedown', start);
            canvas.addEventListener('mousemove', move);
            window.addEventListener('mouseup', stop);
            canvas.addEventListener('touchstart', start, { passive: false });
            canvas.addEventListener('touchmove', move, { passive: false });
            canvas.addEventListener('touchend', stop);

            window.clearSignature = function () {
              ctx.clearRect(0, 0, canvas.width, canvas.height);
              hasDrawn = false;
            };

            window.prepareSignature = function (ev) {
              if (!hasDrawn) {
                alert('Please sign in the box above before submitting.');
                ev.preventDefault();
                return false;
              }
              document.getElementById('teacher_signature').value = canvas.toDataURL('image/png');
              return true;
            };
          })();
        </script>
      `;
    } else if (r.status === 'Pending approval' || r.status === 'Changes requested') {
      actionsHtml = `
        <form method="post" action="/cara/${r.id}/approve" style="margin-bottom:10px;">
          <div class="form-row">
            <label for="approver">Approved by</label>
            <input type="text" id="approver" name="approver" placeholder="Principal / school leader name" required>
          </div>
          <button type="submit" class="btn btn-primary" style="width:100%;">Approve</button>
        </form>
        <form method="post" action="/cara/${r.id}/reject">
          <div class="form-row">
            <label for="review_notes">Notes for changes requested</label>
            <textarea id="review_notes" name="review_notes" placeholder="What needs to change?"></textarea>
          </div>
          <button type="submit" class="btn btn-secondary" style="width:100%;">Request changes</button>
        </form>
      `;
    } else if (r.status === 'Approved') {
      actionsHtml = `
        <div class="detail-section">
          <div class="detail-label">Approved by</div>
          <div class="detail-value">${escapeHtml(r.approver || '—')} on ${formatDate(r.approved_at)}</div>
        </div>
        <div class="detail-section">
          <div class="detail-label">Next review due</div>
          <div class="detail-value">${formatDate(r.next_review_date)}</div>
        </div>
      `;
    }

    const reviewSection = r.status === 'Approved' ? `
      <div class="card" style="padding:22px;margin-top:20px;">
        <div class="form-section-title" style="margin-top:0;padding-top:0;border-top:none;">Post-activity monitoring &amp; review</div>
        <form method="post" action="/cara/${r.id}/review">
          <div class="monitoring-row">
            <div class="monitoring-question">Have additional hazards been identified?</div>
            <label><input type="radio" name="monitoring_new_hazards" value="true" ${r.monitoring_new_hazards === true ? 'checked' : ''}> Yes</label>
            <label><input type="radio" name="monitoring_new_hazards" value="false" ${r.monitoring_new_hazards === false ? 'checked' : ''}> No</label>
          </div>
          <div class="monitoring-row">
            <div class="monitoring-question">Were the control measures effective?</div>
            <label><input type="radio" name="monitoring_controls_effective" value="true" ${r.monitoring_controls_effective === true ? 'checked' : ''}> Yes</label>
            <label><input type="radio" name="monitoring_controls_effective" value="false" ${r.monitoring_controls_effective === false ? 'checked' : ''}> No</label>
          </div>
          <div class="monitoring-row">
            <div class="monitoring-question">Are further or different actions required?</div>
            <label><input type="radio" name="monitoring_further_action" value="true" ${r.monitoring_further_action === true ? 'checked' : ''}> Yes</label>
            <label><input type="radio" name="monitoring_further_action" value="false" ${r.monitoring_further_action === false ? 'checked' : ''}> No</label>
          </div>
          <div class="form-row" style="margin-top:14px;">
            <label for="monitoring_details">Details</label>
            <textarea id="monitoring_details" name="monitoring_details">${escapeHtml(r.monitoring_details || '')}</textarea>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">Save review</button>
          </div>
        </form>
        ${r.reviewed_at ? `<p class="form-section-hint" style="margin-top:12px;">Last reviewed ${formatDate(r.reviewed_at)}.</p>` : ''}
      </div>
    ` : '';

    const body = `
      <a class="back-link" href="/cara">← Back to CARA Records</a>
      <div class="page-header">
        <div>
          <span class="badge ${riskBadgeClass(r.risk_level)}">${escapeHtml(r.risk_level)} risk</span>
          <h1 class="page-title" style="margin-top:10px;">${escapeHtml(r.activity_name)}</h1>
          <p class="page-subtitle">${escapeHtml(r.class_unit || 'Class/unit not set')} · Submitted by ${escapeHtml(r.submitted_by || 'unknown')}</p>
        </div>
        <span class="badge ${statusBadgeClass(r.status)}">${escapeHtml(r.status)}</span>
        ${r.archived ? `<span class="badge" style="background:#F0EDE5;color:#6B6659;margin-left:6px;">Archived</span>` : ''}
      </div>
      <div class="detail-grid">
        <div>
          <div class="detail-section">
            <div class="detail-label">Activity scope</div>
            <div class="detail-value">${escapeHtml(r.activity_scope || '—')}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">PERA used</div>
            ${toolChips}
          </div>
          <div class="detail-section">
            <div class="detail-label">Teacher signature</div>
            ${r.teacher_signature
              ? `<img src="${r.teacher_signature}" alt="Teacher signature" class="signature-image">${r.signed_at ? `<div class="detail-value" style="margin-top:4px;font-size:12px;color:#6B6659;">Signed ${formatDate(r.signed_at)}</div>` : ''}`
              : `<div class="detail-value">—</div>`}
          </div>
          <div class="detail-section">
            <div class="detail-label">Students</div>
            <div class="detail-value">${escapeHtml(r.students_notes || '—')}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Emergency and first aid</div>
            <div class="detail-value">${escapeHtml(r.emergency_first_aid || '—')}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Induction and instruction</div>
            <div class="detail-value">${escapeHtml(r.induction_instruction || '—')}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Parent consent required</div>
            <div class="detail-value">${r.consent_required ? 'Yes' : 'No'}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Supervision</div>
            <div class="detail-value">${escapeHtml(r.supervision_notes || '—')}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Supervisor qualification</div>
            <div class="detail-value">${escapeHtml(r.supervisor_qualification || '—')}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Facilities and equipment</div>
            <div class="detail-value">${escapeHtml(r.facilities_equipment || '—')}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Environmental hazards</div>
            <div class="detail-value">${escapeHtml(r.environmental_hazards || '—')}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Environmental control measures</div>
            <div class="detail-value">${escapeHtml(r.environmental_controls || '—')}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Facilities and equipment hazards</div>
            <div class="detail-value">${escapeHtml(r.facilities_hazards || '—')}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Facilities and equipment control measures</div>
            <div class="detail-value">${escapeHtml(r.facilities_controls || '—')}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Student hazards</div>
            <div class="detail-value">${escapeHtml(r.student_hazards || '—')}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Student control measures</div>
            <div class="detail-value">${escapeHtml(r.student_controls || '—')}</div>
          </div>
          ${r.review_notes ? `
          <div class="detail-section">
            <div class="detail-label">Last review notes</div>
            <div class="detail-value">${escapeHtml(r.review_notes)}</div>
          </div>` : ''}
          ${reviewSection}
        </div>
        <div class="card" style="padding:22px;">
          <a class="btn btn-secondary" href="/cara/${r.id}/pdf" style="width:100%;display:block;text-align:center;box-sizing:border-box;margin-bottom:14px;">Download PDF</a>
          <a class="btn btn-secondary" href="/cara/${r.id}/edit" style="width:100%;display:block;text-align:center;box-sizing:border-box;margin-bottom:10px;">Edit this CARA</a>
          <form method="post" action="/cara/${r.id}/duplicate" style="margin-bottom:10px;">
            <button type="submit" class="btn btn-secondary" style="width:100%;">Duplicate as new CARA</button>
          </form>
          <form method="post" action="/cara/${r.id}/${r.archived ? 'unarchive' : 'archive'}" style="margin-bottom:14px;"${r.archived ? '' : ` onsubmit="return confirm('Archive this CARA? It will be hidden from the main CARA list, but can be restored anytime from the Archived view.');"`}>
            <button type="submit" class="btn btn-secondary" style="width:100%;">${r.archived ? 'Unarchive' : 'Archive'}</button>
          </form>
          ${r.archived ? `<div class="note-box" style="margin-bottom:14px;">This CARA is archived and hidden from the main CARA list.</div>` : ''}
          <div class="note-box">${caraApprovalRequirement(r.risk_level)}</div>
          ${actionsHtml}
        </div>
      </div>
      <div class="card" style="padding:22px;margin-top:20px;">
        <div class="form-section-title" style="margin-top:0;padding-top:0;border-top:none;">Change history</div>
        ${changeLogHtml}
      </div>
    `;

    res.send(page({ title: r.activity_name, active: 'cara', body }));
  } catch (err) {
    next(err);
  }
});

// ---------- CARA: PDF export ----------

app.get('/cara/:id/pdf', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM cara_records WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).send('CARA record not found.');
    }
    const r = result.rows[0];

    const toolsResult = await pool.query(
      `SELECT ra.activity_name, ra.risk_level
       FROM cara_tool_links l
       JOIN pera_records ra ON ra.id = l.pera_id
       WHERE l.cara_id = $1
       ORDER BY ra.activity_name`,
      [req.params.id]
    );

    const safeName = (r.activity_name || 'CARA').replace(/[^a-z0-9 \-_.]/gi, '').trim() || 'CARA';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="CARA - ${safeName}.pdf"`);

    const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
    doc.pipe(res);

    const GREEN = '#1B5E52';
    const MUTED = '#6B6659';
    const TEXT = '#1a1a1a';

    // Light rounded card panels for each section, matching the white/beige
    // "detail-section" cards on the CARA web page (see public/style.css).
    // A panel's height depends on its (possibly multi-paragraph) content, so
    // it's measured with heightOfString using the exact fonts/sizes/width
    // that will be used to draw it, then the background is drawn first and
    // the text on top of it -- and if the panel doesn't fit in the space
    // left on the page (but would fit a fresh page) it's moved to a new page
    // rather than being cut in half by the page break.
    const PANEL_FILL = '#F7F5F1';
    const PANEL_BORDER = '#E4DFD3';
    const PANEL_PADDING = 12;
    const PANEL_RADIUS = 6;
    const PANEL_GAP = 10;
    const TITLE_SIZE = 10.5;
    const BODY_SIZE = 10;
    const TITLE_GAP = 4;

    function panelContentWidth() {
      return doc.page.width - doc.page.margins.left - doc.page.margins.right - PANEL_PADDING * 2;
    }

    function drawPanelShell(contentHeight, draw) {
      const cw = panelContentWidth();
      const panelW = cw + PANEL_PADDING * 2;
      const panelH = contentHeight + PANEL_PADDING * 2;
      const usableTop = doc.page.margins.top;
      const usableBottom = doc.page.height - doc.page.margins.bottom;
      const maxPageContentHeight = usableBottom - usableTop;
      if (doc.y + panelH > usableBottom && panelH <= maxPageContentHeight) {
        doc.addPage();
      }
      const left = doc.page.margins.left;
      const top = doc.y;
      doc.lineWidth(1);
      doc.roundedRect(left, top, panelW, panelH, PANEL_RADIUS).fillAndStroke(PANEL_FILL, PANEL_BORDER);
      doc.x = left + PANEL_PADDING;
      doc.y = top + PANEL_PADDING;
      draw(cw);
      doc.y = top + panelH + PANEL_GAP;
      doc.x = left;
    }

    // Renders one panel with a title followed by any number of styled text
    // parts stacked underneath it (each with its own gap above it, font size
    // and colour) -- used both for a plain "title + body" section and for
    // panels like the monitoring review that mix several lines of text.
    // `extraDraw(startX, width)`, if given, is called once a panel's text
    // parts have all been drawn far enough to reach the first part with a
    // fixed `height` instead of `text` -- used to place an image (whose
    // rendered size isn't known ahead of time the way text height is) at
    // the right y position within a reserved block of vertical space.
    function multiPanel(title, parts, extraDraw) {
      const cw = panelContentWidth();
      doc.fontSize(TITLE_SIZE);
      const titleHeight = doc.heightOfString(title, { width: cw });
      let contentHeight = titleHeight;
      for (const part of parts) {
        contentHeight += part.gapBefore || 0;
        if (part.height != null) {
          contentHeight += part.height;
        } else {
          doc.fontSize(part.size || BODY_SIZE);
          contentHeight += doc.heightOfString(part.text, { width: cw });
        }
      }
      drawPanelShell(contentHeight, (w) => {
        const startX = doc.x;
        doc.fontSize(TITLE_SIZE).fillColor(GREEN).text(title, startX, doc.y, { width: w });
        for (const part of parts) {
          doc.y += part.gapBefore || 0;
          if (part.height != null) {
            if (extraDraw) extraDraw(startX, w);
            doc.y += part.height;
          } else {
            doc.fontSize(part.size || BODY_SIZE).fillColor(part.color || TEXT).text(part.text, startX, doc.y, { width: w });
          }
        }
      });
    }

    if (LETTERHEAD_BUFFER) {
      try {
        doc.image(LETTERHEAD_BUFFER, { fit: [495, 85], align: 'center' });
        doc.moveDown(0.5);
      } catch (e) {
        doc.fontSize(9).fillColor(MUTED).text('Faith Lutheran College — Plainland', { align: 'left' });
        doc.moveDown(0.3);
      }
    } else {
      doc.fontSize(9).fillColor(MUTED).text('Faith Lutheran College — Plainland', { align: 'left' });
      doc.moveDown(0.3);
    }

    doc.fontSize(9).fillColor(MUTED).text('School Guard', { align: 'left' });
    doc.moveDown(0.3);
    doc.fontSize(16).fillColor(GREEN).text('Curriculum Activity Risk Assessment (CARA)');
    doc.moveDown(0.2);
    doc.fontSize(13).fillColor(TEXT).text(r.activity_name || 'Untitled activity');
    doc.fontSize(9).fillColor(MUTED).text(
      `${r.class_unit || 'Class/unit not set'}   ·   Risk level: ${r.risk_level}   ·   Status: ${r.status}`
    );
    doc.moveDown(0.8);

    function section(title, value) {
      const body = value && String(value).trim() ? normalizeText(value) : '—';
      multiPanel(title, [{ text: body, gapBefore: TITLE_GAP }]);
    }

    section('Activity scope', r.activity_scope);

    if (toolsResult.rows.length) {
      multiPanel('PERA used', [{
        text: toolsResult.rows.map((t) => `• ${t.activity_name} (${t.risk_level})`).join('\n'),
        gapBefore: TITLE_GAP,
      }]);
    } else {
      section('PERA used', null);
    }

    section('Students', r.students_notes);
    section('Emergency and first aid', r.emergency_first_aid);
    section('Induction and instruction', r.induction_instruction);
    section('Parent consent required', r.consent_required ? 'Yes' : 'No');
    section('Supervision', r.supervision_notes);
    section('Supervisor qualification', r.supervisor_qualification);
    section('Facilities and equipment', r.facilities_equipment);
    section('Environmental hazards', r.environmental_hazards);
    section('Environmental control measures', r.environmental_controls);
    section('Facilities and equipment hazards', r.facilities_hazards);
    section('Facilities and equipment control measures', r.facilities_controls);
    section('Student hazards', r.student_hazards);
    section('Student control measures', r.student_controls);

    if (r.review_notes) {
      section('Last review notes', r.review_notes);
    }

    if (r.status === 'Approved') {
      section('Approved by', `${r.approver || '—'}  on  ${formatDate(r.approved_at)}`);
      section('Next review due', formatDate(r.next_review_date));
    }

    if (r.reviewed_at) {
      const yn = (v) => (v === true ? 'Yes' : v === false ? 'No' : '—');
      const monitoringParts = [
        { text: `Additional hazards identified: ${yn(r.monitoring_new_hazards)}`, gapBefore: TITLE_GAP },
        { text: `Control measures effective: ${yn(r.monitoring_controls_effective)}`, gapBefore: 2 },
        { text: `Further action required: ${yn(r.monitoring_further_action)}`, gapBefore: 2 },
      ];
      if (r.monitoring_details) {
        monitoringParts.push({ text: normalizeText(r.monitoring_details), gapBefore: 6 });
      }
      monitoringParts.push({ text: `Last reviewed ${formatDate(r.reviewed_at)}.`, gapBefore: 6, size: 8.5, color: MUTED });
      multiPanel('Post-activity monitoring & review', monitoringParts);
    }

    const signatureParts = [{
      text: `Submitted by: ${r.submitted_by || 'unknown'}${r.signed_at ? `  on  ${formatDate(r.signed_at)}` : ''}`,
      gapBefore: TITLE_GAP,
    }];
    let signatureImage = null;
    if (r.teacher_signature) {
      try {
        const base64 = r.teacher_signature.split(',')[1];
        signatureImage = Buffer.from(base64, 'base64');
        // Reserve the fitted image's max height (see `fit` below); the exact
        // rendered height depends on the signature's aspect ratio, but this
        // keeps the panel comfortably tall enough either way.
        signatureParts.push({ text: '', gapBefore: 8, height: 80 });
      } catch (e) {
        signatureParts.push({ text: '(signature image could not be rendered)', gapBefore: 6, size: 9, color: MUTED });
      }
    } else {
      signatureParts.push({ text: 'No signature captured.', gapBefore: 6, size: 9, color: MUTED });
    }
    multiPanel('Teacher signature', signatureParts, (startX) => {
      if (signatureImage) {
        try {
          doc.image(signatureImage, startX, doc.y, { fit: [200, 80] });
        } catch (e) {
          doc.fontSize(9).fillColor(MUTED).text('(signature image could not be rendered)', startX, doc.y);
        }
      }
    });

    doc.moveDown(1.2);
    doc.fontSize(8).fillColor('#999999').text(
      `Generated ${new Date().toLocaleString('en-AU')} — School Guard`,
      { align: 'center' }
    );

    doc.end();
  } catch (err) {
    next(err);
  }
});

app.post('/cara/:id/submit', async (req, res, next) => {
  try {
    const { teacher_signature } = req.body;
    const isValidSignature = typeof teacher_signature === 'string'
      && teacher_signature.length < 500000
      && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(teacher_signature);

    if (!isValidSignature) {
      return res.status(400).send('A teacher signature is required before this CARA can be submitted for approval. Please go back and sign.');
    }

    await pool.query(
      `UPDATE cara_records
       SET status = 'Pending approval', teacher_signature = $1, signed_at = now(), updated_at = now()
       WHERE id = $2`,
      [teacher_signature, req.params.id]
    );
    res.redirect(`/cara/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

app.post('/cara/:id/approve', async (req, res, next) => {
  try {
    const { approver } = req.body;
    await pool.query(
      `UPDATE cara_records
       SET status = 'Approved', approver = $1, approved_at = now(),
           next_review_date = (now() + interval '1 year')::date, updated_at = now()
       WHERE id = $2`,
      [approver || null, req.params.id]
    );
    res.redirect(`/cara/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

app.post('/cara/:id/reject', async (req, res, next) => {
  try {
    const { review_notes } = req.body;
    await pool.query(
      `UPDATE cara_records
       SET status = 'Changes requested', review_notes = $1, updated_at = now()
       WHERE id = $2`,
      [review_notes || null, req.params.id]
    );
    res.redirect(`/cara/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

app.post('/cara/:id/review', async (req, res, next) => {
  try {
    const { monitoring_new_hazards, monitoring_controls_effective, monitoring_further_action, monitoring_details } = req.body;
    const toBool = (v) => (v === 'true' ? true : v === 'false' ? false : null);
    await pool.query(
      `UPDATE cara_records SET
         monitoring_new_hazards = $1, monitoring_controls_effective = $2,
         monitoring_further_action = $3, monitoring_details = $4,
         reviewed_at = now(), updated_at = now()
       WHERE id = $5`,
      [
        toBool(monitoring_new_hazards), toBool(monitoring_controls_effective),
        toBool(monitoring_further_action), normalizeText(monitoring_details) || null,
        req.params.id,
      ]
    );
    res.redirect(`/cara/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// ---------- CARA: duplicate ----------
// Lets a teacher reuse an existing CARA (same content, tools, risk level) for
// a repeat occurrence of the activity. The copy always starts life as a fresh,
// unsigned, unapproved Draft — status/signature/approval never carry over —
// and naturally gets today's date via created_at, so no separate "date" field
// is needed.

app.post('/cara/:id/duplicate', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM cara_records WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).send('CARA record not found.');
    }
    const r = result.rows[0];

    const insertResult = await pool.query(
      `INSERT INTO cara_records
        (activity_name, class_unit, activity_scope, risk_level,
         students_notes, emergency_first_aid, induction_instruction, consent_required,
         supervision_notes, supervisor_qualification, facilities_equipment,
         environmental_hazards, environmental_controls,
         facilities_hazards, facilities_controls,
         student_hazards, student_controls,
         submitted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id`,
      [
        r.activity_name, r.class_unit, r.activity_scope, r.risk_level,
        r.students_notes, r.emergency_first_aid, r.induction_instruction, r.consent_required,
        r.supervision_notes, r.supervisor_qualification, r.facilities_equipment,
        r.environmental_hazards, r.environmental_controls,
        r.facilities_hazards, r.facilities_controls,
        r.student_hazards, r.student_controls,
        r.submitted_by,
      ]
    );
    const newId = insertResult.rows[0].id;

    const toolLinks = await pool.query('SELECT pera_id FROM cara_tool_links WHERE cara_id = $1', [req.params.id]);
    if (toolLinks.rows.length) {
      const values = toolLinks.rows.map((_, i) => `($1, $${i + 2})`).join(',');
      await pool.query(
        `INSERT INTO cara_tool_links (cara_id, pera_id) VALUES ${values} ON CONFLICT DO NOTHING`,
        [newId, ...toolLinks.rows.map((t) => t.pera_id)]
      );
    }

    await pool.query(
      'INSERT INTO cara_change_log (cara_id, changed_by, summary, brief) VALUES ($1, $2, $3, $3)',
      [newId, r.submitted_by || null, `CARA created (duplicated from "${r.activity_name}")`]
    );

    res.redirect(`/cara/${newId}`);
  } catch (err) {
    next(err);
  }
});

// ---------- CARA: archive / unarchive ----------
// Archiving hides a CARA from the main /cara list (e.g. once it's stale or
// superseded by a duplicate) without deleting it. It stays fully viewable via
// the "Archived" view and can be unarchived at any time.

app.post('/cara/:id/archive', async (req, res, next) => {
  try {
    await pool.query('UPDATE cara_records SET archived = true, updated_at = now() WHERE id = $1', [req.params.id]);
    res.redirect('/cara');
  } catch (err) {
    next(err);
  }
});

app.post('/cara/:id/unarchive', async (req, res, next) => {
  try {
    await pool.query('UPDATE cara_records SET archived = false, updated_at = now() WHERE id = $1', [req.params.id]);
    res.redirect(`/cara/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// ================================================================
// Equipment (physical asset register)
// ================================================================
// A simple register of the school's actual tools and machinery. This is
// deliberately separate from PERA, which is the risk-assessment paperwork
// for a *type* of tool/activity: an equipment item is a specific physical
// thing (e.g. "Guillotine #2, Workshop A") that can optionally link to the
// PERA covering it, so a physical item can be traced straight to its risk
// assessment.

const EQUIPMENT_STATUSES = ['Operational', 'Needs repair', 'Out of service'];

// How often an item needs checking. Drives next_inspection_due whenever a
// check is logged (see computeNextDue below) — a school term/semester is
// only approximate (~10/~20 weeks) since actual term dates move year to
// year, but that's close enough for a maintenance reminder.
const EQUIPMENT_FREQUENCIES = ['Daily', 'Week', 'Term', 'Semester', 'Yearly'];
const FREQUENCY_DAYS = { Daily: 1, Week: 7, Term: 70, Semester: 140, Yearly: 365 };

// An item with no next_inspection_due is "unscheduled" rather than overdue —
// there's nothing to be late for until a frequency/check sets one.
const DUE_SOON_DAYS = 14;

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function computeNextDue(fromDate, frequency) {
  if (!frequency || !FREQUENCY_DAYS[frequency]) return null;
  return addDays(fromDate || new Date(), FREQUENCY_DAYS[frequency]);
}

// Checklist items are stored as a JSON array of short strings (e.g. "Blade
// guard", "Power cord condition") — plain lines of text, not records in
// their own right — so the form just edits them as one item per line.
function parseChecklistText(text) {
  if (!text) return [];
  return String(text)
    .split('\n')
    .map((s) => normalizeText(s).trim())
    .filter(Boolean);
}

function checklistTextareaValue(items) {
  return Array.isArray(items) ? items.join('\n') : '';
}

// Renders the "Checklist items" form row as an add/remove list of rows (each
// with a decorative, disabled checkbox previewing how it'll look when
// someone logs a check) instead of a free-text textarea. A hidden textarea
// keeps the same name/id the server already expects (one item per line), so
// nothing on the receiving end (parseChecklistText, the route handlers) has
// to change — the builder just keeps that hidden field in sync as rows are
// added, edited, or removed.
function checklistBuilderHtml(initialItems) {
  const initialItemsJson = JSON.stringify(Array.isArray(initialItems) ? initialItems : []).replace(/</g, '\\u003c');
  return `
        <div class="form-row">
          <label>Checklist items</label>
          <div id="checklist-builder"></div>
          <button type="button" class="btn btn-secondary" id="checklist-add-btn" style="margin-top:4px;padding:6px 12px;font-size:12px;">+ Add item</button>
          <textarea id="checklist_items" name="checklist_items" style="display:none;"></textarea>
        </div>
        <script>
          (function() {
            var initialItems = ${initialItemsJson};
            var builder = document.getElementById('checklist-builder');
            var hidden = document.getElementById('checklist_items');
            var rows = [];

            function sync() {
              hidden.value = rows.map(function(r) { return r.input.value.trim(); }).filter(Boolean).join('\\n');
            }

            function addRow(value) {
              var row = document.createElement('div');
              row.className = 'checkbox-row';
              row.style.marginBottom = '8px';

              var cb = document.createElement('input');
              cb.type = 'checkbox';
              cb.disabled = true;
              cb.title = 'Ticked off when someone logs a check';

              var input = document.createElement('input');
              input.type = 'text';
              input.value = value || '';
              input.placeholder = 'e.g. Blade guard';
              input.style.flex = '1';
              input.addEventListener('input', sync);

              var removeBtn = document.createElement('button');
              removeBtn.type = 'button';
              removeBtn.className = 'btn btn-secondary';
              removeBtn.style.padding = '4px 10px';
              removeBtn.style.fontSize = '12px';
              removeBtn.textContent = 'Remove';
              removeBtn.addEventListener('click', function() {
                builder.removeChild(row);
                var idx = rows.findIndex(function(r) { return r.row === row; });
                if (idx !== -1) rows.splice(idx, 1);
                sync();
              });

              row.appendChild(cb);
              row.appendChild(input);
              row.appendChild(removeBtn);
              builder.appendChild(row);
              rows.push({ row: row, input: input });
              sync();
            }

            (initialItems.length ? initialItems : ['']).forEach(addRow);

            document.getElementById('checklist-add-btn').addEventListener('click', function() {
              addRow('');
            });
          })();
        </script>
  `;
}

function equipmentFrequencyOptions(selected) {
  return EQUIPMENT_FREQUENCIES.map((f) => `<option value="${f}" ${f === selected ? 'selected' : ''}>${f}</option>`).join('');
}

// Express's urlencoded parser gives an array for a repeated field name, but
// only a bare string when exactly one checkbox of that name was checked (and
// undefined when none were) — normalise all three to an array.
function toArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// 'overdue' | 'due-soon' | 'scheduled' | 'unscheduled', in that urgency order.
function equipmentUrgency(nextDue) {
  if (!nextDue) return 'unscheduled';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(nextDue);
  due.setHours(0, 0, 0, 0);
  const diffDays = Math.round((due - today) / 86400000);
  if (diffDays < 0) return 'overdue';
  if (diffDays <= DUE_SOON_DAYS) return 'due-soon';
  return 'scheduled';
}

function equipmentBadgeClass(status) {
  return {
    'Operational': 'badge-operational',
    'Needs repair': 'badge-needs-repair',
    'Out of service': 'badge-out-of-service',
  }[status] || 'badge-draft';
}

function equipmentChipClass(status) {
  return {
    'Operational': 'chip-operational',
    'Needs repair': 'chip-needs-repair',
    'Out of service': 'chip-out-of-service',
  }[status] || '';
}

function toDateInputValue(d) {
  if (!d) return '';
  return new Date(d).toISOString().slice(0, 10);
}

// ---------- Equipment: list ----------

app.get('/equipment', async (req, res, next) => {
  try {
    const { status, q } = req.query;
    const conditions = [];
    const params = [];

    if (status && EQUIPMENT_STATUSES.includes(status)) {
      params.push(status);
      conditions.push(`e.status = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      conditions.push(`e.name ILIKE $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT e.*, p.activity_name AS pera_name
       FROM equipment_items e
       LEFT JOIN pera_records p ON p.id = e.pera_id
       ${where}
       ORDER BY e.name ASC`,
      params
    );

    const chips = ['All', ...EQUIPMENT_STATUSES].map((s) => {
      const isActive = s === 'All' ? !status : status === s;
      const href = s === 'All' ? '/equipment' : `/equipment?status=${encodeURIComponent(s)}`;
      const chipClass = s === 'All' ? '' : ` ${equipmentChipClass(s)}`;
      return `<a class="chip${chipClass}${isActive ? ' active' : ''}" href="${href}">${s}</a>`;
    }).join('');

    let rowsHtml;
    if (result.rows.length === 0) {
      rowsHtml = `<div class="empty-state">No equipment recorded yet. Click "New equipment" to add the first item.</div>`;
    } else {
      const rows = result.rows.map((r) => `
        <tr class="row-link" onclick="window.location='/equipment/${r.id}'">
          <td>${escapeHtml(r.name)}</td>
          <td>${escapeHtml(r.category || '—')}</td>
          <td>${escapeHtml(r.location || '—')}</td>
          <td><span class="badge ${equipmentBadgeClass(r.status)}">${escapeHtml(r.status)}</span></td>
          <td>${formatDate(r.next_inspection_due)}</td>
        </tr>
      `).join('');
      rowsHtml = `
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Category</th>
              <th>Location</th>
              <th>Status</th>
              <th>Next inspection</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      `;
    }

    const body = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Equipment</h1>
          <p class="page-subtitle">The school's register of tools and machinery, and the condition/inspection status of each item. <a href="/equipment/by-room" style="color:#1B5E52;font-weight:600;">View by room →</a></p>
        </div>
        <a class="btn btn-primary" href="/equipment/new">+ New equipment</a>
      </div>
      <div class="filter-row">
        <form method="get" action="/equipment">
          ${status ? `<input type="hidden" name="status" value="${escapeHtml(status)}">` : ''}
          <input class="search-input" type="search" name="q" placeholder="Search equipment..." value="${escapeHtml(q || '')}">
        </form>
        <div class="chip-row">${chips}</div>
      </div>
      <div class="card">${rowsHtml}</div>
    `;

    res.send(page({ title: 'Equipment', active: 'equipment', body }));
  } catch (err) {
    next(err);
  }
});

// ---------- Equipment: new (form) ----------

app.get('/equipment/new', async (req, res, next) => {
  try {
    const peraResult = await pool.query('SELECT id, activity_name FROM pera_records ORDER BY activity_name ASC');
    const statusOptions = EQUIPMENT_STATUSES.map((s) => `<option value="${s}" ${s === 'Operational' ? 'selected' : ''}>${s}</option>`).join('');
    const peraOptions = [
      '<option value="">— None —</option>',
      ...peraResult.rows.map((p) => `<option value="${p.id}">${escapeHtml(p.activity_name)}</option>`),
    ].join('');
    // Category shares the same master tool list as "Linked PERA" (rather than
    // a free-text field), so equipment is tagged with the school's existing
    // standard tool names instead of ad hoc category labels.
    const categoryOptions = [
      '<option value="">— None —</option>',
      ...peraResult.rows.map((p) => `<option value="${escapeHtml(p.activity_name)}">${escapeHtml(p.activity_name)}</option>`),
    ].join('');

    const body = `
      <a class="back-link" href="/equipment">← Back to Equipment</a>
      <h1 class="page-title">New equipment</h1>
      <p class="page-subtitle" style="margin-bottom:24px;">Add a tool or piece of machinery to the equipment register.</p>
      <form class="form-card" method="post" action="/equipment">
        <div class="form-row">
          <label for="name">Name</label>
          <input type="text" id="name" name="name" required placeholder="e.g. Guillotine — light sheet metal (Workshop A)">
        </div>
        <div class="form-row">
          <label for="category">Category</label>
          <select id="category" name="category">${categoryOptions}</select>
        </div>
        <div class="form-row">
          <label for="location">Location</label>
          <input type="text" id="location" name="location" placeholder="e.g. IDT Workshop A">
        </div>
        <div class="form-row">
          <label for="status">Status</label>
          <select id="status" name="status" required>${statusOptions}</select>
        </div>
        <div class="form-row">
          <label for="pera_id">Linked PERA</label>
          <select id="pera_id" name="pera_id">${peraOptions}</select>
        </div>
        <div class="form-row">
          <label for="last_inspected">Last inspected</label>
          <input type="date" id="last_inspected" name="last_inspected">
        </div>
        <div class="form-row">
          <label for="next_inspection_due">Next inspection due</label>
          <input type="date" id="next_inspection_due" name="next_inspection_due">
        </div>
        <div class="form-row">
          <label for="inspection_frequency">Inspection frequency</label>
          <select id="inspection_frequency" name="inspection_frequency">
            <option value="">— None —</option>
            ${equipmentFrequencyOptions('')}
          </select>
        </div>
        ${checklistBuilderHtml([])}
        <div class="form-row">
          <label for="notes">Notes</label>
          <textarea id="notes" name="notes" placeholder="Serial number, maintenance history, anything else worth recording..."></textarea>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Save equipment</button>
          <a class="btn btn-secondary" href="/equipment">Cancel</a>
        </div>
      </form>
    `;

    res.send(page({ title: 'New equipment', active: 'equipment', body }));
  } catch (err) {
    next(err);
  }
});

// ---------- Equipment: create ----------

app.post('/equipment', async (req, res, next) => {
  try {
    const {
      name, category, location, status, pera_id, last_inspected, next_inspection_due, notes,
      inspection_frequency, checklist_items,
    } = req.body;

    if (!name || !EQUIPMENT_STATUSES.includes(status)) {
      return res.status(400).send('Name and a valid status are required.');
    }
    const frequency = EQUIPMENT_FREQUENCIES.includes(inspection_frequency) ? inspection_frequency : null;

    const result = await pool.query(
      `INSERT INTO equipment_items
        (name, category, location, status, pera_id, last_inspected, next_inspection_due, notes, inspection_frequency, checklist_items)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [
        normalizeText(name), normalizeText(category) || null, normalizeText(location) || null, status,
        pera_id || null, last_inspected || null, next_inspection_due || null, normalizeText(notes) || null,
        frequency, JSON.stringify(parseChecklistText(checklist_items)),
      ]
    );

    res.redirect(`/equipment/${result.rows[0].id}`);
  } catch (err) {
    next(err);
  }
});

// ---------- Equipment: by room ----------
// Must be registered before the "/equipment/:id" route below, since Express
// matches route patterns in registration order and ":id" would otherwise
// swallow "/equipment/by-room" as if "by-room" were an id.

app.get('/equipment/by-room', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM equipment_items ORDER BY name ASC');
    const hideClear = req.query.hide_clear === '1';

    const groups = new Map();
    for (const r of result.rows) {
      const key = normalizeText(r.location) || 'Unassigned location';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }

    let totalOverdue = 0;
    let totalDueSoon = 0;
    const urgencyRank = { overdue: 0, 'due-soon': 1, scheduled: 2, unscheduled: 3 };

    const rooms = [...groups.entries()].map(([location, items]) => {
      const withUrgency = items.map((r) => ({ ...r, urgency: equipmentUrgency(r.next_inspection_due) }));
      const overdueCount = withUrgency.filter((r) => r.urgency === 'overdue').length;
      const dueSoonCount = withUrgency.filter((r) => r.urgency === 'due-soon').length;
      totalOverdue += overdueCount;
      totalDueSoon += dueSoonCount;
      withUrgency.sort((a, b) => {
        const rankDiff = urgencyRank[a.urgency] - urgencyRank[b.urgency];
        if (rankDiff !== 0) return rankDiff;
        const aDue = a.next_inspection_due ? new Date(a.next_inspection_due).getTime() : Infinity;
        const bDue = b.next_inspection_due ? new Date(b.next_inspection_due).getTime() : Infinity;
        return aDue - bDue;
      });
      return { location, items: withUrgency, overdueCount, dueSoonCount };
    });

    rooms.sort((a, b) => {
      if (a.overdueCount !== b.overdueCount) return b.overdueCount - a.overdueCount;
      if (a.dueSoonCount !== b.dueSoonCount) return b.dueSoonCount - a.dueSoonCount;
      return a.location.localeCompare(b.location);
    });

    const urgencyBadge = { overdue: 'badge-out-of-service', 'due-soon': 'badge-needs-repair', scheduled: 'badge-operational', unscheduled: 'badge-draft' };
    const urgencyLabel = { overdue: 'Overdue', 'due-soon': 'Due soon', scheduled: 'Scheduled', unscheduled: 'Not scheduled' };

    let roomsHtml = '';
    for (const room of rooms) {
      const isClear = room.overdueCount === 0 && room.dueSoonCount === 0;
      if (hideClear && isClear) continue;

      const rowsHtml = room.items.map((r) => `
        <tr class="row-link" onclick="window.location='/equipment/${r.id}'">
          <td>${escapeHtml(r.name)}</td>
          <td><span class="badge ${urgencyBadge[r.urgency]}">${urgencyLabel[r.urgency]}</span></td>
          <td>${formatDate(r.next_inspection_due)}</td>
          <td><span class="badge ${equipmentBadgeClass(r.status)}">${escapeHtml(r.status)}</span></td>
          <td onclick="event.stopPropagation();">
            <form method="post" action="/equipment/${r.id}/check">
              <input type="hidden" name="return_to" value="by-room">
              <button type="submit" class="btn btn-secondary" style="padding:6px 12px;font-size:12px;">Log check</button>
            </form>
          </td>
        </tr>
      `).join('');

      const summary = isClear
        ? 'All clear'
        : [room.overdueCount ? `${room.overdueCount} overdue` : '', room.dueSoonCount ? `${room.dueSoonCount} due soon` : ''].filter(Boolean).join(' · ');

      roomsHtml += `
        <div class="form-section-title" style="display:flex;justify-content:space-between;align-items:baseline;">
          <span>${escapeHtml(room.location)}</span>
          <span style="font-size:12px;font-weight:500;color:${isClear ? '#2F7D5A' : '#B7791F'};">${summary}</span>
        </div>
        <div class="card">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Next inspection</th>
                <th>Condition</th>
                <th></th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      `;
    }

    if (!roomsHtml) {
      roomsHtml = `<div class="empty-state">${result.rows.length === 0 ? 'No equipment recorded yet.' : 'Nothing overdue or due soon — every room is all clear.'}</div>`;
    }

    const body = `
      <a class="back-link" href="/equipment">← Back to Equipment</a>
      <div class="page-header">
        <div>
          <h1 class="page-title">Equipment by room</h1>
          <p class="page-subtitle">${(totalOverdue || totalDueSoon) ? `${totalOverdue} overdue · ${totalDueSoon} due soon across ${rooms.length} room${rooms.length === 1 ? '' : 's'}.` : 'Nothing overdue or due soon right now.'}</p>
        </div>
      </div>
      <div class="checkbox-row" style="margin-bottom:16px;">
        <input type="checkbox" id="hide_clear" ${hideClear ? 'checked' : ''} onchange="window.location='/equipment/by-room' + (this.checked ? '?hide_clear=1' : '')">
        <label for="hide_clear">Hide rooms that are all clear</label>
      </div>
      ${roomsHtml}
    `;

    res.send(page({ title: 'Equipment by room', active: 'equipment', body }));
  } catch (err) {
    next(err);
  }
});

// ---------- Equipment: detail ----------

app.get('/equipment/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT e.*, p.activity_name AS pera_name
       FROM equipment_items e
       LEFT JOIN pera_records p ON p.id = e.pera_id
       WHERE e.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).send('Equipment item not found.');
    }
    const r = result.rows[0];
    const checklist = Array.isArray(r.checklist_items) ? r.checklist_items : [];

    const checksResult = await pool.query(
      'SELECT * FROM equipment_checks WHERE equipment_id = $1 ORDER BY checked_at DESC LIMIT 10',
      [r.id]
    );

    const checklistHtml = checklist.length
      ? checklist.map((item, i) => `
          <div class="checkbox-row" style="margin-bottom:8px;">
            <input type="checkbox" id="ci_${i}" name="completed_items" value="${escapeHtml(item)}" checked>
            <label for="ci_${i}">${escapeHtml(item)}</label>
          </div>
        `).join('')
      : '<div class="form-section-hint" style="margin:0 0 12px 0;">No checklist items set for this item — <a href="/admin/equipment/' + r.id + '/edit" style="color:#1B5E52;font-weight:600;">add some</a> so a check has something to tick off.</div>';

    const historyHtml = checksResult.rows.length
      ? checksResult.rows.map((c) => `
          <div class="detail-section">
            <div class="detail-label">${formatDateTime(c.checked_at)}${c.checked_by ? ` · ${escapeHtml(c.checked_by)}` : ''}</div>
            <div class="detail-value">${
              (Array.isArray(c.completed_items) && c.completed_items.length)
                ? escapeHtml(c.completed_items.join(', '))
                : 'No checklist items recorded'
            }${c.notes ? `<br>${escapeHtml(c.notes)}` : ''}</div>
          </div>
        `).join('')
      : '<div class="form-section-hint" style="margin:0;">No checks logged yet.</div>';

    const body = `
      <a class="back-link" href="/equipment">← Back to Equipment</a>
      <div class="page-header">
        <div>
          <h1 class="page-title">${escapeHtml(r.name)}</h1>
          <p class="page-subtitle">${escapeHtml(r.category || 'Equipment')}${r.location ? ` · ${escapeHtml(r.location)}` : ''}</p>
        </div>
        <span class="badge ${equipmentBadgeClass(r.status)}">${escapeHtml(r.status)}</span>
      </div>
      <div class="detail-grid">
        <div>
          <div class="detail-section">
            <div class="detail-label">Linked PERA</div>
            <div class="detail-value">${r.pera_id ? `<a href="/pera/${r.pera_id}" style="color:#1B5E52;font-weight:600;">${escapeHtml(r.pera_name)}</a>` : 'None'}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Last inspected</div>
            <div class="detail-value">${formatDate(r.last_inspected)}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Next inspection due</div>
            <div class="detail-value">${formatDate(r.next_inspection_due)}${r.inspection_frequency ? ` (checked every ${escapeHtml(r.inspection_frequency)})` : ''}</div>
          </div>
          ${r.notes ? `
          <div class="detail-section">
            <div class="detail-label">Notes</div>
            <div class="detail-value">${escapeHtml(r.notes)}</div>
          </div>` : ''}
          <div class="form-section-title" style="margin-top:32px;">Check history</div>
          ${historyHtml}
        </div>
        <div>
          <div class="card" style="padding:22px;margin-bottom:20px;">
            <div class="note-box">Keep this record up to date after every inspection or repair — it's what the equipment register relies on to flag what needs attention.</div>
            <a class="btn btn-secondary" href="/admin/equipment/${r.id}/edit" style="width:100%;display:block;text-align:center;box-sizing:border-box;margin-top:14px;">Edit this item</a>
          </div>
          <div class="card" style="padding:22px;">
            <div class="form-section-title" style="margin-top:0;padding-top:0;border-top:none;">Log a check</div>
            <form method="post" action="/equipment/${r.id}/check">
              ${checklistHtml}
              <div class="form-row" style="margin-top:12px;">
                <label for="checked_by">Checked by</label>
                <input type="text" id="checked_by" name="checked_by" placeholder="Your name">
              </div>
              <div class="form-row">
                <label for="check_notes">Notes</label>
                <textarea id="check_notes" name="notes" placeholder="Anything noticed during this check..."></textarea>
              </div>
              <div class="form-actions">
                <button type="submit" class="btn btn-primary">Log check</button>
              </div>
            </form>
          </div>
        </div>
      </div>
    `;

    res.send(page({ title: r.name, active: 'equipment', body }));
  } catch (err) {
    next(err);
  }
});

// ---------- Equipment: log a check ----------

app.post('/equipment/:id/check', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM equipment_items WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).send('Equipment item not found.');
    }
    const r = result.rows[0];

    // The full "Log a check" form on the detail page submits completed_items
    // (only the boxes left ticked) plus checked_by/notes. The one-click
    // "Log check" button on the by-room page submits none of these — treat
    // that as "the whole checklist was done, no name/notes recorded".
    const formSubmitted = 'completed_items' in req.body || 'checked_by' in req.body || 'notes' in req.body;
    const completedItems = formSubmitted
      ? toArray(req.body.completed_items).map((v) => normalizeText(v))
      : (Array.isArray(r.checklist_items) ? r.checklist_items : []);
    const checkedBy = formSubmitted ? (normalizeText(req.body.checked_by) || null) : null;
    const checkNotes = formSubmitted ? (normalizeText(req.body.notes) || null) : null;

    const today = new Date();
    const nextDue = computeNextDue(today, r.inspection_frequency);

    await pool.query(
      `INSERT INTO equipment_checks (equipment_id, checked_by, completed_items, notes)
       VALUES ($1,$2,$3,$4)`,
      [r.id, checkedBy, JSON.stringify(completedItems), checkNotes]
    );
    await pool.query(
      `UPDATE equipment_items SET last_inspected = $1, next_inspection_due = $2, updated_at = now() WHERE id = $3`,
      [today, nextDue, r.id]
    );

    res.redirect(req.body.return_to === 'by-room' ? '/equipment/by-room' : `/equipment/${r.id}`);
  } catch (err) {
    next(err);
  }
});

// ---------- Admin: login ----------

app.get('/admin/login', (req, res) => {
  const next = typeof req.query.next === 'string' && req.query.next.startsWith('/') ? req.query.next : '/admin';
  const body = `
    <div class="form-card" style="max-width:380px;margin:60px auto;">
      <h1 class="page-title" style="margin-bottom:20px;">Admin sign in</h1>
      <form method="post" action="/admin/login">
        <input type="hidden" name="next" value="${escapeHtml(next)}">
        <div class="form-row">
          <label for="password">Admin password</label>
          <input type="password" id="password" name="password" required autofocus>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary" style="width:100%;">Sign in</button>
        </div>
      </form>
    </div>
  `;
  res.send(page({ title: 'Admin sign in', active: '', body }));
});

app.post('/admin/login', (req, res) => {
  const { password, next } = req.body;
  const target = typeof next === 'string' && next.startsWith('/') ? next : '/admin';

  if (ADMIN_PASSWORD && password === ADMIN_PASSWORD) {
    res.setHeader(
      'Set-Cookie',
      `admin_token=${ADMIN_TOKEN}; HttpOnly; Secure; Path=/; Max-Age=2592000; SameSite=Lax`
    );
    return res.redirect(target);
  }

  res.status(401).send('Incorrect password. <a href="/admin/login">Try again</a>');
});

app.post('/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'admin_token=; HttpOnly; Secure; Path=/; Max-Age=0');
  res.redirect('/pera');
});

// ---------- Admin: records list ----------

app.get('/admin', requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM pera_records ORDER BY id');
    const caraResult = await pool.query('SELECT * FROM cara_records ORDER BY id');
    const equipmentResult = await pool.query('SELECT * FROM equipment_items ORDER BY name ASC');

    const rows = result.rows.map((r) => `
      <tr class="row-link" onclick="window.location='/admin/pera/${r.id}/edit'">
        <td>${escapeHtml(r.activity_name)}</td>
        <td>${escapeHtml(r.class_unit || '—')}</td>
        <td><span class="badge ${riskBadgeClass(r.risk_level)}">${escapeHtml(r.risk_level)}</span></td>
        <td><span class="badge ${statusBadgeClass(r.status)}">${escapeHtml(r.status)}</span></td>
        <td>${escapeHtml(r.approver || '—')}</td>
      </tr>
    `).join('');

    const caraRows = caraResult.rows.map((r) => `
      <tr class="row-link" onclick="window.location='/admin/cara/${r.id}/edit'">
        <td>${escapeHtml(r.activity_name)}</td>
        <td>${escapeHtml(r.class_unit || '—')}</td>
        <td><span class="badge ${riskBadgeClass(r.risk_level)}">${escapeHtml(r.risk_level)}</span></td>
        <td><span class="badge ${statusBadgeClass(r.status)}">${escapeHtml(r.status)}</span></td>
        <td>${escapeHtml(r.submitted_by || '—')}</td>
      </tr>
    `).join('');

    const equipmentRows = equipmentResult.rows.map((r) => `
      <tr class="row-link" onclick="window.location='/admin/equipment/${r.id}/edit'">
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.category || '—')}</td>
        <td>${escapeHtml(r.location || '—')}</td>
        <td><span class="badge ${equipmentBadgeClass(r.status)}">${escapeHtml(r.status)}</span></td>
      </tr>
    `).join('');

    const body = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Admin</h1>
          <p class="page-subtitle">Click any record to edit or delete it.</p>
        </div>
        <form method="post" action="/admin/logout">
          <button type="submit" class="btn btn-secondary">Sign out</button>
        </form>
      </div>
      <div class="form-section-title" style="margin-top:0;padding-top:0;border-top:none;">PERA records</div>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>Activity</th>
              <th>Class / unit</th>
              <th>Risk</th>
              <th>Status</th>
              <th>Approver</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="form-section-title">CARA records</div>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>Activity</th>
              <th>Class / unit</th>
              <th>Risk</th>
              <th>Status</th>
              <th>Teacher</th>
            </tr>
          </thead>
          <tbody>${caraRows || '<tr><td colspan="5" style="text-align:center;color:#6B6659;padding:24px;">No CARA records yet.</td></tr>'}</tbody>
        </table>
      </div>
      <div class="form-section-title">Equipment</div>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Category</th>
              <th>Location</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>${equipmentRows || '<tr><td colspan="4" style="text-align:center;color:#6B6659;padding:24px;">No equipment recorded yet.</td></tr>'}</tbody>
        </table>
      </div>
    `;

    res.send(page({ title: 'Admin', active: 'admin', body }));
  } catch (err) {
    next(err);
  }
});

// ---------- Admin: edit a record ----------

app.get('/admin/pera/:id/edit', requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM pera_records WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).send('PERA record not found.');
    }
    const r = result.rows[0];

    const riskOptions = RISK_LEVELS.map((l) => `<option value="${l}" ${l === r.risk_level ? 'selected' : ''}>${l}</option>`).join('');
    const statusOptions = STATUSES.map((s) => `<option value="${s}" ${s === r.status ? 'selected' : ''}>${s}</option>`).join('');

    const body = `
      <a class="back-link" href="/admin">← Back to Admin</a>
      <h1 class="page-title" style="margin-bottom:24px;">Edit: ${escapeHtml(r.activity_name)}</h1>
      <form class="form-card" method="post" action="/admin/pera/${r.id}">
        <div class="form-row">
          <label for="activity_name">Activity name</label>
          <input type="text" id="activity_name" name="activity_name" value="${escapeHtml(r.activity_name)}" required>
        </div>
        <div class="form-row">
          <label for="class_unit">Class / unit</label>
          <input type="text" id="class_unit" name="class_unit" value="${escapeHtml(r.class_unit || '')}">
        </div>
        <div class="form-row">
          <label for="risk_level">Risk level</label>
          <select id="risk_level" name="risk_level" required>${riskOptions}</select>
        </div>
        <div class="form-row">
          <label for="status">Status</label>
          <select id="status" name="status" required>${statusOptions}</select>
        </div>
        <div class="form-row">
          <label for="hazards">Hazards identified</label>
          <textarea id="hazards" name="hazards">${escapeHtml(r.hazards || '')}</textarea>
        </div>
        <div class="form-row">
          <label for="control_measures">Control measures</label>
          <textarea id="control_measures" name="control_measures">${escapeHtml(r.control_measures || '')}</textarea>
        </div>
        <div class="form-row">
          <label for="required_supervision">Required supervision</label>
          <input type="text" id="required_supervision" name="required_supervision" value="${escapeHtml(r.required_supervision || '')}">
        </div>
        <div class="form-row checkbox-row">
          <input type="checkbox" id="consent_required" name="consent_required" value="true" ${r.consent_required ? 'checked' : ''}>
          <label for="consent_required">Parent consent required</label>
        </div>
        <div class="form-row">
          <label for="submitted_by">Submitted by</label>
          <input type="text" id="submitted_by" name="submitted_by" value="${escapeHtml(r.submitted_by || '')}">
        </div>
        <div class="form-row">
          <label for="approver">Approver</label>
          <input type="text" id="approver" name="approver" value="${escapeHtml(r.approver || '')}">
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Save changes</button>
          <a class="btn btn-secondary" href="/admin">Cancel</a>
        </div>
      </form>
      <form method="post" action="/admin/pera/${r.id}/delete" style="margin-top:16px;" onsubmit="return confirm('Delete this record permanently? This cannot be undone.');">
        <button type="submit" class="btn btn-secondary" style="color:#B3261E;border-color:#B3261E;">Delete this record</button>
      </form>
    `;

    res.send(page({ title: `Edit — ${r.activity_name}`, active: 'admin', body }));
  } catch (err) {
    next(err);
  }
});

app.post('/admin/pera/:id', requireAdmin, async (req, res, next) => {
  try {
    const {
      activity_name, class_unit, risk_level, status,
      hazards, control_measures, required_supervision,
      consent_required, submitted_by, approver,
    } = req.body;

    if (!activity_name || !RISK_LEVELS.includes(risk_level) || !STATUSES.includes(status)) {
      return res.status(400).send('Activity name, a valid risk level and a valid status are required.');
    }

    await pool.query(
      `UPDATE pera_records SET
         activity_name = $1, class_unit = $2, risk_level = $3, status = $4,
         hazards = $5, control_measures = $6, required_supervision = $7, consent_required = $8,
         submitted_by = $9, approver = $10, updated_at = now()
       WHERE id = $11`,
      [
        normalizeText(activity_name), normalizeText(class_unit) || null, risk_level, status,
        normalizeText(hazards) || null, normalizeText(control_measures) || null, normalizeText(required_supervision) || null,
        consent_required === 'true', normalizeText(submitted_by) || null, normalizeText(approver) || null,
        req.params.id,
      ]
    );

    res.redirect(`/admin/pera/${req.params.id}/edit`);
  } catch (err) {
    next(err);
  }
});

app.post('/admin/pera/:id/delete', requireAdmin, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM pera_records WHERE id = $1', [req.params.id]);
    res.redirect('/admin');
  } catch (err) {
    next(err);
  }
});

// ---------- Admin: edit a CARA record ----------

app.get('/admin/cara/:id/edit', requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM cara_records WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).send('CARA record not found.');
    }
    const r = result.rows[0];

    const riskOptions = RISK_LEVELS.map((l) => `<option value="${l}" ${l === r.risk_level ? 'selected' : ''}>${l}</option>`).join('');
    const statusOptions = STATUSES.map((s) => `<option value="${s}" ${s === r.status ? 'selected' : ''}>${s}</option>`).join('');

    const body = `
      <a class="back-link" href="/admin">← Back to Admin</a>
      <h1 class="page-title" style="margin-bottom:24px;">Edit CARA: ${escapeHtml(r.activity_name)}</h1>
      <form class="form-card" method="post" action="/admin/cara/${r.id}" style="max-width:760px;">
        <div class="form-row">
          <label for="activity_name">Activity name</label>
          <input type="text" id="activity_name" name="activity_name" value="${escapeHtml(r.activity_name)}" required>
        </div>
        <div class="form-row">
          <label for="class_unit">Class / unit</label>
          <input type="text" id="class_unit" name="class_unit" value="${escapeHtml(r.class_unit || '')}">
        </div>
        <div class="form-row">
          <label for="activity_scope">Activity scope</label>
          <textarea id="activity_scope" name="activity_scope">${escapeHtml(r.activity_scope || '')}</textarea>
        </div>
        <div class="form-row">
          <label for="risk_level">Risk level</label>
          <select id="risk_level" name="risk_level" required>${riskOptions}</select>
        </div>
        <div class="form-row">
          <label for="status">Status</label>
          <select id="status" name="status" required>${statusOptions}</select>
        </div>
        <div class="form-row">
          <label for="students_notes">Students</label>
          <textarea id="students_notes" name="students_notes">${escapeHtml(r.students_notes || '')}</textarea>
        </div>
        <div class="form-row">
          <label for="emergency_first_aid">Emergency and first aid</label>
          <textarea id="emergency_first_aid" name="emergency_first_aid">${escapeHtml(r.emergency_first_aid || '')}</textarea>
        </div>
        <div class="form-row">
          <label for="induction_instruction">Induction and instruction</label>
          <textarea id="induction_instruction" name="induction_instruction">${escapeHtml(r.induction_instruction || '')}</textarea>
        </div>
        <div class="form-row checkbox-row">
          <input type="checkbox" id="consent_required" name="consent_required" value="true" ${r.consent_required ? 'checked' : ''}>
          <label for="consent_required">Parent consent required</label>
        </div>
        <div class="form-row">
          <label for="supervision_notes">Supervision</label>
          <textarea id="supervision_notes" name="supervision_notes">${escapeHtml(r.supervision_notes || '')}</textarea>
        </div>
        <div class="form-row">
          <label for="supervisor_qualification">Supervisor qualification</label>
          <textarea id="supervisor_qualification" name="supervisor_qualification">${escapeHtml(r.supervisor_qualification || '')}</textarea>
        </div>
        <div class="form-row">
          <label for="facilities_equipment">Facilities and equipment</label>
          <textarea id="facilities_equipment" name="facilities_equipment">${escapeHtml(r.facilities_equipment || '')}</textarea>
        </div>
        <div class="form-row">
          <label for="environmental_hazards">Environmental hazards</label>
          <textarea id="environmental_hazards" name="environmental_hazards">${escapeHtml(r.environmental_hazards || '')}</textarea>
        </div>
        <div class="form-row">
          <label for="environmental_controls">Environmental control measures</label>
          <textarea id="environmental_controls" name="environmental_controls">${escapeHtml(r.environmental_controls || '')}</textarea>
        </div>
        <div class="form-row">
          <label for="facilities_hazards">Facilities and equipment hazards</label>
          <textarea id="facilities_hazards" name="facilities_hazards">${escapeHtml(r.facilities_hazards || '')}</textarea>
        </div>
        <div class="form-row">
          <label for="facilities_controls">Facilities and equipment control measures</label>
          <textarea id="facilities_controls" name="facilities_controls">${escapeHtml(r.facilities_controls || '')}</textarea>
        </div>
        <div class="form-row">
          <label for="student_hazards">Student hazards</label>
          <textarea id="student_hazards" name="student_hazards">${escapeHtml(r.student_hazards || '')}</textarea>
        </div>
        <div class="form-row">
          <label for="student_controls">Student control measures</label>
          <textarea id="student_controls" name="student_controls">${escapeHtml(r.student_controls || '')}</textarea>
        </div>
        <div class="form-row">
          <label for="submitted_by">Submitted by</label>
          <input type="text" id="submitted_by" name="submitted_by" value="${escapeHtml(r.submitted_by || '')}">
        </div>
        <div class="form-row">
          <label for="approver">Approver</label>
          <input type="text" id="approver" name="approver" value="${escapeHtml(r.approver || '')}">
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Save changes</button>
          <a class="btn btn-secondary" href="/admin">Cancel</a>
        </div>
      </form>
      <form method="post" action="/admin/cara/${r.id}/delete" style="margin-top:16px;" onsubmit="return confirm('Delete this CARA record permanently? This cannot be undone.');">
        <button type="submit" class="btn btn-secondary" style="color:#B3261E;border-color:#B3261E;">Delete this record</button>
      </form>
    `;

    res.send(page({ title: `Edit — ${r.activity_name}`, active: 'admin', body }));
  } catch (err) {
    next(err);
  }
});

app.post('/admin/cara/:id', requireAdmin, async (req, res, next) => {
  try {
    const {
      activity_name, class_unit, activity_scope, risk_level, status,
      students_notes, emergency_first_aid, induction_instruction, consent_required,
      supervision_notes, supervisor_qualification, facilities_equipment,
      environmental_hazards, environmental_controls,
      facilities_hazards, facilities_controls,
      student_hazards, student_controls,
      submitted_by, approver,
    } = req.body;

    if (!activity_name || !RISK_LEVELS.includes(risk_level) || !STATUSES.includes(status)) {
      return res.status(400).send('Activity name, a valid risk level and a valid status are required.');
    }

    await pool.query(
      `UPDATE cara_records SET
         activity_name = $1, class_unit = $2, activity_scope = $3, risk_level = $4, status = $5,
         students_notes = $6, emergency_first_aid = $7, induction_instruction = $8, consent_required = $9,
         supervision_notes = $10, supervisor_qualification = $11, facilities_equipment = $12,
         environmental_hazards = $13, environmental_controls = $14,
         facilities_hazards = $15, facilities_controls = $16,
         student_hazards = $17, student_controls = $18,
         submitted_by = $19, approver = $20, updated_at = now()
       WHERE id = $21`,
      [
        normalizeText(activity_name), normalizeText(class_unit) || null, normalizeText(activity_scope) || null, risk_level, status,
        normalizeText(students_notes) || null, normalizeText(emergency_first_aid) || null, normalizeText(induction_instruction) || null, consent_required === 'true',
        normalizeText(supervision_notes) || null, normalizeText(supervisor_qualification) || null, normalizeText(facilities_equipment) || null,
        normalizeText(environmental_hazards) || null, normalizeText(environmental_controls) || null,
        normalizeText(facilities_hazards) || null, normalizeText(facilities_controls) || null,
        normalizeText(student_hazards) || null, normalizeText(student_controls) || null,
        normalizeText(submitted_by) || null, normalizeText(approver) || null,
        req.params.id,
      ]
    );

    res.redirect(`/admin/cara/${req.params.id}/edit`);
  } catch (err) {
    next(err);
  }
});

app.post('/admin/cara/:id/delete', requireAdmin, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM cara_records WHERE id = $1', [req.params.id]);
    res.redirect('/admin');
  } catch (err) {
    next(err);
  }
});

// ---------- Admin: edit an Equipment item ----------

app.get('/admin/equipment/:id/edit', requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM equipment_items WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).send('Equipment item not found.');
    }
    const r = result.rows[0];

    const peraResult = await pool.query('SELECT id, activity_name FROM pera_records ORDER BY activity_name ASC');
    const statusOptions = EQUIPMENT_STATUSES.map((s) => `<option value="${s}" ${s === r.status ? 'selected' : ''}>${s}</option>`).join('');
    const peraOptions = [
      '<option value="">— None —</option>',
      ...peraResult.rows.map((p) => `<option value="${p.id}" ${p.id === r.pera_id ? 'selected' : ''}>${escapeHtml(p.activity_name)}</option>`),
    ].join('');
    // Category shares the same master tool list as "Linked PERA" (rather than
    // a free-text field), so equipment is tagged with the school's existing
    // standard tool names instead of ad hoc category labels.
    const categoryOptions = [
      '<option value="">— None —</option>',
      ...peraResult.rows.map((p) => `<option value="${escapeHtml(p.activity_name)}" ${p.activity_name === r.category ? 'selected' : ''}>${escapeHtml(p.activity_name)}</option>`),
    ].join('');

    const body = `
      <a class="back-link" href="/admin">← Back to Admin</a>
      <h1 class="page-title" style="margin-bottom:24px;">Edit: ${escapeHtml(r.name)}</h1>
      <form class="form-card" method="post" action="/admin/equipment/${r.id}">
        <div class="form-row">
          <label for="name">Name</label>
          <input type="text" id="name" name="name" value="${escapeHtml(r.name)}" required>
        </div>
        <div class="form-row">
          <label for="category">Category</label>
          <select id="category" name="category">${categoryOptions}</select>
        </div>
        <div class="form-row">
          <label for="location">Location</label>
          <input type="text" id="location" name="location" value="${escapeHtml(r.location || '')}">
        </div>
        <div class="form-row">
          <label for="status">Status</label>
          <select id="status" name="status" required>${statusOptions}</select>
        </div>
        <div class="form-row">
          <label for="pera_id">Linked PERA</label>
          <select id="pera_id" name="pera_id">${peraOptions}</select>
        </div>
        <div class="form-row">
          <label for="last_inspected">Last inspected</label>
          <input type="date" id="last_inspected" name="last_inspected" value="${toDateInputValue(r.last_inspected)}">
        </div>
        <div class="form-row">
          <label for="next_inspection_due">Next inspection due</label>
          <input type="date" id="next_inspection_due" name="next_inspection_due" value="${toDateInputValue(r.next_inspection_due)}">
        </div>
        <div class="form-row">
          <label for="inspection_frequency">Inspection frequency</label>
          <select id="inspection_frequency" name="inspection_frequency">
            <option value="">— None —</option>
            ${equipmentFrequencyOptions(r.inspection_frequency || '')}
          </select>
        </div>
        ${checklistBuilderHtml(Array.isArray(r.checklist_items) ? r.checklist_items : [])}
        <div class="form-row">
          <label for="notes">Notes</label>
          <textarea id="notes" name="notes">${escapeHtml(r.notes || '')}</textarea>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Save changes</button>
          <a class="btn btn-secondary" href="/admin">Cancel</a>
        </div>
      </form>
      <form method="post" action="/admin/equipment/${r.id}/delete" style="margin-top:16px;" onsubmit="return confirm('Delete this equipment item permanently? This cannot be undone.');">
        <button type="submit" class="btn btn-secondary" style="color:#B3261E;border-color:#B3261E;">Delete this item</button>
      </form>
    `;

    res.send(page({ title: `Edit — ${r.name}`, active: 'admin', body }));
  } catch (err) {
    next(err);
  }
});

app.post('/admin/equipment/:id', requireAdmin, async (req, res, next) => {
  try {
    const {
      name, category, location, status, pera_id, last_inspected, next_inspection_due, notes,
      inspection_frequency, checklist_items,
    } = req.body;

    if (!name || !EQUIPMENT_STATUSES.includes(status)) {
      return res.status(400).send('Name and a valid status are required.');
    }
    const frequency = EQUIPMENT_FREQUENCIES.includes(inspection_frequency) ? inspection_frequency : null;

    await pool.query(
      `UPDATE equipment_items SET
         name = $1, category = $2, location = $3, status = $4, pera_id = $5,
         last_inspected = $6, next_inspection_due = $7, notes = $8,
         inspection_frequency = $9, checklist_items = $10, updated_at = now()
       WHERE id = $11`,
      [
        normalizeText(name), normalizeText(category) || null, normalizeText(location) || null, status,
        pera_id || null, last_inspected || null, next_inspection_due || null, normalizeText(notes) || null,
        frequency, JSON.stringify(parseChecklistText(checklist_items)),
        req.params.id,
      ]
    );

    res.redirect(`/admin/equipment/${req.params.id}/edit`);
  } catch (err) {
    next(err);
  }
});

app.post('/admin/equipment/:id/delete', requireAdmin, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM equipment_items WHERE id = $1', [req.params.id]);
    res.redirect('/admin');
  } catch (err) {
    next(err);
  }
});

// ---------- Health check ----------

app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).send('ok');
  } catch (err) {
    res.status(500).send('db error');
  }
});

// ---------- Error handler ----------

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong on our end. Please try again.');
});

migrate()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`School Guard listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to run database migration:', err);
    process.exit(1);
  });
