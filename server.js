const express = require('express');
const crypto = require('crypto');
const { pool, migrate } = require('./db');
const { page, escapeHtml } = require('./views/layout');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
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

// ---------- Dashboard ----------

app.get('/', async (req, res, next) => {
  try {
    const totalResult = await pool.query('SELECT COUNT(*)::int AS count FROM risk_assessments');
    const pendingResult = await pool.query(
      "SELECT COUNT(*)::int AS count FROM risk_assessments WHERE status = 'Pending approval'"
    );
    const caraTotalResult = await pool.query('SELECT COUNT(*)::int AS count FROM cara_records');
    const caraPendingResult = await pool.query(
      "SELECT COUNT(*)::int AS count FROM cara_records WHERE status = 'Pending approval'"
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
          <div class="stat-label">Tool risk assessments</div>
          <div class="stat-value">${totalResult.rows[0].count}</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">Tool RAs pending approval</div>
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
          <a href="/risk-assessments" style="color:#1B5E52;font-weight:600;">Risk Assessments</a> holds the equipment/tool
          risk assessment library. <a href="/cara" style="color:#1B5E52;font-weight:600;">CARA</a> is where teachers put
          together a Curriculum Activity Risk Assessment for a class or activity, drawing on tools from that library.
        </p>
      </div>
    `;

    res.send(page({ title: 'Dashboard', active: 'dashboard', body }));
  } catch (err) {
    next(err);
  }
});

// ---------- Risk Assessments: list ----------

app.get('/risk-assessments', async (req, res, next) => {
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
      `SELECT * FROM risk_assessments ${where} ORDER BY created_at DESC`,
      params
    );

    const chips = ['All', ...RISK_LEVELS].map((level) => {
      const isActive = level === 'All' ? !risk : risk === level;
      const href = level === 'All' ? '/risk-assessments' : `/risk-assessments?risk=${encodeURIComponent(level)}`;
      return `<a class="chip${isActive ? ' active' : ''}" href="${href}">${level}</a>`;
    }).join('');

    let rowsHtml;
    if (result.rows.length === 0) {
      rowsHtml = `<div class="empty-state">No risk assessments yet. Click "New risk assessment" to add the first one.</div>`;
    } else {
      const rows = result.rows.map((r) => `
        <tr class="row-link" onclick="window.location='/risk-assessments/${r.id}'">
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
          <h1 class="page-title">Risk Assessments</h1>
          <p class="page-subtitle">Tool and equipment risk assessment library across IDT and VET workshops.</p>
        </div>
        <a class="btn btn-primary" href="/risk-assessments/new">+ New risk assessment</a>
      </div>
      <div class="filter-row">
        <form method="get" action="/risk-assessments">
          ${risk ? `<input type="hidden" name="risk" value="${escapeHtml(risk)}">` : ''}
          <input class="search-input" type="search" name="q" placeholder="Search activities..." value="${escapeHtml(q || '')}">
        </form>
        <div class="chip-row">${chips}</div>
      </div>
      <div class="card">${rowsHtml}</div>
    `;

    res.send(page({ title: 'Risk Assessments', active: 'risk-assessments', body }));
  } catch (err) {
    next(err);
  }
});

// ---------- Risk Assessments: new (form) ----------

app.get('/risk-assessments/new', (req, res) => {
  const riskOptions = RISK_LEVELS.map((l) => `<option value="${l}">${l}</option>`).join('');

  const body = `
    <a class="back-link" href="/risk-assessments">← Back to Risk Assessments</a>
    <h1 class="page-title">New risk assessment</h1>
    <p class="page-subtitle" style="margin-bottom:24px;">This will be saved as a Draft until you submit it for approval.</p>
    <form class="form-card" method="post" action="/risk-assessments">
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
        <a class="btn btn-secondary" href="/risk-assessments">Cancel</a>
      </div>
    </form>
  `;

  res.send(page({ title: 'New risk assessment', active: 'risk-assessments', body }));
});

// ---------- Risk Assessments: create ----------

app.post('/risk-assessments', async (req, res, next) => {
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
      `INSERT INTO risk_assessments
        (activity_name, class_unit, risk_level, hazards, control_measures, required_supervision, consent_required, submitted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        activity_name, class_unit || null, risk_level,
        hazards || null, control_measures || null, required_supervision || null,
        consent_required === 'true', submitted_by || null,
      ]
    );

    res.redirect(`/risk-assessments/${result.rows[0].id}`);
  } catch (err) {
    next(err);
  }
});

// ---------- Risk Assessments: detail ----------

app.get('/risk-assessments/:id', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM risk_assessments WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).send('Risk assessment not found.');
    }
    const r = result.rows[0];

    let actionsHtml = '';
    if (r.status === 'Draft') {
      actionsHtml = `
        <form method="post" action="/risk-assessments/${r.id}/submit">
          <button type="submit" class="btn btn-primary" style="width:100%;">Submit for approval</button>
        </form>
      `;
    } else if (r.status === 'Pending approval' || r.status === 'Changes requested') {
      actionsHtml = `
        <form method="post" action="/risk-assessments/${r.id}/approve" style="margin-bottom:10px;">
          <div class="form-row">
            <label for="approver">Approved by</label>
            <input type="text" id="approver" name="approver" placeholder="Name of approver" value="Workplace Health and Safety Officer" required>
          </div>
          <button type="submit" class="btn btn-primary" style="width:100%;">Approve</button>
        </form>
        <form method="post" action="/risk-assessments/${r.id}/reject">
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
      <a class="back-link" href="/risk-assessments">← Back to Risk Assessments</a>
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

    res.send(page({ title: r.activity_name, active: 'risk-assessments', body }));
  } catch (err) {
    next(err);
  }
});

// ---------- Risk Assessments: workflow actions ----------

app.post('/risk-assessments/:id/submit', async (req, res, next) => {
  try {
    await pool.query(
      "UPDATE risk_assessments SET status = 'Pending approval', updated_at = now() WHERE id = $1",
      [req.params.id]
    );
    res.redirect(`/risk-assessments/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

app.post('/risk-assessments/:id/approve', async (req, res, next) => {
  try {
    const { approver } = req.body;
    await pool.query(
      `UPDATE risk_assessments
       SET status = 'Approved', approver = $1, approved_at = now(),
           next_review_date = (now() + interval '1 year')::date, updated_at = now()
       WHERE id = $2`,
      [approver || null, req.params.id]
    );
    res.redirect(`/risk-assessments/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

app.post('/risk-assessments/:id/reject', async (req, res, next) => {
  try {
    const { review_notes } = req.body;
    await pool.query(
      `UPDATE risk_assessments
       SET status = 'Changes requested', review_notes = $1, updated_at = now()
       WHERE id = $2`,
      [review_notes || null, req.params.id]
    );
    res.redirect(`/risk-assessments/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// ================================================================
// CARA (Curriculum Activity Risk Assessments)
// ================================================================

app.get('/cara', async (req, res, next) => {
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
      `SELECT * FROM cara_records ${where} ORDER BY created_at DESC`,
      params
    );

    const chips = ['All', ...RISK_LEVELS].map((level) => {
      const isActive = level === 'All' ? !risk : risk === level;
      const href = level === 'All' ? '/cara' : `/cara?risk=${encodeURIComponent(level)}`;
      return `<a class="chip${isActive ? ' active' : ''}" href="${href}">${level}</a>`;
    }).join('');

    let rowsHtml;
    if (result.rows.length === 0) {
      rowsHtml = `<div class="empty-state">No CARA records yet. Click "New CARA" to add the first one.</div>`;
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
          <h1 class="page-title">CARA Records</h1>
          <p class="page-subtitle">Curriculum Activity Risk Assessments for classes and activities.</p>
        </div>
        <a class="btn btn-primary" href="/cara/new">+ New CARA</a>
      </div>
      <div class="filter-row">
        <form method="get" action="/cara">
          ${risk ? `<input type="hidden" name="risk" value="${escapeHtml(risk)}">` : ''}
          <input class="search-input" type="search" name="q" placeholder="Search activities..." value="${escapeHtml(q || '')}">
        </form>
        <div class="chip-row">${chips}</div>
      </div>
      <div class="card">${rowsHtml}</div>
    `;

    res.send(page({ title: 'CARA Records', active: 'cara', body }));
  } catch (err) {
    next(err);
  }
});

app.get('/cara/new', async (req, res, next) => {
  try {
    const toolsResult = await pool.query(
      `SELECT id, activity_name, class_unit, risk_level FROM risk_assessments
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
      toolListHtml = '<div class="tool-picker-item">No approved tool risk assessments yet.</div>';
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

        <div class="form-section-title">Tool risk assessments used</div>
        <p class="form-section-hint">Select any equipment already covered by an approved tool risk assessment. If something you need isn't listed, ask your WHS Coordinator to add it first.</p>
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
          <textarea id="environmental_hazards" name="environmental_hazards" placeholder="e.g. weather, insects/wildlife, sun exposure"></textarea>
        </div>
        <div class="form-row">
          <label for="environmental_controls">Control measures</label>
          <textarea id="environmental_controls" name="environmental_controls" placeholder="e.g. reschedule outdoor tasks in extreme heat, insect repellent available, sun-safe hats/shade required"></textarea>
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
        `INSERT INTO cara_tool_links (cara_id, risk_assessment_id) VALUES ${values} ON CONFLICT DO NOTHING`,
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
       JOIN risk_assessments ra ON ra.id = l.risk_assessment_id
       WHERE l.cara_id = $1
       ORDER BY ra.activity_name`,
      [req.params.id]
    );

    const toolChips = toolsResult.rows.length
      ? `<div class="tool-chip-list">${toolsResult.rows.map((t) => `
          <a class="tool-chip" href="/risk-assessments/${t.id}">
            <span class="badge ${riskBadgeClass(t.risk_level)}">${escapeHtml(t.risk_level)}</span>
            ${escapeHtml(t.activity_name)}
          </a>
        `).join('')}</div>`
      : `<div class="detail-value">No tool risk assessments linked.</div>`;

    let actionsHtml = '';
    if (r.status === 'Draft') {
      actionsHtml = `
        <form method="post" action="/cara/${r.id}/submit">
          <button type="submit" class="btn btn-primary" style="width:100%;">Submit for approval</button>
        </form>
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
      </div>
      <div class="detail-grid">
        <div>
          <div class="detail-section">
            <div class="detail-label">Activity scope</div>
            <div class="detail-value">${escapeHtml(r.activity_scope || '—')}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">Tool risk assessments used</div>
            ${toolChips}
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

app.post('/cara/:id/submit', async (req, res, next) => {
  try {
    await pool.query(
      "UPDATE cara_records SET status = 'Pending approval', updated_at = now() WHERE id = $1",
      [req.params.id]
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
  res.redirect('/risk-assessments');
});

// ---------- Admin: records list ----------

app.get('/admin', requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM risk_assessments ORDER BY id');
    const caraResult = await pool.query('SELECT * FROM cara_records ORDER BY id');

    const rows = result.rows.map((r) => `
      <tr class="row-link" onclick="window.location='/admin/risk-assessments/${r.id}/edit'">
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
      <div class="form-section-title" style="margin-top:0;padding-top:0;border-top:none;">Tool risk assessments</div>
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

app.get('/admin/risk-assessments/:id/edit', requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM risk_assessments WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).send('Risk assessment not found.');
    }
    const r = result.rows[0];

    const riskOptions = RISK_LEVELS.map((l) => `<option value="${l}" ${l === r.risk_level ? 'selected' : ''}>${l}</option>`).join('');
    const statusOptions = STATUSES.map((s) => `<option value="${s}" ${s === r.status ? 'selected' : ''}>${s}</option>`).join('');

    const body = `
      <a class="back-link" href="/admin">← Back to Admin</a>
      <h1 class="page-title" style="margin-bottom:24px;">Edit: ${escapeHtml(r.activity_name)}</h1>
      <form class="form-card" method="post" action="/admin/risk-assessments/${r.id}">
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
      <form method="post" action="/admin/risk-assessments/${r.id}/delete" style="margin-top:16px;" onsubmit="return confirm('Delete this record permanently? This cannot be undone.');">
        <button type="submit" class="btn btn-secondary" style="color:#B3261E;border-color:#B3261E;">Delete this record</button>
      </form>
    `;

    res.send(page({ title: `Edit — ${r.activity_name}`, active: 'admin', body }));
  } catch (err) {
    next(err);
  }
});

app.post('/admin/risk-assessments/:id', requireAdmin, async (req, res, next) => {
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
      `UPDATE risk_assessments SET
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

    res.redirect(`/admin/risk-assessments/${req.params.id}/edit`);
  } catch (err) {
    next(err);
  }
});

app.post('/admin/risk-assessments/:id/delete', requireAdmin, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM risk_assessments WHERE id = $1', [req.params.id]);
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
