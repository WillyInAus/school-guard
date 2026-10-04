// Approvals queue (/admin/approvals): every PERA and CARA waiting for a
// decision on one page, with the key facts needed to decide (risk and who
// must approve, minimum-safety checklist progress, SOP attached, student use)
// and a decision form on each card. The forms post to the existing
// /pera/:id/approve and /cara/:id/approve|reject routes (which enforce the
// role, the record's status and record who made the decision), then come
// back here. Admins and approvers only.

module.exports = function registerAdminApprovals(app, deps) {
  const {
    pool, page, escapeHtml, requireRole, adminTabs, adminHeader, riskBadgeClass, statusBadgeClass, formatBrisbaneDate,
    approvalRequirement, caraApprovalRequirement, APPROVAL_DECISIONS, APPROVAL_REQUIRED_LEVELS,
  } = deps;

  const short = (s) => String(s || '').replace(' — Plant & Equipment Risk Assessment', '');
  const suggestedLevel = (risk) => (risk === 'High' || risk === 'Extreme' ? 'Principal' : (risk === 'Medium' ? 'HOD' : 'WHS Officer'));

  app.get('/admin/approvals', requireRole('admin', 'approver'), async (req, res, next) => {
    try {
      const me = req.staffUser;
      const [perasR, carasR, recentPeraR, recentCaraR] = await Promise.all([
        pool.query(`
          SELECT p.id, p.activity_name, p.risk_level, p.status, p.submitted_by, p.updated_at, p.review_notes,
                 p.student_use_permitted, p.approval_required_level, p.created_by_staff_id,
                 (SELECT COUNT(*)::int FROM pera_min_requirements m WHERE m.pera_id = p.id) AS req_total,
                 (SELECT COUNT(*)::int FROM pera_min_requirements m WHERE m.pera_id = p.id AND m.status = 'Current') AS req_current,
                 (SELECT COUNT(*)::int FROM pera_min_requirements m WHERE m.pera_id = p.id AND m.status = 'Not applicable') AS req_na,
                 (SELECT string_agg(m.requirement, ', ' ORDER BY m.sort_order) FROM pera_min_requirements m WHERE m.pera_id = p.id AND m.status = 'Required') AS req_outstanding,
                 (SELECT COUNT(*)::int FROM pera_hazards h WHERE h.pera_id = p.id) AS hazard_count,
                 EXISTS (SELECT 1 FROM pera_documents d WHERE d.pera_id = p.id AND d.category = 'SOP' AND (d.file_data IS NOT NULL OR COALESCE(d.url,'') <> '')) AS has_sop,
                 (SELECT l.changed_by FROM pera_change_log l WHERE l.pera_id = p.id AND l.action = 'Submitted' ORDER BY l.changed_at DESC LIMIT 1) AS submitted_by_user,
                 (SELECT l.changed_at FROM pera_change_log l WHERE l.pera_id = p.id AND l.action = 'Submitted' ORDER BY l.changed_at DESC LIMIT 1) AS submitted_at
          FROM pera_records p
          WHERE p.archived = false AND p.status = 'Pending approval'
          ORDER BY CASE p.risk_level WHEN 'Extreme' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END, p.updated_at ASC`),
        pool.query(`
          SELECT c.id, c.activity_name, c.class_unit, c.risk_level, c.status, c.submitted_by, c.teacher_signature, c.signed_at, c.updated_at,
                 c.consent_required,
                 (SELECT COUNT(*)::int FROM cara_tool_links t WHERE t.cara_id = c.id) AS tool_count,
                 (SELECT COUNT(*)::int FROM cara_tool_links t JOIN pera_records p ON p.id = t.pera_id WHERE t.cara_id = c.id AND p.status <> 'Approved') AS unapproved_tools
          FROM cara_records c
          WHERE c.archived = false AND c.status = 'Pending approval'
          ORDER BY CASE c.risk_level WHEN 'Extreme' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END, c.updated_at ASC`),
        pool.query(`
          SELECT l.pera_id AS id, p.activity_name, l.action, l.summary, l.changed_by, l.changed_at
          FROM pera_change_log l JOIN pera_records p ON p.id = l.pera_id
          WHERE l.action IN ('Approved','Not approved') AND l.changed_at > now() - interval '30 days'
          ORDER BY l.changed_at DESC LIMIT 15`),
        pool.query(`
          SELECT l.cara_id AS id, c.activity_name, l.summary, l.changed_by, l.changed_at
          FROM cara_change_log l JOIN cara_records c ON c.id = l.cara_id
          WHERE (l.summary LIKE 'Approved%' OR l.summary LIKE 'Changes requested%') AND l.changed_at > now() - interval '30 days'
          ORDER BY l.changed_at DESC LIMIT 15`),
      ]);

      const peraCard = (p) => {
        const applicable = p.req_total - p.req_na;
        const checklistDone = applicable > 0 && p.req_current === applicable;
        const warnings = [];
        if (!p.has_sop) warnings.push('No SOP attached');
        if (p.req_outstanding) warnings.push(`Checklist still Required: ${p.req_outstanding}`);
        if (!p.hazard_count) warnings.push('No hazards recorded');
        const submittedBy = p.submitted_by_user || p.submitted_by;
        const isMine = (p.created_by_staff_id && p.created_by_staff_id === me.id) || (submittedBy && submittedBy === me.name);
        const level = p.approval_required_level || suggestedLevel(p.risk_level);
        return `
        <article class="apv-card apv-risk-${escapeHtml(String(p.risk_level).toLowerCase())}">
          <header class="apv-head">
            <div>
              <a class="apv-title" href="/pera/${p.id}">${escapeHtml(short(p.activity_name))}</a>
              <div class="apv-meta">PERA · submitted${submittedBy ? ` by ${escapeHtml(submittedBy)}` : ''} · ${formatBrisbaneDate(p.submitted_at || p.updated_at)}</div>
            </div>
            <span class="badge ${riskBadgeClass(p.risk_level)}">${escapeHtml(p.risk_level)} risk</span>
          </header>
          <div class="apv-req">${escapeHtml(approvalRequirement(p.risk_level))}</div>
          <div class="apv-facts">
            <div><span>Checklist</span><strong class="${checklistDone ? 'apv-good' : 'apv-bad'}">${p.req_total ? `${p.req_current} of ${applicable} current` : 'No checklist'}</strong></div>
            <div><span>SOP</span><strong class="${p.has_sop ? 'apv-good' : 'apv-bad'}">${p.has_sop ? 'Attached' : 'Missing'}</strong></div>
            <div><span>Hazards</span><strong>${p.hazard_count}</strong></div>
            <div><span>Student use</span><strong>${p.student_use_permitted === true ? 'Permitted' : (p.student_use_permitted === false ? 'Not permitted' : '—')}</strong></div>
          </div>
          ${warnings.length ? `<ul class="apv-warn">${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>` : ''}
          ${isMine ? '<div class="apv-self">You submitted this PERA. Ideally another approver makes this decision.</div>' : ''}
          <details class="apv-decide">
            <summary>Record decision</summary>
            <form method="post" action="/pera/${p.id}/approve" class="apv-form">
              <input type="hidden" name="redirect_to" value="/admin/approvals">
              <div class="apv-decisions" role="radiogroup" aria-label="Decision">
                ${APPROVAL_DECISIONS.map((d, i) => `
                  <label class="apv-choice apv-choice-${i}"><input type="radio" name="decision" value="${escapeHtml(d)}" required> <span>${escapeHtml(d)}</span></label>`).join('')}
              </div>
              <div class="apv-row apv-conditions"><label>Conditions</label><textarea name="approval_conditions" rows="2" placeholder="What conditions must be met?"></textarea></div>
              <div class="apv-row apv-notes"><label>What needs to change</label><textarea name="review_notes" rows="2" placeholder="Required if not approved — sent back to the author"></textarea></div>
              <div class="apv-grid">
                <div class="apv-row"><label>Approver name</label><input type="text" name="approver" value="${escapeHtml(me.name)}" required></div>
                <div class="apv-row"><label>Approver role</label><input type="text" name="approver_role" placeholder="e.g. WHS Officer, Principal, HOD"></div>
                <div class="apv-row"><label>Approval requirement</label>
                  <select name="approval_required_level">${APPROVAL_REQUIRED_LEVELS.map((l) => `<option value="${escapeHtml(l)}" ${l === level ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}</select></div>
              </div>
              <div class="apv-actions">
                <button type="submit" class="btn btn-primary">Save decision</button>
                <a class="apv-open" href="/pera/${p.id}">Open full PERA →</a>
              </div>
            </form>
          </details>
        </article>`;
      };

      const caraCard = (c) => {
        const warnings = [];
        if (c.unapproved_tools) warnings.push(`${c.unapproved_tools} linked PERA${c.unapproved_tools === 1 ? ' is' : 's are'} not approved`);
        if (!c.teacher_signature) warnings.push('Not signed by the teacher');
        return `
        <article class="apv-card apv-risk-${escapeHtml(String(c.risk_level).toLowerCase())}">
          <header class="apv-head">
            <div>
              <a class="apv-title" href="/cara/${c.id}">${escapeHtml(c.activity_name)}</a>
              <div class="apv-meta">CARA${c.class_unit ? ` · ${escapeHtml(c.class_unit)}` : ''} · ${c.submitted_by ? `by ${escapeHtml(c.submitted_by)} · ` : ''}${formatBrisbaneDate(c.signed_at || c.updated_at)}</div>
            </div>
            <span class="badge ${riskBadgeClass(c.risk_level)}">${escapeHtml(c.risk_level)} risk</span>
          </header>
          <div class="apv-req">${escapeHtml(caraApprovalRequirement(c.risk_level))}</div>
          <div class="apv-facts">
            <div><span>Tools / PERAs</span><strong>${c.tool_count}</strong></div>
            <div><span>Teacher signature</span><strong class="${c.teacher_signature ? 'apv-good' : 'apv-bad'}">${c.teacher_signature ? 'Signed' : 'Missing'}</strong></div>
            <div><span>Parent consent</span><strong>${c.consent_required ? 'Required' : 'Not required'}</strong></div>
          </div>
          ${warnings.length ? `<ul class="apv-warn">${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>` : ''}
          <details class="apv-decide">
            <summary>Record decision</summary>
            <div class="apv-cara-forms">
              <form method="post" action="/cara/${c.id}/approve" class="apv-form">
                <input type="hidden" name="redirect_to" value="/admin/approvals">
                <div class="apv-row"><label>Approved by</label><input type="text" name="approver" value="${escapeHtml(me.name)}" required></div>
                <button type="submit" class="btn btn-primary">Approve</button>
              </form>
              <form method="post" action="/cara/${c.id}/reject" class="apv-form">
                <input type="hidden" name="redirect_to" value="/admin/approvals">
                <div class="apv-row"><label>What needs to change</label><textarea name="review_notes" rows="2" required></textarea></div>
                <button type="submit" class="btn btn-secondary">Request changes</button>
              </form>
            </div>
            <a class="apv-open" href="/cara/${c.id}">Open full CARA →</a>
          </details>
        </article>`;
      };

      const recent = [
        ...recentPeraR.rows.map((r) => ({ ...r, kind: 'PERA', href: `/pera/${r.id}`, ok: r.action === 'Approved' })),
        ...recentCaraR.rows.map((r) => ({ ...r, kind: 'CARA', href: `/cara/${r.id}`, ok: r.summary.startsWith('Approved') })),
      ].sort((a, b) => new Date(b.changed_at) - new Date(a.changed_at)).slice(0, 15);

      const body = `
        ${adminHeader('Approvals', 'PERAs and CARAs waiting for a decision')}
        ${me.role === 'admin' ? adminTabs('approvals') : ''}
        <nav class="apv-jump">
          <a href="#pera">PERAs <span class="apv-count">${perasR.rows.length}</span></a>
          <a href="#cara">CARAs <span class="apv-count">${carasR.rows.length}</span></a>
          <a href="#recent">Recent decisions</a>
        </nav>

        <section id="pera" class="apv-section">
          <h2 class="apv-h2">PERAs awaiting approval <span class="apv-count">${perasR.rows.length}</span></h2>
          ${perasR.rows.length ? `<div class="apv-list">${perasR.rows.map(peraCard).join('')}</div>` : '<p class="apv-empty">No PERAs are waiting for approval. Drafts appear here once they are submitted.</p>'}
        </section>

        <section id="cara" class="apv-section">
          <h2 class="apv-h2">CARAs awaiting approval <span class="apv-count">${carasR.rows.length}</span></h2>
          ${carasR.rows.length ? `<div class="apv-list">${carasR.rows.map(caraCard).join('')}</div>` : '<p class="apv-empty">No CARAs are waiting for approval.</p>'}
        </section>

        <section id="recent" class="apv-section">
          <h2 class="apv-h2">Recent decisions <span class="apv-sub">last 30 days</span></h2>
          ${recent.length ? `<div class="card apv-recent"><ul>${recent.map((r) => `
            <li><span class="badge ${r.ok ? 'badge-approved' : 'badge-changes'}">${r.ok ? 'Approved' : 'Sent back'}</span>
              <a href="${r.href}"><span class="apv-kind">${r.kind}</span> ${escapeHtml(short(r.activity_name))}</a>
              <span class="apv-meta">${escapeHtml(r.changed_by || '')} · ${formatBrisbaneDate(r.changed_at)}</span></li>`).join('')}</ul></div>`
            : '<p class="apv-empty">No decisions recorded in the last 30 days.</p>'}
        </section>

        <style>
          .apv-jump { display: flex; gap: 8px; flex-wrap: wrap; margin: 4px 0 18px; }
          .apv-jump a { background: #FFFFFF; border: 1px solid #E4DFD3; border-radius: 999px; padding: 6px 14px; font-size: 13px; font-weight: 600; color: #1A1D1B; text-decoration: none; }
          .apv-count { display: inline-block; min-width: 20px; text-align: center; background: #1B5E52; color: #FFFFFF; border-radius: 999px; font-size: 12px; padding: 1px 7px; margin-left: 4px; }
          .apv-section { margin-bottom: 26px; scroll-margin-top: 16px; }
          .apv-h2 { font-size: 16px; font-weight: 700; margin: 0 0 12px; display: flex; align-items: center; gap: 6px; }
          .apv-sub { font-size: 12px; font-weight: 500; color: #6B6659; }
          .apv-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; align-items: start; }
          .apv-card { background: #FFFFFF; border: 1px solid #E4DFD3; border-left: 5px solid #D9D3C4; border-radius: 12px; padding: 16px 18px; }
          .apv-risk-low { border-left-color: #2F7D5A; } .apv-risk-medium { border-left-color: #B7791F; }
          .apv-risk-high { border-left-color: #C2600F; } .apv-risk-extreme { border-left-color: #C0392B; }
          .apv-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
          .apv-title { font-size: 15px; font-weight: 700; color: #1A1D1B; text-decoration: none; }
          .apv-title:hover { color: #1B5E52; }
          .apv-meta { font-size: 12px; color: #6B6659; margin-top: 2px; }
          .apv-req { font-size: 12px; color: #4A463D; background: #F5F3EE; border-radius: 8px; padding: 6px 10px; margin: 10px 0; }
          .apv-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; }
          .apv-facts div { border: 1px solid #F0EDE5; border-radius: 8px; padding: 6px 10px; }
          .apv-facts span { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #6B6659; }
          .apv-facts strong { font-size: 14px; }
          .apv-good { color: #2F7D5A; } .apv-bad { color: #C0392B; }
          .apv-warn { margin: 10px 0 0; padding: 8px 10px 8px 26px; background: #FDF0E6; border-radius: 8px; font-size: 12px; color: #8A3E1C; }
          .apv-self { margin-top: 8px; font-size: 12px; color: #6B5A1F; background: #FBF6E6; border-radius: 8px; padding: 6px 10px; }
          .apv-decide { margin-top: 12px; border-top: 1px solid #F0EDE5; padding-top: 10px; }
          .apv-decide > summary { cursor: pointer; font-weight: 700; font-size: 14px; color: #1B5E52; }
          .apv-form { margin-top: 10px; }
          .apv-decisions { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
          .apv-choice { display: flex; align-items: center; gap: 8px; border: 1px solid #E4DFD3; border-radius: 8px; padding: 8px 10px; font-size: 13px; font-weight: 600; cursor: pointer; }
          .apv-choice:has(input:checked) { border-color: #1B5E52; background: #EEF6F3; }
          .apv-choice-2:has(input:checked) { border-color: #C0392B; background: #FDF1EF; }
          .apv-row { margin-bottom: 8px; }
          .apv-row label { display: block; font-size: 12px; font-weight: 600; color: #6B6659; margin-bottom: 3px; }
          .apv-row input, .apv-row select, .apv-row textarea { width: 100%; box-sizing: border-box; border: 1px solid #D9D3C4; border-radius: 8px; padding: 7px 9px; font: inherit; font-size: 13px; }
          .apv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0 10px; }
          .apv-conditions, .apv-notes { display: none; }
          .apv-form:has(.apv-choice-1 input:checked) .apv-conditions { display: block; }
          .apv-form:has(.apv-choice-2 input:checked) .apv-notes { display: block; }
          .apv-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
          .apv-open { font-size: 13px; font-weight: 600; color: #1B5E52; text-decoration: none; }
          .apv-cara-forms { display: grid; gap: 12px; }
          .apv-empty { color: #6B6659; font-size: 14px; background: #FFFFFF; border: 1px dashed #D9D3C4; border-radius: 12px; padding: 16px; margin: 0; }
          .apv-recent { padding: 6px 18px; }
          .apv-recent ul { list-style: none; margin: 0; padding: 0; }
          .apv-recent li { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 9px 0; border-top: 1px solid #F0EDE5; font-size: 14px; }
          .apv-recent li:first-child { border-top: none; }
          .apv-recent li a { color: #1A1D1B; font-weight: 600; text-decoration: none; flex: 1 1 200px; }
          .apv-kind { font-size: 11px; font-weight: 700; color: #6B6659; background: #F0EDE5; border-radius: 4px; padding: 1px 5px; margin-right: 4px; }
          @media (max-width: 520px) { .apv-list { grid-template-columns: 1fr; } }
        </style>
      `;
      res.send(page({ title: 'Approvals', active: 'admin', body }));
    } catch (err) {
      next(err);
    }
  });
};
