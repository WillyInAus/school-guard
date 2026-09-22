const express = require('express');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { pool, migrate } = require('./db');
const { page, escapeHtml } = require('./views/layout');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.static('public'));

const RISK_LEVELS = ['Low', 'Medium', 'High', 'Extreme'];
const STATUSES = ['Draft', 'Pending approval', 'Approved', 'Changes requested'];
const EQUIPMENT_CATEGORIES = ['Power tool', 'Hand tool', 'Fixed machinery', 'Electrical test equipment', 'PPE', 'Mobile plant/vehicle', 'Other'];
const EQUIPMENT_STATUSES = ['In service', 'Under repair', 'Out of service', 'Awaiting disposal'];
const INSPECTION_FREQUENCIES = ['Daily', 'Week', 'Term', 'Semester', 'Yearly'];
// Starter checklist items every newly-created piece of equipment is seeded
// with (see POST /admin/equipment below). From there, each item's own
// checklist is fully editable per-tool from its Edit page — add/rename/
// remove items as needed (e.g. a disk sander gets "Sanding disc condition"
// and "Vibration" added; a hand tool might have most of these removed).
const DEFAULT_CHECK_ITEMS = [
  'Equipment in working order',
  'Guards in place',
  'Emergency stop and isolation switches in good working condition',
  'Test & tagged in date',
  'Area clean and tidy',
  'SOP available and updated',
];

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

function equipmentStatusBadgeClass(status) {
  return {
    'In service': 'badge-approved',
    'Under repair': 'badge-pending',
    'Out of service': 'badge-changes',
    'Awaiting disposal': 'badge-draft',
  }[status] || 'badge-draft';
}

function inspectionBadge(nextDue) {
  if (!nextDue) return { cls: 'badge-draft', label: 'Not scheduled' };
  const due = new Date(nextDue);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysUntil = Math.round((due - today) / msPerDay);
  if (daysUntil < 0) return { cls: 'badge-changes', label: `Overdue — ${formatDate(nextDue)}` };
  if (daysUntil <= 30) return { cls: 'badge-pending', label: `Due soon — ${formatDate(nextDue)}` };
  return { cls: 'badge-approved', label: formatDate(nextDue) };
}

// Inspection due dates are calculated from a school-calendar interval
// rather than a raw number of months. "Term" is approximated as a quarter
// of the year (a school term runs roughly 10 weeks) since terms don't line
// up with calendar months.
function addInspectionInterval(dateStr, frequency) {
  if (!dateStr || !frequency) return null;
  const d = new Date(dateStr);
  // Use the UTC setters (not setMonth/setDate/setFullYear, which operate in
  // the server's local timezone) so a daylight-saving transition falling
  // inside the interval can't shift the result by a day.
  switch (frequency) {
    case 'Daily':
      d.setUTCDate(d.getUTCDate() + 1);
      break;
    case 'Week':
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case 'Term':
      d.setUTCMonth(d.getUTCMonth() + 3);
      break;
    case 'Semester':
      d.setUTCMonth(d.getUTCMonth() + 6);
      break;
    case 'Yearly':
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      break;
    default:
      return null;
  }
  return d.toISOString().slice(0, 10);
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
    const equipmentTotalResult = await pool.query('SELECT COUNT(*)::int AS count FROM equipment_records WHERE archived = false');
    const equipmentOverdueResult = await pool.query(
      "SELECT COUNT(*)::int AS count FROM equipment_records WHERE archived = false AND next_inspection_due IS NOT NULL AND next_inspection_due < CURRENT_DATE"
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
          <div class="stat-label">Inspections overdue</div>
          <div class="stat-value">${equipmentOverdueResult.rows[0].count}</div>
        </div>
      </div>
      <div class="card" style="padding: 24px;">
        <p style="margin:0;font-size:14px;color:#6B6659;">
          <a href="/pera" style="color:#1B5E52;font-weight:600;">PERA</a> holds the equipment/tool
          risk assessment library (Plant &amp; Equipment Risk Assessments). <a href="/cara" style="color:#1B5E52;font-weight:600;">CARA</a> is where teachers put
          together a Curriculum Activity Risk Assessment for a class or activity, drawing on tools from that library.
          <a href="/equipment" style="color:#1B5E52;font-weight:600;">Equipment</a> is the physical asset register — inventory,
          location, condition and inspection/test-and-tag due dates.
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
      return `<a class="chip${isActive ? ' active' : ''}" href="${href}">${level}</a>`;
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
          <p class="page-subtitle">Plant and equipment risk assessments (PERA) for tools and machinery across IDT and VET workshops.</p>
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
        activity_name, class_unit || null, risk_level,
        hazards || null, control_measures || null, required_supervision || null,
        consent_required === 'true', submitted_by || null,
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
      return `<a class="chip${isActive ? ' active' : ''}" href="${href}">${level}</a>`;
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
      toolListHtml += `<div class="tool-picker-group-label">${escapeHtml(group)}</div>`;
      toolListHtml += tools.map((t) => `
        <div class="tool-picker-item" data-search="${escapeHtml(t.activity_name.toLowerCase())}">
          <input type="checkbox" id="tool_${t.id}" name="tool_ids" value="${t.id}">
          <label for="tool_${t.id}">${escapeHtml(t.activity_name)}</label>
          <span class="badge ${riskBadgeClass(t.risk_level)}">${escapeHtml(t.risk_level)}</span>
        </div>
      `).join('');
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
          document.querySelectorAll('.tool-picker-item[data-search]').forEach((item) => {
            item.style.display = item.dataset.search.includes(q) ? '' : 'none';
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
        activity_name, class_unit || null, activity_scope || null, risk_level,
        students_notes || null, emergency_first_aid || null, induction_instruction || null, consent_required === 'true',
        supervision_notes || null, supervisor_qualification || null, facilities_equipment || null,
        environmental_hazards || null, environmental_controls || null,
        facilities_hazards || null, facilities_controls || null,
        student_hazards || null, student_controls || null,
        submitted_by || null,
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

    res.redirect(`/cara/${caraId}`);
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

    doc.fontSize(9).fillColor(MUTED).text('School Guard — Faith Lutheran College', { align: 'left' });
    doc.moveDown(0.3);
    doc.fontSize(16).fillColor(GREEN).text('Curriculum Activity Risk Assessment (CARA)');
    doc.moveDown(0.2);
    doc.fontSize(13).fillColor(TEXT).text(r.activity_name || 'Untitled activity');
    doc.fontSize(9).fillColor(MUTED).text(
      `${r.class_unit || 'Class/unit not set'}   ·   Risk level: ${r.risk_level}   ·   Status: ${r.status}`
    );
    doc.moveDown(0.8);

    function section(title, value) {
      doc.fontSize(10.5).fillColor(GREEN).text(title);
      doc.fontSize(10).fillColor(TEXT).text(value && String(value).trim() ? String(value) : '—');
      doc.moveDown(0.6);
    }

    section('Activity scope', r.activity_scope);

    if (toolsResult.rows.length) {
      doc.fontSize(10.5).fillColor(GREEN).text('PERA used');
      doc.fontSize(10).fillColor(TEXT).text(
        toolsResult.rows.map((t) => `${t.activity_name} (${t.risk_level})`).join(', ')
      );
      doc.moveDown(0.6);
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
      doc.fontSize(10.5).fillColor(GREEN).text('Post-activity monitoring & review');
      const yn = (v) => (v === true ? 'Yes' : v === false ? 'No' : '—');
      doc.fontSize(10).fillColor(TEXT).text(`Additional hazards identified: ${yn(r.monitoring_new_hazards)}`);
      doc.text(`Control measures effective: ${yn(r.monitoring_controls_effective)}`);
      doc.text(`Further action required: ${yn(r.monitoring_further_action)}`);
      if (r.monitoring_details) doc.text(r.monitoring_details);
      doc.fontSize(8.5).fillColor(MUTED).text(`Last reviewed ${formatDate(r.reviewed_at)}.`);
      doc.moveDown(0.6);
    }

    doc.fontSize(10.5).fillColor(GREEN).text('Teacher signature');
    doc.fontSize(10).fillColor(TEXT).text(
      `Submitted by: ${r.submitted_by || 'unknown'}${r.signed_at ? `  on  ${formatDate(r.signed_at)}` : ''}`
    );
    if (r.teacher_signature) {
      try {
        const base64 = r.teacher_signature.split(',')[1];
        const imgBuffer = Buffer.from(base64, 'base64');
        doc.moveDown(0.3);
        doc.image(imgBuffer, { fit: [200, 80] });
      } catch (e) {
        doc.fontSize(9).fillColor(MUTED).text('(signature image could not be rendered)');
      }
    } else {
      doc.fontSize(9).fillColor(MUTED).text('No signature captured.');
    }

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
        toBool(monitoring_further_action), monitoring_details || null,
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

// ---------- Equipment Register: list ----------
// Physical asset inventory for tools/machinery/PPE — separate from PERA (which
// documents the risk assessment for a piece of plant/equipment). An equipment
// item can optionally link to the PERA record that covers it. Viewing is open
// to all staff; adding/editing/deleting is admin-only (see /admin/equipment/*).

app.get('/equipment', async (req, res, next) => {
  try {
    const { category, status, q, overdue } = req.query;
    const showArchived = req.query.archived === '1';
    const conditions = [];
    const params = [];

    params.push(showArchived);
    conditions.push(`e.archived = $${params.length}`);

    if (category && EQUIPMENT_CATEGORIES.includes(category)) {
      params.push(category);
      conditions.push(`e.category = $${params.length}`);
    }
    if (status && EQUIPMENT_STATUSES.includes(status)) {
      params.push(status);
      conditions.push(`e.status = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      conditions.push(`(e.name ILIKE $${params.length} OR e.asset_tag ILIKE $${params.length} OR e.serial_number ILIKE $${params.length})`);
    }
    if (overdue === '1') {
      conditions.push(`e.next_inspection_due IS NOT NULL AND e.next_inspection_due < CURRENT_DATE`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT e.*, p.activity_name AS pera_name
       FROM equipment_records e
       LEFT JOIN pera_records p ON p.id = e.pera_id
       ${where} ORDER BY e.name ASC`,
      params
    );

    const catChips = ['All', ...EQUIPMENT_CATEGORIES].map((cat) => {
      const isActive = cat === 'All' ? !category : category === cat;
      const chipParams = new URLSearchParams();
      if (cat !== 'All') chipParams.set('category', cat);
      if (status) chipParams.set('status', status);
      if (showArchived) chipParams.set('archived', '1');
      const qs = chipParams.toString();
      return `<a class="chip${isActive ? ' active' : ''}" href="/equipment${qs ? `?${qs}` : ''}">${cat}</a>`;
    }).join('');

    const statusOptions = ['All', ...EQUIPMENT_STATUSES].map(
      (s) => `<option value="${s === 'All' ? '' : s}" ${(!status && s === 'All') || status === s ? 'selected' : ''}>${s}</option>`
    ).join('');

    let rowsHtml;
    if (result.rows.length === 0) {
      rowsHtml = showArchived
        ? `<div class="empty-state">No archived equipment records.</div>`
        : `<div class="empty-state">No equipment recorded yet.</div>`;
    } else {
      const rows = result.rows.map((r) => {
        const insp = inspectionBadge(r.next_inspection_due);
        return `
        <tr class="row-link" onclick="window.location='/equipment/${r.id}'">
          <td>${escapeHtml(r.name)}${r.asset_tag ? ` <span style="color:#8B8578;">(${escapeHtml(r.asset_tag)})</span>` : ''}</td>
          <td>${escapeHtml(r.category)}</td>
          <td>${escapeHtml(r.location || '—')}</td>
          <td><span class="badge ${equipmentStatusBadgeClass(r.status)}">${escapeHtml(r.status)}</span></td>
          <td><span class="badge ${insp.cls}">${insp.label}</span></td>
        </tr>
      `;
      }).join('');
      rowsHtml = `
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Category</th>
              <th>Location</th>
              <th>Status</th>
              <th>Inspection</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      `;
    }

    const body = `
      <div class="page-header">
        <div>
          <h1 class="page-title">${showArchived ? 'Archived Equipment' : 'Equipment Register'}</h1>
          <p class="page-subtitle">${showArchived
            ? 'Equipment records that have been archived and are hidden from the main register.'
            : 'Tools, machinery and PPE inventory across IDT and VET workshops, with inspection/test-and-tag due dates.'}</p>
        </div>
        ${showArchived
          ? `<a class="btn btn-secondary" href="/equipment">← Back to active</a>`
          : `<a class="btn btn-primary" href="/admin/equipment/new">+ Add equipment</a>`}
      </div>
      <div class="filter-row">
        <form method="get" action="/equipment">
          ${category ? `<input type="hidden" name="category" value="${escapeHtml(category)}">` : ''}
          ${showArchived ? `<input type="hidden" name="archived" value="1">` : ''}
          <input class="search-input" type="search" name="q" placeholder="Search name, asset tag, serial..." value="${escapeHtml(q || '')}">
          <select name="status" onchange="this.form.submit()">${statusOptions}</select>
        </form>
        <div class="chip-row">${catChips}</div>
      </div>
      <p style="margin:-10px 0 18px;">
        <a href="/equipment?overdue=1${showArchived ? '&archived=1' : ''}" style="font-size:13px;color:#B3261E;text-decoration:underline;">Show overdue inspections only →</a>
        &nbsp;·&nbsp; <a href="/equipment/by-room" style="font-size:13px;color:#1B5E52;text-decoration:underline;">View by room →</a>
        ${!showArchived ? ` &nbsp;·&nbsp; <a href="/equipment?archived=1" style="font-size:13px;color:#6B6659;text-decoration:underline;">View archived equipment →</a>` : ''}
      </p>
      <div class="card">${rowsHtml}</div>
    `;

    res.send(page({ title: showArchived ? 'Archived Equipment' : 'Equipment Register', active: 'equipment', body }));
  } catch (err) {
    next(err);
  }
});

// ---------- Equipment Register: by room ----------
// Groups active equipment by Location so a maintenance person can walk into
// a room and see everything there that needs checking, without hunting
// through the full register. Registered before /equipment/:id so "by-room"
// isn't swallowed as an :id.

app.get('/equipment/by-room', async (req, res, next) => {
  try {
    const onlyDue = req.query.due === '1';
    const result = await pool.query(
      `SELECT * FROM equipment_records WHERE archived = false ORDER BY name ASC`
    );

    const urgencyRank = (r) => {
      const cls = inspectionBadge(r.next_inspection_due).cls;
      if (cls === 'badge-changes') return 0; // Overdue
      if (cls === 'badge-pending') return 1; // Due soon
      if (cls === 'badge-draft') return 2; // Not scheduled
      return 3; // Ok
    };

    const groups = new Map();
    result.rows.forEach((r) => {
      const loc = r.location || 'No location assigned';
      if (!groups.has(loc)) groups.set(loc, []);
      groups.get(loc).push(r);
    });

    const roomNames = [...groups.keys()].sort((a, b) => {
      if (a === 'No location assigned') return 1;
      if (b === 'No location assigned') return -1;
      return a.localeCompare(b);
    });

    let totalOverdue = 0;
    let totalDueSoon = 0;
    result.rows.forEach((r) => {
      const cls = inspectionBadge(r.next_inspection_due).cls;
      if (cls === 'badge-changes') totalOverdue += 1;
      if (cls === 'badge-pending') totalDueSoon += 1;
    });

    const roomSections = roomNames.map((roomName) => {
      let items = groups.get(roomName).slice().sort((a, b) => {
        const rankDiff = urgencyRank(a) - urgencyRank(b);
        return rankDiff !== 0 ? rankDiff : a.name.localeCompare(b.name);
      });
      const roomOverdue = items.filter((r) => urgencyRank(r) === 0).length;
      const roomDueSoon = items.filter((r) => urgencyRank(r) === 1).length;
      if (onlyDue) items = items.filter((r) => urgencyRank(r) <= 1);
      if (items.length === 0) return '';

      const rows = items.map((r) => {
        const insp = inspectionBadge(r.next_inspection_due);
        return `
          <tr class="row-link" onclick="window.location='/equipment/${r.id}'">
            <td>${escapeHtml(r.name)}${r.asset_tag ? ` <span style="color:#8B8578;">(${escapeHtml(r.asset_tag)})</span>` : ''}</td>
            <td>${escapeHtml(r.category)}</td>
            <td><span class="badge ${equipmentStatusBadgeClass(r.status)}">${escapeHtml(r.status)}</span></td>
            <td><span class="badge ${insp.cls}">${insp.label}</span></td>
            <td onclick="event.stopPropagation();"><a class="btn btn-secondary" href="/equipment/${r.id}/check" style="padding:4px 12px;font-size:13px;">Log check</a></td>
          </tr>
        `;
      }).join('');

      return `
        <div class="page-header" style="margin-top:28px;margin-bottom:8px;">
          <h2 style="margin:0;font-size:18px;">${escapeHtml(roomName)}</h2>
          <span style="font-size:13px;color:#6B6659;">
            ${roomOverdue ? `<span style="color:#B3261E;font-weight:600;">${roomOverdue} overdue</span>` : ''}
            ${roomOverdue && roomDueSoon ? ' · ' : ''}
            ${roomDueSoon ? `${roomDueSoon} due soon` : ''}
            ${!roomOverdue && !roomDueSoon ? 'All clear' : ''}
          </span>
        </div>
        <div class="card">
          <table>
            <thead>
              <tr><th>Item</th><th>Category</th><th>Status</th><th>Inspection</th><th></th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    }).filter(Boolean).join('');

    const body = `
      <a class="back-link" href="/equipment">← Back to Equipment Register</a>
      <div class="page-header">
        <div>
          <h1 class="page-title">Equipment by Room</h1>
          <p class="page-subtitle">What needs checking, grouped by workshop/area — for walking a room and clearing its maintenance checks.</p>
        </div>
      </div>
      <p style="margin:-10px 0 18px;font-size:13px;">
        ${totalOverdue ? `<span style="color:#B3261E;font-weight:600;">${totalOverdue} overdue</span>` : ''}
        ${totalOverdue && totalDueSoon ? ' · ' : ''}
        ${totalDueSoon ? `<span style="color:#8A6D00;font-weight:600;">${totalDueSoon} due soon</span>` : ''}
        ${!totalOverdue && !totalDueSoon ? '<span style="color:#1B5E52;">Nothing overdue or due soon.</span>' : ''}
        &nbsp;·&nbsp;
        ${onlyDue
          ? `<a href="/equipment/by-room" style="color:#6B6659;text-decoration:underline;">Show all equipment →</a>`
          : `<a href="/equipment/by-room?due=1" style="color:#6B6659;text-decoration:underline;">Show only overdue/due soon →</a>`}
      </p>
      ${roomSections || `<div class="empty-state">${onlyDue ? 'Nothing overdue or due soon.' : 'No equipment recorded yet.'}</div>`}
    `;

    res.send(page({ title: 'Equipment by Room', active: 'equipment', body }));
  } catch (err) {
    next(err);
  }
});

// ---------- Equipment Register: detail ----------

app.get('/equipment/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT e.*, p.activity_name AS pera_name
       FROM equipment_records e
       LEFT JOIN pera_records p ON p.id = e.pera_id
       WHERE e.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).send('Equipment record not found.');
    }
    const r = result.rows[0];
    const insp = inspectionBadge(r.next_inspection_due);

    const checksResult = await pool.query(
      'SELECT * FROM equipment_checks WHERE equipment_id = $1 ORDER BY checked_at DESC LIMIT 10',
      [req.params.id]
    );
    const latestCheck = checksResult.rows[0];

    // Results are stored per-check (each row snapshotting the checklist item's
    // label + pass/fail at the time), so pull them all in one query and group
    // by check_id rather than re-querying per row.
    const checkIds = checksResult.rows.map((c) => c.id);
    const resultsByCheck = {};
    if (checkIds.length) {
      const resultsResult = await pool.query(
        'SELECT * FROM equipment_check_results WHERE check_id = ANY($1) ORDER BY sort_order ASC, id ASC',
        [checkIds]
      );
      resultsResult.rows.forEach((row) => {
        (resultsByCheck[row.check_id] = resultsByCheck[row.check_id] || []).push(row);
      });
    }
    const latestCheckItems = latestCheck ? (resultsByCheck[latestCheck.id] || []) : [];

    const checkHistoryRows = checksResult.rows.map((c) => {
      const items = resultsByCheck[c.id] || [];
      const failCount = items.filter((item) => !item.ok).length;
      return `
        <tr>
          <td>${formatDate(c.checked_at)}</td>
          <td>${escapeHtml(c.checked_by || '—')}</td>
          <td><span class="badge ${failCount === 0 ? 'badge-approved' : 'badge-changes'}">${failCount === 0 ? 'All clear' : `${failCount} issue${failCount === 1 ? '' : 's'}`}</span></td>
        </tr>
      `;
    }).join('');

    const body = `
      <a class="back-link" href="/equipment">← Back to Equipment Register</a>
      <div class="page-header">
        <div>
          <h1 class="page-title">${escapeHtml(r.name)}</h1>
          <p class="page-subtitle">${escapeHtml(r.category)}${r.asset_tag ? ` · Asset tag ${escapeHtml(r.asset_tag)}` : ''}</p>
        </div>
        <span>
          <a class="btn btn-primary" href="/equipment/${r.id}/check">Log maintenance check</a>
          <a class="btn btn-secondary" href="/admin/equipment/${r.id}/edit">Edit</a>
        </span>
      </div>
      <div class="stat-grid">
        <div class="stat-tile">
          <div class="stat-label">Status</div>
          <div class="stat-value" style="font-size:16px;"><span class="badge ${equipmentStatusBadgeClass(r.status)}">${escapeHtml(r.status)}</span></div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">Next inspection</div>
          <div class="stat-value" style="font-size:16px;"><span class="badge ${insp.cls}">${insp.label}</span></div>
        </div>
      </div>
      <div class="card" style="padding:24px;">
        <div class="detail-grid">
          <div><div class="detail-label">Location</div><div>${escapeHtml(r.location || '—')}</div></div>
          <div><div class="detail-label">Manufacturer</div><div>${escapeHtml(r.manufacturer || '—')}</div></div>
          <div><div class="detail-label">Serial number</div><div>${escapeHtml(r.serial_number || '—')}</div></div>
          <div><div class="detail-label">Test/tag number</div><div>${escapeHtml(r.test_tag_number || '—')}</div></div>
          <div><div class="detail-label">Responsible person</div><div>${escapeHtml(r.responsible_person || '—')}</div></div>
          <div><div class="detail-label">Purchase date</div><div>${formatDate(r.purchase_date)}</div></div>
          <div><div class="detail-label">Inspection frequency</div><div>${escapeHtml(r.inspection_frequency || '—')}</div></div>
          <div><div class="detail-label">Last inspection</div><div>${formatDate(r.last_inspection_date)}</div></div>
          <div><div class="detail-label">Linked PERA</div><div>${r.pera_id ? `<a href="/pera/${r.pera_id}" style="color:#1B5E52;font-weight:600;">${escapeHtml(r.pera_name)} →</a>` : '—'}</div></div>
        </div>
        ${r.condition_notes ? `<div style="margin-top:20px;"><div class="detail-label">Condition notes</div><p style="margin:6px 0 0;white-space:pre-wrap;">${escapeHtml(r.condition_notes)}</p></div>` : ''}
      </div>
      <div class="form-section-title">Maintenance checks</div>
      ${latestCheck ? `
        <div class="card" style="padding:24px;margin-bottom:16px;">
          <p style="margin:0 0 12px;font-size:13px;color:#6B6659;">Last checked ${formatDate(latestCheck.checked_at)}${latestCheck.checked_by ? ` by ${escapeHtml(latestCheck.checked_by)}` : ''}.</p>
          <div class="detail-grid">
            ${latestCheckItems.map((item) => `
              <div><div class="detail-label">${escapeHtml(item.label)}</div><div><span class="badge ${item.ok ? 'badge-approved' : 'badge-changes'}">${item.ok ? 'OK' : 'Not OK'}</span></div></div>
            `).join('')}
          </div>
          ${latestCheck.notes ? `<div style="margin-top:16px;"><div class="detail-label">Notes</div><p style="margin:6px 0 0;white-space:pre-wrap;">${escapeHtml(latestCheck.notes)}</p></div>` : ''}
        </div>
      ` : `<div class="card" style="padding:24px;margin-bottom:16px;"><p style="margin:0;font-size:14px;color:#6B6659;">No maintenance checks logged yet.</p></div>`}
      ${checksResult.rows.length ? `
        <div class="card">
          <table>
            <thead><tr><th>Date</th><th>Checked by</th><th>Result</th></tr></thead>
            <tbody>${checkHistoryRows}</tbody>
          </table>
        </div>
      ` : ''}
    `;

    res.send(page({ title: r.name, active: 'equipment', body }));
  } catch (err) {
    next(err);
  }
});

// ---------- Equipment Register: maintenance check ----------
// Open to any staff member (like PERA/CARA submission, unlike editing the
// equipment record itself) so a maintenance person can log a check without
// needing the admin password. Submitting updates the item's last/next
// inspection dates and flips status to Under repair if anything failed, or
// In service if everything checked out.

app.get('/equipment/:id/check', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM equipment_records WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).send('Equipment record not found.');
    }
    const r = result.rows[0];

    const itemsResult = await pool.query(
      'SELECT * FROM equipment_check_items WHERE equipment_id = $1 ORDER BY sort_order ASC, id ASC',
      [req.params.id]
    );

    if (itemsResult.rows.length === 0) {
      const body = `
        <a class="back-link" href="/equipment/${r.id}">← Back to ${escapeHtml(r.name)}</a>
        <h1 class="page-title" style="margin-bottom:8px;">Maintenance check: ${escapeHtml(r.name)}</h1>
        <div class="empty-state">This item doesn't have any checklist items set up yet. <a href="/admin/equipment/${r.id}/edit" style="color:#1B5E52;">Add some from the Edit page →</a></div>
      `;
      return res.send(page({ title: `Maintenance check — ${r.name}`, active: 'equipment', body }));
    }

    const itemsHtml = itemsResult.rows.map((item) => `
      <div class="form-row checkbox-row">
        <input type="checkbox" id="item_${item.id}" name="item_${item.id}" value="true">
        <label for="item_${item.id}">${escapeHtml(item.label)}</label>
      </div>
    `).join('');

    const body = `
      <a class="back-link" href="/equipment/${r.id}">← Back to ${escapeHtml(r.name)}</a>
      <h1 class="page-title" style="margin-bottom:8px;">Maintenance check: ${escapeHtml(r.name)}</h1>
      <p class="page-subtitle" style="margin-bottom:24px;">Tick off each item once you've confirmed it. Leave anything unticked that isn't OK — the item will be marked as needing attention.</p>
      <form class="form-card" method="post" action="/equipment/${r.id}/check">
        ${itemsHtml}
        <div class="form-row">
          <label for="notes">Notes</label>
          <textarea id="notes" name="notes" placeholder="Any issues found, parts needed, follow-up required..."></textarea>
        </div>
        <div class="form-row">
          <label for="checked_by">Checked by</label>
          <input type="text" id="checked_by" name="checked_by" placeholder="Your name" required>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Submit check</button>
          <a class="btn btn-secondary" href="/equipment/${r.id}">Cancel</a>
        </div>
      </form>
    `;

    res.send(page({ title: `Maintenance check — ${r.name}`, active: 'equipment', body }));
  } catch (err) {
    next(err);
  }
});

app.post('/equipment/:id/check', async (req, res, next) => {
  try {
    const equipmentResult = await pool.query('SELECT * FROM equipment_records WHERE id = $1', [req.params.id]);
    if (equipmentResult.rows.length === 0) {
      return res.status(404).send('Equipment record not found.');
    }
    const equipment = equipmentResult.rows[0];

    const itemsResult = await pool.query(
      'SELECT * FROM equipment_check_items WHERE equipment_id = $1 ORDER BY sort_order ASC, id ASC',
      [req.params.id]
    );
    if (itemsResult.rows.length === 0) {
      return res.status(400).send('This item has no checklist items set up — add some from its Edit page first.');
    }

    const checkedItems = itemsResult.rows.map((item) => ({
      label: item.label,
      sort_order: item.sort_order,
      ok: req.body[`item_${item.id}`] === 'true',
    }));
    const allOk = checkedItems.every((item) => item.ok);

    const checkResult = await pool.query(
      `INSERT INTO equipment_checks (equipment_id, checked_by, notes) VALUES ($1,$2,$3) RETURNING id`,
      [req.params.id, req.body.checked_by || null, req.body.notes || null]
    );
    const checkId = checkResult.rows[0].id;

    const values = [];
    const placeholders = checkedItems.map((item, i) => {
      const base = i * 4;
      values.push(checkId, item.label, item.ok, item.sort_order);
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4})`;
    }).join(',');
    await pool.query(
      `INSERT INTO equipment_check_results (check_id, label, ok, sort_order) VALUES ${placeholders}`,
      values
    );

    const today = new Date().toISOString().slice(0, 10);
    const nextDue = addInspectionInterval(today, equipment.inspection_frequency) || equipment.next_inspection_due;
    const newStatus = allOk ? 'In service' : 'Under repair';

    await pool.query(
      `UPDATE equipment_records
       SET last_inspection_date = $1, next_inspection_due = $2, status = $3, updated_at = now()
       WHERE id = $4`,
      [today, nextDue, newStatus, req.params.id]
    );

    res.redirect(`/equipment/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// ---------- Equipment Register: admin add/edit/delete ----------
// Adding and editing equipment is admin-only (unlike PERA/CARA, which any
// staff member can submit) — the register is a managed asset list, not a
// document teachers author.

function equipmentFormFields(r = {}) {
  const categoryOptions = EQUIPMENT_CATEGORIES.map(
    (c) => `<option value="${c}" ${r.category === c ? 'selected' : ''}>${c}</option>`
  ).join('');
  const statusOptions = EQUIPMENT_STATUSES.map(
    (s) => `<option value="${s}" ${(r.status || 'In service') === s ? 'selected' : ''}>${s}</option>`
  ).join('');
  const frequencyOptions = `<option value="">— None —</option>` + INSPECTION_FREQUENCIES.map(
    (f) => `<option value="${f}" ${r.inspection_frequency === f ? 'selected' : ''}>${f}</option>`
  ).join('');
  return { categoryOptions, statusOptions, frequencyOptions };
}

app.get('/admin/equipment/new', requireAdmin, async (req, res, next) => {
  try {
    const peraResult = await pool.query('SELECT id, activity_name FROM pera_records ORDER BY activity_name ASC');
    const peraOptions = peraResult.rows.map((p) => `<option value="${p.id}">${escapeHtml(p.activity_name)}</option>`).join('');
    const locationsResult = await pool.query('SELECT name FROM equipment_locations ORDER BY name ASC');
    const locationOptions = locationsResult.rows.map((l) => `<option value="${escapeHtml(l.name)}">${escapeHtml(l.name)}</option>`).join('');
    const { categoryOptions, statusOptions, frequencyOptions } = equipmentFormFields();

    const body = `
      <a class="back-link" href="/equipment">← Back to Equipment Register</a>
      <h1 class="page-title" style="margin-bottom:24px;">Add equipment</h1>
      <form class="form-card" method="post" action="/admin/equipment">
        <div class="form-row">
          <label for="name">Item name</label>
          <input type="text" id="name" name="name" required placeholder="e.g. Makita LS1019L drop saw">
        </div>
        <div class="form-row">
          <label for="asset_tag">Asset tag</label>
          <input type="text" id="asset_tag" name="asset_tag" placeholder="e.g. IDT-014">
        </div>
        <div class="form-row">
          <label for="category">Category</label>
          <select id="category" name="category" required>${categoryOptions}</select>
        </div>
        <div class="form-row">
          <label for="status">Status</label>
          <select id="status" name="status" required>${statusOptions}</select>
        </div>
        <div class="form-row">
          <label for="location">Location</label>
          <select id="location" name="location">
            <option value="">— None —</option>
            ${locationOptions}
          </select>
          <p class="form-section-hint"><a href="/admin/locations" style="color:#1B5E52;">Manage locations →</a></p>
        </div>
        <div class="form-row">
          <label for="manufacturer">Manufacturer</label>
          <input type="text" id="manufacturer" name="manufacturer">
        </div>
        <div class="form-row">
          <label for="serial_number">Serial number</label>
          <input type="text" id="serial_number" name="serial_number">
        </div>
        <div class="form-row">
          <label for="test_tag_number">Test/tag number</label>
          <input type="text" id="test_tag_number" name="test_tag_number" placeholder="Electrical test &amp; tag sticker number, if applicable">
        </div>
        <div class="form-row">
          <label for="responsible_person">Responsible person</label>
          <input type="text" id="responsible_person" name="responsible_person">
        </div>
        <div class="form-row">
          <label for="purchase_date">Purchase date</label>
          <input type="date" id="purchase_date" name="purchase_date">
        </div>
        <div class="form-row">
          <label for="inspection_frequency">Inspection frequency</label>
          <select id="inspection_frequency" name="inspection_frequency">${frequencyOptions}</select>
        </div>
        <div class="form-row">
          <label for="last_inspection_date">Last inspection date</label>
          <input type="date" id="last_inspection_date" name="last_inspection_date">
        </div>
        <div class="form-row">
          <label for="next_inspection_due">Next inspection due</label>
          <input type="date" id="next_inspection_due" name="next_inspection_due" placeholder="Leave blank to calculate from last inspection + frequency">
        </div>
        <div class="form-row">
          <label for="pera_id">Linked PERA (optional)</label>
          <select id="pera_id" name="pera_id">
            <option value="">— None —</option>
            ${peraOptions}
          </select>
        </div>
        <div class="form-row">
          <label for="condition_notes">Condition notes</label>
          <textarea id="condition_notes" name="condition_notes"></textarea>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Add equipment</button>
          <a class="btn btn-secondary" href="/equipment">Cancel</a>
        </div>
      </form>
    `;

    res.send(page({ title: 'Add equipment', active: 'equipment', body }));
  } catch (err) {
    next(err);
  }
});

app.post('/admin/equipment', requireAdmin, async (req, res, next) => {
  try {
    const {
      name, asset_tag, category, status, location, manufacturer, serial_number,
      test_tag_number, responsible_person, purchase_date,
      inspection_frequency, last_inspection_date, next_inspection_due,
      pera_id, condition_notes,
    } = req.body;

    if (!name || !EQUIPMENT_CATEGORIES.includes(category)) {
      return res.status(400).send('Item name and a valid category are required.');
    }

    const validFrequency = INSPECTION_FREQUENCIES.includes(inspection_frequency) ? inspection_frequency : null;
    const computedNextDue = next_inspection_due
      || addInspectionInterval(last_inspection_date, validFrequency);

    const result = await pool.query(
      `INSERT INTO equipment_records
        (name, asset_tag, category, status, location, manufacturer, serial_number,
         test_tag_number, responsible_person, purchase_date,
         inspection_frequency, last_inspection_date, next_inspection_due,
         pera_id, condition_notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id`,
      [
        name, asset_tag || null, category, EQUIPMENT_STATUSES.includes(status) ? status : 'In service',
        location || null, manufacturer || null, serial_number || null,
        test_tag_number || null, responsible_person || null, purchase_date || null,
        validFrequency, last_inspection_date || null, computedNextDue || null,
        pera_id || null, condition_notes || null,
      ]
    );

    const newEquipmentId = result.rows[0].id;
    const seedValues = [];
    const seedPlaceholders = DEFAULT_CHECK_ITEMS.map((label, i) => {
      const base = i * 3;
      seedValues.push(newEquipmentId, label, i + 1);
      return `($${base + 1},$${base + 2},$${base + 3})`;
    }).join(',');
    await pool.query(
      `INSERT INTO equipment_check_items (equipment_id, label, sort_order) VALUES ${seedPlaceholders}`,
      seedValues
    );

    res.redirect(`/equipment/${newEquipmentId}`);
  } catch (err) {
    next(err);
  }
});

app.get('/admin/equipment/:id/edit', requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM equipment_records WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).send('Equipment record not found.');
    }
    const r = result.rows[0];
    const peraResult = await pool.query('SELECT id, activity_name FROM pera_records ORDER BY activity_name ASC');
    const peraOptions = peraResult.rows.map(
      (p) => `<option value="${p.id}" ${r.pera_id === p.id ? 'selected' : ''}>${escapeHtml(p.activity_name)}</option>`
    ).join('');
    const locationsResult = await pool.query('SELECT name FROM equipment_locations ORDER BY name ASC');
    const knownLocations = locationsResult.rows.map((l) => l.name);
    if (r.location && !knownLocations.includes(r.location)) knownLocations.push(r.location);
    const locationOptions = knownLocations.map(
      (name) => `<option value="${escapeHtml(name)}" ${r.location === name ? 'selected' : ''}>${escapeHtml(name)}</option>`
    ).join('');
    const { categoryOptions, statusOptions, frequencyOptions } = equipmentFormFields(r);
    const dateVal = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

    const checkItemsResult = await pool.query(
      'SELECT * FROM equipment_check_items WHERE equipment_id = $1 ORDER BY sort_order ASC, id ASC',
      [req.params.id]
    );
    const checkItemRows = checkItemsResult.rows.map((item) => `
      <tr>
        <td>
          <form method="post" action="/admin/equipment/${r.id}/check-items/${item.id}" style="display:flex;gap:8px;align-items:center;">
            <input type="text" name="label" value="${escapeHtml(item.label)}" style="max-width:320px;">
            <button type="submit" class="btn btn-secondary" style="padding:4px 12px;font-size:13px;">Save</button>
          </form>
        </td>
        <td style="text-align:right;">
          <form method="post" action="/admin/equipment/${r.id}/check-items/${item.id}/delete" style="display:inline;" onsubmit="return confirm('Remove this checklist item?');">
            <button type="submit" class="btn btn-secondary" style="padding:4px 12px;font-size:13px;color:#B3261E;border-color:#B3261E;">Remove</button>
          </form>
        </td>
      </tr>
    `).join('');

    const body = `
      <a class="back-link" href="/equipment/${r.id}">← Back to ${escapeHtml(r.name)}</a>
      <h1 class="page-title" style="margin-bottom:24px;">Edit: ${escapeHtml(r.name)}</h1>
      <form class="form-card" method="post" action="/admin/equipment/${r.id}">
        <div class="form-row">
          <label for="name">Item name</label>
          <input type="text" id="name" name="name" value="${escapeHtml(r.name)}" required>
        </div>
        <div class="form-row">
          <label for="asset_tag">Asset tag</label>
          <input type="text" id="asset_tag" name="asset_tag" value="${escapeHtml(r.asset_tag || '')}">
        </div>
        <div class="form-row">
          <label for="category">Category</label>
          <select id="category" name="category" required>${categoryOptions}</select>
        </div>
        <div class="form-row">
          <label for="status">Status</label>
          <select id="status" name="status" required>${statusOptions}</select>
        </div>
        <div class="form-row">
          <label for="location">Location</label>
          <select id="location" name="location">
            <option value="">— None —</option>
            ${locationOptions}
          </select>
          <p class="form-section-hint"><a href="/admin/locations" style="color:#1B5E52;">Manage locations →</a></p>
        </div>
        <div class="form-row">
          <label for="manufacturer">Manufacturer</label>
          <input type="text" id="manufacturer" name="manufacturer" value="${escapeHtml(r.manufacturer || '')}">
        </div>
        <div class="form-row">
          <label for="serial_number">Serial number</label>
          <input type="text" id="serial_number" name="serial_number" value="${escapeHtml(r.serial_number || '')}">
        </div>
        <div class="form-row">
          <label for="test_tag_number">Test/tag number</label>
          <input type="text" id="test_tag_number" name="test_tag_number" value="${escapeHtml(r.test_tag_number || '')}">
        </div>
        <div class="form-row">
          <label for="responsible_person">Responsible person</label>
          <input type="text" id="responsible_person" name="responsible_person" value="${escapeHtml(r.responsible_person || '')}">
        </div>
        <div class="form-row">
          <label for="purchase_date">Purchase date</label>
          <input type="date" id="purchase_date" name="purchase_date" value="${dateVal(r.purchase_date)}">
        </div>
        <div class="form-row">
          <label for="inspection_frequency">Inspection frequency</label>
          <select id="inspection_frequency" name="inspection_frequency">${frequencyOptions}</select>
        </div>
        <div class="form-row">
          <label for="last_inspection_date">Last inspection date</label>
          <input type="date" id="last_inspection_date" name="last_inspection_date" value="${dateVal(r.last_inspection_date)}">
        </div>
        <div class="form-row">
          <label for="next_inspection_due">Next inspection due</label>
          <input type="date" id="next_inspection_due" name="next_inspection_due" value="${dateVal(r.next_inspection_due)}">
        </div>
        <div class="form-row">
          <label for="pera_id">Linked PERA (optional)</label>
          <select id="pera_id" name="pera_id">
            <option value="">— None —</option>
            ${peraOptions}
          </select>
        </div>
        <div class="form-row">
          <label for="condition_notes">Condition notes</label>
          <textarea id="condition_notes" name="condition_notes">${escapeHtml(r.condition_notes || '')}</textarea>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Save changes</button>
          <a class="btn btn-secondary" href="/equipment/${r.id}">Cancel</a>
        </div>
      </form>
      <div class="form-section-title" style="margin-top:32px;">Maintenance checklist</div>
      <p class="page-subtitle" style="margin-bottom:16px;">These are the items shown on this item's own maintenance check screen. Different equipment needs different checks — e.g. a disk sander might need "Sanding disc condition" and "Vibration" added here.</p>
      <div class="card" style="margin-bottom:16px;">
        <table>
          <thead><tr><th>Checklist item</th><th></th></tr></thead>
          <tbody>${checkItemRows || '<tr><td colspan="2" style="text-align:center;color:#6B6659;padding:24px;">No checklist items yet.</td></tr>'}</tbody>
        </table>
      </div>
      <form class="form-card" method="post" action="/admin/equipment/${r.id}/check-items" style="margin-bottom:32px;">
        <div class="form-row">
          <label for="new_item_label">Add checklist item</label>
          <input type="text" id="new_item_label" name="label" required placeholder="e.g. Sanding disc condition">
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Add item</button>
        </div>
      </form>
      <form method="post" action="/admin/equipment/${r.id}/${r.archived ? 'unarchive' : 'archive'}" style="margin-top:16px;">
        <button type="submit" class="btn btn-secondary">${r.archived ? 'Unarchive this item' : 'Archive this item'}</button>
      </form>
      <form method="post" action="/admin/equipment/${r.id}/delete" style="margin-top:16px;" onsubmit="return confirm('Delete this equipment record permanently? This cannot be undone.');">
        <button type="submit" class="btn btn-secondary" style="color:#B3261E;border-color:#B3261E;">Delete this record</button>
      </form>
    `;

    res.send(page({ title: `Edit — ${r.name}`, active: 'equipment', body }));
  } catch (err) {
    next(err);
  }
});

app.post('/admin/equipment/:id', requireAdmin, async (req, res, next) => {
  try {
    const {
      name, asset_tag, category, status, location, manufacturer, serial_number,
      test_tag_number, responsible_person, purchase_date,
      inspection_frequency, last_inspection_date, next_inspection_due,
      pera_id, condition_notes,
    } = req.body;

    if (!name || !EQUIPMENT_CATEGORIES.includes(category)) {
      return res.status(400).send('Item name and a valid category are required.');
    }

    const validFrequency = INSPECTION_FREQUENCIES.includes(inspection_frequency) ? inspection_frequency : null;
    const computedNextDue = next_inspection_due
      || addInspectionInterval(last_inspection_date, validFrequency);

    await pool.query(
      `UPDATE equipment_records SET
        name = $1, asset_tag = $2, category = $3, status = $4, location = $5,
        manufacturer = $6, serial_number = $7, test_tag_number = $8,
        responsible_person = $9, purchase_date = $10, inspection_frequency = $11,
        last_inspection_date = $12, next_inspection_due = $13, pera_id = $14,
        condition_notes = $15, updated_at = now()
       WHERE id = $16`,
      [
        name, asset_tag || null, category, EQUIPMENT_STATUSES.includes(status) ? status : 'In service',
        location || null, manufacturer || null, serial_number || null,
        test_tag_number || null, responsible_person || null, purchase_date || null,
        validFrequency, last_inspection_date || null, computedNextDue || null,
        pera_id || null, condition_notes || null, req.params.id,
      ]
    );

    res.redirect(`/equipment/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

app.post('/admin/equipment/:id/archive', requireAdmin, async (req, res, next) => {
  try {
    await pool.query('UPDATE equipment_records SET archived = true, updated_at = now() WHERE id = $1', [req.params.id]);
    res.redirect('/equipment');
  } catch (err) {
    next(err);
  }
});
app.post('/admin/equipment/:id/unarchive', requireAdmin, async (req, res, next) => {
  try {
    await pool.query('UPDATE equipment_records SET archived = false, updated_at = now() WHERE id = $1', [req.params.id]);
    res.redirect(`/equipment/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

app.post('/admin/equipment/:id/delete', requireAdmin, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM equipment_records WHERE id = $1', [req.params.id]);
    res.redirect('/equipment');
  } catch (err) {
    next(err);
  }
});

// ---------- Equipment Register: per-item maintenance checklist ----------
// Each piece of equipment has its own editable list of checklist items (see
// equipment_check_items in db.js) — e.g. a disk sander needs "Sanding disc
// condition" and "Vibration" added on top of the shared defaults, while a
// simple hand tool might have most of the defaults removed.

app.post('/admin/equipment/:id/check-items', requireAdmin, async (req, res, next) => {
  try {
    const { label } = req.body;
    if (!label || !label.trim()) {
      return res.status(400).send('A checklist item name is required.');
    }
    const maxOrderResult = await pool.query(
      'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM equipment_check_items WHERE equipment_id = $1',
      [req.params.id]
    );
    const nextOrder = maxOrderResult.rows[0].max_order + 1;
    await pool.query(
      'INSERT INTO equipment_check_items (equipment_id, label, sort_order) VALUES ($1,$2,$3) ON CONFLICT (equipment_id, label) DO NOTHING',
      [req.params.id, label.trim(), nextOrder]
    );
    res.redirect(`/admin/equipment/${req.params.id}/edit`);
  } catch (err) {
    next(err);
  }
});

app.post('/admin/equipment/:id/check-items/:itemId', requireAdmin, async (req, res, next) => {
  try {
    const { label } = req.body;
    if (!label || !label.trim()) {
      return res.status(400).send('A checklist item name is required.');
    }
    await pool.query(
      'UPDATE equipment_check_items SET label = $1 WHERE id = $2 AND equipment_id = $3',
      [label.trim(), req.params.itemId, req.params.id]
    );
    res.redirect(`/admin/equipment/${req.params.id}/edit`);
  } catch (err) {
    next(err);
  }
});

app.post('/admin/equipment/:id/check-items/:itemId/delete', requireAdmin, async (req, res, next) => {
  try {
    await pool.query(
      'DELETE FROM equipment_check_items WHERE id = $1 AND equipment_id = $2',
      [req.params.itemId, req.params.id]
    );
    res.redirect(`/admin/equipment/${req.params.id}/edit`);
  } catch (err) {
    next(err);
  }
});

// ---------- Equipment Register: manage locations ----------
// The list of workshop/area names offered in the Equipment Location dropdown
// is admin-managed here, rather than hardcoded or free-typed on each item.

app.get('/admin/locations', requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT l.*, (SELECT COUNT(*)::int FROM equipment_records e WHERE e.location = l.name) AS in_use
       FROM equipment_locations l ORDER BY l.name ASC`
    );

    const rows = result.rows.map((l) => `
      <tr>
        <td>
          <form method="post" action="/admin/locations/${l.id}" style="display:flex;gap:8px;align-items:center;">
            <input type="text" name="name" value="${escapeHtml(l.name)}" style="max-width:240px;">
            <button type="submit" class="btn btn-secondary" style="padding:4px 12px;font-size:13px;">Save</button>
          </form>
        </td>
        <td>${l.in_use} item${l.in_use === 1 ? '' : 's'}</td>
        <td style="text-align:right;">
          <form method="post" action="/admin/locations/${l.id}/delete" style="display:inline;" onsubmit="return confirm('Remove &quot;${escapeHtml(l.name).replace(/"/g, '&quot;')}&quot; from the location list? Equipment already using it will keep showing it, but it won\\'t be selectable for new items.');">
            <button type="submit" class="btn btn-secondary" style="padding:4px 12px;font-size:13px;color:#B3261E;border-color:#B3261E;">Remove</button>
          </form>
        </td>
      </tr>
    `).join('');

    const body = `
      <a class="back-link" href="/admin">← Back to Admin</a>
      <h1 class="page-title" style="margin-bottom:8px;">Manage locations</h1>
      <p class="page-subtitle" style="margin-bottom:24px;">These are the workshop/area names offered in the Equipment Register's Location dropdown.</p>
      <form class="form-card" method="post" action="/admin/locations" style="margin-bottom:24px;">
        <div class="form-row">
          <label for="name">New location name</label>
          <input type="text" id="name" name="name" required placeholder="e.g. Design studio">
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Add location</button>
        </div>
      </form>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>Location</th>
              <th>In use</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="3" style="text-align:center;color:#6B6659;padding:24px;">No locations yet.</td></tr>'}</tbody>
        </table>
      </div>
    `;

    res.send(page({ title: 'Manage locations', active: 'admin', body }));
  } catch (err) {
    next(err);
  }
});

app.post('/admin/locations', requireAdmin, async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).send('A location name is required.');
    }
    await pool.query('INSERT INTO equipment_locations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name.trim()]);
    res.redirect('/admin/locations');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/locations/:id', requireAdmin, async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).send('A location name is required.');
    }
    const trimmed = name.trim();
    const existing = await pool.query('SELECT name FROM equipment_locations WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).send('Location not found.');
    }
    const oldName = existing.rows[0].name;
    await pool.query('UPDATE equipment_locations SET name = $1 WHERE id = $2', [trimmed, req.params.id]);
    if (oldName !== trimmed) {
      // Keep equipment already using the old name pointed at the renamed location.
      await pool.query('UPDATE equipment_records SET location = $1 WHERE location = $2', [trimmed, oldName]);
    }
    res.redirect('/admin/locations');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/locations/:id/delete', requireAdmin, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM equipment_locations WHERE id = $1', [req.params.id]);
    res.redirect('/admin/locations');
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
    const equipmentResult = await pool.query('SELECT * FROM equipment_records WHERE archived = false ORDER BY name ASC');

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

    const equipmentRows = equipmentResult.rows.map((r) => {
      const insp = inspectionBadge(r.next_inspection_due);
      return `
      <tr class="row-link" onclick="window.location='/admin/equipment/${r.id}/edit'">
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.category)}</td>
        <td><span class="badge ${equipmentStatusBadgeClass(r.status)}">${escapeHtml(r.status)}</span></td>
        <td><span class="badge ${insp.cls}">${insp.label}</span></td>
      </tr>
    `;
    }).join('');

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
      <div class="form-section-title" style="display:flex;align-items:center;justify-content:space-between;">
        <span>Equipment register</span>
        <span>
          <a class="btn btn-secondary" href="/admin/locations" style="padding:6px 14px;font-size:13px;">Manage locations</a>
          <a class="btn btn-secondary" href="/admin/equipment/new" style="padding:6px 14px;font-size:13px;">+ Add equipment</a>
        </span>
      </div>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Category</th>
              <th>Status</th>
              <th>Inspection</th>
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
        activity_name, class_unit || null, risk_level, status,
        hazards || null, control_measures || null, required_supervision || null,
        consent_required === 'true', submitted_by || null, approver || null,
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
        activity_name, class_unit || null, activity_scope || null, risk_level, status,
        students_notes || null, emergency_first_aid || null, induction_instruction || null, consent_required === 'true',
        supervision_notes || null, supervisor_qualification || null, facilities_equipment || null,
        environmental_hazards || null, environmental_controls || null,
        facilities_hazards || null, facilities_controls || null,
        student_hazards || null, student_controls || null,
        submitted_by || null, approver || null,
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
