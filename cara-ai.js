// CARA assistant: (1) "Suggest content" on the CARA form, drafted from the
// selected PERAs, and (2) a pre-submission check on the CARA page.
//
// - Rule checks (risk level vs PERAs, consent, empty fields, hazards without
//   controls, PERAs that don't allow student use) need no AI and always run.
// - The AI parts only switch on when ANTHROPIC_API_KEY is set. Nothing the AI
//   suggests is written to a record unless the teacher clicks "Use this".
// - Privacy: the Students notes, names, signatures and approver details are
//   never sent to the AI.

const API_URL = `${process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/messages`;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const RISK_ORDER = { Low: 1, Medium: 2, High: 3, Extreme: 4 };
const RISK_LEVELS = ['Low', 'Medium', 'High', 'Extreme'];

// Fields the assistant may draft (students_notes only as an empty-box template, see STUDENTS_GUIDE; never submitted_by).
const DRAFT_FIELDS = {
  activity_scope: 'Activity scope',
  induction_instruction: 'Induction and instruction',
  supervision_notes: 'Supervision',
  supervisor_qualification: 'Supervisor qualification',
  facilities_equipment: 'Facilities and equipment',
  environmental_hazards: 'Environmental hazards',
  environmental_controls: 'Environmental controls',
  facilities_hazards: 'Facilities hazards',
  facilities_controls: 'Facilities controls',
  student_hazards: 'Student hazards',
  student_controls: 'Student controls',
  emergency_first_aid: 'Emergency and first aid',
};
// What belongs in each field, so the AI doesn't repeat the same content in
// two boxes (e.g. Supervision vs Supervisor qualification).
const FIELD_GUIDE = {
  activity_scope: 'What students will do: the tasks, processes, equipment and materials. No hazards, controls or supervision here.',
  induction_instruction: 'How students are prepared before and during the activity: workshop and machine inductions, demonstrations, SOPs/SWMS, competency sign-off. Not supervision levels or staff qualifications.',
  supervision_notes: 'HOW the activity is supervised: level of supervision (direct vs general) per process or machine, staff-to-student ratios, maximum students on machines, teacher positioning, what happens if the teacher leaves, rules on access outside class. Do NOT state staff qualifications, licences or training here; they belong in Supervisor qualification.',
  supervisor_qualification: 'WHO may supervise and what they must hold: required qualifications, trade background, licences/tickets, current first aid, workshop/machine induction or competency for staff, requirements for relief staff. Do NOT describe supervision levels, ratios or positioning here; they belong in Supervision.',
  facilities_equipment: 'The room and fixed safety provisions: workshop layout, extraction/ventilation, welding screens/bays, spray booth, emergency stops, eyewash, fire equipment, PPE available. Not hazards or controls.',
  environmental_hazards: 'Hazards from the work environment (fumes, UV, noise, heat, dust, sparks, lighting, housekeeping, slips/trips).',
  environmental_controls: 'Controls for the environmental hazards listed, in the same order.',
  facilities_hazards: 'Hazards from machines, tools, electrical supply, gas cylinders and other plant.',
  facilities_controls: 'Controls for the facilities and equipment hazards listed, in the same order.',
  student_hazards: 'Hazards arising from the students themselves: inexperience, behaviour, fatigue, clothing/hair/jewellery, PPE non-use, medical needs (generic only).',
  student_controls: 'Controls for the student hazards listed, in the same order.',
  emergency_first_aid: 'Emergency and first aid arrangements: first aid kit/burns kit, how to get help, emergency stops and isolation, fire response, incident reporting. Use [placeholders] for locations and names.',
};

// Students is only drafted when the teacher's box is empty, and its contents
// are never sent to the AI (privacy) - only a template is suggested.
const STUDENTS_GUIDE = 'A general description of the class group as a template with [placeholders]: year level and course, age range, class size, prior workshop experience relevant to this activity, and how students with additional needs are identified and managed (e.g. teacher checks medical/learning support info in [school system] before the first practical; individual plans agreed with Learning Support). Use "- " bullets and short sub-headings ending in ":" such as "Prior experience:" and "Students with additional needs:". No names, no specific conditions about real students.';

// Belt and braces: strip any markdown the model still uses, since the form
// boxes are plain text ("**Label:**" would show as literal asterisks).
function plainText(v) {
  return String(v || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[*•]\s+/gm, '- ')
    .trim();
}

const HAZARD_PAIRS = [
  ['environmental_hazards', 'environmental_controls', 'Environmental'],
  ['facilities_hazards', 'facilities_controls', 'Facilities'],
  ['student_hazards', 'student_controls', 'Student'],
];

const SYSTEM_PROMPT = `You help teachers in a Queensland school's practical subjects (Industrial Design and Technology, metalwork, woodwork, VET trades) write Curriculum Activity Risk Assessments (CARAs).
A CARA covers one class activity. It draws on Plant & Equipment Risk Assessments (PERAs), which hold the approved hazards and controls for each machine or tool.
Rules:
- Base everything on the PERA details provided. Do not contradict a PERA, and never relax a PERA control or supervision requirement.
- Do not invent school-specific facts (names, room numbers, staff, qualifications held, first aid locations). Where something school-specific is needed, write a short placeholder in square brackets, e.g. [name of supervising teacher].
- Use Australian English, plain language a teacher can paste straight in, and short "- " bullet lines where a list helps.
- Plain text only: NO markdown. Never use **, __, # headings or backticks. To group bullets, put a short sub-heading on its own line ending in ":" (e.g. "Prior experience:"), then its "- " bullets underneath. Keep each bullet to one or two short lines.
- Be practical and specific to the activity; avoid generic filler.
- Each field has its own job (see the field descriptions). Never repeat the same point in two fields; put it only in the field it belongs to.
- Supervision = how closely and at what ratio students are supervised. Supervisor qualification = who may supervise and what they must hold. Keep them separate.
- You never see real student information. If asked to draft the Students field, write a general cohort template using [placeholders] (year level, course, class size, school system name). Never invent student names, medical conditions or numbers.`;

const ERROR_TEXT = {
  auth: 'The AI key was rejected. Check ANTHROPIC_API_KEY in the server .env file (it should start with sk-ant-api).',
  credit: 'The Anthropic account has no credit left. Add credit at console.anthropic.com.',
  model: 'The AI model setting is not available on this Anthropic account.',
  busy: 'The AI service is busy. Try again in a minute.',
  timeout: 'The AI took too long to respond. Try again.',
  error: 'The AI assistant could not respond just now. Try again in a minute.',
};
function errorCode(err) {
  if (err && err.name === 'AbortError') return 'timeout';
  return (err && err.code && ERROR_TEXT[err.code]) ? err.code : 'error';
}

function apiEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function clip(v, n = 600) {
  const s = String(v == null ? '' : v).trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function yesNo(v) {
  return v === true ? 'Yes' : v === false ? 'No' : 'Not set';
}

// Simple per-user limit so a stuck button or loop can't run up a bill.
const recentCalls = new Map();
function overLimit(userId, perHour = 30) {
  const now = Date.now();
  const list = (recentCalls.get(userId) || []).filter((t) => now - t < 3600e3);
  if (list.length >= perHour) {
    recentCalls.set(userId, list);
    return true;
  }
  list.push(now);
  recentCalls.set(userId, list);
  return false;
}

module.exports = function registerCaraAi({ app, pool, escapeHtml, canManageOwnRecord }) {
  async function loadPeras(ids) {
    const clean = [...new Set([].concat(ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 25);
    if (!clean.length) return [];
    const { rows } = await pool.query(
      `SELECT id, activity_name, class_unit, risk_level, status, archived, activity_process, materials_used, student_use,
              student_use_permitted, operating_conditions, supervision_level, supervisor_competency, max_operators,
              student_induction_required, competency_demonstration_required, safe_working_zone_required,
              required_supervision, student_training, consent_required
       FROM pera_records WHERE id = ANY($1::int[]) ORDER BY activity_name`,
      [clean]
    );
    const hz = await pool.query(
      `SELECT pera_id, category, description, risk_level, control_measure, control_type, mandatory
       FROM pera_hazards WHERE pera_id = ANY($1::int[]) ORDER BY pera_id, sort_order, id`,
      [clean]
    );
    for (const p of rows) p.hazards = hz.rows.filter((h) => h.pera_id === p.id).slice(0, 25);
    return rows;
  }

  function peraContext(peras) {
    if (!peras.length) return 'No PERAs selected.';
    return peras
      .map((p) => {
        const hazards = p.hazards.length
          ? p.hazards
              .map((h) => `  - ${clip(h.description, 200)} [${h.risk_level || '?'}] → ${clip(h.control_measure, 300)}${h.control_type ? ` (${h.control_type})` : ''}${h.mandatory ? ' MANDATORY' : ''}`)
              .join('\n')
          : '  (no hazards recorded)';
        return [
          `PERA: ${p.activity_name} (risk ${p.risk_level}, status ${p.archived ? 'Archived' : p.status})`,
          `Activity/process: ${clip(p.activity_process)}`,
          `Materials: ${clip(p.materials_used, 300)}`,
          `Student use: ${clip(p.student_use, 300)} | Student use permitted: ${yesNo(p.student_use_permitted)}`,
          `Operating conditions: ${clip(p.operating_conditions, 300)}`,
          `Supervision level: ${clip(p.supervision_level, 200)} | Supervisor competency: ${clip(p.supervisor_competency, 200)} | Max operators: ${p.max_operators || 'Not set'}`,
          `Student induction required: ${yesNo(p.student_induction_required)} | Competency demonstration required: ${yesNo(p.competency_demonstration_required)} | Safe working zone required: ${yesNo(p.safe_working_zone_required)}`,
          `Student training: ${clip(p.student_training, 300)}`,
          `Hazards and controls:\n${hazards}`,
        ].join('\n');
      })
      .join('\n\n');
  }

  function caraContext(c) {
    const lines = [
      `Activity name: ${clip(c.activity_name, 200) || '(blank)'}`,
      `Class/unit: ${clip(c.class_unit, 200) || '(blank)'}`,
      `Risk level chosen: ${c.risk_level || '(blank)'}`,
      `Parent consent required ticked: ${c.consent_required ? 'Yes' : 'No'}`,
    ];
    for (const [key, label] of Object.entries(DRAFT_FIELDS)) {
      lines.push(`${label}: ${clip(c[key], 1500) || '(blank)'}`);
    }
    lines.push('Students notes: (withheld for privacy)');
    return lines.join('\n');
  }

  async function callClaude({ userText, tool, maxTokens }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 95000);
    try {
      const resp = await fetch(API_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: maxTokens,
          system: SYSTEM_PROMPT,
          tools: [tool],
          // Newer models don't accept a forced tool_choice, so ask for the
          // tool in the prompt and let the model choose ("auto").
          tool_choice: { type: 'auto' },
          messages: [{ role: 'user', content: `${userText}\n\nRespond only by calling the ${tool.name} tool.` }],
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const msg = (data && data.error && data.error.message) || `HTTP ${resp.status}`;
        const err = new Error(`AI service error (${resp.status}): ${msg}`);
        // Short code for a friendly message; the full text goes to the server log.
        if (resp.status === 401 || resp.status === 403) err.code = 'auth';
        else if (/credit|billing|balance/i.test(msg)) err.code = 'credit';
        else if (resp.status === 404 || /model.*(not found|not available|does not exist|not have access)/i.test(msg)) err.code = 'model';
        else if (resp.status === 429) err.code = 'busy';
        throw err;
      }
      const block = (data.content || []).find((b) => b.type === 'tool_use' && b.name === tool.name);
      if (block) return { result: block.input || {}, usage: data.usage || {}, model: data.model || MODEL, truncated: data.stop_reason === 'max_tokens' };
      // Fallback: the model answered in text; accept it if it is a JSON object.
      const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          return { result: JSON.parse(m[0]), usage: data.usage || {}, model: data.model || MODEL };
        } catch (e) { /* fall through */ }
      }
      throw new Error('AI service returned no result.');
    } finally {
      clearTimeout(timer);
    }
  }

  async function logUsage({ caraId, kind, staffId, model, usage, result }) {
    try {
      await pool.query(
        `INSERT INTO cara_ai_reviews (cara_id, kind, staff_id, model, input_tokens, output_tokens, result)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [caraId || null, kind, staffId || null, model, usage.input_tokens || 0, usage.output_tokens || 0, result ? JSON.stringify(result) : null]
      );
    } catch (e) {
      console.error('cara_ai_reviews insert failed:', e.message);
    }
  }

  // ---------- Rule checks (no AI) ----------
  function ruleChecks(c, peras) {
    const out = [];
    const add = (severity, message) => out.push({ severity, message });
    if (!peras.length) add('Should fix', 'No equipment (PERA) is selected. If the activity uses no tools or machines, say so in the activity scope.');
    for (const p of peras) {
      if (p.archived || p.status !== 'Approved') add('Must fix', `"${p.activity_name}" is not approved yet (${p.archived ? 'Archived' : p.status}). The CARA can't be submitted until it is.`);
      if (p.student_use_permitted === false) add('Must fix', `The PERA for "${p.activity_name}" says students must not use it. Remove it, or make clear in the scope that only staff operate it.`);
    }
    const highest = peras.reduce((m, p) => (RISK_ORDER[p.risk_level] > RISK_ORDER[m] ? p.risk_level : m), 'Low');
    if (peras.length && RISK_ORDER[c.risk_level] < RISK_ORDER[highest]) {
      const which = peras.filter((p) => p.risk_level === highest).map((p) => p.activity_name).join(', ');
      add('Should fix', `Risk level is ${c.risk_level}, but ${which} ${which.includes(',') ? 'are' : 'is'} rated ${highest}. The CARA risk level is usually at least the highest PERA's.`);
    }
    if (c.risk_level === 'Extreme' && !c.consent_required) add('Must fix', 'Extreme risk activities need parent consent. Tick "Parent consent required".');
    if (c.risk_level === 'High' && !c.consent_required) add('Suggestion', 'Parent consent is recommended for High risk activities.');
    const blanks = [
      ['activity_scope', 'Activity scope'],
      ['supervision_notes', 'Supervision'],
      ['induction_instruction', 'Induction and instruction'],
      ['emergency_first_aid', 'Emergency and first aid'],
    ].filter(([k]) => !String(c[k] || '').trim());
    if (blanks.length) add('Should fix', `These sections are empty: ${blanks.map(([, l]) => l).join(', ')}.`);
    for (const [h, ctl, label] of HAZARD_PAIRS) {
      if (String(c[h] || '').trim() && !String(c[ctl] || '').trim()) add('Should fix', `${label} hazards are listed but there are no ${label.toLowerCase()} controls.`);
    }
    const needsInduction = peras.filter((p) => p.student_induction_required || p.competency_demonstration_required);
    if (needsInduction.length && !/induct|demonstrat|competen/i.test(String(c.induction_instruction || ''))) {
      add('Suggestion', `${needsInduction.length === 1 ? 'A PERA requires' : 'Some PERAs require'} student induction or a competency demonstration (${needsInduction.map((p) => p.activity_name).slice(0, 4).join(', ')}). Mention how that will happen under Induction and instruction.`);
    }
    return out;
  }

  // ---------- Draft suggestions (form) ----------
  const DRAFT_TOOL = {
    name: 'cara_draft',
    description: 'Suggested content for the CARA form fields.',
    input_schema: {
      type: 'object',
      properties: {
        ...Object.fromEntries(Object.entries(DRAFT_FIELDS).map(([k, label]) => [k, { type: 'string', description: `Suggested text for "${label}". ${FIELD_GUIDE[k] || ''} Omit or leave empty if the existing text is already good.` }])),
        suggested_risk_level: { type: 'string', enum: RISK_LEVELS },
        risk_reason: { type: 'string', description: 'One sentence explaining the suggested risk level.' },
        consent_recommended: { type: 'boolean' },
        consent_reason: { type: 'string', description: 'One sentence.' },
        notes: { type: 'array', items: { type: 'string' }, description: 'Up to 3 short notes for the teacher, e.g. missing information.' },
      },
      required: ['suggested_risk_level', 'risk_reason'],
    },
  };

  app.post('/cara/ai/draft', async (req, res) => {
    try {
      if (!apiEnabled()) return res.json({ ok: false, error: 'The AI assistant is not set up on this server yet.' });
      if (overLimit(req.staffUser.id)) return res.status(429).json({ ok: false, error: 'Too many AI requests in the last hour. Try again later.' });
      const b = req.body || {};
      const c = { activity_name: b.activity_name, class_unit: b.class_unit, risk_level: b.risk_level, consent_required: b.consent_required === 'true' };
      for (const k of Object.keys(DRAFT_FIELDS)) c[k] = b[k];
      if (!String(c.activity_name || '').trim()) return res.status(400).json({ ok: false, error: 'Enter the activity name first.' });
      const peras = await loadPeras(b.tool_ids);
      const wantStudents = b.students_notes_empty === '1';
      const tool = wantStudents
        ? { ...DRAFT_TOOL, input_schema: { ...DRAFT_TOOL.input_schema, required: [...DRAFT_TOOL.input_schema.required, 'students_notes'], properties: { ...DRAFT_TOOL.input_schema.properties, students_notes: { type: 'string', description: `Suggested template for "Students". ${STUDENTS_GUIDE}` } } } }
        : DRAFT_TOOL;
      const userText = `${wantStudents ? 'The Students box is empty: include a students_notes template.\n\n' : ''}Draft suggested content for this CARA. Where a field already has good text, leave it out of your answer; where it has some text, suggest an improved full version that keeps the teacher's points.\n\n=== CARA so far ===\n${caraContext(c)}\n\n=== PERAs selected ===\n${peraContext(peras)}`;
      // 12 long fields for a many-machine activity can exceed 4000 tokens, which
      // silently cut off the last fields (e.g. Student controls). Allow more.
      const { result, usage, model, truncated } = await callClaude({ userText, tool, maxTokens: 8000 });
      await logUsage({ kind: 'draft', staffId: req.staffUser.id, model, usage, result: null });
      const suggestions = {};
      for (const k of Object.keys(DRAFT_FIELDS)) {
        const v = plainText(result[k]);
        if (v && v !== String(c[k] || '').trim()) suggestions[k] = v.slice(0, 4000);
      }
      if (wantStudents && String(result.students_notes || '').trim()) suggestions.students_notes = plainText(result.students_notes).slice(0, 4000);
      res.json({
        ok: true,
        suggestions,
        risk: RISK_LEVELS.includes(result.suggested_risk_level) ? { level: result.suggested_risk_level, reason: clip(result.risk_reason, 300) } : null,
        consent: typeof result.consent_recommended === 'boolean' ? { recommended: result.consent_recommended, reason: clip(result.consent_reason, 300) } : null,
        notes: [
          ...(truncated ? ['The AI ran out of space before finishing, so some fields may have no suggestion. Check every section, or run Draft again.'] : []),
          ...(Array.isArray(result.notes) ? result.notes.slice(0, 3).map((n) => clip(n, 300)) : []),
        ],
        rules: ruleChecks(c, peras),
      });
    } catch (err) {
      console.error('CARA AI draft failed:', err.message);
      res.json({ ok: false, error: ERROR_TEXT[errorCode(err)] });
    }
  });

  // ---------- Pre-submission check (CARA page) ----------
  const CHECK_TOOL = {
    name: 'cara_review',
    description: 'Review of a CARA before it is submitted for approval.',
    input_schema: {
      type: 'object',
      properties: {
        overall: { type: 'string', enum: ['Ready to submit', 'Minor improvements suggested', 'Needs work before submitting'] },
        summary: { type: 'string', description: 'One or two sentences.' },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              severity: { type: 'string', enum: ['Must fix', 'Should fix', 'Suggestion'] },
              section: { type: 'string', description: 'CARA section the issue relates to.' },
              issue: { type: 'string' },
              suggestion: { type: 'string', description: 'What to add or change, specific and short.' },
            },
            required: ['severity', 'issue'],
          },
          description: 'Up to 8 issues, most important first.',
        },
      },
      required: ['overall', 'summary', 'issues'],
    },
  };

  async function canUse(user, caraId) {
    const { rows } = await pool.query('SELECT * FROM cara_records WHERE id = $1', [caraId]);
    if (!rows.length) return { cara: null };
    const cara = rows[0];
    const allowed = user && (['admin', 'approver'].includes(user.role) || canManageOwnRecord(user, cara));
    return { cara, allowed };
  }

  async function linkedPeraIds(caraId) {
    const { rows } = await pool.query('SELECT pera_id FROM cara_tool_links WHERE cara_id = $1', [caraId]);
    return rows.map((r) => r.pera_id);
  }

  app.post('/cara/:id/ai/check', async (req, res, next) => {
    const id = Number(req.params.id);
    try {
      const { cara, allowed } = await canUse(req.staffUser, id);
      if (!cara) return res.status(404).send('CARA record not found.');
      if (!allowed) return res.status(403).send('You can only check CARA records you created yourself.');
      if (!apiEnabled()) return res.redirect(`/cara/${id}?ai=off#ai-check`);
      if (overLimit(req.staffUser.id)) return res.redirect(`/cara/${id}?ai=limit#ai-check`);
      const peras = await loadPeras(await linkedPeraIds(id));
      const rules = ruleChecks(cara, peras);
      const userText = `Review this CARA before it is submitted for approval. Check it against the PERAs: are the activity's real hazards covered, are controls adequate and specific, is supervision consistent with the PERAs, is induction/competency covered, is anything missing or contradictory? Rule-based checks have already found the following, so don't repeat them:\n${rules.map((r) => `- ${r.message}`).join('\n') || '- (none)'}\n\n=== CARA ===\n${caraContext(cara)}\n\n=== PERAs used ===\n${peraContext(peras)}`;
      let result;
      try {
        const out = await callClaude({ userText, tool: CHECK_TOOL, maxTokens: 3000 });
        result = out.result;
        result.issues = Array.isArray(result.issues) ? result.issues.slice(0, 8) : [];
        await logUsage({ caraId: id, kind: 'check', staffId: req.staffUser.id, model: out.model, usage: out.usage, result });
      } catch (e) {
        console.error('CARA AI check failed:', e.message);
        return res.redirect(`/cara/${id}?ai=${errorCode(e)}#ai-check`);
      }
      res.redirect(`/cara/${id}#ai-check`);
    } catch (err) {
      next(err);
    }
  });

  const SEV_CLASS = { 'Must fix': 'ai-sev-must', 'Should fix': 'ai-sev-should', Suggestion: 'ai-sev-sugg' };
  function issueList(items) {
    return `<ul class="ai-issues">${items
      .map((i) => `<li class="${SEV_CLASS[i.severity] || 'ai-sev-sugg'}"><span class="ai-sev">${escapeHtml(i.severity || 'Suggestion')}</span>
        <div>${i.section ? `<strong>${escapeHtml(i.section)}:</strong> ` : ''}${escapeHtml(i.issue || i.message || '')}${i.suggestion ? `<div class="ai-fix">${escapeHtml(i.suggestion)}</div>` : ''}</div></li>`)
      .join('')}</ul>`;
  }

  // Panel for the CARA page. `canRun` = the viewer may run a new AI check.
  async function checkPanelHtml(cara, user, query = {}) {
    const peras = await loadPeras(await linkedPeraIds(cara.id));
    const rules = ruleChecks(cara, peras);
    const latest = (await pool.query(
      `SELECT r.*, s.name AS staff_name FROM cara_ai_reviews r LEFT JOIN staff_users s ON s.id = r.staff_id
       WHERE r.cara_id = $1 AND r.kind = 'check' ORDER BY r.created_at DESC LIMIT 1`,
      [cara.id]
    )).rows[0];
    const editable = cara.status === 'Draft' || cara.status === 'Changes requested';
    const canRun = editable && apiEnabled() && user && (['admin', 'approver'].includes(user.role) || canManageOwnRecord(user, cara));
    const stale = latest && new Date(cara.updated_at) > new Date(latest.created_at);
    const notice = {
      ...ERROR_TEXT,
      off: 'The AI check is not set up on this server yet.',
      limit: 'Too many AI requests in the last hour. Try again later.',
    }[query.ai];

    let aiHtml = '';
    if (latest && latest.result) {
      const r = latest.result;
      const tone = r.overall === 'Ready to submit' ? 'ai-ok' : r.overall === 'Needs work before submitting' ? 'ai-bad' : 'ai-mid';
      aiHtml = `
        <div class="ai-result">
          <div class="ai-overall ${tone}">${escapeHtml(r.overall || '')}</div>
          <p class="ai-summary">${escapeHtml(r.summary || '')}</p>
          ${(r.issues || []).length ? issueList(r.issues) : ''}
          <p class="ai-meta">AI check ${new Date(latest.created_at).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane', dateStyle: 'medium', timeStyle: 'short' })}${latest.staff_name ? ` by ${escapeHtml(latest.staff_name)}` : ''}${stale ? ' · <strong>the CARA has changed since — run it again</strong>' : ''}. Advice only; it doesn't change the CARA.</p>
        </div>`;
    }

    return `
      <div class="ai-check-panel" id="ai-check">
        <div class="ai-check-head">
          <h3>Check before submitting</h3>
          ${canRun ? `<form method="post" action="/cara/${cara.id}/ai/check" onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').textContent='Checking… (up to a minute)';">
            <button type="submit" class="btn btn-secondary btn-sm">${latest ? 'Run AI check again' : 'Run AI check'}</button></form>` : ''}
        </div>
        ${notice ? `<div class="ai-notice">${escapeHtml(notice)}</div>` : ''}
        ${rules.length ? `<p class="ai-sub">Automatic checks</p>${issueList(rules)}` : '<p class="ai-sub ai-allclear">Automatic checks: nothing flagged.</p>'}
        ${aiHtml || (canRun ? '<p class="ai-meta">The AI check reviews the hazards, controls, supervision and induction against the PERAs and lists anything to fix. Student notes are never sent.</p>' : '')}
      </div>`;
  }

  // Assistant panel + script for the CARA new/edit form.
  function draftPanelHtml() {
    if (!apiEnabled()) return '';
    return `
      <div class="ai-draft-panel" id="ai_draft_panel">
        <div class="ai-draft-text">
          <strong>AI assistant</strong>
          <span>Fill in the activity name and select the PERAs, then get suggested wording for the rest of the form. Nothing is filled in until you choose <em>Use this</em>. The Students box is never sent.</span>
        </div>
        <button type="button" class="btn btn-secondary" id="ai_draft_btn">Suggest content</button>
        <div class="ai-draft-status" id="ai_draft_status" role="status" aria-live="polite"></div>
      </div>
      <script>
      (function () {
        var btn = document.getElementById('ai_draft_btn');
        var statusEl = document.getElementById('ai_draft_status');
        var form = btn.closest('form');
        function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
        function clearOld() { document.querySelectorAll('.ai-suggest').forEach(function (n) { n.remove(); }); }
        function suggestBox(target, title, text, onUse, onAdd) {
          var box = el('div', 'ai-suggest');
          box.appendChild(el('div', 'ai-suggest-title', title));
          if (text) box.appendChild(el('div', 'ai-suggest-body', text));
          var row = el('div', 'ai-suggest-actions');
          var use = el('button', 'btn btn-primary btn-sm', 'Use this'); use.type = 'button';
          use.onclick = function () { onUse(); box.remove(); };
          row.appendChild(use);
          if (onAdd) { var add = el('button', 'btn btn-secondary btn-sm', 'Add to mine'); add.type = 'button'; add.onclick = function () { onAdd(); box.remove(); }; row.appendChild(add); }
          var no = el('button', 'btn btn-secondary btn-sm', 'Dismiss'); no.type = 'button'; no.onclick = function () { box.remove(); };
          row.appendChild(no);
          box.appendChild(row);
          target.insertAdjacentElement('afterend', box);
        }
        btn.addEventListener('click', function () {
          var fd = new FormData(form);
          // Never send what's typed in Students; only whether it's empty.
          var studentsEmpty = !String(fd.get('students_notes') || '').trim();
          fd.delete('students_notes'); fd.delete('submitted_by');
          fd.append('students_notes_empty', studentsEmpty ? '1' : '0');
          var params = new URLSearchParams();
          fd.forEach(function (v, k) { if (typeof v === 'string') params.append(k, v); });
          if (!(fd.get('activity_name') || '').trim()) { statusEl.textContent = 'Enter the activity name first.'; return; }
          btn.disabled = true; statusEl.textContent = 'Thinking… this can take up to a minute.';
          fetch('/cara/ai/draft', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(), credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              btn.disabled = false;
              if (!d.ok) { statusEl.textContent = d.error || 'Something went wrong.'; return; }
              clearOld();
              var count = 0;
              Object.keys(d.suggestions || {}).forEach(function (k) {
                var f = form.querySelector('[name="' + k + '"]'); if (!f) return;
                count++;
                suggestBox(f, 'Suggested', d.suggestions[k],
                  function () { f.value = d.suggestions[k]; },
                  f.value.trim() ? function () { f.value = f.value.trim() + '\\n' + d.suggestions[k]; } : null);
              });
              var risk = form.querySelector('[name="risk_level"]');
              if (d.risk && risk && d.risk.level !== risk.value) { count++; suggestBox(risk, 'Suggested risk level: ' + d.risk.level, d.risk.reason, function () { risk.value = d.risk.level; }); }
              var consent = form.querySelector('[name="consent_required"]');
              if (d.consent && consent && d.consent.recommended && !consent.checked) { count++; suggestBox(consent.parentElement, 'Parent consent recommended', d.consent.reason, function () { consent.checked = true; }); }
              var msgs = (d.notes || []).concat((d.rules || []).map(function (r) { return r.message; }));
              statusEl.innerHTML = '';
              statusEl.appendChild(el('div', null, count ? count + ' suggestion' + (count === 1 ? '' : 's') + ' added below the matching boxes. Review each one before using it.' : 'No changes suggested.'));
              if (msgs.length) { var ul = el('ul', 'ai-draft-notes'); msgs.forEach(function (m) { ul.appendChild(el('li', null, m)); }); statusEl.appendChild(ul); }
            })
            .catch(function () { btn.disabled = false; statusEl.textContent = 'Could not reach the AI assistant. Try again.'; });
        });
      })();
      </script>`;
  }

  return { ruleChecks, checkPanelHtml, draftPanelHtml, apiEnabled };
};
