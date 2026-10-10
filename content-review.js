// Content review: finds saved CARAs and projects with unsafe first aid
// wording, unresolved placeholders or possible supervision conflicts, shows
// where the wording first appeared (change history / AI use), and lets an
// admin apply a reviewed correction explicitly.
//
// - Scanning is read-only (/admin/content-review and
//   scripts/audit-cara-content.js).
// - A correction is never automatic: an admin clicks "Apply reviewed
//   correction" for one field. It is logged with the old and new text. An
//   approved or pending record goes back to Draft (and a project gets a new
//   version, keeping the approved one) so it must be re-approved.

const firstAid = require('./first-aid');
const features = require('./features');
const checks = require('./cara-checks');

const CARA_FIELDS = checks.CARA_TEXT_FIELDS;
const PROJECT_FIELDS = [
  ['description', 'What students will do'], ['scope_exclusions', 'Scope and exclusions'], ['conditions', 'Other conditions and hazards'],
  ['ppe', 'PPE'], ['induction_supervision', 'Induction, supervision and competency'], ['emergency_notes', 'Emergency considerations'],
  ['open_questions', 'Outstanding questions'],
];

async function scan(pool) {
  const out = [];
  const caras = (await pool.query(`SELECT c.*, s.name AS creator FROM cara_records c LEFT JOIN staff_users s ON s.id = c.created_by_staff_id ORDER BY c.id`)).rows;
  for (const c of caras) {
    const findings = [];
    for (const [k, label] of CARA_FIELDS) {
      const unsafe = firstAid.scanUnsafe(c[k]);
      if (unsafe.length) findings.push({ kind: 'unsafe', field: k, label, items: unsafe, current: c[k], proposal: firstAid.proposeCorrection(c[k]) });
      const ph = checks.findPlaceholders(c[k]);
      if (ph.length) findings.push({ kind: 'placeholder', field: k, label, items: ph });
    }
    const peras = (await pool.query(`SELECT p.id, p.activity_name, p.supervision_level, p.required_supervision FROM cara_tool_links l JOIN pera_records p ON p.id = l.pera_id WHERE l.cara_id = $1`, [c.id])).rows;
    const conflicts = checks.supervisionConflicts([{ label: 'Supervision', text: c.supervision_notes }, { label: 'Induction and instruction', text: c.induction_instruction }], peras);
    if (conflicts.length) findings.push({ kind: 'conflict', field: 'supervision_notes', label: 'Supervision', items: conflicts.map((x) => x.text) });
    if (!findings.length) continue;
    // Where did unsafe wording first appear?
    for (const f of findings.filter((x) => x.kind === 'unsafe')) {
      f.origin = [];
      for (const it of f.items) {
        const hit = (await pool.query(`SELECT changed_at, changed_by, brief FROM cara_change_log WHERE cara_id = $1 AND position($2 in summary) > 0 ORDER BY changed_at ASC LIMIT 1`, [c.id, it.sentence])).rows[0];
        let ai = null;
        if (c.created_by_staff_id) {
          ai = (await pool.query(`SELECT COUNT(*)::int AS n FROM cara_ai_reviews WHERE staff_id = $1 AND kind = 'draft' AND created_at BETWEEN $2::timestamptz - interval '1 day' AND $2::timestamptz + interval '1 day'`, [c.created_by_staff_id, hit ? hit.changed_at : c.created_at])).rows[0];
        }
        f.origin.push({
          sentence: it.sentence,
          firstSeen: hit ? `edit on ${new Date(hit.changed_at).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })} by ${hit.changed_by || 'unknown'}` : `present since the CARA was created (${new Date(c.created_at).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })}, by ${c.creator || c.submitted_by || 'unknown'})`,
          aiDraftsThatDay: ai ? ai.n : 0,
        });
      }
    }
    out.push({ type: 'CARA', id: c.id, title: c.activity_name, status: c.status, archived: c.archived, findings });
  }
  const projects = (await pool.query(`SELECT * FROM cara_projects ORDER BY id`)).rows;
  for (const p of projects) {
    const findings = [];
    for (const [k, label] of PROJECT_FIELDS) {
      const unsafe = firstAid.scanUnsafe(p[k]);
      if (unsafe.length) findings.push({ kind: 'unsafe', field: k, label, items: unsafe, current: p[k], proposal: firstAid.proposeCorrection(p[k]) });
      const ph = k === 'open_questions' ? [] : checks.findPlaceholders(p[k]);
      if (ph.length) findings.push({ kind: 'placeholder', field: k, label, items: ph });
    }
    if (findings.length) out.push({ type: 'Project', id: p.id, title: p.name, status: p.status, archived: p.status === 'Archived', findings });
  }
  return out;
}

function textReport(results) {
  const lines = [`Content review — ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })} (first aid library ${firstAid.LIBRARY_VERSION})`, ''];
  if (!results.length) lines.push('No issues found.');
  for (const r of results) {
    lines.push(`${r.type} #${r.id} "${r.title}" — ${r.status}${r.archived ? ' (archived)' : ''}`);
    for (const f of r.findings) {
      if (f.kind === 'unsafe') {
        for (const o of f.origin || f.items.map((i) => ({ sentence: i.sentence }))) {
          lines.push(`  UNSAFE FIRST AID in ${f.label}: "${o.sentence}"`);
          if (o.firstSeen) lines.push(`    first appeared: ${o.firstSeen}${o.aiDraftsThatDay ? `; ${o.aiDraftsThatDay} AI "Suggest content" request(s) by the creator that day` : ''}`);
        }
        lines.push(`    ${f.items[0].message}`);
      } else if (f.kind === 'placeholder') lines.push(`  Placeholders in ${f.label}: ${f.items.join(', ')}`);
      else lines.push(...f.items.map((t) => `  Possible conflict: ${t}`));
    }
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = function registerContentReview(app, deps) {
  const { pool, page, escapeHtml, requireRole, formatDate } = deps;
  const e = escapeHtml;

  app.get('/admin/content-review', requireRole('admin', 'approver', 'system_admin'), async (req, res, next) => {
    try {
      const results = (await scan(pool)).filter((r) => features.projects || r.type === 'CARA');
      const isAdmin = ['admin', 'system_admin'].includes(req.staffUser.role);
      const unsafeCount = results.reduce((n, r) => n + r.findings.filter((f) => f.kind === 'unsafe').length, 0);
      const body = `
        <a class="back-link" href="/admin/approvals">← Approvals</a>
        <h1 class="page-title">Content review</h1>
        <p class="page-subtitle">Saved CARAs and projects with unsafe first aid wording, unfilled placeholders or possible supervision conflicts. Read-only until you apply a correction.</p>
        <div class="chk-panel ${unsafeCount ? '' : 'chk-ok'}"><strong>${unsafeCount} unsafe first aid finding${unsafeCount === 1 ? '' : 's'}</strong> · ${results.length} record${results.length === 1 ? '' : 's'} listed</div>
        ${results.map((r) => `
          <div class="detail-section">
            <div class="detail-label"><a href="${r.type === 'CARA' ? `/cara/${r.id}` : `/projects/${r.id}`}">${e(r.type)} #${r.id} ${e(r.title)}</a> — ${e(r.status)}${r.archived ? ' (archived)' : ''}</div>
            ${r.findings.map((f) => {
              if (f.kind === 'unsafe') {
                return `<div class="cr-unsafe">
                  <strong>Unsafe first aid in ${e(f.label)}:</strong>
                  <ul>${(f.origin || f.items).map((o) => `<li>"${e(o.sentence)}"${o.firstSeen ? `<br><span class="prj-sub">First appeared: ${e(o.firstSeen)}${o.aiDraftsThatDay ? ` · ${o.aiDraftsThatDay} AI suggestion request(s) by the creator that day` : ''}</span>` : ''}</li>`).join('')}</ul>
                  <p class="prj-sub">${e(f.items[0].message)}</p>
                  <details><summary>Proposed correction for ${e(f.label)}</summary>
                    <div class="cr-cols"><div><b>Now</b><pre class="cr-pre">${e(f.current)}</pre></div><div><b>Proposed</b><pre class="cr-pre">${e(f.proposal.corrected)}</pre></div></div>
                    ${isAdmin ? `<form method="post" action="/admin/content-review/${r.type === 'CARA' ? 'cara' : 'project'}/${r.id}/fix" onsubmit="return confirm('Apply this correction? It is logged, and an approved or pending record goes back to Draft for re-approval.');">
                      <input type="hidden" name="field" value="${e(f.field)}">
                      <button class="btn btn-primary btn-sm" type="submit">Apply reviewed correction${r.status === 'Approved' || r.status === 'Pending approval' || r.status === 'Awaiting review' ? ' (returns to Draft for re-approval)' : ''}</button>
                    </form>` : '<p class="prj-sub">An admin can apply this correction.</p>'}
                  </details>
                </div>`;
              }
              if (f.kind === 'placeholder') return `<div class="cr-ph">Placeholders in ${e(f.label)}: ${e(f.items.join(', '))}</div>`;
              return `<div class="cr-ph">${f.items.map((t) => `Possible conflict: ${e(t)}`).join('<br>')}</div>`;
            }).join('')}
          </div>`).join('') || '<p>No issues found.</p>'}`;
      res.send(page({ title: 'Content review', active: 'admin', body }));
    } catch (err) { next(err); }
  });

  app.post('/admin/content-review/cara/:id/fix', requireRole('admin', 'system_admin'), async (req, res, next) => {
    try {
      const field = CARA_FIELDS.find(([k]) => k === req.body.field);
      const c = (await pool.query('SELECT * FROM cara_records WHERE id = $1', [req.params.id])).rows[0];
      if (!c || !field) return res.status(404).send('Not found.');
      const prop = firstAid.proposeCorrection(c[field[0]]);
      if (!prop) return res.redirect('/admin/content-review');
      const wasActive = ['Approved', 'Pending approval'].includes(c.status);
      const note = `Safety correction by ${req.staffUser.name} on ${formatDate(new Date())}: unsafe first aid wording in "${field[1]}" replaced with reviewed wording (first aid library ${firstAid.LIBRARY_VERSION}). Please check and resubmit for approval.`;
      await pool.query(
        `UPDATE cara_records SET ${field[0]} = $1, updated_at = now()${wasActive ? `, status = 'Draft', teacher_signature = NULL, signed_at = NULL, approver = NULL, approved_at = NULL, next_review_date = NULL, review_notes = $3` : ''} WHERE id = $2`,
        wasActive ? [prop.corrected, c.id, note] : [prop.corrected, c.id]
      );
      await pool.query('INSERT INTO cara_change_log (cara_id, changed_by, summary, brief) VALUES ($1,$2,$3,$4)',
        [c.id, req.staffUser.name, `${field[1]}: ${c[field[0]]} → ${prop.corrected}\nReason: ${prop.findings.map((f) => f.message).join(' ')}${wasActive ? `\nStatus: ${c.status} → Draft (re-approval required)` : ''}`, 'Safety correction']);
      res.redirect(`/cara/${c.id}`);
    } catch (err) { next(err); }
  });

  app.post('/admin/content-review/project/:id/fix', requireRole('admin', 'system_admin'), async (req, res, next) => {
    try {
      const field = PROJECT_FIELDS.find(([k]) => k === req.body.field);
      const p = (await pool.query('SELECT * FROM cara_projects WHERE id = $1', [req.params.id])).rows[0];
      if (!p || !field) return res.status(404).send('Not found.');
      const prop = firstAid.proposeCorrection(p[field[0]]);
      if (!prop) return res.redirect('/admin/content-review');
      const wasApproved = p.status === 'Approved';
      const wasActive = wasApproved || p.status === 'Awaiting review';
      await pool.query(
        `UPDATE cara_projects SET ${field[0]} = $1, updated_at = now()${wasActive ? `, status = 'Draft', version = version + ${wasApproved ? 1 : 0}, approver = NULL, approver_staff_id = NULL, approved_at = NULL` : ''} WHERE id = $2`,
        [prop.corrected, p.id]
      );
      await pool.query('INSERT INTO cara_project_log (project_id, changed_by, action, summary) VALUES ($1,$2,$3,$4)',
        [p.id, req.staffUser.name, 'Safety correction', `${field[1]}: ${p[field[0]]} → ${prop.corrected}\nReason: ${prop.findings.map((f) => f.message).join(' ')}${wasActive ? `\nStatus: ${p.status} → Draft${wasApproved ? ` (version ${p.version + 1}; approved version ${p.version} kept)` : ''}` : ''}`]);
      res.redirect(`/projects/${p.id}`);
    } catch (err) { next(err); }
  });
};

module.exports.scan = scan;
module.exports.textReport = textReport;
