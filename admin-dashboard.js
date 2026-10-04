// Admin dashboard (/admin): one page of tiles showing what needs an admin's
// attention -- items waiting for approval, reviews coming due, equipment
// problems and Staff Induction follow-ups -- plus short lists of the actual
// records so they can be opened directly. Read-only: every number links to
// the page where the work is done.

module.exports = function registerAdminDashboard(app, deps) {
  const { pool, page, escapeHtml, requireRole, adminTabs, adminHeader, riskBadgeClass, statusBadgeClass, formatBrisbaneDate } = deps;

  const n = async (sql, params = []) => (await pool.query(sql, params)).rows[0].count;

  app.get('/admin', requireRole('admin'), async (req, res, next) => {
    try {
      const [
        peraPending, peraDraft, peraChanges, peraReviewOverdue, peraReviewSoon,
        caraPending, caraDraft,
        equipNotOperational, equipInspectOverdue, equipMaintOverdue,
        indAwaiting, indSetup, indRequests, indLicences,
        staffActive,
      ] = await Promise.all([
        n(`SELECT COUNT(*)::int AS count FROM pera_records WHERE archived = false AND status = 'Pending approval'`),
        n(`SELECT COUNT(*)::int AS count FROM pera_records WHERE archived = false AND status = 'Draft'`),
        n(`SELECT COUNT(*)::int AS count FROM pera_records WHERE archived = false AND status = 'Changes requested'`),
        n(`SELECT COUNT(*)::int AS count FROM pera_records WHERE archived = false AND status = 'Approved' AND next_review_date < current_date`),
        n(`SELECT COUNT(*)::int AS count FROM pera_records WHERE archived = false AND status = 'Approved' AND next_review_date BETWEEN current_date AND current_date + 30`),
        n(`SELECT COUNT(*)::int AS count FROM cara_records WHERE archived = false AND status = 'Pending approval'`),
        n(`SELECT COUNT(*)::int AS count FROM cara_records WHERE archived = false AND status IN ('Draft','Changes requested')`),
        n(`SELECT COUNT(*)::int AS count FROM equipment_items WHERE status <> 'Operational'`),
        n(`SELECT COUNT(*)::int AS count FROM equipment_items WHERE status = 'Operational' AND next_inspection_due < current_date`),
        n(`SELECT COUNT(*)::int AS count FROM equipment_items WHERE status = 'Operational' AND next_maintenance_due < current_date`),
        n(`SELECT COUNT(*)::int AS count FROM staff_induction_declarations d
           JOIN staff_users s ON s.id = d.staff_id AND s.disabled = false
           JOIN induction_equipment_items i ON i.id = d.induction_item_id AND i.available_at_school = true
           WHERE d.status = 'C' AND NOT EXISTS (
             SELECT 1 FROM staff_induction_competency_verifications v
             WHERE v.staff_id = d.staff_id AND v.induction_item_id = d.induction_item_id AND v.verified = true)`),
        n(`SELECT COUNT(DISTINCT induction_item_id)::int AS count FROM induction_setup_alerts WHERE resolved_at IS NULL`),
        n(`SELECT COUNT(*)::int AS count FROM induction_assessor_requests r JOIN staff_users s ON s.id = r.staff_id AND s.disabled = false WHERE r.status = 'open'`),
        n(`SELECT COUNT(*)::int AS count FROM staff_profile_licences l JOIN staff_users s ON s.id = l.staff_id AND s.disabled = false
           WHERE l.active = true AND l.expiry_date IS NOT NULL AND l.expiry_date <= current_date + 30`),
        n(`SELECT COUNT(*)::int AS count FROM staff_users WHERE disabled = false`),
      ]);

      const [pendingPeras, pendingCaras, dueReviews, equipIssues] = await Promise.all([
        pool.query(`SELECT id, activity_name, risk_level, submitted_by, updated_at FROM pera_records
                    WHERE archived = false AND status = 'Pending approval' ORDER BY updated_at ASC LIMIT 8`),
        pool.query(`SELECT id, activity_name, risk_level, submitted_by, updated_at FROM cara_records
                    WHERE archived = false AND status = 'Pending approval' ORDER BY updated_at ASC LIMIT 8`),
        pool.query(`SELECT id, activity_name, next_review_date FROM pera_records
                    WHERE archived = false AND status = 'Approved' AND next_review_date <= current_date + 30
                    ORDER BY next_review_date ASC LIMIT 8`),
        pool.query(`SELECT id, name, status, next_inspection_due, next_maintenance_due FROM equipment_items
                    WHERE status <> 'Operational' OR next_inspection_due < current_date OR next_maintenance_due < current_date
                    ORDER BY (status <> 'Operational') DESC, LEAST(next_inspection_due, next_maintenance_due) ASC NULLS LAST LIMIT 8`),
      ]);

      // tone: 'alert' (needs action now), 'warn' (coming up), 'ok' (nothing to do), 'info' (neutral count)
      const tone = (count, whenPositive) => (count > 0 ? whenPositive : 'ok');
      const tile = ({ label, count, href, hint, t }) => `
        <a class="adm-tile adm-${t}" href="${href}">
          <div class="adm-tile-count">${count}</div>
          <div class="adm-tile-label">${escapeHtml(label)}</div>
          ${hint ? `<div class="adm-tile-hint">${escapeHtml(hint)}</div>` : ''}
        </a>`;
      const group = (title, tiles) => `
        <section class="adm-group">
          <h2 class="adm-group-title">${escapeHtml(title)}</h2>
          <div class="adm-tiles">${tiles.join('')}</div>
        </section>`;

      const listCard = (title, rows, empty, renderRow, moreHref) => `
        <section class="card adm-list">
          <div class="adm-list-head"><h2 class="adm-group-title" style="margin:0;">${escapeHtml(title)}</h2>${moreHref ? `<a class="adm-more" href="${moreHref}">View all →</a>` : ''}</div>
          ${rows.length ? `<ul>${rows.map(renderRow).join('')}</ul>` : `<p class="adm-empty">${escapeHtml(empty)}</p>`}
        </section>`;
      const short = (s) => String(s || '').replace(' — Plant & Equipment Risk Assessment', '');

      const body = `
        ${adminHeader('Admin dashboard', 'What needs your attention across School Guard')}
        ${adminTabs('dashboard')}

        ${group('Approvals', [
          tile({ label: 'CARAs awaiting approval', count: caraPending, href: '/admin/approvals#cara', hint: 'Signed by the teacher, waiting for a decision', t: tone(caraPending, 'alert') }),
          tile({ label: 'CARAs in Draft or sent back', count: caraDraft, href: '/cara', t: 'info' }),
          tile({ label: 'PERAs awaiting approval', count: peraPending, href: '/admin/approvals#pera', hint: 'Submitted and waiting for a decision', t: tone(peraPending, 'alert') }),
          tile({ label: 'PERAs in Draft', count: peraDraft, href: '/pera', hint: 'To be checked and submitted', t: tone(peraDraft, 'warn') }),
          tile({ label: 'PERAs with changes requested', count: peraChanges, href: '/pera', hint: 'Sent back to the author', t: tone(peraChanges, 'warn') }),
        ])}

        ${group('Reviews and equipment', [
          tile({ label: 'PERA reviews overdue', count: peraReviewOverdue, href: '#reviews', hint: 'Approved PERAs past their review date', t: tone(peraReviewOverdue, 'alert') }),
          tile({ label: 'PERA reviews due in 30 days', count: peraReviewSoon, href: '#reviews', t: tone(peraReviewSoon, 'warn') }),
          tile({ label: 'Equipment not operational', count: equipNotOperational, href: '#equipment', hint: 'Needs repair or out of service', t: tone(equipNotOperational, 'alert') }),
          tile({ label: 'Inspections overdue', count: equipInspectOverdue, href: '/equipment', t: tone(equipInspectOverdue, 'warn') }),
          tile({ label: 'Maintenance overdue', count: equipMaintOverdue, href: '/equipment', t: tone(equipMaintOverdue, 'warn') }),
        ])}

        ${group('Staff induction', [
          tile({ label: 'Competency awaiting review', count: indAwaiting, href: '/induction/assessor', hint: 'Self-assessed items not yet verified', t: tone(indAwaiting, 'warn') }),
          tile({ label: 'School setup required', count: indSetup, href: '/induction/assessor', hint: 'Equipment missing an approved PERA or SOP', t: tone(indSetup, 'alert') }),
          tile({ label: 'Open training / evidence requests', count: indRequests, href: '/induction/assessor', t: tone(indRequests, 'info') }),
          tile({ label: 'Licences expired or expiring', count: indLicences, href: '/induction/review-queue', hint: 'Within the next 30 days', t: tone(indLicences, 'warn') }),
          tile({ label: 'Active staff accounts', count: staffActive, href: '/admin/staff', t: 'info' }),
        ])}

        <div class="adm-lists">
          <div id="awaiting">
          ${listCard('Awaiting approval', [
            ...pendingCaras.rows.map((r) => ({ ...r, kind: 'CARA', href: `/cara/${r.id}` })),
            ...pendingPeras.rows.map((r) => ({ ...r, kind: 'PERA', href: `/pera/${r.id}` })),
          ], 'Nothing is waiting for approval.', (r) => `
            <li><a href="${r.href}"><span class="adm-kind">${r.kind}</span> ${escapeHtml(short(r.activity_name))}</a>
              <span class="badge ${riskBadgeClass(r.risk_level)}">${escapeHtml(r.risk_level)}</span>
              <span class="adm-meta">${r.submitted_by ? `${escapeHtml(r.submitted_by)} · ` : ''}${formatBrisbaneDate(r.updated_at)}</span></li>`, '/admin/approvals')}
          </div>
          <div id="reviews">
          ${listCard('PERA reviews due', dueReviews.rows, 'No PERA reviews due in the next 30 days.', (r) => `
            <li><a href="/pera/${r.id}">${escapeHtml(short(r.activity_name))}</a>
              <span class="badge ${new Date(r.next_review_date) < new Date(new Date().toDateString()) ? 'badge-changes' : 'badge-pending'}">${formatBrisbaneDate(r.next_review_date)}</span></li>`)}
          </div>
          <div id="equipment">
          ${listCard('Equipment needing attention', equipIssues.rows, 'All equipment is operational and up to date.', (r) => `
            <li><a href="/equipment/${r.id}">${escapeHtml(r.name)}</a>
              <span class="badge ${r.status === 'Operational' ? 'badge-pending' : 'badge-changes'}">${escapeHtml(r.status === 'Operational' ? 'Check overdue' : r.status)}</span></li>`, '/equipment')}
          </div>
        </div>

        <style>
          .adm-group { margin-bottom: 22px; }
          .adm-group-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: #6B6659; margin: 0 0 10px; }
          .adm-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; }
          .adm-tile { display: block; background: #FFFFFF; border: 1px solid #E4DFD3; border-top: 4px solid #D9D3C4; border-radius: 12px; padding: 14px 16px; text-decoration: none; color: inherit; transition: box-shadow .15s, transform .15s; }
          .adm-tile:hover { box-shadow: 0 4px 14px rgba(26,29,27,.08); transform: translateY(-1px); }
          .adm-tile-count { font-size: 30px; font-weight: 700; line-height: 1.1; color: #1A1D1B; }
          .adm-tile-label { font-size: 14px; font-weight: 600; color: #1A1D1B; margin-top: 4px; }
          .adm-tile-hint { font-size: 12px; color: #6B6659; margin-top: 4px; line-height: 1.35; }
          .adm-alert { border-top-color: #C0392B; } .adm-alert .adm-tile-count { color: #C0392B; }
          .adm-warn { border-top-color: #B7791F; } .adm-warn .adm-tile-count { color: #B7791F; }
          .adm-ok { border-top-color: #2F7D5A; } .adm-ok .adm-tile-count { color: #2F7D5A; }
          .adm-info { border-top-color: #1B5E52; }
          .adm-lists { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin-top: 8px; }
          .adm-list { padding: 18px 20px; display: block; height: 100%; box-sizing: border-box; }
          .adm-list-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; }
          .adm-more { font-size: 13px; color: #1B5E52; font-weight: 600; text-decoration: none; }
          .adm-list ul { list-style: none; margin: 0; padding: 0; }
          .adm-list li { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; padding: 8px 0; border-top: 1px solid #F0EDE5; font-size: 14px; }
          .adm-list li:first-child { border-top: none; }
          .adm-list li a { color: #1A1D1B; font-weight: 600; text-decoration: none; flex: 1 1 180px; min-width: 0; }
          .adm-list li a:hover { color: #1B5E52; }
          .adm-kind { font-size: 11px; font-weight: 700; color: #6B6659; background: #F0EDE5; border-radius: 4px; padding: 1px 5px; margin-right: 4px; }
          .adm-meta { font-size: 12px; color: #6B6659; width: 100%; }
          .adm-empty { font-size: 14px; color: #6B6659; margin: 0; }
          @media (max-width: 520px) { .adm-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; } .adm-tile-count { font-size: 26px; } }
        </style>
      `;
      res.send(page({ title: 'Admin dashboard', active: 'admin', body }));
    } catch (err) {
      next(err);
    }
  });
};
