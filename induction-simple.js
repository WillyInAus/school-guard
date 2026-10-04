// Simplified Staff Induction: teacher landing page, equipment selection /
// self-assessment, PERA + SOP review and acknowledgement, and the assessor
// review workspace.
//
// Everything here sits on top of the existing induction tables
// (staff_induction_declarations, staff_induction_competency_verifications,
// staff_induction_authorisations, ...) and the new tables added at the
// end of db.js. Ground rules enforced server-side throughout:
//   * a self-assessment or a document acknowledgement never grants any
//     verification or authorisation by itself;
//   * nobody can verify, authorise or acknowledge on behalf of themselves
//     where that would be self-approval (blockSelfAction), and only the
//     authenticated teacher can acknowledge their own documents;
//   * acknowledgements are pinned to exact document versions, never
//     edited or silently carried over to a new version.

module.exports = function registerSimplifiedInduction(app, deps) {
  const {
    pool, page, escapeHtml, normalizeText,
    formatBrisbaneDate, formatBrisbaneDateTime,
    canActAsAssessor, canAuthoriseSchoolLeader, blockSelfAction,
    logInductionChange, getCurrentProfileVersion, getActiveLicences,
  } = deps;

  const ACK_DECLARATION = 'I have read and understood the linked PERA and SOP and will follow the controls and operating requirements.';

  // Plain-language self-assessment options, mapped onto the existing
  // declaration codes so every existing report keeps working.
  const ANSWER_LABELS = {
    C: 'I have experience and consider myself competent',
    NYC: 'I need training',
    NA: 'I do not use this equipment',
  };

  const WORKFLOW = {
    action: { label: 'Action required', badge: 'badge-changes' },
    awaiting: { label: 'Awaiting assessor review', badge: 'badge-pending' },
    training: { label: 'Training required', badge: 'badge-pending' },
    complete: { label: 'Review complete', badge: 'badge-approved' },
    setup: { label: 'School setup required', badge: 'badge-draft' },
  };

  const REVIEW_OUTCOMES = {
    verified_existing: 'Competency verified — existing competence (documented)',
    verified_assessed: 'Competency verified — assessed at this school',
    training_required: 'Training required (assign training)',
    evidence_requested: 'Request further evidence',
  };

  const back = '<a href="javascript:history.back()">Back</a>';
  const toIntArray = (v) => (v === undefined || v === null || v === '' ? [] : (Array.isArray(v) ? v : [v]))
    .map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const yesNo = (v) => `<span class="ind-perm ${v ? 'ind-perm-yes' : 'ind-perm-no'}">${v ? 'Yes' : 'No'}</span>`;
  const todayDate = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

  // ------------------------------------------------------------------
  // Controlled document versions
  // ------------------------------------------------------------------

  async function ensureCurrentPeraVersion(pera) {
    const sel = () => pool.query(`SELECT * FROM induction_doc_versions WHERE doc_type = 'PERA' AND pera_id = $1 AND is_current`, [pera.id]);
    let r = await sel();
    if (r.rows[0]) return r.rows[0];
    await pool.query(
      `INSERT INTO induction_doc_versions (doc_type, pera_id, title_snapshot, version_label, pera_record_version, reason)
       VALUES ('PERA',$1,$2,$3,$4,'Initial version for staff acknowledgement') ON CONFLICT DO NOTHING`,
      [pera.id, pera.activity_name, `PERA v${pera.version || 1}`, pera.version || 1]
    );
    r = await sel();
    return r.rows[0] || null;
  }

  function sopVersionLabel(doc, rev) {
    return `${doc.file_name || doc.title} · added ${formatBrisbaneDate(doc.added_at)}${rev > 1 ? ` · rev ${rev}` : ''}`;
  }

  // Creates acknowledgement tasks for every teacher affected by a new
  // version: anyone who acknowledged the previous version, plus anyone
  // currently using equipment that relies on this PERA.
  async function createAckTasks(client, { newVersion, previousVersion, reason, createdBy }) {
    const prevCol = previousVersion && previousVersion.doc_type === 'PERA' ? 'pera_version_id' : 'sop_version_id';
    await client.query(
      `INSERT INTO staff_doc_ack_tasks (staff_id, doc_version_id, previous_doc_version_id, reason, created_by_staff_id)
       SELECT DISTINCT s.staff_id, $1::int, $2::int, $3, $4::int FROM (
         SELECT a.staff_id FROM staff_doc_acknowledgements a WHERE $2::int IS NOT NULL AND a.${prevCol} = $2::int
         UNION
         SELECT d.staff_id FROM staff_induction_declarations d
         JOIN induction_equipment_items i ON i.id = d.induction_item_id AND i.available_at_school = true
         WHERE i.pera_id = $5::int AND d.status IN ('C','NYC')
       ) s
       JOIN staff_users u ON u.id = s.staff_id AND u.disabled = false
       ON CONFLICT (staff_id, doc_version_id) DO NOTHING`,
      [newVersion.id, previousVersion ? previousVersion.id : null, reason, createdBy || null, newVersion.pera_id]
    );
  }

  // Supersedes the current version of a document with a new one. Used both
  // for a newly attached SOP file and for a reviewer-recorded material
  // change. The old row is kept (is_current=false) so earlier
  // acknowledgements stay linked to exactly what was read.
  async function supersedeVersion({ peraId, docType, build, reason, material, createdBy, onlyIf }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM pera_records WHERE id = $1 FOR UPDATE', [peraId]);
      const cur = (await client.query(
        'SELECT * FROM induction_doc_versions WHERE doc_type = $1 AND pera_id = $2 AND is_current FOR UPDATE',
        [docType, peraId]
      )).rows[0] || null;
      if (onlyIf && !onlyIf(cur)) {
        await client.query('COMMIT');
        return cur;
      }
      const revCount = (await client.query('SELECT COUNT(*)::int AS n FROM induction_doc_versions WHERE doc_type = $1 AND pera_id = $2', [docType, peraId])).rows[0].n;
      if (cur) {
        await client.query('UPDATE induction_doc_versions SET is_current = false, superseded_at = now() WHERE id = $1', [cur.id]);
      }
      const fields = build(revCount + 1);
      const ins = await client.query(
        `INSERT INTO induction_doc_versions (doc_type, pera_id, pera_document_id, title_snapshot, version_label, pera_record_version, reason, material_change, created_by_staff_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [docType, peraId, fields.pera_document_id || null, fields.title_snapshot, fields.version_label, fields.pera_record_version || null, reason, Boolean(material), createdBy || null]
      );
      const newVersion = ins.rows[0];
      if (cur) {
        await client.query('UPDATE induction_doc_versions SET superseded_by_id = $1 WHERE id = $2', [newVersion.id, cur.id]);
        await createAckTasks(client, { newVersion, previousVersion: cur, reason, createdBy });
      }
      await client.query('COMMIT');
      return newVersion;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function ensureCurrentSopVersion(pera, doc) {
    const cur = (await pool.query(`SELECT * FROM induction_doc_versions WHERE doc_type = 'SOP' AND pera_id = $1 AND is_current`, [pera.id])).rows[0];
    if (cur && cur.pera_document_id === doc.id) return cur;
    return supersedeVersion({
      peraId: pera.id,
      docType: 'SOP',
      onlyIf: (c) => !c || c.pera_document_id !== doc.id,
      build: () => ({ pera_document_id: doc.id, title_snapshot: doc.title, version_label: sopVersionLabel(doc, 1) }),
      reason: cur ? 'A new SOP document was attached to this PERA, replacing the one previously acknowledged.' : 'Initial version for staff acknowledgement',
      material: Boolean(cur),
    });
  }

  function peraReviewStatus(pera) {
    if (!pera) return 'Missing';
    if (pera.archived) return 'Archived';
    if (pera.status !== 'Approved') return `Not approved (${pera.status})`;
    if (pera.next_review_date && new Date(pera.next_review_date) < todayDate()) return `Review overdue (was due ${formatBrisbaneDate(pera.next_review_date)})`;
    return `Approved${pera.next_review_date ? ` · next review ${formatBrisbaneDate(pera.next_review_date)}` : ''}`;
  }

  // Everything a teacher or assessor needs to know about the PERA + SOP
  // behind one equipment item. A missing or unapproved document is listed
  // in "missing" and can never be acknowledged.
  async function resolveDocsForPera(peraId) {
    const out = { peraId: peraId || null, pera: null, peraVersion: null, sopDoc: null, sopVersion: null, missing: [] };
    if (!peraId) {
      out.missing.push({ type: 'PERA', detail: 'No PERA is linked to this equipment yet.' });
      out.missing.push({ type: 'SOP', detail: 'No SOP is available because no PERA is linked.' });
      return out;
    }
    const pera = (await pool.query('SELECT id, activity_name, status, version, next_review_date, archived FROM pera_records WHERE id = $1', [peraId])).rows[0] || null;
    out.pera = pera;
    if (!pera) {
      out.missing.push({ type: 'PERA', detail: 'The linked PERA no longer exists.' });
      out.missing.push({ type: 'SOP', detail: 'No SOP is available because the PERA no longer exists.' });
      return out;
    }
    if (pera.archived || pera.status !== 'Approved') {
      out.missing.push({ type: 'PERA', detail: pera.archived ? 'The linked PERA is archived.' : `The linked PERA is not approved yet (status: ${pera.status}).` });
    } else {
      out.peraVersion = await ensureCurrentPeraVersion(pera);
    }
    const sop = (await pool.query(
      `SELECT id, title, file_name, url, added_at, (file_data IS NOT NULL) AS has_file
       FROM pera_documents WHERE pera_id = $1 AND category = 'SOP' AND (file_data IS NOT NULL OR COALESCE(url,'') <> '')
       ORDER BY added_at DESC, id DESC LIMIT 1`,
      [peraId]
    )).rows[0] || null;
    out.sopDoc = sop;
    if (!sop) {
      out.missing.push({ type: 'SOP', detail: 'No SOP document is attached to the linked PERA.' });
    } else {
      out.sopVersion = await ensureCurrentSopVersion(pera, sop);
    }
    return out;
  }

  async function syncSetupAlerts(itemId, docs, staffId) {
    const missingTypes = new Set(docs.missing.map((m) => m.type));
    for (const m of docs.missing) {
      await pool.query(
        `INSERT INTO induction_setup_alerts (induction_item_id, missing, detail, first_raised_for_staff_id)
         VALUES ($1,$2,$3,$4) ON CONFLICT (induction_item_id, missing) WHERE resolved_at IS NULL DO NOTHING`,
        [itemId, m.type, m.detail, staffId || null]
      );
    }
    for (const t of ['PERA', 'SOP']) {
      if (!missingTypes.has(t)) {
        await pool.query('UPDATE induction_setup_alerts SET resolved_at = now() WHERE induction_item_id = $1 AND missing = $2 AND resolved_at IS NULL', [itemId, t]);
      }
    }
  }

  // ------------------------------------------------------------------
  // Per-teacher state
  // ------------------------------------------------------------------

  async function getScopeCategoryIds(staffId) {
    const { rows } = await pool.query('SELECT category_id FROM staff_induction_scope WHERE staff_id = $1', [staffId]);
    return rows.length ? new Set(rows.map((r) => r.category_id)) : null;
  }

  async function getAllItems() {
    const { rows } = await pool.query(
      `SELECT i.id, i.name, i.category_id, i.pera_id, i.available_at_school, i.sort_order,
              c.name AS category_name, c.sort_order AS category_sort_order
       FROM induction_equipment_items i JOIN induction_equipment_categories c ON c.id = i.category_id
       ORDER BY c.sort_order, i.sort_order`
    );
    return rows;
  }

  function groupByCategory(items) {
    const cats = [];
    const byId = new Map();
    for (const it of items) {
      if (!byId.has(it.category_id)) {
        const c = { id: it.category_id, name: it.category_name, items: [] };
        byId.set(it.category_id, c);
        cats.push(c);
      }
      byId.get(it.category_id).items.push(it);
    }
    return cats;
  }

  async function latestBatchComments(staffId) {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (bi.induction_item_id) bi.induction_item_id, bi.comment, b.declared_at
       FROM staff_declaration_batch_items bi JOIN staff_declaration_batches b ON b.id = bi.batch_id
       WHERE b.staff_id = $1 ORDER BY bi.induction_item_id, b.declared_at DESC, b.id DESC`,
      [staffId]
    );
    return new Map(rows.map((r) => [r.induction_item_id, r]));
  }

  async function checklistRequirement(itemId, staffId) {
    const t = (await pool.query(
      `SELECT t.id, t.approved_at, (SELECT COUNT(*)::int FROM induction_checklist_criteria c WHERE c.template_id = t.id) AS n
       FROM induction_checklist_templates t WHERE t.induction_item_id = $1 ORDER BY t.created_at DESC LIMIT 1`,
      [itemId]
    )).rows[0];
    if (!t || !t.approved_at || !t.n) return { required: false, complete: false };
    const a = (await pool.query(
      `SELECT 1 FROM staff_induction_assessments WHERE staff_id = $1 AND template_id = $2 AND status = 'complete' LIMIT 1`,
      [staffId, t.id]
    )).rows[0];
    return { required: true, complete: Boolean(a) };
  }

  function computeWorkflow(e) {
    if (e.openRequests.some((r) => r.request_type === 'evidence')) {
      return { key: 'action', next: 'Provide the evidence your assessor requested' };
    }
    if (e.docState === 'pending') {
      return { key: 'action', next: 'Read and acknowledge the PERA and SOP' };
    }
    if (e.docState === 'missing') {
      return { key: 'setup', next: 'The school needs to add the PERA/SOP — no action needed from you yet' };
    }
    if (e.verified) return { key: 'complete', next: 'No action needed' };
    if (e.decl.status === 'NYC' || e.docState === 'clarification' || e.openRequests.some((r) => r.request_type === 'training')) {
      return { key: 'training', next: 'Complete training with your assessor' };
    }
    return { key: 'awaiting', next: 'Awaiting assessor review' };
  }

  async function buildTeacherState(staffId, { raiseAlerts = true } = {}) {
    const [staffR, allItems, scope, declR, verifR, authR, reqR, profile, licences, licAppsR, comments] = await Promise.all([
      pool.query('SELECT id, name, email, role FROM staff_users WHERE id = $1', [staffId]),
      getAllItems(),
      getScopeCategoryIds(staffId),
      pool.query('SELECT * FROM staff_induction_declarations WHERE staff_id = $1', [staffId]),
      pool.query('SELECT * FROM staff_induction_competency_verifications WHERE staff_id = $1', [staffId]),
      pool.query('SELECT * FROM staff_induction_authorisations WHERE staff_id = $1', [staffId]),
      pool.query(`SELECT * FROM induction_assessor_requests WHERE staff_id = $1 AND status = 'open' ORDER BY created_at`, [staffId]),
      getCurrentProfileVersion(staffId),
      getActiveLicences(staffId),
      pool.query(
        `SELECT a.induction_item_id, l.id, l.name, l.expiry_date, l.active
         FROM staff_profile_licence_applications a JOIN staff_profile_licences l ON l.id = a.profile_licence_id
         WHERE a.staff_id = $1`,
        [staffId]
      ),
      latestBatchComments(staffId),
    ]);
    const staff = staffR.rows[0] || null;
    if (!staff) return null;

    const declByItem = new Map(declR.rows.map((d) => [d.induction_item_id, d]));
    const verifByItem = new Map(verifR.rows.map((v) => [v.induction_item_id, v]));
    const authByItem = new Map();
    for (const a of authR.rows) {
      if (!authByItem.has(a.induction_item_id)) authByItem.set(a.induction_item_id, {});
      authByItem.get(a.induction_item_id)[a.authorisation_type] = a;
    }
    const reqByItem = new Map();
    for (const r of reqR.rows) {
      if (!reqByItem.has(r.induction_item_id)) reqByItem.set(r.induction_item_id, []);
      reqByItem.get(r.induction_item_id).push(r);
    }
    const licByItem = new Map();
    for (const l of licAppsR.rows) {
      if (!licByItem.has(l.induction_item_id)) licByItem.set(l.induction_item_id, new Map());
      licByItem.get(l.induction_item_id).set(l.id, l);
    }

    const available = allItems.filter((i) => i.available_at_school);
    const selectable = available.filter((i) => !scope || scope.has(i.category_id));

    const selected = available.filter((i) => {
      const d = declByItem.get(i.id);
      return d && (d.status === 'C' || d.status === 'NYC');
    });

    const docsByPera = new Map();
    for (const it of selected) {
      const key = it.pera_id || 0;
      if (!docsByPera.has(key)) docsByPera.set(key, await resolveDocsForPera(it.pera_id));
    }

    // Read acknowledgements and tasks only after the document versions above
    // are resolved -- resolving can create a new version (and its tasks).
    const [acksR, tasksR] = await Promise.all([
      pool.query(
        `SELECT DISTINCT ON (pera_version_id, sop_version_id) *
         FROM staff_doc_acknowledgements WHERE staff_id = $1
         ORDER BY pera_version_id, sop_version_id, recorded_at DESC, id DESC`,
        [staffId]
      ),
      pool.query(
        `SELECT t.*, v.doc_type, v.version_label, v.title_snapshot, v.is_current
         FROM staff_doc_ack_tasks t JOIN induction_doc_versions v ON v.id = t.doc_version_id
         WHERE t.staff_id = $1 AND t.completed_at IS NULL ORDER BY t.created_at`,
        [staffId]
      ),
    ]);
    const ackByPair = new Map(acksR.rows.map((a) => [`${a.pera_version_id}:${a.sop_version_id}`, a]));

    const entries = [];
    for (const it of selected) {
      const docs = docsByPera.get(it.pera_id || 0);
      if (raiseAlerts) await syncSetupAlerts(it.id, docs, staffId);
      let docState;
      let ack = null;
      let pairKey = null;
      if (docs.missing.length) {
        docState = 'missing';
      } else {
        pairKey = `${docs.peraVersion.id}:${docs.sopVersion.id}`;
        ack = ackByPair.get(pairKey) || null;
        docState = !ack ? 'pending' : (ack.response === 'acknowledged' ? 'acknowledged' : 'clarification');
      }
      const verification = verifByItem.get(it.id) || null;
      const auth = authByItem.get(it.id) || {};
      const e = {
        item: it,
        decl: declByItem.get(it.id),
        docs,
        docState,
        ack,
        pairKey,
        verification,
        verified: Boolean(verification && verification.verified),
        operate: Boolean(auth.operate && auth.operate.authorised),
        supervise: Boolean(auth.supervise_students && auth.supervise_students.authorised),
        auth,
        openRequests: reqByItem.get(it.id) || [],
        licences: Array.from((licByItem.get(it.id) || new Map()).values()),
        comment: comments.get(it.id) ? comments.get(it.id).comment : null,
      };
      e.workflow = computeWorkflow(e);
      entries.push(e);
    }

    // Group selected items that share exactly the same PERA + SOP versions.
    const groups = new Map();
    for (const e of entries) {
      if (!e.pairKey) continue;
      if (!groups.has(e.pairKey)) groups.set(e.pairKey, { key: e.pairKey, docs: e.docs, ack: e.ack, docState: e.docState, entries: [] });
      groups.get(e.pairKey).entries.push(e);
    }

    const currentVersionIds = new Set();
    for (const g of groups.values()) { currentVersionIds.add(g.docs.peraVersion.id); currentVersionIds.add(g.docs.sopVersion.id); }
    const openTasks = tasksR.rows.filter((t) => t.is_current && currentVersionIds.has(t.doc_version_id));

    return {
      staff, profile, licences, scope, allItems, available, selectable, declByItem, verifByItem, authByItem,
      entries, groups: Array.from(groups.values()), openTasks, comments, licByItem,
      missingEntries: entries.filter((e) => e.docState === 'missing'),
    };
  }

  // ------------------------------------------------------------------
  // Shared rendering bits
  // ------------------------------------------------------------------

  function workflowBadge(key) {
    const w = WORKFLOW[key];
    return `<span class="badge ${w.badge}">${escapeHtml(w.label)}</span>`;
  }

  function permissionIndicators(e) {
    return `
      <div class="ind-perms">
        <div><span class="ind-perm-label">Authorised to operate:</span> ${yesNo(e.operate)}</div>
        <div><span class="ind-perm-label">Authorised to supervise students:</span> ${yesNo(e.supervise)}</div>
      </div>`;
  }

  function profileSummaryHtml(profile, licences, { compact = false } = {}) {
    const quals = profile && profile.qualifications_trade ? profile.qualifications_trade : '';
    const exp = profile && profile.teaching_industry_experience ? profile.teaching_industry_experience : '';
    const clip = (s) => (compact && s.length > 160 ? `${s.slice(0, 157)}…` : s);
    return `
      <div class="ind-kv"><span>Qualifications / trade</span><div>${quals ? escapeHtml(clip(quals)) : '<em class="ind-muted">Not added yet</em>'}</div></div>
      <div class="ind-kv"><span>Teaching / industry experience</span><div>${exp ? escapeHtml(clip(exp)) : '<em class="ind-muted">Not added yet</em>'}</div></div>
      <div class="ind-kv"><span>Licences / certificates</span><div>${licences.length
        ? licences.map((l) => `${escapeHtml(l.name)}${l.expiry_date ? ` <span class="ind-muted">(expires ${formatBrisbaneDate(l.expiry_date)})</span>` : ''}`).join(', ')
        : '<em class="ind-muted">None recorded</em>'}</div></div>
      <div class="ind-muted" style="font-size:12px;margin-top:6px;">Full certificate details are kept on file at the school — refer to HR.</div>`;
  }

  function docLinksHtml(docs, staffOpenedIds) {
    if (docs.missing.length) {
      return `<div class="ind-setup"><strong>School setup required.</strong> ${docs.missing.map((m) => escapeHtml(m.detail)).join(' ')} The administrator has been notified. This document review can't be completed until the school adds it.</div>`;
    }
    const pv = docs.peraVersion;
    const sv = docs.sopVersion;
    const opened = (id) => staffOpenedIds && staffOpenedIds.has(id);
    return `
      <table class="ind-doc-table">
        <tr>
          <td><strong>PERA</strong></td>
          <td><a class="ind-doc-link" data-doc="pera" href="/induction/doc/${pv.id}/open" target="_blank" rel="noopener">${escapeHtml(docs.pera.activity_name)}</a>${opened(pv.id) ? ' <span class="ind-muted ind-opened">· opened</span>' : ' <span class="ind-muted ind-opened"></span>'}</td>
          <td class="ind-muted">${escapeHtml(pv.version_label)}</td>
          <td class="ind-muted">${escapeHtml(peraReviewStatus(docs.pera))}</td>
        </tr>
        <tr>
          <td><strong>SOP</strong></td>
          <td><a class="ind-doc-link" data-doc="sop" href="/induction/doc/${sv.id}/open" target="_blank" rel="noopener">${escapeHtml(docs.sopDoc.title)}</a>${opened(sv.id) ? ' <span class="ind-muted ind-opened">· opened</span>' : ' <span class="ind-muted ind-opened"></span>'}</td>
          <td class="ind-muted">${escapeHtml(sv.version_label)}</td>
          <td class="ind-muted">Current SOP for this PERA</td>
        </tr>
      </table>`;
  }

  function ackStatusText(docState, ack) {
    if (docState === 'missing') return '<span class="badge badge-draft">School setup required</span>';
    if (docState === 'pending') return '<span class="badge badge-changes">Not yet acknowledged</span>';
    if (docState === 'clarification') return `<span class="badge badge-pending">Clarification / training requested</span> <span class="ind-muted">${formatBrisbaneDateTime(ack.recorded_at)}</span>`;
    return `<span class="badge badge-approved">Acknowledged</span> <span class="ind-muted">${formatBrisbaneDateTime(ack.recorded_at)}</span>`;
  }

  function nextOverallAction(state) {
    if (!state.entries.length) return { href: '/induction/me/equipment', text: 'Select the equipment you use and complete your self-assessment.' };
    const evidence = state.entries.find((e) => e.openRequests.some((r) => r.request_type === 'evidence'));
    if (evidence) return { href: `/induction/staff/${state.staff.id}/item/${evidence.item.id}`, text: `Provide the evidence your assessor requested for ${evidence.item.name}.` };
    const pendingGroups = state.groups.filter((g) => g.docState === 'pending');
    if (pendingGroups.length) return { href: '/induction/me/documents', text: `Read and acknowledge ${pendingGroups.length} PERA/SOP document set${pendingGroups.length === 1 ? '' : 's'}.` };
    const hasProfile = state.profile && (state.profile.qualifications_trade || state.profile.teaching_industry_experience);
    if (!hasProfile) return { href: `/induction/staff/${state.staff.id}/profile`, text: 'Add your qualifications and experience to your profile.' };
    if (state.entries.some((e) => e.workflow.key === 'training')) return { href: '/induction/me', text: 'Complete training with your assessor for the items marked "Training required".' };
    if (state.entries.some((e) => e.workflow.key === 'awaiting')) return { href: '/induction/me', text: 'Nothing more for you to do right now — awaiting assessor review.' };
    return { href: '/induction/me/equipment', text: 'Nothing outstanding. You can update your equipment selection at any time.' };
  }

  // ------------------------------------------------------------------
  // Teacher: landing page
  // ------------------------------------------------------------------

  app.get('/induction/me', async (req, res, next) => {
    try {
      const state = await buildTeacherState(req.staffUser.id);
      const { entries, groups, openTasks, profile, licences } = state;
      const counts = { action: 0, awaiting: 0, training: 0, complete: 0, setup: 0 };
      for (const e of entries) counts[e.workflow.key] += 1;
      const nextAct = nextOverallAction(state);
      const submitted = req.query.submitted === '1';

      // Outstanding actions list
      const actions = [];
      if (!entries.length) actions.push(`<li><a href="/induction/me/equipment">Select the equipment you use and complete your self-assessment</a></li>`);
      for (const t of openTasks) {
        actions.push(`<li><a href="/induction/me/documents">Re-acknowledge updated ${escapeHtml(t.doc_type)}: ${escapeHtml(t.title_snapshot)}</a><div class="ind-muted">Reason: ${escapeHtml(t.reason)}</div></li>`);
      }
      const taskVersionIds = new Set(openTasks.map((t) => t.doc_version_id));
      for (const g of groups.filter((x) => x.docState === 'pending')) {
        if (taskVersionIds.has(g.docs.peraVersion.id) || taskVersionIds.has(g.docs.sopVersion.id)) continue;
        actions.push(`<li><a href="/induction/me/documents">Read and acknowledge the PERA and SOP for ${escapeHtml(g.entries.map((e) => e.item.name).join(', '))}</a></li>`);
      }
      for (const e of entries) {
        for (const r of e.openRequests) {
          actions.push(`<li><a href="/induction/staff/${state.staff.id}/item/${e.item.id}">${r.request_type === 'evidence' ? 'Evidence requested' : 'Training assigned'}: ${escapeHtml(e.item.name)}</a>${r.details ? `<div class="ind-muted">${escapeHtml(r.details)}</div>` : ''}</li>`);
        }
      }
      if (!(profile && (profile.qualifications_trade || profile.teaching_industry_experience)) && entries.some((e) => e.decl.status === 'C')) {
        actions.push(`<li><a href="/induction/staff/${state.staff.id}/profile">Add your qualifications and experience to your profile</a></li>`);
      }
      const setupNames = state.missingEntries.map((e) => e.item.name);

      const equipmentRows = entries.map((e) => `
        <div class="ind-equip-row">
          <div class="ind-equip-main">
            <a href="/induction/staff/${state.staff.id}/item/${e.item.id}" class="ind-equip-name">${escapeHtml(e.item.name)}</a>
            <div class="ind-muted">${escapeHtml(ANSWER_LABELS[e.decl.status] || '')} · Next: ${escapeHtml(e.workflow.next)}</div>
          </div>
          <div class="ind-equip-status">${workflowBadge(e.workflow.key)}</div>
          ${permissionIndicators(e)}
        </div>`).join('');

      const body = `
        <div class="page-header">
          <div>
            <h1 class="page-title">My induction</h1>
            <p class="page-subtitle">${escapeHtml(state.staff.name)} · Faith Lutheran College</p>
          </div>
        </div>
        ${submitted ? `<div class="ind-flash">Your self-assessment has been submitted. Awaiting assessor review. Any further actions will appear here.</div>` : ''}
        <div class="card ind-progress">
          <div>
            <div class="ind-progress-title">Next step</div>
            <div class="ind-progress-next">${escapeHtml(nextAct.text)}</div>
            <div class="ind-muted" style="margin-top:6px;">${entries.length} item${entries.length === 1 ? '' : 's'} selected · ${counts.action} need action · ${counts.awaiting} awaiting review · ${counts.training} training required · ${counts.complete} review complete${counts.setup ? ` · ${counts.setup} awaiting school setup` : ''}</div>
          </div>
          <a class="btn btn-primary ind-continue" href="${nextAct.href}">Continue induction</a>
        </div>

        <div class="ind-sections">
          <section class="card ind-section">
            <h2 class="ind-h2">My profile</h2>
            ${profileSummaryHtml(profile, licences, { compact: true })}
            <a class="ind-link" href="/induction/staff/${state.staff.id}/profile">Update my profile →</a>
          </section>

          <section class="card ind-section">
            <h2 class="ind-h2">My outstanding actions</h2>
            ${actions.length ? `<ul class="ind-actions">${actions.join('')}</ul>` : `<p class="ind-muted" style="margin:0;">${entries.length ? 'Nothing for you to do right now. Any further actions will appear here.' : ''}</p>`}
            ${setupNames.length ? `<div class="ind-setup" style="margin-top:10px;"><strong>School setup required</strong> for ${escapeHtml(setupNames.join(', '))} — the PERA or SOP hasn't been added yet. The administrator has been notified; nothing is needed from you.</div>` : ''}
          </section>
        </div>

        <section class="card ind-section">
          <div class="ind-section-head">
            <h2 class="ind-h2">Equipment I use</h2>
            <a class="ind-link" href="/induction/me/equipment">Change my equipment selection →</a>
          </div>
          ${entries.length ? equipmentRows : '<p class="ind-muted" style="margin:0;">You haven\'t selected any equipment yet.</p>'}
          <div class="ind-muted" style="font-size:12px;margin-top:12px;">A self-assessment or document acknowledgement does not authorise you to operate equipment or supervise students. Only the two permission indicators above show that, and they are set separately by the school.</div>
        </section>

        <details class="card ind-section">
          <summary class="ind-summary">View details</summary>
          <p class="ind-muted">Your full record — step-by-step induction progress, checklists, logbook and history for every item.</p>
          <a class="btn btn-secondary" href="/induction/staff/${state.staff.id}">Open my detailed induction record</a>
          <a class="btn btn-secondary" href="/induction/staff/${state.staff.id}/print">Printable record</a>
        </details>
        ${canActAsAssessor(req.staffUser.role) ? `<p style="margin-top:16px;"><a class="ind-link" href="/induction">Assessor &amp; admin tools →</a></p>` : ''}
      `;
      res.send(page({ title: 'My induction', active: 'induction', body: body + clientCss() }));
    } catch (err) {
      next(err);
    }
  });

  // ------------------------------------------------------------------
  // Teacher: equipment selection + self-assessment
  // ------------------------------------------------------------------

  app.get('/induction/me/equipment', async (req, res, next) => {
    try {
      const state = await buildTeacherState(req.staffUser.id, { raiseAlerts: false });
      const { declByItem, licences, profile } = state;
      // Show selectable items, plus any item the teacher already answered
      // that's still available (so earlier answers are never hidden).
      const shown = state.available.filter((i) => state.selectable.includes(i) || declByItem.has(i.id));
      const cats = groupByCategory(shown);
      const hasProfileText = Boolean(profile && (profile.qualifications_trade || profile.teaching_industry_experience));

      const catHtml = cats.map((cat) => `
        <details class="ind-cat" data-cat="${cat.id}">
          <summary>
            <span class="ind-cat-name">${escapeHtml(cat.name)}</span>
            <span class="ind-muted ind-cat-count">${cat.items.length} item${cat.items.length === 1 ? '' : 's'}</span>
          </summary>
          <div class="ind-cat-tools">
            <label>Select category:
              <select class="ind-cat-select" data-cat="${cat.id}">
                <option value="">Choose…</option>
                <option value="C">${escapeHtml(ANSWER_LABELS.C)}</option>
                <option value="NYC">${escapeHtml(ANSWER_LABELS.NYC)}</option>
                <option value="NA">${escapeHtml(ANSWER_LABELS.NA)}</option>
                <option value="clear">Clear my choices in this category</option>
              </select>
            </label>
            <button type="button" class="btn btn-secondary ind-cat-apply" data-cat="${cat.id}">Apply to all in category</button>
          </div>
          ${cat.items.map((it) => {
            const d = declByItem.get(it.id);
            const cur = d && ANSWER_LABELS[d.status] ? ANSWER_LABELS[d.status] : null;
            const linked = state.licByItem.get(it.id) || new Map();
            return `
            <div class="ind-item" data-name="${escapeHtml(it.name.toLowerCase())}" data-cat="${cat.id}">
              <div class="ind-item-name">${escapeHtml(it.name)}${cur ? `<div class="ind-muted">Your current answer: ${escapeHtml(cur)}</div>` : ''}</div>
              <div class="ind-item-opts" role="radiogroup" aria-label="${escapeHtml(it.name)}">
                ${['C', 'NYC', 'NA'].map((k) => `<label><input type="radio" name="answer_${it.id}" value="${k}"> ${escapeHtml(ANSWER_LABELS[k])}</label>`).join('')}
              </div>
              <details class="ind-add-details">
                <summary>Add details</summary>
                <div class="form-row"><label for="c_${it.id}">Comment or exception for this item</label><textarea id="c_${it.id}" name="comment_${it.id}" rows="2"></textarea></div>
                ${licences.length ? `<div class="ind-muted" style="font-size:12px;margin-bottom:4px;">Link relevant qualifications to this item only (optional):</div>
                ${licences.map((l) => `<label class="ind-check"><input type="checkbox" name="licence_${it.id}" value="${l.id}" ${linked.has(l.id) ? 'checked disabled' : ''}> ${escapeHtml(l.name)}${linked.has(l.id) ? ' <span class="ind-muted">(already linked)</span>' : ''}</label>`).join('')}` : ''}
              </details>
            </div>`;
          }).join('')}
        </details>`).join('');

      const body = `
        <a class="back-link" href="/induction/me">← My induction</a>
        <h1 class="page-title">Equipment I use</h1>
        <p class="page-subtitle" style="margin-bottom:14px;">Choose an answer only for equipment that applies to you. Items you leave blank stay as they are.</p>
        ${state.scope ? '<div class="ind-muted" style="margin-bottom:10px;">Showing equipment available at the school for your role.</div>' : ''}
        ${!hasProfileText ? `<div class="note-box">Before answering "${escapeHtml(ANSWER_LABELS.C)}", add your qualifications and experience to <a href="/induction/staff/${state.staff.id}/profile">your profile</a>, or link a relevant licence under "Add details".</div>` : ''}
        <form method="post" action="/induction/me/equipment" class="ind-form" id="equip-form">
          <div class="ind-search">
            <input type="search" id="equip-search" placeholder="Search equipment…" aria-label="Search equipment">
            <button type="button" class="btn btn-secondary" id="expand-all">Expand all</button>
            <button type="button" class="btn btn-secondary" id="collapse-all">Collapse all</button>
          </div>
          ${catHtml || '<p class="ind-muted">No equipment has been set up for your role yet. Please contact the administrator.</p>'}
          <div class="card ind-confirm">
            <label class="ind-check"><input type="checkbox" name="confirm_selections" value="on" required>
              I confirm these answers are my own assessment of each selected item. Where I've chosen "${escapeHtml(ANSWER_LABELS.C)}", my qualifications and experience support it.</label>
            <div class="ind-muted" style="font-size:12px;margin:6px 0 10px;">Your answers are a self-assessment only. They do not authorise you to operate equipment or supervise students.</div>
            <span id="answer-count" class="ind-muted"></span>
            <button type="submit" class="btn btn-primary">Submit self-assessment</button>
          </div>
        </form>
        <script>
        (function(){
          var form = document.getElementById('equip-form');
          var search = document.getElementById('equip-search');
          function cats(){ return Array.prototype.slice.call(form.querySelectorAll('details.ind-cat')); }
          search.addEventListener('input', function(){
            var q = search.value.trim().toLowerCase();
            cats().forEach(function(cat){
              var any = false;
              cat.querySelectorAll('.ind-item').forEach(function(it){
                var m = !q || it.getAttribute('data-name').indexOf(q) !== -1;
                it.style.display = m ? '' : 'none';
                if (m) any = true;
              });
              cat.style.display = any ? '' : 'none';
              if (q && any) cat.open = true;
            });
          });
          document.getElementById('expand-all').onclick = function(){ cats().forEach(function(c){ c.open = true; }); };
          document.getElementById('collapse-all').onclick = function(){ cats().forEach(function(c){ c.open = false; }); };
          form.querySelectorAll('.ind-cat-apply').forEach(function(btn){
            btn.addEventListener('click', function(){
              var id = btn.getAttribute('data-cat');
              var sel = form.querySelector('.ind-cat-select[data-cat="' + id + '"]');
              var v = sel.value; if (!v) return;
              form.querySelectorAll('.ind-item[data-cat="' + id + '"]').forEach(function(it){
                if (it.style.display === 'none') return;
                it.querySelectorAll('input[type=radio]').forEach(function(r){ r.checked = (v !== 'clear' && r.value === v); });
              });
              count();
            });
          });
          function count(){
            var n = form.querySelectorAll('input[type=radio]:checked').length;
            document.getElementById('answer-count').textContent = n ? (n + ' item' + (n === 1 ? '' : 's') + ' answered · ') : 'No items answered yet · ';
          }
          form.addEventListener('change', count); count();
        })();
        </script>
      `;
      res.send(page({ title: 'Equipment I use', active: 'induction', body: body + clientCss() }));
    } catch (err) {
      next(err);
    }
  });

  app.post('/induction/me/equipment', async (req, res, next) => {
    const staffId = req.staffUser.id;
    const client = await pool.connect();
    try {
      const confirmed = req.body.confirm_selections === 'on' || req.body.confirm_selections === 'true';
      const items = (await pool.query('SELECT id, name, category_id FROM induction_equipment_items WHERE available_at_school = true')).rows;
      const answers = [];
      for (const it of items) {
        const v = req.body[`answer_${it.id}`];
        if (v === undefined || v === '') continue;
        if (!['C', 'NYC', 'NA'].includes(v)) return res.status(400).send(`Invalid answer for ${escapeHtml(it.name)}. ${back}`);
        answers.push({ item: it, status: v, comment: normalizeText(req.body[`comment_${it.id}`]) || null, licenceIds: toIntArray(req.body[`licence_${it.id}`]) });
      }
      if (!answers.length) return res.status(400).send(`Choose an answer for at least one item before submitting. ${back}`);
      if (!confirmed) return res.status(400).send(`Please confirm your selections before submitting. ${back}`);

      const ownLicences = new Set((await getActiveLicences(staffId)).map((l) => l.id));
      for (const a of answers) {
        if (a.licenceIds.some((id) => !ownLicences.has(id))) return res.status(400).send(`One of the linked qualifications isn't on your profile. ${back}`);
      }
      const profile = await getCurrentProfileVersion(staffId);
      const hasProfileText = Boolean(profile && (profile.qualifications_trade || profile.teaching_industry_experience));
      if (!hasProfileText) {
        const existingLinks = new Set((await pool.query('SELECT DISTINCT induction_item_id FROM staff_profile_licence_applications WHERE staff_id = $1', [staffId])).rows.map((r) => r.induction_item_id));
        const unsupported = answers.filter((a) => a.status === 'C' && !a.licenceIds.length && !existingLinks.has(a.item.id));
        if (unsupported.length) {
          return res.status(400).send(`To answer "${escapeHtml(ANSWER_LABELS.C)}" for ${escapeHtml(unsupported.map((a) => a.item.name).join(', '))}, first add your qualifications and experience to <a href="/induction/staff/${staffId}/profile">your profile</a> or link a relevant licence under "Add details". ${back}`);
        }
      }

      const statuses = new Set(answers.map((a) => a.status));
      const batchStatus = statuses.size === 1 ? answers[0].status : 'mixed';
      const qualsSnapshot = profile ? [profile.qualifications_trade, profile.teaching_industry_experience].filter(Boolean).join('\n\n') || null : null;

      await client.query('BEGIN');
      const batch = (await client.query(
        `INSERT INTO staff_declaration_batches (staff_id, batch_status, confirmed_quals_support, confirmed_selections, source, profile_version_id, declared_by_staff_id)
         VALUES ($1,$2,$3,true,'teacher_landing',$4,$1) RETURNING id`,
        [staffId, batchStatus, statuses.has('C'), profile ? profile.id : null]
      )).rows[0];
      for (const a of answers) {
        await client.query(
          'INSERT INTO staff_declaration_batch_items (batch_id, induction_item_id, status, comment) VALUES ($1,$2,$3,$4)',
          [batch.id, a.item.id, a.status, a.comment]
        );
        const decl = (await client.query(
          `INSERT INTO staff_induction_declarations (staff_id, induction_item_id, status, qualifications_experience, declared_at)
           VALUES ($1,$2,$3,$4,now())
           ON CONFLICT (staff_id, induction_item_id) DO UPDATE SET
             status = EXCLUDED.status, qualifications_experience = EXCLUDED.qualifications_experience, declared_at = now(), updated_at = now()
           RETURNING id`,
          [staffId, a.item.id, a.status, a.status === 'C' ? qualsSnapshot : null]
        )).rows[0];
        for (const lid of a.licenceIds) {
          await client.query(
            `INSERT INTO staff_profile_licence_applications (profile_licence_id, staff_id, induction_item_id, declaration_batch_id, applied_by_staff_id)
             VALUES ($1,$2,$3,$4,$2)`,
            [lid, staffId, a.item.id, batch.id]
          );
        }
        await client.query(
          `INSERT INTO induction_change_log (staff_id, induction_item_id, context_type, context_id, summary, changed_by_staff_id)
           VALUES ($1,$2,'declaration',$3,$4,$1)`,
          [staffId, a.item.id, decl.id, `Self-assessment: "${ANSWER_LABELS[a.status]}" (submission #${batch.id})${a.licenceIds.length ? ` · ${a.licenceIds.length} qualification(s) linked` : ''}`]
        );
      }
      await client.query('COMMIT');
      res.redirect('/induction/me?submitted=1');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      next(err);
    } finally {
      client.release();
    }
  });

  // ------------------------------------------------------------------
  // Teacher: PERA + SOP review
  // ------------------------------------------------------------------

  async function openedVersionIds(staffId) {
    const { rows } = await pool.query('SELECT DISTINCT doc_version_id FROM induction_doc_opens WHERE staff_id = $1', [staffId]);
    return new Set(rows.map((r) => r.doc_version_id));
  }

  app.get('/induction/me/documents', async (req, res, next) => {
    try {
      const state = await buildTeacherState(req.staffUser.id);
      const opened = await openedVersionIds(req.staffUser.id);
      const tasksByVersion = new Map();
      for (const t of state.openTasks) tasksByVersion.set(t.doc_version_id, t);

      const order = { pending: 0, clarification: 1, acknowledged: 2 };
      const groups = state.groups.slice().sort((a, b) => order[a.docState] - order[b.docState]);

      const groupHtml = groups.map((g) => {
        const pv = g.docs.peraVersion;
        const sv = g.docs.sopVersion;
        const tasks = [tasksByVersion.get(pv.id), tasksByVersion.get(sv.id)].filter(Boolean);
        const bothOpened = opened.has(pv.id) && opened.has(sv.id);
        const canRespond = g.docState !== 'acknowledged';
        return `
        <div class="card ind-docgroup" data-pera="${pv.id}" data-sop="${sv.id}">
          <div class="ind-section-head">
            <div>
              <div class="ind-h3">${escapeHtml(g.entries.map((e) => e.item.name).join(', '))}</div>
              <div class="ind-muted">${g.entries.length > 1 ? `One acknowledgement covers these ${g.entries.length} items — they use exactly the same PERA and SOP versions.` : 'Equipment using this PERA and SOP.'}</div>
            </div>
            <div>${ackStatusText(g.docState, g.ack)}</div>
          </div>
          ${tasks.map((t) => `<div class="ind-update"><strong>Updated ${escapeHtml(t.doc_type)}.</strong> ${escapeHtml(t.reason)}</div>`).join('')}
          ${docLinksHtml(g.docs, opened)}
          ${canRespond ? `
          <div class="ind-ack">
            <div class="ind-muted ind-open-hint" style="font-size:12px;margin-bottom:8px;">${bothOpened ? 'You have opened both documents.' : 'Open and read both documents above before acknowledging. Opening a document does not count as acknowledging it.'}</div>
            <form method="post" action="/induction/me/documents/respond" class="ind-ack-form">
              <input type="hidden" name="pera_version_id" value="${pv.id}">
              <input type="hidden" name="sop_version_id" value="${sv.id}">
              <input type="hidden" name="response" value="acknowledged">
              <label class="ind-check"><input type="checkbox" name="declaration" value="on" class="ind-ack-check" ${bothOpened ? '' : 'disabled'} required> ${escapeHtml(ACK_DECLARATION)}</label>
              <button type="submit" class="btn btn-primary ind-ack-btn" ${bothOpened ? '' : 'disabled'}>Acknowledge</button>
            </form>
            <details class="ind-add-details" style="margin-top:10px;">
              <summary>I need clarification or training</summary>
              <form method="post" action="/induction/me/documents/respond">
                <input type="hidden" name="pera_version_id" value="${pv.id}">
                <input type="hidden" name="sop_version_id" value="${sv.id}">
                <input type="hidden" name="response" value="clarification_requested">
                <div class="form-row"><label>What do you need clarified? (optional)</label><textarea name="comment" rows="2"></textarea></div>
                <button type="submit" class="btn btn-secondary">Request clarification or training</button>
              </form>
            </details>
          </div>` : `<div class="ind-muted" style="font-size:12px;margin-top:8px;">Acknowledged: ${escapeHtml(pv.version_label)}, SOP ${escapeHtml(sv.version_label)}.</div>`}
        </div>`;
      }).join('');

      const missingHtml = state.missingEntries.length ? `
        <div class="card ind-docgroup">
          <div class="ind-h3">School setup required</div>
          ${state.missingEntries.map((e) => `<div style="margin-top:8px;"><strong>${escapeHtml(e.item.name)}</strong>: ${escapeHtml(e.docs.missing.map((m) => m.detail).join(' '))}</div>`).join('')}
          <div class="ind-muted" style="margin-top:8px;">The administrator has been notified. These can't be acknowledged until the documents are added.</div>
        </div>` : '';

      const body = `
        <a class="back-link" href="/induction/me">← My induction</a>
        <h1 class="page-title">PERA and SOP review</h1>
        <p class="page-subtitle" style="margin-bottom:16px;">For each piece of equipment you use, open and read the current PERA and SOP, then acknowledge them or ask for clarification.</p>
        ${groupHtml || (state.missingEntries.length ? '' : '<p class="ind-muted">Select the equipment you use first — documents to review will appear here.</p>')}
        ${missingHtml}
        <script>
        (function(){
          document.querySelectorAll('.ind-docgroup[data-pera]').forEach(function(g){
            var seen = {};
            g.querySelectorAll('.ind-doc-link').forEach(function(a){
              if (a.parentNode.querySelector('.ind-opened').textContent.indexOf('opened') !== -1) seen[a.getAttribute('data-doc')] = true;
              a.addEventListener('click', function(){
                seen[a.getAttribute('data-doc')] = true;
                a.parentNode.querySelector('.ind-opened').textContent = ' · opened';
                if (seen.pera && seen.sop) {
                  g.querySelectorAll('.ind-ack-check, .ind-ack-btn').forEach(function(el){ el.disabled = false; });
                  var h = g.querySelector('.ind-open-hint'); if (h) h.textContent = 'You have opened both documents.';
                }
              });
            });
          });
        })();
        </script>
      `;
      res.send(page({ title: 'PERA and SOP review', active: 'induction', body: body + clientCss() }));
    } catch (err) {
      next(err);
    }
  });

  // Opening a controlled document: logs the open (never an
  // acknowledgement) and takes the teacher to the document.
  app.get('/induction/doc/:versionId/open', async (req, res, next) => {
    try {
      const v = (await pool.query('SELECT * FROM induction_doc_versions WHERE id = $1', [Number(req.params.versionId)])).rows[0];
      if (!v) return res.status(404).send('Document version not found.');
      if (v.doc_type === 'PERA') {
        if (!v.pera_id) return res.status(404).send('This PERA is no longer available.');
        await pool.query('INSERT INTO induction_doc_opens (staff_id, doc_version_id) VALUES ($1,$2)', [req.staffUser.id, v.id]);
        return res.redirect(`/pera/${v.pera_id}`);
      }
      if (!v.pera_document_id) return res.status(404).send('This SOP document is no longer available.');
      const d = (await pool.query('SELECT id, pera_id, url, (file_data IS NOT NULL) AS has_file FROM pera_documents WHERE id = $1', [v.pera_document_id])).rows[0];
      if (!d) return res.status(404).send('This SOP document is no longer available.');
      await pool.query('INSERT INTO induction_doc_opens (staff_id, doc_version_id) VALUES ($1,$2)', [req.staffUser.id, v.id]);
      if (d.has_file) return res.redirect(`/pera/${d.pera_id}/documents/${d.id}/file`);
      if (/^https?:\/\//i.test(d.url || '')) return res.redirect(d.url);
      return res.redirect(`/pera/${d.pera_id}`);
    } catch (err) {
      next(err);
    }
  });

  app.post('/induction/me/documents/respond', async (req, res, next) => {
    const staffId = req.staffUser.id; // always the authenticated teacher
    try {
      const peraVersionId = Number(req.body.pera_version_id);
      const sopVersionId = Number(req.body.sop_version_id);
      const response = req.body.response;
      if (!['acknowledged', 'clarification_requested'].includes(response)) return res.status(400).send(`Invalid response. ${back}`);
      const versions = (await pool.query('SELECT * FROM induction_doc_versions WHERE id = ANY($1::int[])', [[peraVersionId, sopVersionId]])).rows;
      const pv = versions.find((v) => v.id === peraVersionId && v.doc_type === 'PERA');
      const sv = versions.find((v) => v.id === sopVersionId && v.doc_type === 'SOP');
      if (!pv || !sv || pv.pera_id !== sv.pera_id) return res.status(400).send(`Those documents don't match. ${back}`);
      if (!pv.is_current || !sv.is_current) return res.status(409).send(`This document has been updated since you opened the page. Please reload and review the current version. <a href="/induction/me/documents">Reload</a>`);

      // Re-derive from the live state: the pair must be the current,
      // complete document set for at least one item this teacher uses.
      const state = await buildTeacherState(staffId);
      const group = state.groups.find((g) => g.key === `${pv.id}:${sv.id}`);
      if (!group) return res.status(400).send(`These documents aren't required for any equipment you've selected, or the school still needs to finish setting them up. ${back}`);
      const coveredIds = group.entries.map((e) => e.item.id);

      if (response === 'acknowledged') {
        if (!(req.body.declaration === 'on' || req.body.declaration === 'true')) {
          return res.status(400).send(`Tick the declaration to acknowledge. ${back}`);
        }
        const opened = await openedVersionIds(staffId);
        if (!opened.has(pv.id) || !opened.has(sv.id)) {
          return res.status(400).send(`Open and read both the PERA and the SOP before acknowledging them. <a href="/induction/me/documents">Back</a>`);
        }
      }
      const peraRec = pv.pera_id ? (await pool.query('SELECT version FROM pera_records WHERE id = $1', [pv.pera_id])).rows[0] : null;
      const ack = (await pool.query(
        `INSERT INTO staff_doc_acknowledgements (staff_id, pera_version_id, sop_version_id, response, declaration_text, comment, covered_item_ids, pera_record_version, sop_document_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [staffId, pv.id, sv.id, response, response === 'acknowledged' ? ACK_DECLARATION : null, normalizeText(req.body.comment) || null,
          coveredIds, peraRec ? peraRec.version : null, sv.pera_document_id]
      )).rows[0];
      if (response === 'acknowledged') {
        await pool.query(
          `UPDATE staff_doc_ack_tasks SET completed_ack_id = $1, completed_at = now()
           WHERE staff_id = $2 AND doc_version_id = ANY($3::int[]) AND completed_at IS NULL`,
          [ack.id, staffId, [pv.id, sv.id]]
        );
      }
      for (const id of coveredIds) {
        await logInductionChange({
          staffId, inductionItemId: id, contextType: 'document_acknowledgement', contextId: ack.id,
          summary: response === 'acknowledged'
            ? `${pv.version_label} and SOP (${sv.version_label}) acknowledged`
            : `Clarification or training requested on ${pv.version_label} / SOP (${sv.version_label})`,
          changedByStaffId: staffId,
        });
      }
      res.redirect('/induction/me/documents');
    } catch (err) {
      next(err);
    }
  });

  // ------------------------------------------------------------------
  // Assessor workspace
  // ------------------------------------------------------------------

  function requireAssessor(req, res) {
    if (!canActAsAssessor(req.staffUser.role)) {
      res.status(403).send('This area is for authorised assessors. <a href="/induction/me">Back to my induction</a>');
      return false;
    }
    return true;
  }

  app.get('/induction/assessor', async (req, res, next) => {
    try {
      if (!requireAssessor(req, res)) return;
      const staffList = (await pool.query(`SELECT id, name, role FROM staff_users WHERE disabled = false ORDER BY name`)).rows;
      const rows = [];
      for (const s of staffList) {
        const st = await buildTeacherState(s.id); // also raises/resolves setup alerts
        if (!st.entries.length) continue;
        const c = { action: 0, awaiting: 0, training: 0, complete: 0, setup: 0 };
        for (const e of st.entries) c[e.workflow.key] += 1;
        rows.push({ s, c, n: st.entries.length });
      }
      const alerts = (await pool.query(
        `SELECT a.*, i.name AS item_name, i.pera_id, s.name AS raised_for
         FROM induction_setup_alerts a JOIN induction_equipment_items i ON i.id = a.induction_item_id
         LEFT JOIN staff_users s ON s.id = a.first_raised_for_staff_id
         WHERE a.resolved_at IS NULL ORDER BY a.raised_at`
      )).rows;

      const body = `
        <a class="back-link" href="/induction">← Staff Induction</a>
        <h1 class="page-title">Assessor review workspace</h1>
        <p class="page-subtitle" style="margin-bottom:16px;">Staff who have selected equipment. Open a staff member to review their profile once and record a separate decision for each item.</p>
        <div class="card" style="padding:18px;margin-bottom:16px;">
          <table class="ind-table">
            <thead><tr><th>Staff member</th><th>Items</th><th>Awaiting review</th><th>Teacher action</th><th>Training</th><th>Complete</th><th>Setup</th><th></th></tr></thead>
            <tbody>
              ${rows.length ? rows.map(({ s, c, n }) => `
                <tr>
                  <td>${escapeHtml(s.name)}</td><td>${n}</td><td>${c.awaiting}</td><td>${c.action}</td><td>${c.training}</td><td>${c.complete}</td><td>${c.setup}</td>
                  <td style="text-align:right;">${s.id === req.staffUser.id ? '<span class="ind-muted">You (can\'t self-review)</span>' : `<a class="ind-link" href="/induction/assessor/staff/${s.id}">Review →</a>`}</td>
                </tr>`).join('') : '<tr><td colspan="8" class="ind-muted">No staff have selected equipment yet.</td></tr>'}
            </tbody>
          </table>
        </div>
        <div class="card" style="padding:18px;margin-bottom:16px;">
          <h2 class="ind-h2">School setup required (${alerts.length})</h2>
          ${alerts.length ? `<ul class="ind-actions">${alerts.map((a) => `<li><strong>${escapeHtml(a.item_name)}</strong> — missing ${escapeHtml(a.missing)}: ${escapeHtml(a.detail || '')} <span class="ind-muted">(first needed by ${escapeHtml(a.raised_for || 'a staff member')}, ${formatBrisbaneDateTime(a.raised_at)})</span>${req.staffUser.role === 'admin' ? ` · <a class="ind-link" href="${a.pera_id ? `/pera/${a.pera_id}` : '/admin/induction/items'}">Fix →</a>` : ''}</li>`).join('')}</ul>` : '<p class="ind-muted" style="margin:0;">No missing PERA or SOP documents for equipment staff have selected.</p>'}
        </div>
        <div class="card" style="padding:18px;">
          <h2 class="ind-h2">Documents</h2>
          <a class="ind-link" href="/induction/assessor/documents">PERA/SOP versions and material changes →</a>
        </div>
      `;
      res.send(page({ title: 'Assessor review workspace', active: 'induction', body: body + clientCss() }));
    } catch (err) {
      next(err);
    }
  });

  app.get('/induction/assessor/staff/:staffId', async (req, res, next) => {
    try {
      if (!requireAssessor(req, res)) return;
      const staffId = Number(req.params.staffId);
      if (blockSelfAction(res, req.staffUser.id, staffId)) return;
      const state = await buildTeacherState(staffId, { raiseAlerts: false });
      if (!state) return res.status(404).send('Staff member not found.');
      const isLeader = canAuthoriseSchoolLeader(req.staffUser.role);
      const allCats = groupByCategory(state.available);
      const lastSession = (await pool.query(
        `SELECT r.*, s.name AS assessor_name FROM induction_review_sessions r LEFT JOIN staff_users s ON s.id = r.assessor_staff_id
         WHERE r.staff_id = $1 AND r.profile_reviewed ORDER BY r.created_at DESC LIMIT 1`, [staffId])).rows[0];
      const reviewsByItem = new Map();
      for (const r of (await pool.query(
        `SELECT DISTINCT ON (r.induction_item_id) r.*, s.name AS assessor_name FROM induction_item_reviews r LEFT JOIN staff_users s ON s.id = r.assessor_staff_id
         WHERE r.staff_id = $1 ORDER BY r.induction_item_id, r.created_at DESC, r.id DESC`, [staffId])).rows) {
        reviewsByItem.set(r.induction_item_id, r);
      }

      const itemRows = state.entries.map((e) => {
        const last = reviewsByItem.get(e.item.id);
        return `
        <tr class="ind-review-row">
          <td><input type="checkbox" name="item_id" value="${e.item.id}" aria-label="Select ${escapeHtml(e.item.name)}" ${e.workflow.key === 'awaiting' ? 'checked' : ''}></td>
          <td>
            <a class="ind-link" href="/induction/staff/${staffId}/item/${e.item.id}">${escapeHtml(e.item.name)}</a>
            <div class="ind-muted">${escapeHtml(e.item.category_name)}</div>
            <div style="margin-top:4px;">${workflowBadge(e.workflow.key)}</div>
          </td>
          <td>
            <div>${escapeHtml(ANSWER_LABELS[e.decl.status])}</div>
            ${e.comment ? `<div class="ind-muted">“${escapeHtml(e.comment)}”</div>` : ''}
            ${e.licences.length ? `<div class="ind-muted">Linked: ${e.licences.map((l) => escapeHtml(l.name) + (l.active ? '' : ' (superseded)')).join(', ')}</div>` : ''}
          </td>
          <td>
            ${ackStatusText(e.docState, e.ack)}
            ${e.docState !== 'missing' ? `<div class="ind-muted">${escapeHtml(e.docs.peraVersion.version_label)} · SOP ${escapeHtml(e.docs.sopVersion.version_label)}</div>` : `<div class="ind-muted">${escapeHtml(e.docs.missing.map((m) => m.detail).join(' '))}</div>`}
            ${e.ack && e.ack.comment ? `<div class="ind-muted">Teacher: “${escapeHtml(e.ack.comment)}”</div>` : ''}
          </td>
          <td>
            ${e.verified ? `<span class="badge badge-approved">Verified</span><div class="ind-muted">${escapeHtml(e.verification.basis || '')}</div>` : '<span class="badge badge-draft">Not verified</span>'}
            ${last ? `<div class="ind-muted">Last decision: ${escapeHtml(REVIEW_OUTCOMES[last.outcome])} — ${escapeHtml(last.assessor_name || '')}, ${formatBrisbaneDateTime(last.created_at)}</div>` : ''}
            ${e.openRequests.map((r) => `<div class="ind-muted">Open ${escapeHtml(r.request_type)} request${r.details ? `: ${escapeHtml(r.details)}` : ''}
              <form method="post" action="/induction/assessor/requests/${r.id}/close" style="display:inline;"><button class="ind-mini" type="submit">Close</button></form></div>`).join('')}
          </td>
          <td>
            <details class="ind-add-details"><summary>Item decision</summary>
              <div class="form-row"><label>Outcome for this item (overrides group)</label>
                <select name="outcome_${e.item.id}"><option value="">Use group outcome</option>${Object.entries(REVIEW_OUTCOMES).map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join('')}</select></div>
              <div class="form-row"><label>Evidence basis for this item (overrides group)</label><textarea name="basis_${e.item.id}" rows="2"></textarea></div>
            </details>
          </td>
        </tr>`;
      }).join('');

      const authRows = state.entries.map((e) => `
        <tr>
          <td>${escapeHtml(e.item.name)}</td>
          ${['operate', 'supervise_students'].map((type) => {
            const a = e.auth[type];
            const cur = Boolean(a && a.authorised);
            return `<td>
              <div>${yesNo(cur)}${a && a.decision_at ? ` <span class="ind-muted">${formatBrisbaneDateTime(a.decision_at)}</span>` : ''}</div>
              ${isLeader ? `
              <form method="post" action="/induction/assessor/staff/${staffId}/item/${e.item.id}/authorise" class="ind-auth-form">
                <input type="hidden" name="authorisation_type" value="${type}">
                <select name="authorised" aria-label="${type === 'operate' ? 'Authorised to operate' : 'Authorised to supervise students'} — ${escapeHtml(e.item.name)}"><option value="no" ${cur ? '' : 'selected'}>No</option><option value="yes" ${cur ? 'selected' : ''}>Yes</option></select>
                <input type="text" name="restrictions" placeholder="Restrictions (optional)" value="${escapeHtml(a ? a.restrictions || '' : '')}">
                <button type="submit" class="ind-mini">Save</button>
              </form>` : ''}
            </td>`;
          }).join('')}
        </tr>`).join('');

      const scopeHtml = req.staffUser.role === 'admin' ? `
        <details class="card ind-section">
          <summary class="ind-summary">Equipment relevant to this staff member's role</summary>
          <form method="post" action="/induction/assessor/staff/${staffId}/scope">
            <p class="ind-muted">Tick the equipment groups this teacher should see when selecting equipment. Leave all unticked to show every group available at the school.</p>
            ${allCats.map((c) => `<label class="ind-check"><input type="checkbox" name="category_id" value="${c.id}" ${state.scope && state.scope.has(c.id) ? 'checked' : ''}> ${escapeHtml(c.name)}</label>`).join('')}
            <button type="submit" class="btn btn-secondary" style="margin-top:8px;">Save relevant equipment</button>
          </form>
        </details>` : '';

      const body = `
        <a class="back-link" href="/induction/assessor">← Assessor review workspace</a>
        <h1 class="page-title">Review — ${escapeHtml(state.staff.name)}</h1>
        <p class="page-subtitle" style="margin-bottom:16px;">Review the profile once, then record a separate decision and evidence basis for each item.</p>

        <section class="card ind-section">
          <h2 class="ind-h2">Staff profile</h2>
          ${profileSummaryHtml(state.profile, state.licences)}
          ${lastSession ? `<div class="ind-muted" style="margin-top:8px;">Profile last reviewed by ${escapeHtml(lastSession.assessor_name || '')}, ${formatBrisbaneDateTime(lastSession.created_at)}${state.profile && lastSession.profile_version_id !== state.profile.id ? ' — <strong>the profile has changed since then</strong>' : ''}</div>` : ''}
          <a class="ind-link" href="/induction/staff/${staffId}/profile">Open full profile →</a>
        </section>

        <form method="post" action="/induction/assessor/staff/${staffId}/review" class="card ind-section">
          <h2 class="ind-h2">Equipment-specific assessment</h2>
          <div class="ind-muted" style="margin-bottom:10px;">Self-assessment and document acknowledgement are not evidence of competence on their own. Verification needs the current PERA/SOP to be acknowledged and any approved machine checklist to be complete.</div>
          <div class="ind-table-wrap">
          <table class="ind-table">
            <thead><tr><th></th><th>Equipment</th><th>Self-assessment</th><th>PERA / SOP</th><th>Assessment</th><th></th></tr></thead>
            <tbody>${itemRows || '<tr><td colspan="6" class="ind-muted">No equipment selected yet.</td></tr>'}</tbody>
          </table>
          </div>
          <div class="ind-group-decision">
            <div class="form-row"><label for="group_outcome">Group outcome for selected items</label>
              <select id="group_outcome" name="group_outcome">${Object.entries(REVIEW_OUTCOMES).map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join('')}</select></div>
            <div class="form-row"><label for="group_basis">Evidence basis (copied to each selected item unless that item has its own)</label>
              <textarea id="group_basis" name="group_basis" rows="3" placeholder="e.g. Cert III Carpentry sighted; observed safe set-up and operation on 03/10/2026"></textarea></div>
            <label class="ind-check"><input type="checkbox" name="profile_reviewed" value="on" required> I have reviewed this staff member's profile.</label>
            <label class="ind-check"><input type="checkbox" name="local_checks_confirmed" value="on"> For items verified as existing competence: I confirm the local, equipment-specific checks were completed for each of those items (e.g. guards, E-stop, isolation, this workshop's set-up).</label>
            <button type="submit" class="btn btn-primary" style="margin-top:10px;">Record decisions for selected items</button>
          </div>
        </form>

        <section class="card ind-section">
          <h2 class="ind-h2">School authorisation</h2>
          <p class="ind-muted">Two separate decisions, made by an authorised school leader. Each needs verified competency and a current PERA/SOP acknowledgement first.</p>
          <div class="ind-table-wrap">
          <table class="ind-table">
            <thead><tr><th>Equipment</th><th>Authorised to operate</th><th>Authorised to supervise students</th></tr></thead>
            <tbody>${authRows || '<tr><td colspan="3" class="ind-muted">No equipment selected yet.</td></tr>'}</tbody>
          </table>
          </div>
          ${isLeader ? '' : '<p class="ind-muted">Only an authorised school leader can change these.</p>'}
        </section>
        ${scopeHtml}
      `;
      res.send(page({ title: `Review — ${state.staff.name}`, active: 'induction', body: body + clientCss() }));
    } catch (err) {
      next(err);
    }
  });

  app.post('/induction/assessor/staff/:staffId/review', async (req, res, next) => {
    let client;
    try {
      if (!requireAssessor(req, res)) return;
      const staffId = Number(req.params.staffId);
      if (blockSelfAction(res, req.staffUser.id, staffId)) return;
      if (!(req.body.profile_reviewed === 'on' || req.body.profile_reviewed === 'true')) {
        return res.status(400).send(`Confirm you have reviewed the staff profile. ${back}`);
      }
      const itemIds = toIntArray(req.body.item_id);
      if (!itemIds.length) return res.status(400).send(`Select at least one item. ${back}`);
      const groupOutcome = req.body.group_outcome;
      const groupBasis = normalizeText(req.body.group_basis) || '';
      const localChecks = req.body.local_checks_confirmed === 'on' || req.body.local_checks_confirmed === 'true';

      const state = await buildTeacherState(staffId, { raiseAlerts: false });
      if (!state) return res.status(404).send('Staff member not found.');
      const entryById = new Map(state.entries.map((e) => [e.item.id, e]));

      const decisions = [];
      const problems = [];
      for (const id of itemIds) {
        const e = entryById.get(id);
        if (!e) { problems.push(`Item #${id} isn't one this staff member has selected.`); continue; }
        const override = req.body[`outcome_${id}`];
        const outcome = override && REVIEW_OUTCOMES[override] ? override : groupOutcome;
        if (!REVIEW_OUTCOMES[outcome]) { problems.push(`${e.item.name}: choose an outcome.`); continue; }
        const basis = normalizeText(req.body[`basis_${id}`]) || groupBasis;
        if (!basis.trim()) { problems.push(`${e.item.name}: an evidence basis is required.`); continue; }
        if (outcome === 'verified_existing' || outcome === 'verified_assessed') {
          if (e.docState !== 'acknowledged') problems.push(`${e.item.name}: the teacher hasn't acknowledged the current PERA and SOP.`);
          const chk = await checklistRequirement(id, staffId);
          if (chk.required && !chk.complete) problems.push(`${e.item.name}: the approved machine competency checklist hasn't been completed.`);
          if (outcome === 'verified_existing' && !localChecks) problems.push(`${e.item.name}: confirm the local equipment-specific checks were completed.`);
        }
        if (outcome === 'training_required' && e.verified) problems.push(`${e.item.name}: already verified — change this from the detailed record if competency needs to be withdrawn.`);
        decisions.push({ e, outcome, basis });
      }
      if (problems.length) {
        return res.status(400).send(`<p>Nothing was saved:</p><ul>${problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>${back}`);
      }

      const profile = await getCurrentProfileVersion(staffId);
      client = await pool.connect();
      await client.query('BEGIN');
      const session = (await client.query(
        `INSERT INTO induction_review_sessions (staff_id, assessor_staff_id, profile_version_id, profile_reviewed) VALUES ($1,$2,$3,true) RETURNING id`,
        [staffId, req.staffUser.id, profile ? profile.id : null]
      )).rows[0];
      for (const { e, outcome, basis } of decisions) {
        await client.query(
          `INSERT INTO induction_item_reviews (session_id, staff_id, induction_item_id, outcome, basis, licence_ids, local_checks_confirmed, doc_ack_id, assessor_staff_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [session.id, staffId, e.item.id, outcome, basis, e.licences.map((l) => l.id), outcome === 'verified_existing' ? localChecks : false,
            e.ack ? e.ack.id : null, req.staffUser.id]
        );
        let summary;
        if (outcome === 'verified_existing' || outcome === 'verified_assessed') {
          const label = outcome === 'verified_existing' ? 'Existing competence (assessor-documented)' : 'Assessed at this school';
          const v = (await client.query(
            `INSERT INTO staff_induction_competency_verifications (staff_id, induction_item_id, verified, verified_by_staff_id, verified_at, basis, notes)
             VALUES ($1,$2,true,$3,now(),$4,$5)
             ON CONFLICT (staff_id, induction_item_id) DO UPDATE SET
               verified = true, verified_by_staff_id = EXCLUDED.verified_by_staff_id, verified_at = now(), basis = EXCLUDED.basis, notes = EXCLUDED.notes, updated_at = now()
             RETURNING id`,
            [staffId, e.item.id, req.staffUser.id, `${label}: ${basis}`, `Review session #${session.id}`]
          )).rows[0];
          await client.query(
            `UPDATE induction_assessor_requests SET status = 'closed', closed_by_staff_id = $1, closed_at = now(), close_note = 'Closed when competency was verified'
             WHERE staff_id = $2 AND induction_item_id = $3 AND status = 'open'`,
            [req.staffUser.id, staffId, e.item.id]
          );
          summary = `Competency verified (${label}) in review session #${session.id}`;
          await client.query(
            `INSERT INTO induction_change_log (staff_id, induction_item_id, context_type, context_id, summary, changed_by_staff_id) VALUES ($1,$2,'verification',$3,$4,$5)`,
            [staffId, e.item.id, v.id, summary, req.staffUser.id]
          );
        } else {
          const type = outcome === 'training_required' ? 'training' : 'evidence';
          const r = (await client.query(
            `INSERT INTO induction_assessor_requests (staff_id, induction_item_id, request_type, details, created_by_staff_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [staffId, e.item.id, type, basis, req.staffUser.id]
          )).rows[0];
          summary = type === 'training' ? `Training assigned in review session #${session.id}` : `Further evidence requested in review session #${session.id}`;
          await client.query(
            `INSERT INTO induction_change_log (staff_id, induction_item_id, context_type, context_id, summary, changed_by_staff_id) VALUES ($1,$2,'assessor_request',$3,$4,$5)`,
            [staffId, e.item.id, r.id, summary, req.staffUser.id]
          );
        }
      }
      await client.query('COMMIT');
      res.redirect(`/induction/assessor/staff/${staffId}`);
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      next(err);
    } finally {
      if (client) client.release();
    }
  });

  // Separate school decision per authorisation type. Requires verified
  // competency and a current PERA/SOP acknowledgement before "Yes".
  async function authorisationProblems(staffId, itemId) {
    const state = await buildTeacherState(staffId, { raiseAlerts: false });
    const e = state && state.entries.find((x) => x.item.id === itemId);
    if (!e) return ['This staff member has not selected this equipment.'];
    const problems = [];
    if (!e.verified) problems.push('Competency has not been verified by an assessor.');
    if (e.docState !== 'acknowledged') problems.push('The current PERA and SOP have not been acknowledged.');
    return problems;
  }

  app.post('/induction/assessor/staff/:staffId/item/:itemId/authorise', async (req, res, next) => {
    try {
      const staffId = Number(req.params.staffId);
      const itemId = Number(req.params.itemId);
      if (!canAuthoriseSchoolLeader(req.staffUser.role)) return res.status(403).send('Only an authorised school leader can record this.');
      if (blockSelfAction(res, req.staffUser.id, staffId)) return;
      const type = req.body.authorisation_type;
      if (!['operate', 'supervise_students'].includes(type)) return res.status(400).send('Invalid authorisation type.');
      const authorised = req.body.authorised === 'yes';
      if (authorised) {
        const problems = await authorisationProblems(staffId, itemId);
        if (problems.length) return res.status(400).send(`Can't authorise yet: ${escapeHtml(problems.join(' '))} ${back}`);
      }
      const { rows } = await pool.query(
        `INSERT INTO staff_induction_authorisations (staff_id, induction_item_id, authorisation_type, authorised, restrictions, decision_by_staff_id, decision_at)
         VALUES ($1,$2,$3,$4,$5,$6,now())
         ON CONFLICT (staff_id, induction_item_id, authorisation_type) DO UPDATE SET
           authorised = EXCLUDED.authorised, restrictions = EXCLUDED.restrictions, decision_by_staff_id = EXCLUDED.decision_by_staff_id, decision_at = now(), updated_at = now()
         RETURNING id`,
        [staffId, itemId, type, authorised, normalizeText(req.body.restrictions) || null, req.staffUser.id]
      );
      await logInductionChange({
        staffId, inductionItemId: itemId, contextType: 'authorisation', contextId: rows[0].id,
        summary: `${type === 'operate' ? 'Authorised to operate' : 'Authorised to supervise students'}: ${authorised ? 'Yes' : 'No'}`,
        changedByStaffId: req.staffUser.id,
      });
      res.redirect(`/induction/assessor/staff/${staffId}`);
    } catch (err) {
      next(err);
    }
  });

  app.post('/induction/assessor/requests/:id/close', async (req, res, next) => {
    try {
      if (!requireAssessor(req, res)) return;
      const r = (await pool.query('SELECT * FROM induction_assessor_requests WHERE id = $1', [Number(req.params.id)])).rows[0];
      if (!r) return res.status(404).send('Request not found.');
      if (blockSelfAction(res, req.staffUser.id, r.staff_id)) return;
      await pool.query(`UPDATE induction_assessor_requests SET status = 'closed', closed_by_staff_id = $1, closed_at = now() WHERE id = $2 AND status = 'open'`, [req.staffUser.id, r.id]);
      await logInductionChange({ staffId: r.staff_id, inductionItemId: r.induction_item_id, contextType: 'assessor_request', contextId: r.id, summary: `${r.request_type === 'training' ? 'Training' : 'Evidence'} request closed`, changedByStaffId: req.staffUser.id });
      res.redirect(`/induction/assessor/staff/${r.staff_id}`);
    } catch (err) {
      next(err);
    }
  });

  app.post('/induction/assessor/staff/:staffId/scope', async (req, res, next) => {
    try {
      if (req.staffUser.role !== 'admin') return res.status(403).send('Only an admin can change this.');
      const staffId = Number(req.params.staffId);
      const ids = toIntArray(req.body.category_id);
      await pool.query('DELETE FROM staff_induction_scope WHERE staff_id = $1', [staffId]);
      for (const id of ids) {
        await pool.query('INSERT INTO staff_induction_scope (staff_id, category_id, set_by_staff_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [staffId, id, req.staffUser.id]);
      }
      await logInductionChange({ staffId, inductionItemId: null, contextType: 'scope', contextId: null, summary: ids.length ? `Relevant equipment groups set (${ids.length})` : 'Relevant equipment groups cleared (all groups shown)', changedByStaffId: req.staffUser.id });
      res.redirect(`/induction/assessor/staff/${staffId}`);
    } catch (err) {
      next(err);
    }
  });

  // ------------------------------------------------------------------
  // Document versions + material changes (authorised reviewers)
  // ------------------------------------------------------------------

  app.get('/induction/assessor/documents', async (req, res, next) => {
    try {
      if (!requireAssessor(req, res)) return;
      const peras = (await pool.query(
        `SELECT p.id, p.activity_name, array_agg(i.name ORDER BY i.name) AS items
         FROM induction_equipment_items i JOIN pera_records p ON p.id = i.pera_id
         WHERE i.available_at_school = true GROUP BY p.id ORDER BY p.activity_name`
      )).rows;
      const blocks = [];
      for (const p of peras) {
        const docs = await resolveDocsForPera(p.id);
        const history = (await pool.query(
          `SELECT v.*, s.name AS by_name,
                  (SELECT COUNT(DISTINCT a.staff_id)::int FROM staff_doc_acknowledgements a WHERE a.response = 'acknowledged' AND (a.pera_version_id = v.id OR a.sop_version_id = v.id)) AS ack_count
           FROM induction_doc_versions v LEFT JOIN staff_users s ON s.id = v.created_by_staff_id
           WHERE v.pera_id = $1 ORDER BY v.created_at DESC, v.id DESC`, [p.id])).rows;
        blocks.push(`
          <div class="card ind-docgroup">
            <div class="ind-h3">${escapeHtml(p.activity_name)}</div>
            <div class="ind-muted">Used by: ${escapeHtml(p.items.join(', '))}</div>
            ${docs.missing.length ? `<div class="ind-setup" style="margin-top:8px;">School setup required: ${escapeHtml(docs.missing.map((m) => m.detail).join(' '))}</div>` : ''}
            <table class="ind-table" style="margin-top:8px;">
              <thead><tr><th>Document</th><th>Version</th><th>Status</th><th>Reason</th><th>Acknowledged by</th></tr></thead>
              <tbody>${history.map((v) => `<tr><td>${escapeHtml(v.doc_type)} — ${escapeHtml(v.title_snapshot)}</td><td>${escapeHtml(v.version_label)}<div class="ind-muted">${formatBrisbaneDateTime(v.created_at)}${v.by_name ? ` · ${escapeHtml(v.by_name)}` : ''}</div></td><td>${v.is_current ? '<span class="badge badge-approved">Current</span>' : '<span class="badge badge-draft">Superseded</span>'}</td><td>${escapeHtml(v.reason)}</td><td>${v.ack_count} staff</td></tr>`).join('') || '<tr><td colspan="5" class="ind-muted">No versions yet.</td></tr>'}</tbody>
            </table>
            <details class="ind-add-details" style="margin-top:10px;">
              <summary>Record a material change</summary>
              <form method="post" action="/induction/assessor/documents/material-change">
                <input type="hidden" name="pera_id" value="${p.id}">
                <div class="form-row"><label>Document</label><select name="doc_type"><option value="PERA">PERA</option><option value="SOP">SOP</option></select></div>
                <div class="form-row"><label>Reason (shown to affected teachers)</label><textarea name="reason" rows="2" required placeholder="e.g. New guarding requirement added to control measures"></textarea></div>
                <button type="submit" class="btn btn-secondary">Create new version and acknowledgement tasks</button>
              </form>
            </details>
          </div>`);
      }
      const body = `
        <a class="back-link" href="/induction/assessor">← Assessor review workspace</a>
        <h1 class="page-title">PERA and SOP versions</h1>
        <p class="page-subtitle" style="margin-bottom:16px;">Routine edits don't require staff to re-acknowledge. When a change is material, record it here: a new version is created, affected teachers get a new acknowledgement task with your reason, and earlier acknowledgements stay linked to the version they read.</p>
        ${blocks.join('') || '<p class="ind-muted">No PERAs are linked to induction equipment yet. Link them from <a href="/admin/induction/items">the equipment induction list</a>.</p>'}
      `;
      res.send(page({ title: 'PERA and SOP versions', active: 'induction', body: body + clientCss() }));
    } catch (err) {
      next(err);
    }
  });

  app.post('/induction/assessor/documents/material-change', async (req, res, next) => {
    try {
      if (!requireAssessor(req, res)) return;
      const peraId = Number(req.body.pera_id);
      const docType = req.body.doc_type;
      const reason = normalizeText(req.body.reason) || '';
      if (!['PERA', 'SOP'].includes(docType)) return res.status(400).send(`Invalid document type. ${back}`);
      if (!reason.trim()) return res.status(400).send(`A reason is required. ${back}`);
      const docs = await resolveDocsForPera(peraId);
      if (docType === 'PERA' && !docs.peraVersion) return res.status(400).send(`This PERA isn't approved/current, so it can't be versioned for acknowledgement. ${back}`);
      if (docType === 'SOP' && !docs.sopVersion) return res.status(400).send(`There's no current SOP for this PERA. ${back}`);
      await supersedeVersion({
        peraId,
        docType,
        material: true,
        reason,
        createdBy: req.staffUser.id,
        build: (rev) => (docType === 'PERA'
          ? { title_snapshot: docs.pera.activity_name, version_label: `PERA v${docs.pera.version || 1} · rev ${rev}`, pera_record_version: docs.pera.version }
          : { pera_document_id: docs.sopDoc.id, title_snapshot: docs.sopDoc.title, version_label: sopVersionLabel(docs.sopDoc, rev) }),
      });
      res.redirect('/induction/assessor/documents');
    } catch (err) {
      next(err);
    }
  });

  function clientCss() {
    return `<style>
      .ind-muted{color:#6B6659;font-size:13px}
      .ind-flash{background:#E4F3EA;border:1px solid #9BCDB4;color:#1F5C40;border-radius:10px;padding:14px 16px;margin-bottom:16px;font-weight:600}
      .ind-progress{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:20px;margin-bottom:16px;flex-wrap:wrap}
      .ind-progress-title{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#6B6659;font-weight:700}
      .ind-progress-next{font-size:16px;font-weight:600;color:#1A1D1B;margin-top:4px}
      .ind-continue{font-size:15px;padding:12px 22px}
      .ind-sections{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
      @media (max-width:800px){.ind-sections{grid-template-columns:1fr}}
      .ind-section{padding:20px;margin-bottom:16px;display:block}
      .ind-sections .ind-section{margin-bottom:0}
      .ind-section-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:8px}
      .ind-h2{font-size:16px;font-weight:700;margin:0 0 12px}
      .ind-h3{font-size:15px;font-weight:700}
      .ind-link{color:#1B5E52;font-weight:600;font-size:13px;text-decoration:none}
      .ind-kv{display:grid;grid-template-columns:180px 1fr;gap:8px;font-size:13px;padding:4px 0}
      .ind-kv>span{color:#6B6659}
      @media (max-width:600px){.ind-kv{grid-template-columns:1fr;gap:2px}}
      .ind-actions{margin:0;padding-left:18px;font-size:13px}
      .ind-actions li{margin-bottom:8px}
      .ind-actions a{color:#1B5E52;font-weight:600}
      .ind-equip-row{display:grid;grid-template-columns:1fr auto auto;gap:12px;align-items:center;border-top:1px solid #F0EDE5;padding:10px 0}
      @media (max-width:700px){.ind-equip-row{grid-template-columns:1fr}}
      .ind-equip-name{font-weight:600;color:#1A1D1B;text-decoration:none}
      .ind-perms{font-size:12px;display:flex;flex-direction:column;gap:2px}
      .ind-perm-label{color:#6B6659}
      .ind-perm{font-weight:700;padding:1px 8px;border-radius:999px}
      .ind-perm-yes{background:#E4F3EA;color:#2F7D5A}
      .ind-perm-no{background:#F0EDE5;color:#6B6659}
      .ind-summary{cursor:pointer;font-weight:700}
      .ind-setup{background:#FBF6E6;border:1px solid #E8D9A8;border-radius:8px;padding:10px 12px;font-size:13px;color:#6B5A1F}
      .ind-update{background:#FDF0E6;border:1px solid #F0C9A8;border-radius:8px;padding:8px 12px;font-size:13px;color:#8A3E1C;margin:8px 0}
      .ind-search{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
      .ind-search input{flex:1;min-width:200px;padding:10px 12px;border:1px solid #D9D3C4;border-radius:8px;font-size:14px}
      .ind-cat{background:#fff;border:1px solid #E4DFD3;border-radius:10px;margin-bottom:10px}
      .ind-cat>summary{cursor:pointer;padding:14px 16px;display:flex;justify-content:space-between;gap:10px;font-weight:700}
      .ind-cat-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:0 16px 10px;font-size:13px}
      .ind-cat-tools select{padding:6px;border:1px solid #D9D3C4;border-radius:6px}
      .ind-item{border-top:1px solid #F0EDE5;padding:10px 16px}
      .ind-item-name{font-weight:600;font-size:14px;margin-bottom:6px}
      .ind-item-opts{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:13px}
      .ind-item-opts label{display:flex;align-items:center;gap:6px;cursor:pointer}
      .ind-add-details summary{cursor:pointer;color:#1B5E52;font-size:12px;font-weight:600;margin-top:6px}
      .ind-check{display:flex;align-items:flex-start;gap:8px;font-size:13px;margin:6px 0}
      .ind-check input{margin-top:3px}
      .ind-confirm{padding:16px;position:sticky;bottom:12px;margin-top:12px;box-shadow:0 -4px 18px rgba(26,29,27,.12);z-index:5}
      @media (max-width:800px){.ind-confirm{bottom:70px}}
      .btn:disabled{opacity:.45;cursor:not-allowed}
      .ind-docgroup{padding:18px;margin-bottom:14px;display:block}
      .ind-doc-table{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}
      .ind-doc-table td{padding:6px 8px 6px 0;border-top:1px solid #F0EDE5;vertical-align:top}
      .ind-doc-link{color:#1B5E52;font-weight:600}
      .ind-ack{border-top:1px solid #E4DFD3;margin-top:10px;padding-top:10px}
      .ind-table{width:100%;border-collapse:collapse;font-size:13px}
      .ind-table th{text-align:left;font-size:11px;text-transform:uppercase;color:#6B6659;border-bottom:1px solid #E4DFD3;padding:6px}
      .ind-table td{border-bottom:1px solid #F0EDE5;padding:8px 6px;vertical-align:top}
      .ind-table-wrap{overflow-x:auto}
      .ind-mini{font-size:11px;padding:3px 8px;border:1px solid #D9D3C4;background:#fff;border-radius:6px;cursor:pointer}
      .ind-auth-form{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}
      .ind-auth-form input[type=text]{font-size:12px;padding:3px 6px;border:1px solid #D9D3C4;border-radius:6px;width:150px}
      .ind-group-decision{border-top:1px solid #E4DFD3;margin-top:12px;padding-top:12px}
    </style>`;
  }

  return { buildTeacherState, resolveDocsForPera, authorisationProblems, ANSWER_LABELS, WORKFLOW, computeWorkflow, workflowBadge, permissionIndicators, profileSummaryHtml, clientCss, ackStatusText };
};
