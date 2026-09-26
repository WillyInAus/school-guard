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
      </div>
      <div class="card" style="padding: 24px;">
        <p style="margin:0;font-size:14px;color:#6B6659;">
          <a href="/pera" style="color:#1B5E52;font-weight:600;">PERA</a> holds the equipment/tool
          risk assessment library (Plant &amp; Equipment Risk Assessments). <a href="/cara" style="color:#1B5E52;font-weight:600;">CARA</a> is where teachers put
          together a Curriculum Activity Risk Assessment for a class or activity, drawing on tools from that library.
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
    for (const [key, label, newValue] of fields) {
      const oldValue = before[key];
      const oldStr = (oldValue === null || oldValue === undefined) ? '' : String(oldValue);
      const newStr = (newValue === null || newValue === undefined) ? '' : String(newValue);
      if (oldStr.trim() !== newStr.trim()) {
        changeLines.push(`${label}: ${displayValue(oldValue)} → ${displayValue(newValue)}`);
      }
    }

    if (before.consent_required !== newConsentRequired) {
      changeLines.push(`Parent consent required: ${before.consent_required ? 'Yes' : 'No'} → ${newConsentRequired ? 'Yes' : 'No'}`);
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

    await pool.query(
      'INSERT INTO cara_change_log (cara_id, changed_by, summary) VALUES ($1, $2, $3)',
      [req.params.id, edited_by.trim(), changeLines.join('\n')]
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

    const changeLogHtml = changeLogResult.rows.length
      ? changeLogResult.rows.map((c) => `
          <div class="detail-section">
            <div class="detail-label">${escapeHtml(c.changed_by || 'Unknown')} — ${formatDate(c.changed_at)}</div>
            <div class="detail-value">${escapeHtml(c.summary)}</div>
          </div>
        `).join('')
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
      doc.fontSize(10).fillColor(TEXT).text(value && String(value).trim() ? normalizeText(value) : '—');
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
      if (r.monitoring_details) doc.text(normalizeText(r.monitoring_details));
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
