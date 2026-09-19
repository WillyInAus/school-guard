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

    const body = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Dashboard</h1>
          <p class="page-subtitle">Faith Lutheran College — Plainland</p>
        </div>
      </div>
      <div class="stat-grid" style="grid-template-columns: repeat(2, minmax(0, 1fr));">
        <div class="stat-tile">
          <div class="stat-label">Risk assessments on record</div>
          <div class="stat-value">${totalResult.rows[0].count}</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">Pending approval</div>
          <div class="stat-value">${pendingResult.rows[0].count}</div>
        </div>
      </div>
      <div class="card" style="padding: 24px;">
        <p style="margin:0;font-size:14px;color:#6B6659;">
          This dashboard will grow as more of School Guard is built out — equipment register, inductions and the
          policy library are next. For now, head to <a href="/risk-assessments" style="color:#1B5E52;font-weight:600;">Risk Assessments</a>
          to add and manage records.
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
          <p class="page-subtitle">Curriculum Activity Risk Assessments (CARA) across IDT and VET workshops.</p>
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

// ---------- Admin: one-time bulk field update ----------

app.post('/admin/bulk-update', async (req, res, next) => {
  try {
    const { token } = req.body;
    if (token !== 'schoolguard-admin-2026') {
      return res.status(403).send('forbidden');
    }

    const approverResult = await pool.query(
      `UPDATE risk_assessments SET approver = $1, updated_at = now()`,
      ['Workplace Health and Safety Officer']
    );

    const submittedResult = await pool.query(
      `UPDATE risk_assessments SET submitted_by = $1, updated_at = now()
       WHERE class_unit LIKE 'IDT%' OR class_unit = 'Yr 11 Metalwork'`,
      ['Sean Willmott']
    );

    res.status(200).json({
      approverUpdated: approverResult.rowCount,
      submittedByUpdated: submittedResult.rowCount,
    });
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

    const rows = result.rows.map((r) => `
      <tr class="row-link" onclick="window.location='/admin/risk-assessments/${r.id}/edit'">
        <td>${escapeHtml(r.activity_name)}</td>
        <td>${escapeHtml(r.class_unit || '—')}</td>
        <td><span class="badge ${riskBadgeClass(r.risk_level)}">${escapeHtml(r.risk_level)}</span></td>
        <td><span class="badge ${statusBadgeClass(r.status)}">${escapeHtml(r.status)}</span></td>
        <td>${escapeHtml(r.approver || '—')}</td>
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
