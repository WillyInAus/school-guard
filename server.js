const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const { execFile } = require('child_process');
const PDFDocument = require('pdfkit');
const multer = require('multer');
const sharp = require('sharp');
const { pool, migrate, MIN_SAFETY_REQUIREMENTS, ELECTRICAL_REQUIREMENTS } = require('./db');
const { page, escapeHtml, requestContext, BRAND } = require('./views/layout');
const { renderLanding } = require('./landing');
const { renderCaraHtml, renderCaraPdf } = require('./cara-pdf');

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
const STAFF_ROLES = ['system_admin', 'admin', 'approver', 'submitter'];

// ---------- Structured PERA ----------

const HAZARD_CATEGORIES = ['Mechanical', 'Electrical', 'Chemical', 'Noise', 'Manual handling', 'Fire', 'Ergonomic', 'Environmental', 'Other'];
const CONTROL_TYPES = ['Engineering', 'Administrative', 'PPE', 'Procedural'];
const APPROVAL_DECISIONS = ['Approved as submitted', 'Approved with conditions', 'Not approved'];
const APPROVAL_REQUIRED_LEVELS = ['Principal', 'Delegate', 'HOD', 'WHS Officer'];
const HAZARD_APPLIES_TO = ['Staff', 'Students', 'Both'];
const MIN_REQUIREMENT_STATUSES = ['Current', 'Required', 'Not applicable'];
const DOCUMENT_CATEGORIES = ['SOP', 'Manufacturer manual', 'Equipment Maintenance Record', 'Student induction record', 'Staff competency record', 'Previous risk assessment', 'Other'];

// Related documents on a PERA can now be an actual uploaded file (stored
// straight in Postgres as bytea, not on the app container's disk -- that
// disk doesn't survive a "docker compose up --build") instead of just a
// link to somewhere else. Kept to common office/document/image formats;
// anything else is rejected with a clear error rather than silently
// stored as an unrecognised blob.
const DOCUMENT_UPLOAD_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'text/plain',
]);
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    if (!DOCUMENT_UPLOAD_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error('UNSUPPORTED_FILE_TYPE'));
    }
    cb(null, true);
  },
});

const execFileAsync = util.promisify(execFile);
// A photo just needs to comfortably out-resolve the ~500px display size
// (including on a retina screen), so it's capped lower than a rendered PDF
// page, which needs real DPI for its text to look sharp once magnified --
// a normal A4/Letter page at 200dpi is up to ~2340px tall, so that cap is
// set high enough to leave a normal page untouched and only kick in for
// something unusual (e.g. an A0 poster).
const IMAGE_THUMBNAIL_MAX_DIMENSION = 1200;
const PDF_THUMBNAIL_MAX_DIMENSION = 2400;

// Renders a small preview thumbnail for an uploaded document, if it's a
// type that has a sensible one: an image is just resized down, and a PDF
// is rendered from its first page via poppler's pdftoppm (installed in the
// Docker image -- see Dockerfile). Anything else (Word/Excel/PowerPoint/
// text) gets no thumbnail and falls back to a generic icon in the UI.
// Never throws -- a broken/unusual file just ends up with no thumbnail
// rather than failing the whole upload.
async function generateDocumentThumbnail(buffer, mimetype) {
  try {
    if (mimetype.startsWith('image/')) {
      return await sharp(buffer)
        .resize(IMAGE_THUMBNAIL_MAX_DIMENSION, IMAGE_THUMBNAIL_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer();
    }
    if (mimetype === 'application/pdf') {
      return await renderPdfFirstPageThumbnail(buffer);
    }
  } catch (err) {
    console.warn('Thumbnail generation failed:', err.message);
  }
  return null;
}

async function renderPdfFirstPageThumbnail(buffer) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sop-thumb-'));
  const pdfPath = path.join(tmpDir, 'input.pdf');
  const outPath = path.join(tmpDir, 'out');
  try {
    fs.writeFileSync(pdfPath, buffer);
    // Render at a fixed 200 DPI rather than a fixed pixel width -- a pixel
    // width target was coming out far too low-resolution for readable text
    // (a normal A4 page at 700px wide is only ~85dpi, which looks fuzzy
    // once displayed at 500px). 200dpi keeps text crisp; the resize below
    // then caps the result in case of an oversized physical page.
    await execFileAsync('pdftoppm', [
      '-png', '-f', '1', '-l', '1',
      '-r', '200',
      '-singlefile', pdfPath, outPath,
    ]);
    const rendered = fs.readFileSync(`${outPath}.png`);
    return await sharp(rendered)
      .resize(PDF_THUMBNAIL_MAX_DIMENSION, PDF_THUMBNAIL_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// The checklist items themselves live in db.js (MIN_SAFETY_REQUIREMENTS),
// so the startup migration and new-PERA seeding always use the same list.
// What each item means, from the Queensland ITD reference PERA's minimum
// standards and electrical controls -- shown under each item on the PERA.
const MIN_REQUIREMENT_HINTS = {
  'Competent teacher/operator': 'Registered teacher with knowledge, experience and demonstrated competency in the safe use of this equipment; any staff training needs identified.',
  'Student induction': 'How student use is managed is stated (e.g. workshop safety induction) and inductions are recorded in a student induction register.',
  "Operator's manual available": "The manufacturer's operator manual is available in the school.",
  'SOP available': 'A current Safe Operating Procedure is available (and displayed at the equipment).',
  'Equipment maintenance record current': 'An Equipment Maintenance Record (EMR) is kept, including electrical maintenance.',
  'Guards checked': 'All guards are in place and in good working order.',
  'Safe working zone': 'Safe working zones are defined, e.g. yellow floor lines and/or signage.',
  'Required PPE available': 'Suitable personal protective equipment is available for all operators.',
  'Complies with relevant safety standards': 'The equipment complies with the relevant safety standards.',
  'Electrical inspection/tagging current where applicable': 'Electrical safety inspection/test and tag completed as per guidelines; leads, plugs and switches visually checked; Lock Out/Danger tags used during repair.',
  'Emergency stop operational where applicable': 'Isolating switch and emergency stop buttons fitted, prominent and working.',
};


// ---------- Staff auth (individual accounts, roles) ----------
// Replaces the old single shared ADMIN_PASSWORD. Three roles:
//   admin     - everything, including managing other staff accounts
//   approver  - everything a submitter can do, plus approve/reject PERA
//               and CARA records
//   submitter - create records and edit their own; can't approve

const SESSION_SECRET = process.env.SESSION_SECRET || '';
if (!SESSION_SECRET) {
  console.error('SESSION_SECRET environment variable is not set -- staff sign-in will not work until it is. Set it to a long random value.');
}

function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  const parts = header.split(';').map((c) => c.trim());
  const found = parts.find((c) => c.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : null;
}

// ---- Password hashing (scrypt via Node's built-in crypto -- no extra
// dependency needed, which matters here since adding one means regenerating
// package-lock.json). Stored as "salt:hash", both hex. ----

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const hashBuffer = Buffer.from(hash, 'hex');
  const candidate = crypto.scryptSync(password, salt, hashBuffer.length);
  if (candidate.length !== hashBuffer.length) return false;
  return crypto.timingSafeEqual(candidate, hashBuffer);
}

// ---- Session cookies: "<userId>.<expiryMs>.<hmac>", HMAC-SHA256 signed
// with SESSION_SECRET. Deliberately stateless (no sessions table) -- role
// and disabled/enabled state are re-checked from staff_users on every
// request, so disabling someone takes effect on their very next click. ----

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function signSession(userId) {
  const expiry = Date.now() + SESSION_MAX_AGE_MS;
  const payload = `${userId}.${expiry}`;
  const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${hmac}`;
}

function verifySession(token) {
  if (!token || !SESSION_SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, expiry, hmac] = parts;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(`${userId}.${expiry}`).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(hmac, 'hex');
  if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) return null;
  if (Number(expiry) < Date.now()) return null;
  const id = Number(userId);
  return Number.isInteger(id) ? id : null;
}

// Cookie is deliberately NOT marked Secure: this app is typically reached
// over plain HTTP on a school LAN (no TLS terminator in front of it), and a
// Secure cookie would silently never be sent in that setup.
function setSessionCookie(res, userId) {
  const token = signSession(userId);
  res.setHeader('Set-Cookie', `staff_session=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; SameSite=Lax`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'staff_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
}

// Runs on every request; attaches req.staffUser when a valid, non-disabled
// session cookie is present. Doesn't block anything itself.
async function loadStaffUser(req, res, next) {
  const userId = verifySession(getCookie(req, 'staff_session'));
  if (userId) {
    try {
      const { rows } = await pool.query(
        'SELECT id, name, email, role, disabled FROM staff_users WHERE id = $1',
        [userId]
      );
      if (rows.length && !rows[0].disabled) {
        req.staffUser = rows[0];
        // A System Administrator has every Admin permission, so the rest of the
        // app sees them as 'admin'; dbRole/isSystemAdmin carry the extra powers.
        req.staffUser.dbRole = rows[0].role;
        req.staffUser.isSystemAdmin = rows[0].role === 'system_admin';
        if (req.staffUser.isSystemAdmin) req.staffUser.role = 'admin';
      }
    } catch (e) {
      // DB hiccup: fall through as logged-out rather than failing the request.
    }
  }
  next();
}
app.use(loadStaffUser);
app.use((req, res, next) => requestContext.run({ user: req.staffUser || null, path: req.path }, next));

function requireAuth(req, res, next) {
  if (req.staffUser) return next();
  res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
}

// Admins and approvers can edit any record; a submitter can only edit ones
// they created themselves. Used on the CARA edit form, which is the one
// non-admin edit route staff use day-to-day (PERA only has an admin-only
// edit route, so this check isn't needed there).
function canManageOwnRecord(user, record) {
  if (user.role === 'admin' || user.role === 'approver') return true;
  return record.created_by_staff_id === user.id;
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.staffUser) {
      return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
    }
    if (!roles.includes(req.staffUser.role)) {
      return res.status(403).send('You do not have permission to do that. <a href="/">Back to dashboard</a>');
    }
    next();
  };
}

// Every route below needs a logged-in staff member except these: the login
// page, the one-time setup bootstrap, logout, and the Docker healthcheck.
// (Static files under /public are already handled above and never reach
// here.) Individual routes layer requireRole(...) on top of this where a
// specific role is required (see the admin/approve routes further down).
const PUBLIC_PATHS = new Set(['/', '/admin/login', '/admin/setup', '/admin/logout', '/healthz']);
app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();
  return requireAuth(req, res, next);
});

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

// Groups a PERA's change_log rows (already ORDER BY changed_at DESC) by
// calendar year for the collapsible change-history tree on the PERA detail
// page -- newest year expanded, older years collapsed by default.
function groupChangeLogByYear(rows) {
  const years = new Map();
  for (const row of rows) {
    const year = new Date(row.changed_at).getFullYear();
    if (!years.has(year)) years.set(year, []);
    years.get(year).push(row);
  }
  return [...years.entries()].sort((a, b) => b[0] - a[0]);
}

function approvalDecisionBadgeClass(decision) {
  return {
    'Approved as submitted': 'badge-approved',
    'Approved with conditions': 'badge-pending',
    'Not approved': 'badge-changes',
  }[decision] || 'badge-draft';
}

function minRequirementStatusBadgeClass(status) {
  return {
    'Current': 'badge-approved',
    'Required': 'badge-draft',
    'Not applicable': 'badge-draft',
    'Due Soon': 'badge-pending',
    'Missing': 'badge-changes',
  }[status] || 'badge-draft';
}

// Renders one hazard row for the PERA new/edit forms -- called once per
// existing hazard when pre-filling an edit form, and once with no argument
// for the empty <template> row that "+ Add hazard" clones. All fields
// inside a row deliberately share their name with every other row's
// (hazard_description, hazard_category, ...) rather than using array
// brackets: express/qs collects same-name fields into parallel arrays in
// document order, exactly like the tool_ids checkboxes elsewhere in this
// file, and every field here is a text/select input (never a checkbox) so
// a row can never be silently dropped from the arrays just because a box
// was left unticked.
function renderHazardRow(h = {}) {
  const categoryOptions = ['', ...HAZARD_CATEGORIES].map((c) =>
    `<option value="${escapeHtml(c)}" ${h.category === c ? 'selected' : ''}>${c || 'Select category…'}</option>`
  ).join('');
  const riskOptions = ['', ...RISK_LEVELS].map((l) =>
    `<option value="${l}" ${h.risk_level === l ? 'selected' : ''}>${l || 'Select risk…'}</option>`
  ).join('');
  const controlTypeOptions = ['', ...CONTROL_TYPES].map((t) =>
    `<option value="${escapeHtml(t)}" ${h.control_type === t ? 'selected' : ''}>${t || 'Select control type…'}</option>`
  ).join('');
  return `
    <div class="hazard-row">
      <button type="button" class="hazard-row-remove" onclick="this.closest('.hazard-row').remove()" title="Remove this hazard">×</button>
      <div class="form-row">
        <label>Hazard</label>
        <textarea name="hazard_description" placeholder="e.g. Flying metal fragments from the grinding disc">${escapeHtml(h.description || '')}</textarea>
      </div>
      <div class="hazard-row-grid">
        <div class="form-row">
          <label>Category</label>
          <select name="hazard_category">${categoryOptions}</select>
        </div>
        <div class="form-row">
          <label>Risk level</label>
          <select name="hazard_risk_level">${riskOptions}</select>
        </div>
        <div class="form-row">
          <label>Control type</label>
          <select name="hazard_control_type">${controlTypeOptions}</select>
        </div>
        <div class="form-row">
          <label>Mandatory control?</label>
          <select name="hazard_mandatory">
            <option value="No" ${!h.mandatory ? 'selected' : ''}>No</option>
            <option value="Yes" ${h.mandatory ? 'selected' : ''}>Yes</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <label>Control measure</label>
        <textarea name="hazard_control_measure" placeholder="What reduces this risk?">${escapeHtml(h.control_measure || '')}</textarea>
      </div>
      <div class="form-row">
        <label>Applies to</label>
        <select name="hazard_applies_to">
          <option value="" ${!h.applies_to ? 'selected' : ''}>Select…</option>
          ${HAZARD_APPLIES_TO.map((a) => `<option value="${a}" ${h.applies_to === a ? 'selected' : ''}>${a}</option>`).join('')}
        </select>
      </div>
    </div>
  `;
}

const HAZARD_BUILDER_SCRIPT = `
  <script>
    function addHazardRow() {
      const tpl = document.getElementById('hazard-row-template');
      document.getElementById('hazard-rows').appendChild(tpl.content.cloneNode(true));
    }
  </script>
`;

// Shared "Supervision & student use" + "Training & competency" block for
// the PERA new/edit forms. Called with no argument (all blank/unchecked)
// on the new form, and with the existing record on the edit form.
function renderSupervisionTrainingFields(r = {}) {
  return `
    <div class="form-section-title">Supervision &amp; student use</div>
    <div class="form-row">
      <label for="supervision_level">Supervision level</label>
      <input type="text" id="supervision_level" name="supervision_level" value="${escapeHtml(r.supervision_level || '')}" placeholder="e.g. Direct 1:1, Direct — same room, Indirect">
    </div>
    <div class="form-row">
      <label for="supervisor_competency">Required supervisor qualification / competency</label>
      <input type="text" id="supervisor_competency" name="supervisor_competency" value="${escapeHtml(r.supervisor_competency || '')}" placeholder="e.g. Adult with Design and Technologies qualification, current first aid/CPR">
    </div>
    <div class="form-row">
      <label for="max_operators">Maximum number of operators</label>
      <input type="number" id="max_operators" name="max_operators" min="0" value="${r.max_operators != null ? r.max_operators : ''}">
    </div>
    <div class="form-row checkbox-row">
      <input type="checkbox" id="student_induction_required" name="student_induction_required" value="true" ${r.student_induction_required ? 'checked' : ''}>
      <label for="student_induction_required">Student induction required</label>
    </div>
    <div class="form-row checkbox-row">
      <input type="checkbox" id="competency_demonstration_required" name="competency_demonstration_required" value="true" ${r.competency_demonstration_required ? 'checked' : ''}>
      <label for="competency_demonstration_required">Competency demonstration required</label>
    </div>
    <div class="form-row checkbox-row">
      <input type="checkbox" id="safe_working_zone_required" name="safe_working_zone_required" value="true" ${r.safe_working_zone_required ? 'checked' : ''}>
      <label for="safe_working_zone_required">Safe working zone required</label>
    </div>

    <div class="form-section-title">Training &amp; competency</div>
    <div class="form-row">
      <label for="staff_training">Staff — training/induction/competency required before use</label>
      <textarea id="staff_training" name="staff_training">${escapeHtml(r.staff_training || '')}</textarea>
    </div>
    <div class="form-row">
      <label for="student_training">Students — training/induction/competency required before use</label>
      <textarea id="student_training" name="student_training">${escapeHtml(r.student_training || '')}</textarea>
    </div>
  `;
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
    if (!req.staffUser) return res.send(renderLanding({ next: '/' }));
    const totalResult = await pool.query('SELECT COUNT(*)::int AS count FROM pera_records WHERE archived = false');
    const pendingResult = await pool.query(
      "SELECT COUNT(*)::int AS count FROM pera_records WHERE status = 'Pending approval' AND archived = false"
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
    const isAdmin = req.staffUser && req.staffUser.role === 'admin';
    const conditions = ['archived = false'];
    const params = [];

    if (risk && RISK_LEVELS.includes(risk)) {
      params.push(risk);
      conditions.push(`risk_level = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      conditions.push(`activity_name ILIKE $${params.length}`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
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
          ${isAdmin ? `<td style="width:1%;" onclick="event.stopPropagation();"><input type="checkbox" name="ids" value="${r.id}" form="pera-archive-form" onchange="document.getElementById('archive-selected-btn').disabled = !document.querySelectorAll('input[name=ids][form=pera-archive-form]:checked').length;"></td>` : ''}
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
              ${isAdmin ? `<th style="width:1%;"><input type="checkbox" onchange="document.querySelectorAll('input[name=ids][form=pera-archive-form]').forEach((cb) => cb.checked = this.checked); document.getElementById('archive-selected-btn').disabled = !this.checked;"></th>` : ''}
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
      ${isAdmin ? `
        <form id="pera-archive-form" method="post" action="/admin/pera/archive" onsubmit="return confirm('Archive the selected PERA record(s)? They will be hidden from this list but can be restored anytime from the PERA Archive.');" style="margin-bottom:10px;">
          <input type="hidden" name="redirect_to" value="${escapeHtml(req.originalUrl)}">
          <button type="submit" id="archive-selected-btn" class="btn btn-secondary" disabled>Archive selected</button>
          <a href="/admin/pera/archive" style="margin-left:12px;font-size:13px;color:#6B6659;text-decoration:underline;">View PERA Archive →</a>
        </form>
      ` : ''}
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
    <p class="page-subtitle" style="margin-bottom:24px;">This Plant &amp; Equipment Risk Assessment (PERA) will be saved as a Draft until you submit it for approval. A Minimum Safety Requirements checklist is added automatically once it's created.</p>
    <form class="form-card" method="post" action="/pera">
      <div class="form-section-title" style="margin-top:0;padding-top:0;border-top:none;">Plant / equipment</div>
      <div class="form-row">
        <label for="activity_name">Plant / equipment / activity name</label>
        <input type="text" id="activity_name" name="activity_name" required placeholder="e.g. Angle grinder induction — Yr 11 Metalwork">
      </div>
      <div class="form-row">
        <label for="class_unit">Class / unit</label>
        <input type="text" id="class_unit" name="class_unit" placeholder="e.g. Yr 11 Metalwork, or UEE22020 Cert II Electrotechnology">
      </div>
      <div class="form-row">
        <label for="location">Location</label>
        <input type="text" id="location" name="location" placeholder="e.g. Workshop A">
      </div>
      <div class="form-row">
        <label for="risk_level">Risk level</label>
        <select id="risk_level" name="risk_level" required>${riskOptions}</select>
      </div>

      <div class="form-section-title">Activity / process</div>
      <div class="form-row">
        <label for="activity_process">What happens during this activity or process?</label>
        <textarea id="activity_process" name="activity_process" placeholder="Describe the process step by step"></textarea>
      </div>
      <div class="form-row">
        <label for="materials_used">Materials used</label>
        <textarea id="materials_used" name="materials_used"></textarea>
      </div>
      <div class="form-row">
        <label for="student_use">Student use</label>
        <textarea id="student_use" name="student_use" placeholder="How and when do students use this equipment?"></textarea>
      </div>
      <div class="form-row checkbox-row">
        <input type="checkbox" id="student_use_permitted" name="student_use_permitted" value="true">
        <label for="student_use_permitted">Student use permitted</label>
      </div>
      <div class="form-row">
        <label for="operating_conditions">Operating conditions</label>
        <textarea id="operating_conditions" name="operating_conditions"></textarea>
      </div>

      <div class="form-section-title">Hazards and control measures</div>
      <p class="form-section-hint">Add one row per hazard.</p>
      <div id="hazard-rows">${renderHazardRow()}</div>
      <button type="button" class="btn btn-secondary" onclick="addHazardRow()" style="margin-bottom:20px;">+ Add hazard</button>
      <template id="hazard-row-template">${renderHazardRow()}</template>

      ${renderSupervisionTrainingFields()}

      <div class="form-section-title">Consent and submission</div>
      <div class="form-row checkbox-row">
        <input type="checkbox" id="consent_required" name="consent_required" value="true">
        <label for="consent_required">Parent consent required</label>
      </div>
      <div class="form-row">
        <label for="submitted_by">Submitted by</label>
        <input type="text" id="submitted_by" name="submitted_by" value="${escapeHtml(req.staffUser.name)}">
      </div>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">Save as draft</button>
        <a class="btn btn-secondary" href="/pera">Cancel</a>
      </div>
    </form>
    ${HAZARD_BUILDER_SCRIPT}
  `;

  res.send(page({ title: 'New PERA', active: 'pera', body }));
});

// ---------- PERA: create ----------

app.post('/pera', async (req, res, next) => {
  try {
    const {
      activity_name, class_unit, location, risk_level,
      activity_process, materials_used, student_use, student_use_permitted, operating_conditions,
      supervision_level, supervisor_competency, max_operators,
      student_induction_required, competency_demonstration_required, safe_working_zone_required,
      staff_training, student_training,
      consent_required, submitted_by,
    } = req.body;

    if (!activity_name || !RISK_LEVELS.includes(risk_level)) {
      return res.status(400).send('Activity name and a valid risk level are required.');
    }

    const descriptions = [].concat(req.body.hazard_description || []);
    const categories = [].concat(req.body.hazard_category || []);
    const hazardRiskLevels = [].concat(req.body.hazard_risk_level || []);
    const hazardControlMeasures = [].concat(req.body.hazard_control_measure || []);
    const controlTypes = [].concat(req.body.hazard_control_type || []);
    const mandatoryFlags = [].concat(req.body.hazard_mandatory || []);
    const appliesTos = [].concat(req.body.hazard_applies_to || []);

    const maxOperatorsValue = max_operators !== undefined && max_operators !== '' ? parseInt(max_operators, 10) : null;

    const result = await pool.query(
      `INSERT INTO pera_records
        (activity_name, class_unit, location, risk_level,
         activity_process, materials_used, student_use, student_use_permitted, operating_conditions,
         supervision_level, supervisor_competency, max_operators,
         student_induction_required, competency_demonstration_required, safe_working_zone_required,
         staff_training, student_training,
         consent_required, submitted_by, created_by_staff_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING id`,
      [
        normalizeText(activity_name), normalizeText(class_unit) || null, normalizeText(location) || null, risk_level,
        normalizeText(activity_process) || null, normalizeText(materials_used) || null, normalizeText(student_use) || null, student_use_permitted === 'true', normalizeText(operating_conditions) || null,
        normalizeText(supervision_level) || null, normalizeText(supervisor_competency) || null, Number.isInteger(maxOperatorsValue) ? maxOperatorsValue : null,
        student_induction_required === 'true', competency_demonstration_required === 'true', safe_working_zone_required === 'true',
        normalizeText(staff_training) || null, normalizeText(student_training) || null,
        consent_required === 'true', normalizeText(submitted_by) || null, req.staffUser.id,
      ]
    );
    const peraId = result.rows[0].id;

    for (let i = 0; i < descriptions.length; i++) {
      const description = normalizeText(descriptions[i] || '').trim();
      if (!description) continue;
      await pool.query(
        `INSERT INTO pera_hazards (pera_id, category, description, risk_level, control_measure, control_type, mandatory, applies_to, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          peraId, categories[i] || null, description, hazardRiskLevels[i] || null,
          normalizeText(hazardControlMeasures[i]) || null, controlTypes[i] || null,
          mandatoryFlags[i] === 'Yes', normalizeText(appliesTos[i]) || null, i,
        ]
      );
    }

    const isHandTools = /^\s*hand tools\s*$/i.test(class_unit || '');
    for (let i = 0; i < MIN_SAFETY_REQUIREMENTS.length; i++) {
      if (isHandTools && ELECTRICAL_REQUIREMENTS.includes(MIN_SAFETY_REQUIREMENTS[i])) continue;
      await pool.query(
        `INSERT INTO pera_min_requirements (pera_id, requirement, sort_order) VALUES ($1,$2,$3)`,
        [peraId, MIN_SAFETY_REQUIREMENTS[i], i]
      );
    }

    await pool.query(
      `INSERT INTO pera_change_log (pera_id, changed_by, action, version, summary, brief) VALUES ($1,$2,$3,$4,$5,$6)`,
      [peraId, req.staffUser.name, 'Created', 1, 'PERA created', 'PERA created']
    );

    res.redirect(`/pera/${peraId}`);
  } catch (err) {
    next(err);
  }
});

// ---------- PERA: edit ----------
// Mirrors the CARA edit pattern: lets whoever created the PERA (or an
// admin/approver) correct or expand it later. Any saved change that
// actually changes something bumps "version" and resets the record to
// Draft, clearing whatever approval decision was on it -- the old
// decision no longer reflects the new content. Hazard rows are replaced
// wholesale on every save rather than diffed row-by-row (same approach the
// CARA edit form uses for its PERA tool links), which keeps this simple
// and correct even though it means a hazard's own id changes on every
// edit.

app.get('/pera/:id/edit', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM pera_records WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).send('PERA record not found.');
    }
    const r = result.rows[0];
    if (!canManageOwnRecord(req.staffUser, r)) {
      return res.status(403).send('You can only edit PERA records you created yourself. <a href="/pera">Back to PERA Records</a>');
    }

    const hazardsResult = await pool.query('SELECT * FROM pera_hazards WHERE pera_id = $1 ORDER BY sort_order, id', [req.params.id]);
    const hazardRowsHtml = hazardsResult.rows.length
      ? hazardsResult.rows.map((h) => renderHazardRow(h)).join('')
      : renderHazardRow();

    const riskOptions = RISK_LEVELS.map((l) => `<option value="${l}" ${l === r.risk_level ? 'selected' : ''}>${l}</option>`).join('');

    const resetWarning = r.status !== 'Draft'
      ? `<div class="note-box" style="margin-bottom:20px;">Saving changes will reset this PERA to <strong>Draft</strong> and clear its current approval decision — it will need to be re-submitted and re-approved.</div>`
      : '';

    const body = `
      <a class="back-link" href="/pera/${r.id}">← Back to PERA</a>
      <h1 class="page-title">Edit PERA</h1>
      <p class="page-subtitle" style="margin-bottom:24px;">Changes are recorded in the change history at the bottom of this PERA.</p>
      ${resetWarning}
      <form class="form-card" method="post" action="/pera/${r.id}/edit" style="max-width:760px;">
        <div class="form-section-title" style="margin-top:0;padding-top:0;border-top:none;">Plant / equipment</div>
        <div class="form-row">
          <label for="activity_name">Plant / equipment / activity name</label>
          <input type="text" id="activity_name" name="activity_name" required value="${escapeHtml(r.activity_name)}">
        </div>
        <div class="form-row">
          <label for="class_unit">Class / unit</label>
          <input type="text" id="class_unit" name="class_unit" value="${escapeHtml(r.class_unit || '')}">
        </div>
        <div class="form-row">
          <label for="location">Location</label>
          <input type="text" id="location" name="location" value="${escapeHtml(r.location || '')}">
        </div>
        <div class="form-row">
          <label for="risk_level">Risk level</label>
          <select id="risk_level" name="risk_level" required>${riskOptions}</select>
        </div>

        <div class="form-section-title">Activity / process</div>
        <div class="form-row">
          <label for="activity_process">What happens during this activity or process?</label>
          <textarea id="activity_process" name="activity_process">${escapeHtml(r.activity_process || '')}</textarea>
        </div>
        <div class="form-row">
          <label for="materials_used">Materials used</label>
          <textarea id="materials_used" name="materials_used">${escapeHtml(r.materials_used || '')}</textarea>
        </div>
        <div class="form-row">
          <label for="student_use">Student use</label>
          <textarea id="student_use" name="student_use">${escapeHtml(r.student_use || '')}</textarea>
        </div>
        <div class="form-row checkbox-row">
          <input type="checkbox" id="student_use_permitted" name="student_use_permitted" value="true" ${r.student_use_permitted ? 'checked' : ''}>
          <label for="student_use_permitted">Student use permitted</label>
        </div>
        <div class="form-row">
          <label for="operating_conditions">Operating conditions</label>
          <textarea id="operating_conditions" name="operating_conditions">${escapeHtml(r.operating_conditions || '')}</textarea>
        </div>

        <div class="form-section-title">Hazards and control measures</div>
        <p class="form-section-hint">Add, edit or remove hazard rows.</p>
        <div id="hazard-rows">${hazardRowsHtml}</div>
        <button type="button" class="btn btn-secondary" onclick="addHazardRow()" style="margin-bottom:20px;">+ Add hazard</button>
        <template id="hazard-row-template">${renderHazardRow()}</template>

        ${renderSupervisionTrainingFields(r)}

        <div class="form-section-title">Consent</div>
        <div class="form-row checkbox-row">
          <input type="checkbox" id="consent_required" name="consent_required" value="true" ${r.consent_required ? 'checked' : ''}>
          <label for="consent_required">Parent consent required</label>
        </div>

        <div class="form-section-title">Submitted by</div>
        <div class="form-row">
          <input type="text" id="submitted_by" name="submitted_by" value="${escapeHtml(r.submitted_by || '')}">
        </div>

        <div class="form-section-title">Change record</div>
        <p class="form-section-hint">Your name will be recorded against this edit in the change history below.</p>
        <div class="form-row">
          <label for="edited_by">Your name</label>
          <input type="text" id="edited_by" name="edited_by" required value="${escapeHtml(req.staffUser.name)}">
        </div>

        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Save changes</button>
          <a class="btn btn-secondary" href="/pera/${r.id}">Cancel</a>
        </div>
      </form>
      ${HAZARD_BUILDER_SCRIPT}
    `;

    res.send(page({ title: `Edit — ${r.activity_name}`, active: 'pera', body }));
  } catch (err) {
    next(err);
  }
});

// Any change to an approved (or submitted) PERA sends it back to Draft so it
// has to be submitted and approved again. Returns true if approval was cleared.
async function clearPeraApproval(peraId, changedBy, what) {
  const { rows } = await pool.query('SELECT status, version FROM pera_records WHERE id = $1', [peraId]);
  if (!rows.length || rows[0].status === 'Draft') return false;
  const previous = rows[0].status;
  await pool.query(
    `UPDATE pera_records SET status = 'Draft', approval_decision = NULL, approval_conditions = NULL, approval_required_level = NULL,
       approver = NULL, approver_role = NULL, approved_at = NULL, next_review_date = NULL, review_notes = NULL, updated_at = now()
     WHERE id = $1`,
    [peraId]
  );
  await pool.query(
    'INSERT INTO pera_change_log (pera_id, changed_by, action, version, summary, brief) VALUES ($1, $2, $3, $4, $5, $6)',
    [peraId, changedBy, 'Approval cleared', rows[0].version, `${what}. Status changed from ${previous} to Draft — the PERA needs to be submitted and approved again.`, 'Returned to Draft — needs re-approval']
  );
  return true;
}

app.post('/pera/:id/edit', async (req, res, next) => {
  try {
    let {
      activity_name, class_unit, location, risk_level,
      activity_process, materials_used, student_use, operating_conditions,
      supervision_level, supervisor_competency, max_operators,
      staff_training, student_training,
      consent_required, student_use_permitted, student_induction_required,
      competency_demonstration_required, safe_working_zone_required,
      submitted_by, edited_by,
    } = req.body;

    activity_name = normalizeText(activity_name);
    class_unit = normalizeText(class_unit);
    location = normalizeText(location);
    activity_process = normalizeText(activity_process);
    materials_used = normalizeText(materials_used);
    student_use = normalizeText(student_use);
    operating_conditions = normalizeText(operating_conditions);
    supervision_level = normalizeText(supervision_level);
    supervisor_competency = normalizeText(supervisor_competency);
    staff_training = normalizeText(staff_training);
    student_training = normalizeText(student_training);
    submitted_by = normalizeText(submitted_by);

    if (!activity_name || !RISK_LEVELS.includes(risk_level)) {
      return res.status(400).send('Activity name and a valid risk level are required.');
    }
    if (!edited_by || !edited_by.trim()) {
      return res.status(400).send('Your name is required to save an edit.');
    }

    const existingResult = await pool.query('SELECT * FROM pera_records WHERE id = $1', [req.params.id]);
    if (existingResult.rows.length === 0) {
      return res.status(404).send('PERA record not found.');
    }
    if (!canManageOwnRecord(req.staffUser, existingResult.rows[0])) {
      return res.status(403).send('You can only edit PERA records you created yourself. <a href="/pera">Back to PERA Records</a>');
    }
    const before = existingResult.rows[0];

    const newConsentRequired = consent_required === 'true';
    const newStudentUsePermitted = student_use_permitted === 'true';
    const newStudentInductionRequired = student_induction_required === 'true';
    const newCompetencyDemonstrationRequired = competency_demonstration_required === 'true';
    const newSafeWorkingZoneRequired = safe_working_zone_required === 'true';
    const maxOperatorsValue = max_operators !== undefined && max_operators !== '' ? parseInt(max_operators, 10) : null;
    const newMaxOperators = Number.isInteger(maxOperatorsValue) ? maxOperatorsValue : null;

    const fields = [
      ['activity_name', 'Activity name', activity_name],
      ['class_unit', 'Class / unit', class_unit || null],
      ['location', 'Location', location || null],
      ['risk_level', 'Risk level', risk_level],
      ['activity_process', 'Activity / process', activity_process || null],
      ['materials_used', 'Materials used', materials_used || null],
      ['student_use', 'Student use', student_use || null],
      ['operating_conditions', 'Operating conditions', operating_conditions || null],
      ['supervision_level', 'Supervision level', supervision_level || null],
      ['supervisor_competency', 'Required supervisor qualification / competency', supervisor_competency || null],
      ['staff_training', 'Staff training/competency', staff_training || null],
      ['student_training', 'Student training/competency', student_training || null],
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
    const boolFields = [
      ['consent_required', 'Parent consent required', before.consent_required, newConsentRequired],
      ['student_use_permitted', 'Student use permitted', before.student_use_permitted, newStudentUsePermitted],
      ['student_induction_required', 'Student induction required', before.student_induction_required, newStudentInductionRequired],
      ['competency_demonstration_required', 'Competency demonstration required', before.competency_demonstration_required, newCompetencyDemonstrationRequired],
      ['safe_working_zone_required', 'Safe working zone required', before.safe_working_zone_required, newSafeWorkingZoneRequired],
    ];
    for (const [, label, oldValue, newValue] of boolFields) {
      if (Boolean(oldValue) !== newValue) {
        changeLines.push(`${label}: ${oldValue ? 'Yes' : 'No'} → ${newValue ? 'Yes' : 'No'}`);
        changedLabels.push(label);
      }
    }
    if ((before.max_operators || null) !== newMaxOperators) {
      changeLines.push(`Maximum number of operators: ${before.max_operators != null ? before.max_operators : '(empty)'} → ${newMaxOperators != null ? newMaxOperators : '(empty)'}`);
      changedLabels.push('Maximum number of operators');
    }

    const descriptions = [].concat(req.body.hazard_description || []);
    const categories = [].concat(req.body.hazard_category || []);
    const hazardRiskLevels = [].concat(req.body.hazard_risk_level || []);
    const hazardControlMeasures = [].concat(req.body.hazard_control_measure || []);
    const controlTypes = [].concat(req.body.hazard_control_type || []);
    const mandatoryFlags = [].concat(req.body.hazard_mandatory || []);
    const appliesTos = [].concat(req.body.hazard_applies_to || []);

    // Compare every hazard column (not just the description) so a change to a
    // control measure, risk level, control type etc. is saved and recorded.
    const existingHazardsResult = await pool.query(
      'SELECT category, description, risk_level, control_measure, control_type, mandatory, applies_to FROM pera_hazards WHERE pera_id = $1 ORDER BY sort_order, id',
      [req.params.id]
    );
    const hazardKey = (h) => JSON.stringify([
      h.category || null, String(h.description || '').trim(), h.risk_level || null,
      (h.control_measure || '').trim() || null, h.control_type || null, Boolean(h.mandatory), (h.applies_to || '').trim() || null,
    ]);
    const afterHazards = [];
    for (let i = 0; i < descriptions.length; i++) {
      const description = normalizeText(descriptions[i] || '').trim();
      if (!description) continue;
      afterHazards.push({
        category: categories[i] || null, description, risk_level: hazardRiskLevels[i] || null,
        control_measure: normalizeText(hazardControlMeasures[i]) || null, control_type: controlTypes[i] || null,
        mandatory: mandatoryFlags[i] === 'Yes', applies_to: normalizeText(appliesTos[i]) || null,
      });
    }
    const beforeKeys = existingHazardsResult.rows.map(hazardKey);
    const afterKeys = afterHazards.map(hazardKey);
    if (JSON.stringify(beforeKeys) !== JSON.stringify(afterKeys)) {
      const beforeSet = new Set(beforeKeys);
      const afterSet = new Set(afterKeys);
      const added = afterHazards.filter((h, i) => !beforeSet.has(afterKeys[i]));
      const removed = existingHazardsResult.rows.filter((h, i) => !afterSet.has(beforeKeys[i]));
      const parts = [];
      if (removed.length) parts.push(`changed/removed: ${removed.map((h) => h.description).join('; ')}`);
      if (added.length) parts.push(`changed/added: ${added.map((h) => `${h.description}${h.control_measure ? ` → ${h.control_measure}` : ''}`).join('; ')}`);
      if (!parts.length) parts.push('order changed');
      changeLines.push(`Hazards (${existingHazardsResult.rows.length} → ${afterHazards.length} row(s)) — ${parts.join(' | ')}`);
      changedLabels.push('Hazards');
    }

    if (changeLines.length === 0) {
      return res.redirect(`/pera/${req.params.id}`);
    }

    const newVersion = before.version + 1;
    const resetApproval = before.status !== 'Draft';

    await pool.query(
      `UPDATE pera_records SET
         activity_name = $1, class_unit = $2, location = $3, risk_level = $4,
         activity_process = $5, materials_used = $6, student_use = $7, student_use_permitted = $8, operating_conditions = $9,
         supervision_level = $10, supervisor_competency = $11, max_operators = $12,
         student_induction_required = $13, competency_demonstration_required = $14, safe_working_zone_required = $15,
         staff_training = $16, student_training = $17,
         consent_required = $18, submitted_by = $19,
         version = $20,
         ${resetApproval ? `status = 'Draft', approval_decision = NULL, approval_conditions = NULL, approval_required_level = NULL, approver = NULL, approver_role = NULL, approved_at = NULL, next_review_date = NULL, review_notes = NULL,` : ''}
         updated_at = now()
       WHERE id = $21`,
      [
        activity_name, class_unit || null, location || null, risk_level,
        activity_process || null, materials_used || null, student_use || null, newStudentUsePermitted, operating_conditions || null,
        supervision_level || null, supervisor_competency || null, newMaxOperators,
        newStudentInductionRequired, newCompetencyDemonstrationRequired, newSafeWorkingZoneRequired,
        staff_training || null, student_training || null,
        newConsentRequired, submitted_by || null,
        newVersion,
        req.params.id,
      ]
    );

    await pool.query('DELETE FROM pera_hazards WHERE pera_id = $1', [req.params.id]);
    for (let i = 0; i < descriptions.length; i++) {
      const description = normalizeText(descriptions[i] || '').trim();
      if (!description) continue;
      await pool.query(
        `INSERT INTO pera_hazards (pera_id, category, description, risk_level, control_measure, control_type, mandatory, applies_to, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          req.params.id, categories[i] || null, description, hazardRiskLevels[i] || null,
          normalizeText(hazardControlMeasures[i]) || null, controlTypes[i] || null,
          mandatoryFlags[i] === 'Yes', normalizeText(appliesTos[i]) || null, i,
        ]
      );
    }

    const briefSummary = summarizeChangedLabels(changedLabels);
    await pool.query(
      'INSERT INTO pera_change_log (pera_id, changed_by, action, version, summary, brief) VALUES ($1, $2, $3, $4, $5, $6)',
      [req.params.id, edited_by.trim(), 'Edited', newVersion, changeLines.join('\n'), briefSummary]
    );

    res.redirect(`/pera/${req.params.id}${resetApproval ? '?reapproval=1' : ''}`);
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

    const [hazardsResult, requirementsResult, documentsResult, reviewsResult, changeLogResult] = await Promise.all([
      pool.query('SELECT * FROM pera_hazards WHERE pera_id = $1 ORDER BY sort_order, id', [req.params.id]),
      pool.query('SELECT * FROM pera_min_requirements WHERE pera_id = $1 ORDER BY sort_order, id', [req.params.id]),
      pool.query(
        `SELECT id, pera_id, title, url, notes, added_by, added_at, category, file_name, file_mime, file_size,
                (file_data IS NOT NULL) AS has_file, (thumbnail_data IS NOT NULL) AS has_thumbnail
         FROM pera_documents WHERE pera_id = $1 ORDER BY added_at DESC`,
        [req.params.id]
      ),
      pool.query('SELECT * FROM pera_annual_reviews WHERE pera_id = $1 ORDER BY reviewed_at DESC', [req.params.id]),
      pool.query('SELECT * FROM pera_change_log WHERE pera_id = $1 ORDER BY changed_at DESC', [req.params.id]),
    ]);

    // Archived records are read-only for everyone -- every edit control below
    // is already gated on canEdit, so this one line locks the whole page down.
    const canEdit = !r.archived && canManageOwnRecord(req.staffUser, r);
    const isAdmin = req.staffUser && req.staffUser.role === 'admin';

    const archivedBannerHtml = r.archived
      ? `<div class="note-box" style="margin-bottom:16px;">This PERA is archived and hidden from the main PERA list. It's read-only${isAdmin ? '' : ' — ask an admin to restore it if it needs changes'}.</div>`
      : '';

    let bannerHtml = '';
    if (r.risk_level === 'High' || r.risk_level === 'Extreme') {
      bannerHtml = r.status === 'Approved'
        ? `<div class="risk-banner risk-banner-ok">HIGH-RISK ACTIVITY — approval complete: ${escapeHtml(r.approval_decision || 'Approved')}${r.approver ? ` by ${escapeHtml(r.approver)}${r.approver_role ? ` (${escapeHtml(r.approver_role)})` : ''}` : ''}. Proceed only under the conditions recorded below.</div>`
        : `<div class="risk-banner risk-banner-warning">HIGH-RISK ACTIVITY — Principal/delegate approval required before student participation. This has not yet been approved.</div>`;
    }

    const summaryStripHtml = `
      <div class="summary-strip">
        <div class="summary-strip-item summary-strip-item-wide"><div class="detail-label">Plant / equipment</div><div class="detail-value">${escapeHtml(r.activity_name)}</div></div>
        <div class="summary-strip-item"><div class="detail-label">Risk</div><div class="detail-value"><span class="badge ${riskBadgeClass(r.risk_level)}">${escapeHtml(r.risk_level)}</span></div></div>
        <div class="summary-strip-item"><div class="detail-label">Status</div><div class="detail-value"><span class="badge ${statusBadgeClass(r.status)}">${escapeHtml(r.status)}</span></div></div>
        <div class="summary-strip-item"><div class="detail-label">Location</div><div class="detail-value">${escapeHtml(r.location || '—')}</div></div>
        <div class="summary-strip-item"><div class="detail-label">Class / unit</div><div class="detail-value">${escapeHtml(r.class_unit || '—')}</div></div>
        <div class="summary-strip-item"><div class="detail-label">Assessed</div><div class="detail-value">${formatDate(r.created_at)}</div></div>
        <div class="summary-strip-item"><div class="detail-label">Next review</div><div class="detail-value">${formatDate(r.next_review_date)}</div></div>
      </div>
    `;

    let hazardsSectionHtml;
    if (hazardsResult.rows.length) {
      hazardsSectionHtml = `
        <div class="card" style="overflow-x:auto;">
          <table class="hazards-table">
            <colgroup>
              <col style="width:20%;">
              <col style="width:9%;">
              <col style="width:7%;">
              <col style="width:35%;">
              <col style="width:12%;">
              <col style="width:8%;">
              <col style="width:9%;">
            </colgroup>
            <thead>
              <tr><th>Hazard</th><th>Category</th><th>Risk</th><th>Control measure</th><th>Type</th><th>Mandatory</th><th>Applies to</th></tr>
            </thead>
            <tbody>
              ${hazardsResult.rows.map((h) => `
                <tr>
                  <td>${escapeHtml(h.description)}</td>
                  <td>${escapeHtml(h.category || '—')}</td>
                  <td>${h.risk_level ? `<span class="badge ${riskBadgeClass(h.risk_level)}">${escapeHtml(h.risk_level)}</span>` : '—'}</td>
                  <td>${escapeHtml(h.control_measure || '—')}</td>
                  <td>${escapeHtml(h.control_type || '—')}</td>
                  <td>${h.mandatory ? 'Yes' : 'No'}</td>
                  <td>${escapeHtml(h.applies_to || '—')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    } else if (r.hazards || r.control_measures) {
      hazardsSectionHtml = `
        <div class="note-box" style="margin-bottom:12px;">Recorded before structured hazards existed — shown here as originally saved.</div>
        <div class="detail-section"><div class="detail-label">Hazards identified</div><div class="detail-value">${escapeHtml(r.hazards || '—')}</div></div>
        <div class="detail-section"><div class="detail-label">Control measures</div><div class="detail-value">${escapeHtml(r.control_measures || '—')}</div></div>
      `;
    } else {
      hazardsSectionHtml = `<div class="empty-state">No hazards recorded yet.</div>`;
    }

    const reqCounts = MIN_REQUIREMENT_STATUSES.reduce((acc, st) => {
      acc[st] = requirementsResult.rows.filter((item) => item.status === st).length;
      return acc;
    }, {});
    const requirementsHtml = requirementsResult.rows.length
      ? `
        <form method="post" action="/pera/${r.id}/requirements" class="min-req-form">
          <div class="min-req-summary">
            <strong>${reqCounts.Current || 0} of ${requirementsResult.rows.length - (reqCounts['Not applicable'] || 0)} current</strong>
            ${MIN_REQUIREMENT_STATUSES.filter((st) => st !== 'Current' && reqCounts[st]).map((st) => `<span class="badge ${minRequirementStatusBadgeClass(st)}">${reqCounts[st]} ${escapeHtml(st.toLowerCase())}</span>`).join(' ')}
          </div>
          <div class="min-req-list">
            ${requirementsResult.rows.map((item) => `
              <div class="min-req-item min-req-${escapeHtml(item.status.toLowerCase().replace(/\s+/g, '-'))}">
                <div class="min-req-main">
                  <div class="min-req-name">${escapeHtml(item.requirement)}${MIN_REQUIREMENT_HINTS[item.requirement] ? `<div class="min-req-hint">${escapeHtml(MIN_REQUIREMENT_HINTS[item.requirement])}</div>` : ''}</div>
                  <div class="min-req-pills" role="radiogroup" aria-label="${escapeHtml(item.requirement)} status">
                    ${MIN_REQUIREMENT_STATUSES.map((st) => `
                      <label class="min-req-pill min-req-pill-${escapeHtml(st.toLowerCase().replace(/\s+/g, '-'))}">
                        <input type="radio" name="status_${item.id}" value="${st}" ${item.status === st ? 'checked' : ''} ${canEdit ? '' : 'disabled'}>
                        <span>${escapeHtml(st)}</span>
                      </label>`).join('')}
                  </div>
                </div>
                ${canEdit
                  ? `<input class="min-req-notes" type="text" name="notes_${item.id}" value="${escapeHtml(item.notes || '')}" placeholder="Add a note (optional)" aria-label="Notes for ${escapeHtml(item.requirement)}">`
                  : (item.notes ? `<div class="min-req-notes-text">${escapeHtml(item.notes)}</div>` : '')}
              </div>
            `).join('')}
          </div>
          ${canEdit ? `<div class="form-actions min-req-actions"><button type="submit" class="btn btn-primary">Save checklist</button><span class="min-req-unsaved" hidden>Unsaved changes — click Save checklist</span>${r.status !== 'Draft' ? `<span class="min-req-hint" style="margin-left:12px;">Changing the checklist returns this PERA to Draft for re-approval.</span>` : ''}</div>` : ''}
        </form>
        ${canEdit ? `<script>
          (function () {
            var form = document.querySelector('.min-req-form');
            if (!form) return;
            var snap = function () { return new URLSearchParams(new FormData(form)).toString(); };
            var start = snap();
            var saving = false;
            var flag = form.querySelector('.min-req-unsaved');
            var actions = form.querySelector('.min-req-actions');
            var update = function () {
              var dirty = snap() !== start;
              flag.hidden = !dirty;
              actions.classList.toggle('is-dirty', dirty);
            };
            form.addEventListener('change', update);
            form.addEventListener('input', update);
            form.addEventListener('submit', function () { saving = true; });
            window.addEventListener('beforeunload', function (e) {
              if (!saving && snap() !== start) { e.preventDefault(); e.returnValue = ''; }
            });
          })();
        </script>` : ''}
      `
      : `<div class="empty-state">No checklist on this record.</div>`;

    const documentsHtml = `
      ${documentsResult.rows.length ? `
        <div style="display:flex;flex-wrap:wrap;gap:20px;margin-bottom:16px;">
          ${documentsResult.rows.map((d) => {
            const link = d.has_file ? `/pera/${r.id}/documents/${d.id}/file` : d.url;
            const sizeHint = d.has_file ? ` (${formatFileSize(d.file_size)})` : '';
            const previewHtml = d.has_thumbnail
              ? `<img src="/pera/${r.id}/documents/${d.id}/thumbnail" alt="" style="width:125px;max-width:100%;height:auto;display:block;border-radius:8px;border:1px solid #E3DFD3;">`
              : `<div style="width:125px;max-width:100%;height:125px;border-radius:8px;background:#F0EDE5;color:#6B6659;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;">${escapeHtml(documentFileExtLabel(d))}</div>`;
            return `
            <div class="card" style="padding:14px;width:125px;max-width:100%;">
              ${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener">${previewHtml}</a>` : previewHtml}
              <div style="margin-top:10px;"><span class="badge badge-draft">${escapeHtml(d.category || 'Other')}</span> ${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener">${escapeHtml(d.title)}</a>${sizeHint}` : escapeHtml(d.title)}${d.notes ? ` — ${escapeHtml(d.notes)}` : ''}</div>
              ${canEdit ? `
                <form method="post" action="/pera/${r.id}/documents/${d.id}/delete" onsubmit="return confirm('Remove this document?');" style="margin-top:8px;">
                  <button type="submit" class="btn btn-secondary" style="padding:4px 10px;font-size:13px;">Remove</button>
                </form>
              ` : ''}
            </div>
          `;
          }).join('')}
        </div>
      ` : `<div class="empty-state" style="margin-bottom:16px;">No related documents yet.</div>`}
      ${canEdit ? `
        <form class="form-card" method="post" action="/pera/${r.id}/documents" enctype="multipart/form-data" style="max-width:520px;">
          <div class="form-row">
            <label for="doc_category">Type</label>
            <select id="doc_category" name="category" required>
              ${DOCUMENT_CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('')}
            </select>
          </div>
          <div class="form-row"><label for="doc_file">Upload a file</label><input type="file" id="doc_file" name="file"></div>
          <div class="form-row"><label for="doc_url">Or a link instead</label><input type="text" id="doc_url" name="url" placeholder="https://..."></div>
          <div class="form-row"><label for="doc_title">Title</label><input type="text" id="doc_title" name="title" placeholder="e.g. Bench grinder manual (defaults to the file name if left blank)"></div>
          <div class="form-row"><label for="doc_notes">Notes (optional)</label><input type="text" id="doc_notes" name="notes"></div>
          <div class="form-section-hint">Upload a file (PDF, Word, Excel, PowerPoint, text, or an image) up to 20MB, or paste a link if it's kept somewhere else.</div>
          <div class="form-actions"><button type="submit" class="btn btn-secondary">Add document</button></div>
        </form>
      ` : ''}
    `;

    const reviewsHtml = `
      ${reviewsResult.rows.length ? `
        <div class="min-req-list" style="margin-bottom:16px;">
          ${reviewsResult.rows.map((rv) => `
            <div class="min-req-item">
              <div>
                <strong>${formatDate(rv.reviewed_at)}</strong> — ${escapeHtml(rv.outcome || '—')} by ${escapeHtml(rv.reviewed_by || 'unknown')}${rv.reviewer_designation ? ` (${escapeHtml(rv.reviewer_designation)})` : ''}
                <br><span style="color:#6B6659;font-size:13px;">Risk unchanged: ${rv.risk_unchanged === null ? '—' : rv.risk_unchanged ? 'Yes' : 'No'} · Controls unchanged: ${rv.controls_unchanged === null ? '—' : rv.controls_unchanged ? 'Yes' : 'No'} · Staffing/competency unchanged: ${rv.staffing_unchanged === null ? '—' : rv.staffing_unchanged ? 'Yes' : 'No'}</span>
                ${rv.notes ? `<br>${escapeHtml(rv.notes)}` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      ` : `<div class="empty-state" style="margin-bottom:16px;">No annual reviews recorded yet.</div>`}
      ${canEdit ? `
        <form class="form-card" method="post" action="/pera/${r.id}/reviews" style="max-width:520px;">
          <div class="form-row checkbox-row">
            <input type="checkbox" id="risk_unchanged" name="risk_unchanged" value="true" checked>
            <label for="risk_unchanged">Risk levels unchanged</label>
          </div>
          <div class="form-row checkbox-row">
            <input type="checkbox" id="controls_unchanged" name="controls_unchanged" value="true" checked>
            <label for="controls_unchanged">Controls unchanged</label>
          </div>
          <div class="form-row checkbox-row">
            <input type="checkbox" id="staffing_unchanged" name="staffing_unchanged" value="true" checked>
            <label for="staffing_unchanged">Staffing/competency arrangements unchanged</label>
          </div>
          <div class="form-row"><label for="review_notes_field">Review comments</label><textarea id="review_notes_field" name="notes"></textarea></div>
          <div class="form-row"><label for="reviewer_designation">Your designation</label><input type="text" id="reviewer_designation" name="reviewer_designation" placeholder="e.g. WHS Officer, HOD"></div>
          <div class="form-row"><label for="next_review_date">Next review date</label><input type="date" id="next_review_date" name="next_review_date"></div>
          <div class="form-actions"><button type="submit" class="btn btn-secondary">Record review</button></div>
        </form>
      ` : ''}
    `;

    const changeLogByYear = groupChangeLogByYear(changeLogResult.rows);
    const changeLogHtml = changeLogByYear.length
      ? changeLogByYear.map(([year, entries], idx) => `
          <details class="change-log-year"${idx === 0 ? ' open' : ''}>
            <summary class="change-log-year-summary">${year} <span class="tool-picker-group-count">(${entries.length})</span></summary>
            <div class="change-log">
              ${entries.map((c) => `
                <details class="change-log-entry">
                  <summary class="change-log-summary">
                    <span class="change-log-datetime">${formatDateTime(c.changed_at)} — ${escapeHtml(c.changed_by || 'Unknown')}</span>
                    <span class="change-log-brief">${escapeHtml(c.action || 'Edited')}${c.version ? ` (v${c.version})` : ''} — ${escapeHtml(c.brief || '')}</span>
                  </summary>
                  <div class="change-log-detail">${escapeHtml(c.summary)}</div>
                </details>
              `).join('')}
            </div>
          </details>
        `).join('')
      : `<div class="empty-state">No history recorded yet.</div>`;

    let actionsHtml = '';
    if (!r.archived && r.status === 'Draft') {
      actionsHtml = `
        <form method="post" action="/pera/${r.id}/submit">
          <button type="submit" class="btn btn-primary" style="width:100%;">Submit for approval</button>
        </form>
      `;
    } else if (!r.archived && (r.status === 'Pending approval' || r.status === 'Changes requested')) {
      const decisionOptions = APPROVAL_DECISIONS.map((d) => `<option value="${d}">${d}</option>`).join('');
      const requiredLevelOptions = APPROVAL_REQUIRED_LEVELS.map((lvl) => `<option value="${lvl}" ${r.approval_required_level === lvl ? 'selected' : ''}>${lvl}</option>`).join('');
      actionsHtml = `
        <form method="post" action="/pera/${r.id}/approve">
          <div class="form-row">
            <label for="decision">Decision</label>
            <select id="decision" name="decision" required onchange="document.getElementById('conditions-field').style.display = this.value === 'Approved with conditions' ? '' : 'none';">${decisionOptions}</select>
          </div>
          <div class="form-row" id="conditions-field" style="display:none;">
            <label for="approval_conditions">Conditions</label>
            <textarea id="approval_conditions" name="approval_conditions" placeholder="What conditions must be met?"></textarea>
          </div>
          <div class="form-row">
            <label for="approver">Approver name</label>
            <input type="text" id="approver" name="approver" placeholder="Name of approver" value="${escapeHtml(req.staffUser.name)}" required>
          </div>
          <div class="form-row">
            <label for="approver_role">Approver role</label>
            <input type="text" id="approver_role" name="approver_role" placeholder="e.g. WHS Officer, Principal, HOD">
          </div>
          <div class="form-row">
            <label for="approval_required_level">Approval requirement</label>
            <select id="approval_required_level" name="approval_required_level">
              <option value="">— Not set —</option>
              ${requiredLevelOptions}
            </select>
          </div>
          <div class="form-row">
            <label for="review_notes">Notes (required if not approved)</label>
            <textarea id="review_notes" name="review_notes" placeholder="What needs to change?"></textarea>
          </div>
          <button type="submit" class="btn btn-primary" style="width:100%;">Save decision</button>
        </form>
      `;
    } else if (r.status === 'Approved') {
      actionsHtml = `
        <div class="detail-section">
          <div class="detail-label">Decision</div>
          <div class="detail-value"><span class="badge ${approvalDecisionBadgeClass(r.approval_decision)}">${escapeHtml(r.approval_decision || 'Approved')}</span></div>
        </div>
        ${r.approval_conditions ? `<div class="detail-section"><div class="detail-label">Conditions</div><div class="detail-value">${escapeHtml(r.approval_conditions)}</div></div>` : ''}
        <div class="detail-section">
          <div class="detail-label">Approved by</div>
          <div class="detail-value">${escapeHtml(r.approver || '—')}${r.approver_role ? ` (${escapeHtml(r.approver_role)})` : ''} on ${formatDate(r.approved_at)}</div>
        </div>
        ${r.approval_required_level ? `<div class="detail-section"><div class="detail-label">Approval requirement</div><div class="detail-value">${escapeHtml(r.approval_required_level)}</div></div>` : ''}
        <div class="detail-section">
          <div class="detail-label">Next review due</div>
          <div class="detail-value">${formatDate(r.next_review_date)}</div>
        </div>
      `;
    }

    const body = `
      <a class="back-link" href="/pera">← Back to PERA Records</a>
      ${req.query.reapproval === '1' && r.status === 'Draft' ? `<div class="note-box reapproval-note" role="status"><strong>Saved — this PERA is back to Draft.</strong> Because it was changed, its approval was cleared. Submit it for approval again when you're ready.</div>` : ''}
      <div class="page-header">
        <div>
          <span class="badge ${riskBadgeClass(r.risk_level)}">${escapeHtml(r.risk_level)} risk</span>
          <h1 class="page-title" style="margin-top:10px;">${escapeHtml(r.activity_name)}</h1>
          <p class="page-subtitle">Submitted by ${escapeHtml(r.submitted_by || 'unknown')}</p>
        </div>
        <div style="display:flex;gap:10px;align-items:flex-start;">
          <span class="badge ${statusBadgeClass(r.status)}">${escapeHtml(r.status)}</span>
          ${canEdit ? `<a class="btn btn-secondary" href="/pera/${r.id}/edit">Edit</a>` : ''}
          ${r.archived && isAdmin ? `
            <form method="post" action="/admin/pera/restore" style="display:inline;">
              <input type="hidden" name="ids" value="${r.id}">
              <input type="hidden" name="redirect_to" value="/pera/${r.id}">
              <button type="submit" class="btn btn-secondary">Restore</button>
            </form>
          ` : ''}
        </div>
      </div>
      ${archivedBannerHtml}
      ${bannerHtml}
      ${summaryStripHtml}
      <div class="detail-grid">
        <div>
          <details class="content-section" open>
            <summary class="form-section-title" style="margin-top:0;padding-top:0;border-top:none;cursor:pointer;">Activity / process</summary>
            <div class="detail-section"><div class="detail-label">Activity / process</div><div class="detail-value">${escapeHtml(r.activity_process || '—')}</div></div>
            <div class="detail-section"><div class="detail-label">Materials used</div><div class="detail-value">${escapeHtml(r.materials_used || '—')}</div></div>
            <div class="detail-section"><div class="detail-label">Student use</div><div class="detail-value">${escapeHtml(r.student_use || '—')}</div></div>
            <div class="detail-section"><div class="detail-label">Student use permitted</div><div class="detail-value">${r.student_use_permitted === null || r.student_use_permitted === undefined ? '—' : (r.student_use_permitted ? 'Yes' : 'No')}</div></div>
            <div class="detail-section"><div class="detail-label">Operating conditions</div><div class="detail-value">${escapeHtml(r.operating_conditions || '—')}</div></div>
            <div class="detail-section"><div class="detail-label">Parent consent required</div><div class="detail-value">${r.consent_required ? 'Yes' : 'No'}</div></div>
          </details>

          <details class="content-section" open>
            <summary class="form-section-title" style="cursor:pointer;">Hazards and control measures</summary>
            ${hazardsSectionHtml}
          </details>

          <details class="content-section" open>
            <summary class="form-section-title" style="cursor:pointer;">Minimum Safety Requirements</summary>
            ${requirementsHtml}
          </details>

          <details class="content-section">
            <summary class="form-section-title" style="cursor:pointer;">Supervision &amp; student use</summary>
            ${(r.supervision_level || r.supervisor_competency || r.max_operators != null || r.student_induction_required !== null || r.competency_demonstration_required !== null || r.safe_working_zone_required !== null) ? `
            <div class="detail-section"><div class="detail-label">Supervision level</div><div class="detail-value">${escapeHtml(r.supervision_level || '—')}</div></div>
            <div class="detail-section"><div class="detail-label">Required supervisor qualification / competency</div><div class="detail-value">${escapeHtml(r.supervisor_competency || '—')}</div></div>
            <div class="detail-section"><div class="detail-label">Maximum number of operators</div><div class="detail-value">${r.max_operators != null ? escapeHtml(String(r.max_operators)) : '—'}</div></div>
            <div class="detail-section"><div class="detail-label">Student induction required</div><div class="detail-value">${r.student_induction_required === null || r.student_induction_required === undefined ? '—' : (r.student_induction_required ? 'Yes' : 'No')}</div></div>
            <div class="detail-section"><div class="detail-label">Competency demonstration required</div><div class="detail-value">${r.competency_demonstration_required === null || r.competency_demonstration_required === undefined ? '—' : (r.competency_demonstration_required ? 'Yes' : 'No')}</div></div>
            <div class="detail-section"><div class="detail-label">Safe working zone required</div><div class="detail-value">${r.safe_working_zone_required === null || r.safe_working_zone_required === undefined ? '—' : (r.safe_working_zone_required ? 'Yes' : 'No')}</div></div>
            ` : `<div class="detail-section"><div class="detail-label">Supervision required (legacy)</div><div class="detail-value">${escapeHtml(r.supervision_details || r.required_supervision || '—')}</div></div>`}
          </details>

          <details class="content-section">
            <summary class="form-section-title" style="cursor:pointer;">Training &amp; competency</summary>
            ${(r.staff_training || r.student_training) ? `
            <div class="detail-section"><div class="detail-label">Staff training required</div><div class="detail-value">${escapeHtml(r.staff_training || '—')}</div></div>
            <div class="detail-section"><div class="detail-label">Student training required</div><div class="detail-value">${escapeHtml(r.student_training || '—')}</div></div>
            ` : `<div class="detail-section"><div class="detail-label">Training / competency required (legacy)</div><div class="detail-value">${escapeHtml(r.training_competency || '—')}</div></div>`}
          </details>

          ${r.review_notes ? `
          <div class="detail-section">
            <div class="detail-label">Last review notes</div>
            <div class="detail-value">${escapeHtml(r.review_notes)}</div>
          </div>` : ''}

          <details class="content-section">
            <summary class="form-section-title" style="cursor:pointer;">Related documents</summary>
            ${documentsHtml}
          </details>

          <details class="content-section">
            <summary class="form-section-title" style="cursor:pointer;">Annual review history</summary>
            ${reviewsHtml}
          </details>

          <details class="content-section">
            <summary class="form-section-title" style="cursor:pointer;">Change history</summary>
            ${changeLogHtml}
          </details>
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
    const existingResult = await pool.query('SELECT version FROM pera_records WHERE id = $1', [req.params.id]);
    await pool.query(
      "UPDATE pera_records SET status = 'Pending approval', updated_at = now() WHERE id = $1",
      [req.params.id]
    );
    if (existingResult.rows.length) {
      await pool.query(
        `INSERT INTO pera_change_log (pera_id, changed_by, action, version, summary, brief) VALUES ($1,$2,'Submitted',$3,'Submitted for approval','Submitted for approval')`,
        [req.params.id, req.staffUser ? req.staffUser.name : null, existingResult.rows[0].version]
      );
    }
    res.redirect(`/pera/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});


// Approval forms can be submitted from the record page or from the admin
// approvals queue; only ever redirect back to one of those two places.
function approvalRedirect(req, fallback) {
  return req.body && req.body.redirect_to === '/admin/approvals' ? '/admin/approvals' : fallback;
}

app.post('/pera/:id/approve', requireRole('admin', 'approver'), async (req, res, next) => {
  try {
    const { decision, approval_conditions, approver, approver_role, review_notes, approval_required_level } = req.body;
    const existingResult = await pool.query('SELECT * FROM pera_records WHERE id = $1', [req.params.id]);
    if (existingResult.rows.length === 0) {
      return res.status(404).send('PERA record not found.');
    }
    const before = existingResult.rows[0];
    if (before.archived || !['Pending approval', 'Changes requested'].includes(before.status)) {
      return res.status(400).send(`This PERA is "${escapeHtml(before.status)}" and isn't waiting for a decision. <a href="/pera/${before.id}">Back</a>`);
    }
    const requiredLevel = APPROVAL_REQUIRED_LEVELS.includes(approval_required_level) ? approval_required_level : null;
    const approverName = normalizeText(approver) || req.staffUser.name;
    const loggedBy = approverName === req.staffUser.name ? approverName : `${approverName} (recorded by ${req.staffUser.name})`;

    if (decision === 'Not approved' && !normalizeText(review_notes || '').trim()) {
      return res.status(400).send('Add a note saying what needs to change before marking this Not approved. <a href="javascript:history.back()">Back</a>');
    }
    if (decision === 'Not approved') {
      await pool.query(
        `UPDATE pera_records
         SET status = 'Changes requested', approval_decision = $1, approval_conditions = NULL,
             review_notes = $2, approval_required_level = COALESCE($3, approval_required_level), updated_at = now()
         WHERE id = $4`,
        ['Not approved', normalizeText(review_notes) || null, requiredLevel, req.params.id]
      );
      await pool.query(
        `INSERT INTO pera_change_log (pera_id, changed_by, action, version, summary, brief) VALUES ($1,$2,'Not approved',$3,$4,'Not approved')`,
        [req.params.id, loggedBy, before.version, review_notes ? `Not approved: ${normalizeText(review_notes)}` : 'Not approved']
      );
    } else if (APPROVAL_DECISIONS.includes(decision)) {
      await pool.query(
        `UPDATE pera_records
         SET status = 'Approved', approval_decision = $1, approval_conditions = $2,
             approver = $3, approver_role = $4, approved_at = now(),
             approval_required_level = COALESCE($5, approval_required_level),
             next_review_date = (now() + interval '1 year')::date, review_notes = NULL, updated_at = now()
         WHERE id = $6`,
        [
          decision, decision === 'Approved with conditions' ? (normalizeText(approval_conditions) || null) : null,
          approverName, normalizeText(approver_role) || null, requiredLevel, req.params.id,
        ]
      );
      const summary = decision === 'Approved with conditions'
        ? `Approved with conditions: ${normalizeText(approval_conditions) || '(none stated)'}`
        : decision;
      await pool.query(
        `INSERT INTO pera_change_log (pera_id, changed_by, action, version, summary, brief) VALUES ($1,$2,'Approved',$3,$4,$5)`,
        [req.params.id, loggedBy, before.version, summary, decision]
      );
    } else {
      return res.status(400).send('A valid decision is required. <a href="/pera/' + req.params.id + '">Back</a>');
    }

    res.redirect(approvalRedirect(req, `/pera/${req.params.id}`));
  } catch (err) {
    next(err);
  }
});

app.post('/pera/:id/reject', requireRole('admin', 'approver'), async (req, res, next) => {
  try {
    const { review_notes } = req.body;
    const existingResult = await pool.query('SELECT version FROM pera_records WHERE id = $1', [req.params.id]);
    await pool.query(
      `UPDATE pera_records
       SET status = 'Changes requested', approval_decision = 'Not approved', approval_conditions = NULL, review_notes = $1, updated_at = now()
       WHERE id = $2`,
      [review_notes || null, req.params.id]
    );
    if (existingResult.rows.length) {
      await pool.query(
        `INSERT INTO pera_change_log (pera_id, changed_by, action, version, summary, brief) VALUES ($1,$2,'Not approved',$3,$4,'Not approved')`,
        [req.params.id, req.staffUser.name, existingResult.rows[0].version, review_notes ? `Not approved: ${normalizeText(review_notes)}` : 'Not approved']
      );
    }
    res.redirect(`/pera/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// ---------- PERA: Minimum Safety Requirements checklist ----------

app.post('/pera/:id/requirements', async (req, res, next) => {
  try {
    const recordResult = await pool.query('SELECT * FROM pera_records WHERE id = $1', [req.params.id]);
    if (recordResult.rows.length === 0) {
      return res.status(404).send('PERA record not found.');
    }
    if (!canManageOwnRecord(req.staffUser, recordResult.rows[0])) {
      return res.status(403).send('You can only update the checklist on PERA records you created yourself. <a href="/pera/' + req.params.id + '">Back</a>');
    }
    const itemsResult = await pool.query('SELECT id, requirement, status, notes FROM pera_min_requirements WHERE pera_id = $1', [req.params.id]);
    const changes = [];
    for (const item of itemsResult.rows) {
      const rawStatus = req.body[`status_${item.id}`];
      const status = MIN_REQUIREMENT_STATUSES.includes(rawStatus) ? rawStatus : 'Required';
      const notes = normalizeText(req.body[`notes_${item.id}`]) || null;
      if (status === item.status && (notes || '') === (item.notes || '')) continue;
      changes.push(`${item.requirement}: ${item.status}${item.status !== status ? ` → ${status}` : ''}${(notes || '') !== (item.notes || '') ? ' (notes changed)' : ''}`);
      await pool.query(
        'UPDATE pera_min_requirements SET status = $1, met = $2, notes = $3 WHERE id = $4',
        [status, status === 'Current', notes, item.id]
      );
    }
    let cleared = false;
    if (changes.length) {
      const record = recordResult.rows[0];
      await pool.query(
        'INSERT INTO pera_change_log (pera_id, changed_by, action, version, summary, brief) VALUES ($1, $2, $3, $4, $5, $6)',
        [req.params.id, req.staffUser.name, 'Edited', record.version, `Minimum safety requirements:\n${changes.join('\n')}`, 'Minimum safety requirements updated']
      );
      cleared = await clearPeraApproval(req.params.id, req.staffUser.name, 'Minimum safety requirements were changed');
    }
    res.redirect(`/pera/${req.params.id}${cleared ? '?reapproval=1' : ''}`);
  } catch (err) {
    next(err);
  }
});

// ---------- PERA: related documents ----------

app.post('/pera/:id/documents', (req, res, next) => {
  documentUpload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).send('That file is too large -- the limit is 20MB. <a href="/pera/' + req.params.id + '">Back</a>');
    }
    if (err) {
      return res.status(400).send('That file type isn\'t supported. Allowed: PDF, Word, Excel, PowerPoint, a plain text file, or an image (JPG/PNG/GIF/WEBP). <a href="/pera/' + req.params.id + '">Back</a>');
    }
    next();
  });
}, async (req, res, next) => {
  try {
    const recordResult = await pool.query('SELECT * FROM pera_records WHERE id = $1', [req.params.id]);
    if (recordResult.rows.length === 0) {
      return res.status(404).send('PERA record not found.');
    }
    if (!canManageOwnRecord(req.staffUser, recordResult.rows[0])) {
      return res.status(403).send('You can only add documents to PERA records you created yourself. <a href="/pera/' + req.params.id + '">Back</a>');
    }
    const normalizedTitle = normalizeText(req.body.title || '').trim()
      || (req.file ? normalizeText(req.file.originalname) : '');
    if (!normalizedTitle) {
      return res.status(400).send('A title is required. <a href="/pera/' + req.params.id + '">Back</a>');
    }
    if (!req.file && !normalizeText(req.body.url)) {
      return res.status(400).send('Upload a file or provide a link. <a href="/pera/' + req.params.id + '">Back</a>');
    }
    const category = DOCUMENT_CATEGORIES.includes(req.body.category) ? req.body.category : 'Other';
    const thumbnailData = req.file ? await generateDocumentThumbnail(req.file.buffer, req.file.mimetype) : null;
    await pool.query(
      `INSERT INTO pera_documents (pera_id, title, url, notes, added_by, category, file_data, file_name, file_mime, file_size, thumbnail_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        req.params.id, normalizedTitle, normalizeText(req.body.url) || null, normalizeText(req.body.notes) || null, req.staffUser.name, category,
        req.file ? req.file.buffer : null,
        req.file ? req.file.originalname : null,
        req.file ? req.file.mimetype : null,
        req.file ? req.file.size : null,
        thumbnailData,
      ]
    );
    // A new SOP changes what staff are inducted on, so it needs re-approval.
    const cleared = category === 'SOP'
      ? await clearPeraApproval(req.params.id, req.staffUser.name, `SOP "${normalizedTitle}" was added`)
      : false;
    res.redirect(`/pera/${req.params.id}${cleared ? '?reapproval=1' : ''}`);
  } catch (err) {
    next(err);
  }
});

app.get('/pera/:id/documents/:docId/file', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT file_data, file_name, file_mime FROM pera_documents WHERE id = $1 AND pera_id = $2',
      [req.params.docId, req.params.id]
    );
    if (result.rows.length === 0 || !result.rows[0].file_data) {
      return res.status(404).send('File not found.');
    }
    const { file_data, file_name, file_mime } = result.rows[0];
    res.setHeader('Content-Type', file_mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${(file_name || 'document').replace(/"/g, '')}"`);
    res.send(file_data);
  } catch (err) {
    next(err);
  }
});

app.get('/pera/:id/documents/:docId/thumbnail', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT thumbnail_data FROM pera_documents WHERE id = $1 AND pera_id = $2',
      [req.params.docId, req.params.id]
    );
    if (result.rows.length === 0 || !result.rows[0].thumbnail_data) {
      return res.status(404).send('No thumbnail.');
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(result.rows[0].thumbnail_data);
  } catch (err) {
    next(err);
  }
});

app.post('/pera/:id/documents/:docId/delete', async (req, res, next) => {
  try {
    const recordResult = await pool.query('SELECT * FROM pera_records WHERE id = $1', [req.params.id]);
    if (recordResult.rows.length === 0) {
      return res.status(404).send('PERA record not found.');
    }
    if (!canManageOwnRecord(req.staffUser, recordResult.rows[0])) {
      return res.status(403).send('You can only remove documents from PERA records you created yourself. <a href="/pera/' + req.params.id + '">Back</a>');
    }
    const doc = (await pool.query('SELECT title, category FROM pera_documents WHERE id = $1 AND pera_id = $2', [req.params.docId, req.params.id])).rows[0];
    await pool.query('DELETE FROM pera_documents WHERE id = $1 AND pera_id = $2', [req.params.docId, req.params.id]);
    // Removing the SOP changes what staff are inducted on, so it needs re-approval.
    const cleared = doc && doc.category === 'SOP'
      ? await clearPeraApproval(req.params.id, req.staffUser.name, `SOP "${doc.title}" was removed`)
      : false;
    res.redirect(`/pera/${req.params.id}${cleared ? '?reapproval=1' : ''}`);
  } catch (err) {
    next(err);
  }
});

// ---------- PERA: annual review history ----------

app.post('/pera/:id/reviews', async (req, res, next) => {
  try {
    const recordResult = await pool.query('SELECT * FROM pera_records WHERE id = $1', [req.params.id]);
    if (recordResult.rows.length === 0) {
      return res.status(404).send('PERA record not found.');
    }
    if (!canManageOwnRecord(req.staffUser, recordResult.rows[0])) {
      return res.status(403).send('You can only record reviews on PERA records you created yourself. <a href="/pera/' + req.params.id + '">Back</a>');
    }
    const { notes, next_review_date, reviewer_designation } = req.body;
    const riskUnchanged = req.body.risk_unchanged === 'on' || req.body.risk_unchanged === 'true';
    const controlsUnchanged = req.body.controls_unchanged === 'on' || req.body.controls_unchanged === 'true';
    const staffingUnchanged = req.body.staffing_unchanged === 'on' || req.body.staffing_unchanged === 'true';
    const outcome = (riskUnchanged && controlsUnchanged && staffingUnchanged) ? 'Still current' : 'Updated';
    await pool.query(
      `INSERT INTO pera_annual_reviews
        (pera_id, reviewed_by, outcome, notes, next_review_date, risk_unchanged, controls_unchanged, staffing_unchanged, reviewer_designation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        req.params.id, req.staffUser.name, outcome, normalizeText(notes) || null, next_review_date || null,
        riskUnchanged, controlsUnchanged, staffingUnchanged, normalizeText(reviewer_designation) || null
      ]
    );
    if (next_review_date) {
      await pool.query('UPDATE pera_records SET next_review_date = $1, updated_at = now() WHERE id = $2', [next_review_date, req.params.id]);
    }
    await pool.query(
      `INSERT INTO pera_change_log (pera_id, changed_by, action, version, summary, brief) VALUES ($1,$2,'Reviewed',$3,$4,'Annual review recorded')`,
      [req.params.id, req.staffUser.name, recordResult.rows[0].version, `Annual review — outcome: ${outcome}${notes ? `; ${normalizeText(notes)}` : ''}`]
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
    const canDelete = Boolean(req.staffUser && req.staffUser.isSystemAdmin);
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
          ${canDelete ? `<td class="row-action" onclick="event.stopPropagation()">
            <form method="post" action="/cara/${r.id}/delete" onsubmit="return confirm(${escapeHtml(JSON.stringify(`Permanently delete the CARA "${r.activity_name}"?\n\nThis removes the record, its PERA links, signature and change history. It cannot be undone.`))});">
              ${showArchived ? '<input type="hidden" name="return" value="archived">' : ''}
              <button type="submit" class="btn-delete" aria-label="Delete ${escapeHtml(r.activity_name)}">Delete</button>
            </form>
          </td>` : ''}
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
              ${canDelete ? '<th><span class="visually-hidden">Delete</span></th>' : ''}
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

const caraAi = require('./cara-ai')({ app, pool, escapeHtml, canManageOwnRecord });

// Linked PERAs that aren't approved (or are archived). A CARA can list these
// while it's being drafted, but can't be submitted or approved until they are.
async function unapprovedCaraPeras(caraId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.activity_name, p.status, p.archived
     FROM cara_tool_links l JOIN pera_records p ON p.id = l.pera_id
     WHERE l.cara_id = $1 AND (p.status <> 'Approved' OR p.archived = true)
     ORDER BY p.activity_name`,
    [caraId]
  );
  return rows;
}

function peraPickerFlag(t) {
  if (t.archived) return '<span class="badge badge-draft tool-picker-flag">Archived</span>';
  if (t.status !== 'Approved') return '<span class="badge badge-pending tool-picker-flag">Not yet approved</span>';
  return '';
}

app.get('/cara/new', async (req, res, next) => {
  try {
    const toolsResult = await pool.query(
      `SELECT id, activity_name, class_unit, risk_level, status, archived FROM pera_records
       WHERE archived = false
       ORDER BY class_unit NULLS LAST, activity_name`
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
                ${peraPickerFlag(t)}
                <span class="badge ${riskBadgeClass(t.risk_level)}">${escapeHtml(t.risk_level)}</span>
              </div>
            `).join('')}
          </div>
        </details>
      `;
    }
    if (!toolsResult.rows.length) {
      toolListHtml = '<div class="tool-picker-item">No PERA records yet.</div>';
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
        <p class="form-section-hint">Search or open a group to select the equipment this activity uses. PERAs marked <strong>Not yet approved</strong> can be added now, but the CARA can't be submitted for approval until they're approved. If something isn't listed, ask your WHS Coordinator to add a PERA for it.</p>
        <div class="tool-picker">
          <div class="tool-picker-search">
            <input type="text" id="tool_search" placeholder="Search tools..." oninput="filterTools(this.value)">
          </div>
          <div class="tool-picker-list" id="tool_picker_list">
            ${toolListHtml}
          </div>
        </div>
        ${caraAi.draftPanelHtml()}

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
         submitted_by, created_by_staff_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING id`,
      [
        normalizeText(activity_name), normalizeText(class_unit) || null, normalizeText(activity_scope) || null, risk_level,
        normalizeText(students_notes) || null, normalizeText(emergency_first_aid) || null, normalizeText(induction_instruction) || null, consent_required === 'true',
        normalizeText(supervision_notes) || null, normalizeText(supervisor_qualification) || null, normalizeText(facilities_equipment) || null,
        normalizeText(environmental_hazards) || null, normalizeText(environmental_controls) || null,
        normalizeText(facilities_hazards) || null, normalizeText(facilities_controls) || null,
        normalizeText(student_hazards) || null, normalizeText(student_controls) || null,
        normalizeText(submitted_by) || null, req.staffUser.id,
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
    if (!canManageOwnRecord(req.staffUser, r)) {
      return res.status(403).send('You can only edit CARA records you created yourself. <a href="/cara">Back to CARA list</a>');
    }

    const linkedResult = await pool.query('SELECT pera_id FROM cara_tool_links WHERE cara_id = $1', [req.params.id]);
    const linkedIds = new Set(linkedResult.rows.map((row) => String(row.pera_id)));

    const toolsResult = await pool.query(
      `SELECT DISTINCT pr.id, pr.activity_name, pr.class_unit, pr.risk_level, pr.status, pr.archived FROM pera_records pr
       WHERE pr.archived = false
          OR pr.id IN (SELECT pera_id FROM cara_tool_links WHERE cara_id = $1)
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
                ${peraPickerFlag(t)}
                <span class="badge ${riskBadgeClass(t.risk_level)}">${escapeHtml(t.risk_level)}</span>
              </div>
            `).join('')}
          </div>
        </details>
      `;
    }
    if (!toolsResult.rows.length) {
      toolListHtml = '<div class="tool-picker-item">No PERA records yet.</div>';
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
        <p class="form-section-hint">Search or open a group to select the equipment this activity uses. PERAs marked <strong>Not yet approved</strong> can be added now, but the CARA can't be submitted for approval until they're approved. If something isn't listed, ask your WHS Coordinator to add a PERA for it.</p>
        <div class="tool-picker">
          <div class="tool-picker-search">
            <input type="text" id="tool_search" placeholder="Search tools..." oninput="filterTools(this.value)">
          </div>
          <div class="tool-picker-list" id="tool_picker_list">
            ${toolListHtml}
          </div>
        </div>
        ${caraAi.draftPanelHtml()}

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
    if (!canManageOwnRecord(req.staffUser, existingResult.rows[0])) {
      return res.status(403).send('You can only edit CARA records you created yourself. <a href="/cara">Back to CARA list</a>');
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
      `SELECT ra.id, ra.activity_name, ra.risk_level, ra.status, ra.archived
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
            ${peraPickerFlag(t)}
          </a>
        `).join('')}</div>`
      : `<div class="detail-value">No PERA linked.</div>`;

    const checkPanel = r.archived ? '' : await caraAi.checkPanelHtml(r, req.staffUser, req.query);
    const unapprovedPeras = toolsResult.rows.filter((t) => t.archived || t.status !== 'Approved');
    const unapprovedNotice = unapprovedPeras.length
      ? `<div class="alert alert-warning cara-unapproved">
          <strong>Can't submit yet.</strong> ${unapprovedPeras.length === 1 ? 'This PERA needs' : 'These PERAs need'} to be approved first:
          <ul>${unapprovedPeras.map((t) => `<li><a href="/pera/${t.id}">${escapeHtml(t.activity_name)}</a> (${escapeHtml(t.archived ? 'Archived' : t.status)})</li>`).join('')}</ul>
        </div>`
      : '';

    let actionsHtml = '';
    if (r.status === 'Draft' && unapprovedPeras.length) {
      actionsHtml = unapprovedNotice + checkPanel;
    } else if (r.status === 'Draft') {
      actionsHtml = `
        ${checkPanel}
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
        ${unapprovedNotice.replace("Can't submit yet.", "Can't approve yet.")}
        ${checkPanel}
        <form method="post" action="/cara/${r.id}/approve" style="margin-bottom:10px;">
          <div class="form-row">
            <label for="approver">Approved by</label>
            <input type="text" id="approver" name="approver" placeholder="Principal / school leader name" value="${escapeHtml(req.staffUser.name)}" required>
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

    // ?preview=html shows the print layout in the browser (handy for tweaking
    // the design in cara-pdf.js without downloading a PDF each time).
    if (req.query.preview === 'html') {
      return res.send(renderCaraHtml(r, toolsResult.rows, { brand: BRAND }));
    }

    // Preferred: HTML layout rendered by headless Chromium. If Chromium isn't
    // available, fall through to the older PDFKit export below.
    try {
      const pdf = await renderCaraPdf(r, toolsResult.rows, { brand: BRAND });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="CARA - ${safeName}.pdf"`);
      return res.end(pdf);
    } catch (e) {
      console.warn('CARA HTML->PDF render failed, using PDFKit fallback:', e.message);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="CARA - ${safeName}.pdf"`);

    const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true, info: { Creator: BRAND } });
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

    doc.fontSize(9).fillColor(MUTED).text(BRAND, { align: 'left' });
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
      `Generated ${new Date().toLocaleString('en-AU')} — ${BRAND}`,
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

    const notApproved = await unapprovedCaraPeras(req.params.id);
    if (notApproved.length) {
      return res.status(400).send(`This CARA can't be submitted until these PERAs are approved: ${notApproved.map((p) => escapeHtml(p.activity_name)).join(', ')}. <a href="/cara/${Number(req.params.id)}">Back</a>`);
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

app.post('/cara/:id/approve', requireRole('admin', 'approver'), async (req, res, next) => {
  try {
    const existing = (await pool.query('SELECT id, status, archived FROM cara_records WHERE id = $1', [req.params.id])).rows[0];
    if (!existing) return res.status(404).send('CARA record not found.');
    if (existing.archived || !['Pending approval', 'Changes requested'].includes(existing.status)) {
      return res.status(400).send(`This CARA is "${escapeHtml(existing.status)}" and isn't waiting for a decision. <a href="/cara/${existing.id}">Back</a>`);
    }
    const notApproved = await unapprovedCaraPeras(existing.id);
    if (notApproved.length) {
      return res.status(400).send(`This CARA can't be approved until these PERAs are approved: ${notApproved.map((p) => escapeHtml(p.activity_name)).join(', ')}. <a href="/cara/${existing.id}">Back</a>`);
    }
    const approverName = normalizeText(req.body.approver) || req.staffUser.name;
    await pool.query(
      `UPDATE cara_records
       SET status = 'Approved', approver = $1, approved_at = now(),
           next_review_date = (now() + interval '1 year')::date, updated_at = now()
       WHERE id = $2`,
      [approverName, req.params.id]
    );
    await pool.query('INSERT INTO cara_change_log (cara_id, changed_by, summary) VALUES ($1,$2,$3)',
      [req.params.id, req.staffUser.name, `Approved (approver: ${approverName})`]);
    res.redirect(approvalRedirect(req, `/cara/${req.params.id}`));
  } catch (err) {
    next(err);
  }
});

app.post('/cara/:id/reject', requireRole('admin', 'approver'), async (req, res, next) => {
  try {
    const { review_notes } = req.body;
    if (!normalizeText(review_notes || '').trim()) {
      return res.status(400).send('Add a note saying what needs to change. <a href="javascript:history.back()">Back</a>');
    }
    await pool.query(
      `UPDATE cara_records
       SET status = 'Changes requested', review_notes = $1, updated_at = now()
       WHERE id = $2`,
      [normalizeText(review_notes), req.params.id]
    );
    await pool.query('INSERT INTO cara_change_log (cara_id, changed_by, summary) VALUES ($1,$2,$3)',
      [req.params.id, req.staffUser.name, `Changes requested: ${normalizeText(review_notes)}`]);
    res.redirect(approvalRedirect(req, `/cara/${req.params.id}`));
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

// Permanent delete (System Administrator only). A copy of the record is kept in
// record_deletions, since its own change history is removed with it.
app.post('/cara/:id/delete', requireSystemAdmin, async (req, res, next) => {
  const id = Number(req.params.id);
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT * FROM cara_records WHERE id = $1', [id]);
    if (!rows.length) {
      client.release();
      return res.status(404).send('CARA record not found. <a href="/cara">Back</a>');
    }
    const cara = rows[0];
    const links = (await client.query('SELECT pera_id FROM cara_tool_links WHERE cara_id = $1', [id])).rows.map((r) => r.pera_id);
    const snapshot = { ...cara, teacher_signature: cara.teacher_signature ? '(signature image removed)' : null, pera_ids: links };
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO record_deletions (entity, entity_id, title, snapshot, deleted_by_staff_id, deleted_by_name)
       VALUES ('cara', $1, $2, $3, $4, $5)`,
      [id, cara.activity_name, JSON.stringify(snapshot), req.staffUser.id, req.staffUser.name]
    );
    await client.query('DELETE FROM cara_records WHERE id = $1', [id]);
    await client.query('COMMIT');
    client.release();
    res.redirect(req.body.return === 'archived' ? '/cara?archived=1' : '/cara');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
    client.release();
    next(err);
  }
});

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

// ---- Equipment: shared Maintenance/Inspection criteria libraries --------
// kind is always the literal string 'maintenance' or 'inspection' from
// code in this file, never user input, so building table names with it is
// safe (nothing here is interpolated from a request).

async function fetchCriteriaLibrary(kind) {
  const catTable = kind === 'maintenance' ? 'maintenance_categories' : 'inspection_categories';
  const critTable = kind === 'maintenance' ? 'maintenance_criteria' : 'inspection_criteria';
  const [catsResult, critResult] = await Promise.all([
    pool.query(`SELECT * FROM ${catTable} ORDER BY sort_order, id`),
    pool.query(`SELECT * FROM ${critTable} ORDER BY sort_order, id`),
  ]);
  const byCategory = new Map();
  for (const c of catsResult.rows) byCategory.set(c.id, { ...c, criteria: [] });
  for (const cr of critResult.rows) {
    const cat = byCategory.get(cr.category_id);
    if (cat) cat.criteria.push(cr);
  }
  return [...byCategory.values()];
}

async function fetchSelectedCriteriaIds(kind, equipmentId) {
  if (!equipmentId) return [];
  const table = kind === 'maintenance' ? 'equipment_maintenance_criteria' : 'equipment_inspection_criteria';
  const result = await pool.query(`SELECT criterion_id FROM ${table} WHERE equipment_id = $1`, [equipmentId]);
  return result.rows.map((r) => r.criterion_id);
}

// The selected criteria for one equipment item, joined with their category
// name, for read-only display on the detail page and for the "Log a
// maintenance/inspection" checklist.
async function fetchEquipmentCriteria(kind, equipmentId) {
  const junctionTable = kind === 'maintenance' ? 'equipment_maintenance_criteria' : 'equipment_inspection_criteria';
  const critTable = kind === 'maintenance' ? 'maintenance_criteria' : 'inspection_criteria';
  const catTable = kind === 'maintenance' ? 'maintenance_categories' : 'inspection_categories';
  const result = await pool.query(
    `SELECT cr.id, cr.description, cat.name AS category_name
     FROM ${junctionTable} j
     JOIN ${critTable} cr ON cr.id = j.criterion_id
     JOIN ${catTable} cat ON cat.id = cr.category_id
     WHERE j.equipment_id = $1
     ORDER BY cat.sort_order, cr.sort_order`,
    [equipmentId]
  );
  return result.rows;
}

// Renders the "Manage Maintenance/Inspection Criteria" picker for the
// equipment new/edit form: one collapsible group per category (mirrors the
// existing CARA "tool-picker" pattern), each with a select/deselect-all
// checkbox, plus a "Site Specific" group that can grow a custom criterion
// right there without leaving the form. Selections submit as part of the
// same equipment <form> as ordinary checkboxes -- no separate JS-sync step,
// and no cross-page form association, so the round-7 selector bug class
// can't happen here.
function criteriaPickerHtml(kind, categories, selectedIds) {
  const label = kind === 'maintenance' ? 'Maintenance' : 'Inspection';
  const fieldName = `${kind}_criteria_ids`;
  const newFieldName = `new_${kind}_criteria`;
  const selectedSet = new Set((selectedIds || []).map(String));

  const groupsHtml = categories.map((cat) => {
    const isSiteSpecific = cat.name === 'Site Specific';
    const itemsHtml = cat.criteria.map((cr) => `
      <div class="tool-picker-item">
        <input type="checkbox" id="${kind}_crit_${cr.id}" name="${fieldName}" value="${cr.id}" class="${kind}-criteria-checkbox" ${selectedSet.has(String(cr.id)) ? 'checked' : ''}>
        <label for="${kind}_crit_${cr.id}">${escapeHtml(cr.description)}</label>
      </div>
    `).join('');
    const selectAllHtml = cat.criteria.length ? `
      <div class="tool-picker-item" style="font-weight:600;">
        <input type="checkbox" id="${kind}_selall_${cat.id}" onchange="this.closest('.tool-picker-group-items').querySelectorAll('input.${kind}-criteria-checkbox').forEach((cb) => { cb.checked = this.checked; })">
        <label for="${kind}_selall_${cat.id}">Select / deselect all</label>
      </div>
    ` : '';
    const addRowHtml = isSiteSpecific ? `
      <div id="${kind}-new-rows"></div>
      <div class="tool-picker-item">
        <input type="text" id="${kind}-new-input" placeholder="Add a custom ${label.toLowerCase()} criterion..." style="flex:1;padding:6px 8px;border:1px solid #E4DFD3;border-radius:6px;font-size:13px;">
        <button type="button" class="btn btn-secondary" id="${kind}-add-btn" style="padding:5px 10px;font-size:12px;flex-shrink:0;">+ Add</button>
      </div>
    ` : '';
    return `
      <details class="tool-picker-group">
        <summary class="tool-picker-group-label">${escapeHtml(cat.name)} <span class="tool-picker-group-count">(${cat.criteria.length})</span></summary>
        <div class="tool-picker-group-items">
          ${selectAllHtml}
          ${itemsHtml || (isSiteSpecific ? '' : '<div class="tool-picker-item" style="color:#6B6659;">No criteria yet.</div>')}
          ${addRowHtml}
        </div>
      </details>
    `;
  }).join('');

  return `
    <div class="form-row">
      <label>${label} criteria</label>
      <p class="form-section-hint" style="margin-top:-4px;">Tick which of these apply to this specific item. Add a custom one under "Site Specific" if something's missing — it's saved to the shared library so it's there for other equipment too.</p>
      <div class="tool-picker">
        <div class="tool-picker-list">
          ${groupsHtml}
        </div>
      </div>
    </div>
    <script>
      (function() {
        var addBtn = document.getElementById('${kind}-add-btn');
        if (!addBtn) return;
        addBtn.addEventListener('click', function() {
          var input = document.getElementById('${kind}-new-input');
          var text = input.value.trim();
          if (!text) return;
          var row = document.createElement('div');
          row.className = 'tool-picker-item';
          var cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = true;
          cb.disabled = true;
          var lbl = document.createElement('label');
          lbl.textContent = text + ' (new)';
          var hidden = document.createElement('input');
          hidden.type = 'hidden';
          hidden.name = '${newFieldName}';
          hidden.value = text;
          row.appendChild(cb);
          row.appendChild(lbl);
          row.appendChild(hidden);
          document.getElementById('${kind}-new-rows').appendChild(row);
          input.value = '';
        });
      })();
    </script>
  `;
}

// Persists a picker's submission for one equipment item: links the ticked
// existing criteria, creates any new custom ones under "Site Specific" and
// links those too, then replaces the item's full selection with this set
// (so unticking something in the picker actually removes it).
async function saveEquipmentCriteria(kind, equipmentId, existingIdsRaw, newDescriptionsRaw) {
  const critTable = kind === 'maintenance' ? 'maintenance_criteria' : 'inspection_criteria';
  const catTable = kind === 'maintenance' ? 'maintenance_categories' : 'inspection_categories';
  const junctionTable = kind === 'maintenance' ? 'equipment_maintenance_criteria' : 'equipment_inspection_criteria';

  const ids = toArray(existingIdsRaw).map((id) => parseInt(id, 10)).filter((id) => Number.isInteger(id));

  const newDescriptions = toArray(newDescriptionsRaw).map((d) => normalizeText(d)).filter(Boolean);
  if (newDescriptions.length) {
    const existingSiteSpecific = await pool.query(`SELECT id FROM ${catTable} WHERE name = 'Site Specific' LIMIT 1`);
    let categoryId = existingSiteSpecific.rows.length ? existingSiteSpecific.rows[0].id : null;
    if (!categoryId) {
      const created = await pool.query(`INSERT INTO ${catTable} (name, sort_order) VALUES ('Site Specific', 999) RETURNING id`);
      categoryId = created.rows[0].id;
    }
    for (const description of newDescriptions) {
      const inserted = await pool.query(
        `INSERT INTO ${critTable} (category_id, description, sort_order) VALUES ($1,$2,0) RETURNING id`,
        [categoryId, description]
      );
      ids.push(inserted.rows[0].id);
    }
  }

  await pool.query(`DELETE FROM ${junctionTable} WHERE equipment_id = $1`, [equipmentId]);
  for (const criterionId of ids) {
    await pool.query(`INSERT INTO ${junctionTable} (equipment_id, criterion_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [equipmentId, criterionId]);
  }
}

// Renders the pass/fail/N-A checklist for "Log a maintenance/inspection" on
// the equipment detail page, grouped by category. Each criterion gets a
// tick (pass) / cross (fail) / N/A control -- defaulting to pass -- instead
// of a plain checkbox, so a log records an actual result per item rather
// than just "was this looked at". Category names are bold headings; item
// text stays regular weight, per Sean's reference-screenshot request.
function criteriaLogChecklistHtml(kind, items, equipmentId) {
  if (!items.length) {
    return `<div class="form-section-hint" style="margin:0 0 12px 0;">No ${kind} criteria set for this item — <a href="/admin/equipment/${equipmentId}/edit" style="color:#1B5E52;font-weight:600;">add some</a> so a log has something to tick off.</div>`;
  }
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.category_name)) groups.set(item.category_name, []);
    groups.get(item.category_name).push(item);
  }
  let html = '';
  for (const [categoryName, criteria] of groups) {
    html += `<div class="criteria-category-header">${escapeHtml(categoryName)}</div>`;
    html += criteria.map((item) => `
      <div class="criteria-row">
        <div class="criteria-row-label">${escapeHtml(item.description)}</div>
        <div class="criteria-status-group" id="status-group-${kind}-${item.id}">
          <input type="hidden" name="criteria_status_${item.id}" id="status-input-${kind}-${item.id}" value="yes">
          <button type="button" class="criteria-status-btn status-yes active" title="Pass" onclick="setCriteriaStatus('${kind}', ${item.id}, 'yes')">✓</button>
          <button type="button" class="criteria-status-btn status-no" title="Fail" onclick="setCriteriaStatus('${kind}', ${item.id}, 'no')">✕</button>
          <button type="button" class="criteria-status-btn status-na" title="N/A" onclick="setCriteriaStatus('${kind}', ${item.id}, 'na')">N/A</button>
        </div>
      </div>
    `).join('');
  }
  html += `
    <script>
      function setCriteriaStatus(kind, id, status) {
        document.getElementById('status-input-' + kind + '-' + id).value = status;
        var group = document.getElementById('status-group-' + kind + '-' + id);
        group.querySelectorAll('.criteria-status-btn').forEach(function(btn) { btn.classList.remove('active'); });
        group.querySelector('.status-' + status).classList.add('active');
      }
    </script>
  `;
  return html;
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
  const date = new Date(d);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function formatFileSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// Short label shown in the generic file icon for a related document that
// has no thumbnail (an uploaded Word/Excel/PowerPoint/text file, or a
// link with nothing uploaded at all).
function documentFileExtLabel(d) {
  if (d.has_file && d.file_name) {
    const ext = d.file_name.includes('.') ? d.file_name.split('.').pop() : '';
    if (ext && ext.length <= 5) return ext.toUpperCase();
  }
  return d.has_file ? 'FILE' : 'LINK';
}

// ---- Rooms (equipment's "Location" picker) -------------------------------
// A canonical list managed at Admin > Rooms -- see the migration comment in
// db.js for why this replaced a free-text field. Any logged-in staff member
// can pick a room while adding/editing equipment (and add a new one inline
// if it's not there yet); only admins can rename or archive one.

async function fetchActiveRooms() {
  return fetchRoomsForSelect(null);
}

// Active rooms, plus the given item's current room even if it's since been
// archived -- otherwise editing an item whose room was archived would show
// the picker as "— None —" and silently clear room_id on save.
async function fetchRoomsForSelect(currentRoomId) {
  const { rows } = await pool.query(
    'SELECT * FROM rooms WHERE archived = false OR id = $1 ORDER BY archived ASC, name ASC',
    [currentRoomId || null]
  );
  return rows;
}

// selectedRoomId: the equipment item's current room_id (or null/undefined
// for a new item). Renders a <select> of active rooms plus a "+ Add a new
// room" option that reveals a text input -- resolveRoomIdFromInput below is
// its server-side counterpart.
function roomSelectHtml(rooms, selectedRoomId) {
  const options = rooms.map((room) => `<option value="${room.id}" ${String(room.id) === String(selectedRoomId) ? 'selected' : ''}>${escapeHtml(room.name)}${room.archived ? ' (archived)' : ''}</option>`).join('');
  return `
    <select id="room_id" name="room_id" onchange="document.getElementById('room_id_new').style.display = this.value === '__new__' ? '' : 'none';">
      <option value="">— None —</option>
      ${options}
      <option value="__new__">+ Add a new room…</option>
    </select>
    <input type="text" id="room_id_new" name="new_room_name" placeholder="New room name" style="display:none;margin-top:8px;">
  `;
}

// Turns the room_id/new_room_name pair the equipment form submits into an
// actual room_id, creating the room first if "+ Add a new room" was used
// (ON CONFLICT covers someone else adding the same name a moment earlier).
async function resolveRoomIdFromInput(roomId, newRoomName) {
  if (roomId === '__new__') {
    const name = normalizeText(newRoomName);
    if (!name) return null;
    const result = await pool.query(
      'INSERT INTO rooms (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
      [name]
    );
    return result.rows[0].id;
  }
  const parsed = parseInt(roomId, 10);
  return Number.isInteger(parsed) ? parsed : null;
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
      `SELECT e.*, p.activity_name AS pera_name, rm.name AS room_name
       FROM equipment_items e
       LEFT JOIN pera_records p ON p.id = e.pera_id
       LEFT JOIN rooms rm ON rm.id = e.room_id
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
          <td>${escapeHtml(r.room_name || '—')}</td>
          <td><span class="badge ${equipmentBadgeClass(r.status)}">${escapeHtml(r.status)}</span></td>
          <td>${formatDate(r.next_inspection_due)}</td>
        </tr>
      `).join('');
      rowsHtml = `
        <table>
          <thead>
            <tr>
              <th>Name</th>
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
    const peraResult = await pool.query('SELECT id, activity_name FROM pera_records WHERE archived = false ORDER BY activity_name ASC');
    const [maintenanceCategories, inspectionCategories, rooms] = await Promise.all([
      fetchCriteriaLibrary('maintenance'),
      fetchCriteriaLibrary('inspection'),
      fetchActiveRooms(),
    ]);
    const statusOptions = EQUIPMENT_STATUSES.map((s) => `<option value="${s}" ${s === 'Operational' ? 'selected' : ''}>${s}</option>`).join('');
    const peraOptions = [
      '<option value="">— None —</option>',
      ...peraResult.rows.map((p) => `<option value="${p.id}">${escapeHtml(p.activity_name)}</option>`),
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
          <label for="make">Make</label>
          <input type="text" id="make" name="make" placeholder="e.g. Hafco">
        </div>
        <div class="form-row">
          <label for="model">Model</label>
          <input type="text" id="model" name="model" placeholder="e.g. PT-254">
        </div>
        <div class="form-row">
          <label for="serial_number">Serial number</label>
          <input type="text" id="serial_number" name="serial_number">
        </div>
        <div class="form-row">
          <label for="supplier">Supplier</label>
          <input type="text" id="supplier" name="supplier">
        </div>
        <div class="form-row">
          <label for="purchase_date">Purchase date</label>
          <input type="date" id="purchase_date" name="purchase_date">
        </div>
        <div class="form-row">
          <label for="room_id">Location</label>
          ${roomSelectHtml(rooms, null)}
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
          <label for="inspection_frequency">Inspection frequency</label>
          <select id="inspection_frequency" name="inspection_frequency">
            <option value="">— None —</option>
            ${equipmentFrequencyOptions('')}
          </select>
        </div>
        ${criteriaPickerHtml('inspection', inspectionCategories, [])}
        <div class="form-row">
          <label for="maintenance_frequency">Maintenance frequency</label>
          <select id="maintenance_frequency" name="maintenance_frequency">
            <option value="">— None —</option>
            ${equipmentFrequencyOptions('')}
          </select>
        </div>
        ${criteriaPickerHtml('maintenance', maintenanceCategories, [])}
        <div class="form-row">
          <label for="notes">Notes</label>
          <textarea id="notes" name="notes" placeholder="Maintenance history, anything else worth recording..."></textarea>
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
      name, make, model, serial_number, supplier, purchase_date, room_id, new_room_name, status, pera_id, notes,
      inspection_frequency, maintenance_frequency,
      maintenance_criteria_ids, new_maintenance_criteria, inspection_criteria_ids, new_inspection_criteria,
    } = req.body;

    if (!name || !EQUIPMENT_STATUSES.includes(status)) {
      return res.status(400).send('Name and a valid status are required.');
    }
    const frequency = EQUIPMENT_FREQUENCIES.includes(inspection_frequency) ? inspection_frequency : null;
    const maintFrequency = EQUIPMENT_FREQUENCIES.includes(maintenance_frequency) ? maintenance_frequency : null;
    const resolvedRoomId = await resolveRoomIdFromInput(room_id, new_room_name);

    // last_inspected/next_inspection_due and last_maintained/next_maintenance_due
    // are intentionally not set here -- a brand-new item has no check history
    // yet, so these stay null until the first "Log an inspection"/"Log
    // maintenance" actually happens on the detail page.
    const result = await pool.query(
      `INSERT INTO equipment_items
        (name, make, model, serial_number, supplier, purchase_date, room_id, status, pera_id, notes,
         inspection_frequency, maintenance_frequency, created_by_staff_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [
        normalizeText(name), normalizeText(make) || null, normalizeText(model) || null,
        normalizeText(serial_number) || null, normalizeText(supplier) || null, purchase_date || null,
        resolvedRoomId, status,
        pera_id || null, normalizeText(notes) || null,
        frequency, maintFrequency, req.staffUser.id,
      ]
    );
    const equipmentId = result.rows[0].id;

    await saveEquipmentCriteria('maintenance', equipmentId, maintenance_criteria_ids, new_maintenance_criteria);
    await saveEquipmentCriteria('inspection', equipmentId, inspection_criteria_ids, new_inspection_criteria);

    res.redirect(`/equipment/${equipmentId}`);
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
    const result = await pool.query(`
      SELECT e.*, rm.name AS room_name
      FROM equipment_items e
      LEFT JOIN rooms rm ON rm.id = e.room_id
      ORDER BY e.name ASC
    `);
    const hideClear = req.query.hide_clear === '1';

    const groups = new Map();
    for (const r of result.rows) {
      const key = r.room_name || 'Unassigned location';
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
            <form method="post" action="/equipment/${r.id}/inspection-check">
              <input type="hidden" name="return_to" value="by-room">
              <button type="submit" class="btn btn-secondary" style="padding:6px 12px;font-size:12px;">Log inspection</button>
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
      `SELECT e.*, p.activity_name AS pera_name, rm.name AS room_name
       FROM equipment_items e
       LEFT JOIN pera_records p ON p.id = e.pera_id
       LEFT JOIN rooms rm ON rm.id = e.room_id
       WHERE e.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).send('Equipment item not found.');
    }
    const r = result.rows[0];

    const [maintenanceItems, inspectionItems, maintenanceLogsResult, inspectionLogsResult, serviceLogsResult] = await Promise.all([
      fetchEquipmentCriteria('maintenance', r.id),
      fetchEquipmentCriteria('inspection', r.id),
      pool.query('SELECT * FROM equipment_maintenance_logs WHERE equipment_id = $1 ORDER BY performed_at DESC LIMIT 10', [r.id]),
      pool.query('SELECT * FROM equipment_inspection_logs WHERE equipment_id = $1 ORDER BY performed_at DESC LIMIT 10', [r.id]),
      pool.query('SELECT * FROM equipment_service_logs WHERE equipment_id = $1 ORDER BY performed_at DESC LIMIT 10', [r.id]),
    ]);

    const maintenanceChecklistHtml = criteriaLogChecklistHtml('maintenance', maintenanceItems, r.id);
    const inspectionChecklistHtml = criteriaLogChecklistHtml('inspection', inspectionItems, r.id);

    // completed_criteria is an array of {description, status} objects (see
    // the inspection-check/maintenance-check routes) as of this change, but
    // older log rows saved before it stored plain description strings (just
    // "this one was ticked") -- render both shapes so old history doesn't break.
    const criteriaStatusIcon = { yes: '✓', no: '✕', na: 'N/A' };
    const logStatusIconHtml = (status) =>
      `<span class="log-status-icon log-status-${status || 'yes'}">${escapeHtml(criteriaStatusIcon[status] || '✓')}</span>`;
    // Each entry collapses to one summary line (date/who + a pass/fail
    // count) via <details>/<summary>, reusing the same .change-log tree
    // markup/CSS the PERA change history already uses (public/style.css)
    // -- so a long Inspection/Maintenance history doesn't force-expand
    // every criterion for every past check, and it looks/behaves like the
    // one collapsible history the app already has.
    const logHistoryHtml = (logs) => logs.length
      ? `<div class="change-log">${logs.map((c) => {
          const criteria = Array.isArray(c.completed_criteria) ? c.completed_criteria : [];
          const failCount = criteria.filter((item) => typeof item !== 'string' && item.status === 'no').length;
          const naCount = criteria.filter((item) => typeof item !== 'string' && item.status === 'na').length;
          const passCount = criteria.length - failCount - naCount;
          const briefText = !criteria.length ? 'No criteria recorded' : failCount
            ? `${failCount} failed`
            : `${passCount} passed${naCount ? `, ${naCount} N/A` : ''}`;
          return `
            <details class="change-log-entry">
              <summary class="change-log-summary">
                <span class="change-log-datetime">${formatDateTime(c.performed_at)}${c.performed_by ? ` · ${escapeHtml(c.performed_by)}` : ''}</span>
                <span class="change-log-brief${failCount ? ' log-brief-fail' : ''}">${briefText}</span>
              </summary>
              <div class="change-log-detail">${
                criteria.length
                  ? criteria.map((item) => (typeof item === 'string'
                      ? `${logStatusIconHtml('yes')} ${escapeHtml(item)}`
                      : `${logStatusIconHtml(item.status)} ${escapeHtml(item.description)}`
                    )).join('<br>')
                  : 'No criteria recorded'
              }${c.notes ? `<div class="log-note-positive">${escapeHtml(c.notes)}</div>` : ''}</div>
            </details>
          `;
        }).join('')}</div>`
      : '<div class="form-section-hint" style="margin:0;">None logged yet.</div>';

    // Collapsed one-liner-per-entry tree, same pattern as logHistoryHtml,
    // so a long service history doesn't push the more-important "last
    // service" summary (below) down the page.
    // A separate, visually quieter tile for the Inspection/Maintenance
    // history trees -- these are only for reference if needed, so they
    // live below the "Log an inspection/maintenance" form and start
    // collapsed behind their own summary, rather than sitting between the
    // due-date info and the form where they'd compete for attention.
    const historyTileHtml = (title, bodyHtml) => `
      <div class="card" style="padding:0;margin-top:20px;overflow:hidden;">
        <details>
          <summary class="change-log-summary" style="padding:14px 16px 14px 34px;">
            <span class="change-log-datetime">${title}</span>
            <span class="change-log-brief">Reference only — past checks</span>
          </summary>
          <div style="padding:0 16px 16px 16px;">
            ${bodyHtml}
          </div>
        </details>
      </div>
    `;

    const serviceHistoryTreeHtml = serviceLogsResult.rows.length
      ? `<div class="change-log">${serviceLogsResult.rows.map((s) => `
          <details class="change-log-entry">
            <summary class="change-log-summary">
              <span class="change-log-datetime">${formatDateTime(s.performed_at)}${s.performed_by ? ` · ${escapeHtml(s.performed_by)}` : ''}</span>
              <span class="change-log-brief">${s.previous_status ? `Back from ${escapeHtml(s.previous_status)}` : 'Service logged'}</span>
            </summary>
            <div class="change-log-detail"><div class="log-note-positive">${escapeHtml(s.note)}</div></div>
          </details>
        `).join('')}</div>`
      : '<div class="form-section-hint" style="margin:0;">Nothing logged yet.</div>';

    // Headline summary -- last service date plus whatever note was recorded
    // (e.g. "SOP replaced") -- so this shows up front without opening the
    // history tree above.
    const lastServiceLog = serviceLogsResult.rows[0];
    const lastServiceSummaryHtml = lastServiceLog ? `
      <div class="detail-section" style="box-shadow:none;padding:0;margin-bottom:16px;">
        <div class="detail-label">Last service</div>
        <div class="detail-value">${formatDateTime(lastServiceLog.performed_at)}${lastServiceLog.performed_by ? ` · ${escapeHtml(lastServiceLog.performed_by)}` : ''}</div>
        <div class="log-note-positive" style="margin-top:4px;">${escapeHtml(lastServiceLog.note)}</div>
      </div>
    ` : '<div class="form-section-hint" style="margin:0 0 16px;">No service recorded yet.</div>';

    // Once an item is out of "Operational", the only way back is this form
    // -- see the /equipment/:id/return-to-service route comment. This whole
    // Service card sits near the top of the page (not tabbed alongside
    // Inspection/Maintenance) since it's the thing most worth seeing at a
    // glance: whether the item needs attention, and what was last done.
    const returnToServiceFormHtml = r.status !== 'Operational' ? `
      <div class="note-box" style="border-color:#B3261E;">This item is currently marked "${escapeHtml(r.status)}". Describe what was done to fix or check it before putting it back into service — that note is kept as part of this item's record.</div>
      <form method="post" action="/equipment/${r.id}/return-to-service" style="margin-top:14px;margin-bottom:20px;">
        <div class="form-row">
          <label for="service_performed_by">Restored by</label>
          <input type="text" id="service_performed_by" name="performed_by" placeholder="Your name">
        </div>
        <div class="form-row">
          <label for="service_note">What was done <span style="color:#B3261E;">*</span></label>
          <textarea id="service_note" name="note" required placeholder="e.g. Replaced the guillotine's damaged blade guard and tested it against all inspection criteria."></textarea>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Mark as Operational</button>
        </div>
      </form>
    ` : '';

    const body = `
      <a class="back-link" href="/equipment">← Back to Equipment</a>
      <div class="page-header">
        <div>
          <h1 class="page-title">${escapeHtml(r.name)}</h1>
          <p class="page-subtitle">${r.room_name ? escapeHtml(r.room_name) : 'Equipment'}</p>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:10px;">
          <span class="badge ${equipmentBadgeClass(r.status)}">${escapeHtml(r.status)}</span>
          <a class="btn btn-secondary" href="/admin/equipment/${r.id}/edit" style="padding:8px 14px;">Edit this item</a>
        </div>
      </div>
      <div class="card" style="padding:22px;margin-bottom:20px;">
        <div class="detail-section" style="margin-bottom:0;box-shadow:none;padding:0;">
          <div class="detail-label">Linked PERA</div>
          <div class="detail-value">${r.pera_id ? `<a href="/pera/${r.pera_id}" style="color:#1B5E52;font-weight:600;">${escapeHtml(r.pera_name)}</a>` : 'None'}</div>
        </div>
        ${r.notes ? `
        <div class="detail-section" style="margin-bottom:0;margin-top:16px;box-shadow:none;padding:0;">
          <div class="detail-label">Notes</div>
          <div class="detail-value">${escapeHtml(r.notes)}</div>
        </div>` : ''}
      </div>
      <div class="card" style="padding:22px;margin-bottom:20px;">
        <div class="form-section-title" style="margin-top:0;">Asset details</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
          <div class="detail-section" style="margin-bottom:0;box-shadow:none;padding:0;">
            <div class="detail-label">Make</div>
            <div class="detail-value">${escapeHtml(r.make || '—')}</div>
          </div>
          <div class="detail-section" style="margin-bottom:0;box-shadow:none;padding:0;">
            <div class="detail-label">Model</div>
            <div class="detail-value">${escapeHtml(r.model || '—')}</div>
          </div>
          <div class="detail-section" style="margin-bottom:0;box-shadow:none;padding:0;">
            <div class="detail-label">Serial number</div>
            <div class="detail-value">${escapeHtml(r.serial_number || '—')}</div>
          </div>
          <div class="detail-section" style="margin-bottom:0;box-shadow:none;padding:0;">
            <div class="detail-label">Supplier</div>
            <div class="detail-value">${escapeHtml(r.supplier || '—')}</div>
          </div>
          <div class="detail-section" style="margin-bottom:0;box-shadow:none;padding:0;">
            <div class="detail-label">Purchase date</div>
            <div class="detail-value">${formatDate(r.purchase_date)}</div>
          </div>
        </div>
      </div>
      <div class="card" style="padding:22px;margin-bottom:20px;">
        <div class="form-section-title" style="margin-top:0;">Service${r.status !== 'Operational' ? ' <span style="color:#B3261E;">⚠</span>' : ''}</div>
        ${returnToServiceFormHtml}
        ${lastServiceSummaryHtml}
      </div>
      <div class="card" style="padding:22px;">
        <div class="section-tabs">
          <button type="button" class="section-tab active" id="eq-tab-inspection" onclick="showEquipmentPanel('inspection')">Inspection</button>
          <button type="button" class="section-tab" id="eq-tab-maintenance" onclick="showEquipmentPanel('maintenance')">Maintenance</button>
        </div>
        <div id="eq-panel-inspection" style="display:;">
          <div class="detail-section" style="box-shadow:none;padding:0;margin-bottom:12px;">
            <div class="detail-label">Last inspected</div>
            <div class="detail-value">${formatDate(r.last_inspected)}</div>
          </div>
          <div class="detail-section" style="box-shadow:none;padding:0;margin-bottom:0;">
            <div class="detail-label">Next inspection due</div>
            <div class="detail-value">${formatDate(r.next_inspection_due)}${r.inspection_frequency ? ` (checked every ${escapeHtml(r.inspection_frequency)})` : ''}</div>
          </div>
          <div class="form-section-title" style="margin-top:24px;">Log an inspection</div>
          <form method="post" action="/equipment/${r.id}/inspection-check">
            ${inspectionChecklistHtml}
            <div class="form-row" style="margin-top:12px;">
              <label for="inspected_by">Checked by</label>
              <input type="text" id="inspected_by" name="performed_by" placeholder="Your name">
            </div>
            <div class="form-row">
              <label for="inspection_notes">Notes</label>
              <textarea id="inspection_notes" name="notes" placeholder="Anything noticed during this inspection..."></textarea>
            </div>
            <div class="form-actions">
              <button type="submit" class="btn btn-primary">Log inspection</button>
            </div>
          </form>
        </div>
        <div id="eq-panel-maintenance" style="display:none;">
          <div class="detail-section" style="box-shadow:none;padding:0;margin-bottom:12px;">
            <div class="detail-label">Last maintained</div>
            <div class="detail-value">${formatDate(r.last_maintained)}</div>
          </div>
          <div class="detail-section" style="box-shadow:none;padding:0;margin-bottom:0;">
            <div class="detail-label">Next maintenance due</div>
            <div class="detail-value">${formatDate(r.next_maintenance_due)}${r.maintenance_frequency ? ` (serviced every ${escapeHtml(r.maintenance_frequency)})` : ''}</div>
          </div>
          <div class="form-section-title" style="margin-top:24px;">Log maintenance</div>
          <form method="post" action="/equipment/${r.id}/maintenance-check">
            ${maintenanceChecklistHtml}
            <div class="form-row" style="margin-top:12px;">
              <label for="maintained_by">Serviced by</label>
              <input type="text" id="maintained_by" name="performed_by" placeholder="Your name">
            </div>
            <div class="form-row">
              <label for="maintenance_notes">Notes</label>
              <textarea id="maintenance_notes" name="notes" placeholder="Anything done or noticed during this service..."></textarea>
            </div>
            <div class="form-actions">
              <button type="submit" class="btn btn-primary">Log maintenance</button>
            </div>
          </form>
          ${historyTileHtml('Maintenance history', logHistoryHtml(maintenanceLogsResult.rows))}
        </div>
      </div>
      ${historyTileHtml('Inspection & Service history', `
        <div class="form-section-title" style="margin-top:0;padding-top:0;border-top:none;">Inspection</div>
        ${logHistoryHtml(inspectionLogsResult.rows)}
        <div class="form-section-title">Service</div>
        ${serviceHistoryTreeHtml}
      `)}
      <script>
        function showEquipmentPanel(which) {
          document.getElementById('eq-panel-inspection').style.display = which === 'inspection' ? '' : 'none';
          document.getElementById('eq-panel-maintenance').style.display = which === 'maintenance' ? '' : 'none';
          document.getElementById('eq-tab-inspection').classList.toggle('active', which === 'inspection');
          document.getElementById('eq-tab-maintenance').classList.toggle('active', which === 'maintenance');
        }
      </script>
    `;

    res.send(page({ title: r.name, active: 'equipment', body }));
  } catch (err) {
    next(err);
  }
});

// ---------- Equipment: log an inspection / log maintenance ----------
// Two separate flows (each with its own due date/frequency) instead of the
// old single generic "check" -- see the equipment_maintenance_logs /
// equipment_inspection_logs comment in db.js for why.

app.post('/equipment/:id/inspection-check', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM equipment_items WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).send('Equipment item not found.');
    }
    const r = result.rows[0];

    // The full "Log an inspection" form on the detail page submits a
    // criteria_status_<id>=yes|no|na field per criterion (from the tick/
    // cross/N-A buttons) plus performed_by/notes. The one-click "Log
    // inspection" button on the by-room page submits none of these — treat
    // that as "the whole checklist passed, no name/notes recorded".
    const formSubmitted = 'performed_by' in req.body || 'notes' in req.body;
    const items = await fetchEquipmentCriteria('inspection', r.id);
    const completedCriteria = items.map((item) => {
      const submittedStatus = req.body[`criteria_status_${item.id}`];
      const status = formSubmitted && ['yes', 'no', 'na'].includes(submittedStatus) ? submittedStatus : 'yes';
      return { id: item.id, description: item.description, category: item.category_name, status };
    });
    const performedBy = formSubmitted ? (normalizeText(req.body.performed_by) || null) : null;
    const notes = formSubmitted ? (normalizeText(req.body.notes) || null) : null;

    // A failed ("cross") criterion means the item isn't safe to keep using
    // as-is, so a single failure automatically takes it out of service --
    // it stays that way until someone manually changes the status back
    // (via the edit form), which is a deliberate, visible decision rather
    // than something a later passing inspection silently undoes.
    const hasFailure = completedCriteria.some((c) => c.status === 'no');

    const today = new Date();
    const nextDue = computeNextDue(today, r.inspection_frequency);

    await pool.query(
      `INSERT INTO equipment_inspection_logs (equipment_id, performed_by, completed_criteria, notes)
       VALUES ($1,$2,$3,$4)`,
      [r.id, performedBy, JSON.stringify(completedCriteria), notes]
    );
    await pool.query(
      `UPDATE equipment_items SET last_inspected = $1, next_inspection_due = $2, updated_at = now() WHERE id = $3`,
      [today, nextDue, r.id]
    );
    if (hasFailure) {
      await pool.query(`UPDATE equipment_items SET status = 'Out of service', updated_at = now() WHERE id = $1`, [r.id]);
    }

    res.redirect(req.body.return_to === 'by-room' ? '/equipment/by-room' : `/equipment/${r.id}`);
  } catch (err) {
    next(err);
  }
});

app.post('/equipment/:id/maintenance-check', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM equipment_items WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).send('Equipment item not found.');
    }
    const r = result.rows[0];

    // Maintenance is only ever logged via the full form (no by-room
    // quick-check equivalent), so every criterion always has a submitted
    // criteria_status_<id> field -- default to "yes" only as a fallback.
    const items = await fetchEquipmentCriteria('maintenance', r.id);
    const completedCriteria = items.map((item) => {
      const submittedStatus = req.body[`criteria_status_${item.id}`];
      const status = ['yes', 'no', 'na'].includes(submittedStatus) ? submittedStatus : 'yes';
      return { id: item.id, description: item.description, category: item.category_name, status };
    });
    const performedBy = normalizeText(req.body.performed_by) || null;
    const notes = normalizeText(req.body.notes) || null;

    // Same rule as inspections: a failed criterion automatically takes the
    // item out of service until someone manually restores the status.
    const hasFailure = completedCriteria.some((c) => c.status === 'no');

    const today = new Date();
    const nextDue = computeNextDue(today, r.maintenance_frequency);

    await pool.query(
      `INSERT INTO equipment_maintenance_logs (equipment_id, performed_by, completed_criteria, notes)
       VALUES ($1,$2,$3,$4)`,
      [r.id, performedBy, JSON.stringify(completedCriteria), notes]
    );
    await pool.query(
      `UPDATE equipment_items SET last_maintained = $1, next_maintenance_due = $2, updated_at = now() WHERE id = $3`,
      [today, nextDue, r.id]
    );
    if (hasFailure) {
      await pool.query(`UPDATE equipment_items SET status = 'Out of service', updated_at = now() WHERE id = $1`, [r.id]);
    }

    res.redirect(`/equipment/${r.id}`);
  } catch (err) {
    next(err);
  }
});

// ---------- Equipment: return to service ----------
// The only way an item's status can move back to "Operational" once it's
// "Needs repair"/"Out of service" -- requires a note saying what was done,
// so the record always shows why it's considered safe to use again. The
// admin edit form deliberately can't offer "Operational" as an option
// while an item is in either non-operational state, to stop that note
// requirement being bypassed (see the edit-form routes below).
app.post('/equipment/:id/return-to-service', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM equipment_items WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).send('Equipment item not found.');
    }
    const r = result.rows[0];

    if (r.status === 'Operational') {
      return res.redirect(`/equipment/${r.id}`);
    }

    const note = normalizeText(req.body.note);
    if (!note) {
      return res.status(400).send('A note describing what was done to return this item to service is required. <a href="/equipment/' + r.id + '">Back</a>');
    }
    const performedBy = normalizeText(req.body.performed_by) || null;

    await pool.query(
      `INSERT INTO equipment_service_logs (equipment_id, performed_by, previous_status, note)
       VALUES ($1,$2,$3,$4)`,
      [r.id, performedBy, r.status, note]
    );
    await pool.query(`UPDATE equipment_items SET status = 'Operational', updated_at = now() WHERE id = $1`, [r.id]);

    res.redirect(`/equipment/${r.id}`);
  } catch (err) {
    next(err);
  }
});

// ---------- Staff: login / logout ----------

app.get('/admin/login', (req, res) => {
  const next = typeof req.query.next === 'string' && req.query.next.startsWith('/') && !req.query.next.startsWith('//') ? req.query.next : '/';
  res.send(renderLanding({ next, user: req.staffUser || null }));
});

app.post('/admin/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const target = typeof req.body.next === 'string' && req.body.next.startsWith('/') && !req.body.next.startsWith('//') ? req.body.next : '/';
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

    if (!normalizedEmail || !password) {
      return res.status(401).send(renderLanding({ next: target, error: 'Enter your email and password.', email: normalizedEmail }));
    }

    const { rows } = await pool.query('SELECT * FROM staff_users WHERE lower(email) = $1', [normalizedEmail]);
    const user = rows[0];
    if (!user || user.disabled || !verifyPassword(password, user.password_hash)) {
      return res.status(401).send(renderLanding({ next: target, error: 'Incorrect email or password.', email: normalizedEmail }));
    }

    setSessionCookie(res, user.id);
    res.redirect(target);
  } catch (err) {
    next(err);
  }
});

app.post('/admin/logout', (req, res) => {
  clearSessionCookie(res);
  res.redirect('/admin/login');
});

// ---------- Staff: one-time first-admin setup ----------
// Only reachable while no staff accounts exist at all -- bootstraps the very
// first Admin account without needing shell/database access. Once at least
// one account exists, this permanently redirects to the ordinary login page
// instead, so it can't be used to create a second, unauthorised admin later.

app.get('/admin/setup', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM staff_users');
    if (rows[0].count > 0) {
      return res.redirect('/admin/login');
    }
    const body = `
      <div class="form-card" style="max-width:420px;margin:60px auto;">
        <h1 class="page-title" style="margin-bottom:8px;">Set up the first admin account</h1>
        <p class="page-subtitle" style="margin-bottom:20px;">This only works once, before any staff accounts exist. Once you're signed in, add everyone else from Admin &rarr; Staff.</p>
        <form method="post" action="/admin/setup">
          <div class="form-row">
            <label for="name">Your name</label>
            <input type="text" id="name" name="name" required autofocus>
          </div>
          <div class="form-row">
            <label for="email">Email</label>
            <input type="email" id="email" name="email" required>
          </div>
          <div class="form-row">
            <label for="password">Password</label>
            <input type="password" id="password" name="password" minlength="8" required>
          </div>
          <div class="form-row">
            <label for="password_confirm">Confirm password</label>
            <input type="password" id="password_confirm" name="password_confirm" minlength="8" required>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary" style="width:100%;">Create admin account</button>
          </div>
        </form>
      </div>
    `;
    res.send(page({ title: 'Set up admin account', active: '', body }));
  } catch (err) {
    next(err);
  }
});

app.post('/admin/setup', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM staff_users');
    if (rows[0].count > 0) {
      return res.redirect('/admin/login');
    }

    const { name, email, password, password_confirm } = req.body;
    const normalizedName = normalizeText(name || '').trim();
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

    if (!normalizedName || !normalizedEmail || !password) {
      return res.status(400).send('All fields are required. <a href="/admin/setup">Try again</a>');
    }
    if (password !== password_confirm) {
      return res.status(400).send('Passwords do not match. <a href="/admin/setup">Try again</a>');
    }
    if (password.length < 8) {
      return res.status(400).send('Password must be at least 8 characters. <a href="/admin/setup">Try again</a>');
    }

    const passwordHash = hashPassword(password);
    const insertResult = await pool.query(
      `INSERT INTO staff_users (name, email, password_hash, role) VALUES ($1, $2, $3, 'admin') RETURNING id`,
      [normalizedName, normalizedEmail, passwordHash]
    );
    setSessionCookie(res, insertResult.rows[0].id);
    res.redirect('/admin/staff');
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(400).send('That email is already in use. <a href="/admin/setup">Try again</a>');
    }
    next(err);
  }
});

// ---------- Admin: records list ----------

// The admin area is a set of sibling tabs (Manage Staff / PERA / CARA /
// Equipment), each its own page/URL rather than one long scrolling page.
// adminTabs() renders the shared tab bar; adminHeader() the shared
// title-plus-sign-out-button row that sits above it on every tab.
// The admin pages used to carry a row of tabs; those links now live in the
// sidebar's Admin section (views/layout.js), so this renders nothing. Kept
// as a function so the existing calls on each admin page stay harmless.
function adminTabs() {
  return '';
}

function adminHeader(title, subtitle) {
  return `
    <div class="page-header">
      <div>
        <h1 class="page-title">${escapeHtml(title)}</h1>
        <p class="page-subtitle">${escapeHtml(subtitle)}</p>
      </div>
      <form method="post" action="/admin/logout">
        <button type="submit" class="btn btn-secondary">Sign out</button>
      </form>
    </div>
  `;
}

require('./admin-approvals')(app, {
  pool, page, escapeHtml, requireRole, adminTabs, adminHeader, riskBadgeClass, statusBadgeClass, formatBrisbaneDate,
  approvalRequirement, caraApprovalRequirement, APPROVAL_DECISIONS, APPROVAL_REQUIRED_LEVELS,
});
require('./admin-dashboard')(app, {
  pool, page, escapeHtml, requireRole, adminTabs, adminHeader, riskBadgeClass, statusBadgeClass, formatBrisbaneDate,
});

app.get('/admin/pera', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM pera_records WHERE archived = false ORDER BY id');

    const rows = result.rows.map((r) => `
      <tr class="row-link" onclick="window.location='/admin/pera/${r.id}/edit'">
        <td style="width:1%;" onclick="event.stopPropagation();"><input type="checkbox" name="ids" value="${r.id}" form="admin-pera-archive-form" onchange="document.getElementById('admin-archive-selected-btn').disabled = !document.querySelectorAll('input[name=ids][form=admin-pera-archive-form]:checked').length;"></td>
        <td>${escapeHtml(r.activity_name)}</td>
        <td>${escapeHtml(r.class_unit || '—')}</td>
        <td><span class="badge ${riskBadgeClass(r.risk_level)}">${escapeHtml(r.risk_level)}</span></td>
        <td><span class="badge ${statusBadgeClass(r.status)}">${escapeHtml(r.status)}</span></td>
        <td>${escapeHtml(r.approver || '—')}</td>
      </tr>
    `).join('');

    const body = `
      ${adminHeader('PERA records', 'Click any record to edit or delete it. Tick one or more and use "Archive selected" to move them to the PERA Archive without deleting them.')}
      ${adminTabs('pera')}
      <form id="admin-pera-archive-form" method="post" action="/admin/pera/archive" onsubmit="return confirm('Archive the selected PERA record(s)? They will be hidden from the main PERA list but can be restored anytime from the PERA Archive.');" style="margin-bottom:10px;">
        <input type="hidden" name="redirect_to" value="/admin/pera">
        <button type="submit" id="admin-archive-selected-btn" class="btn btn-secondary" disabled>Archive selected</button>
      </form>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th style="width:1%;"><input type="checkbox" onchange="document.querySelectorAll('input[name=ids][form=admin-pera-archive-form]').forEach((cb) => cb.checked = this.checked); document.getElementById('admin-archive-selected-btn').disabled = !this.checked;"></th>
              <th>Activity</th>
              <th>Class / unit</th>
              <th>Risk</th>
              <th>Status</th>
              <th>Approver</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="6" style="text-align:center;color:#6B6659;padding:24px;">No PERA records yet.</td></tr>'}</tbody>
        </table>
      </div>
    `;

    res.send(page({ title: 'PERA records', active: 'admin', body }));
  } catch (err) {
    next(err);
  }
});

// ---------- PERA: archive (declutter the main list without deleting) ----------
// Archiving is admin-only and bulk (checkboxes on the main /pera list, or on
// this page to restore). An archived PERA is hidden from the main list, the
// CARA tool-picker, and the Equipment "covered by" dropdown, but stays fully
// viewable -- read-only -- at its normal /pera/:id URL, and can be restored
// at any time. These two routes must stay registered before the
// /admin/pera/:id... routes further down, or "archive"/"restore" would be
// swallowed as an :id.

app.get('/admin/pera/archive', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM pera_records WHERE archived = true ORDER BY activity_name ASC');

    const rows = result.rows.map((r) => `
      <tr class="row-link" onclick="window.location='/pera/${r.id}'">
        <td onclick="event.stopPropagation();"><input type="checkbox" name="ids" value="${r.id}" form="pera-restore-form" onchange="document.getElementById('restore-selected-btn').disabled = !document.querySelectorAll('input[name=ids][form=pera-restore-form]:checked').length;"></td>
        <td>${escapeHtml(r.activity_name)}</td>
        <td>${escapeHtml(r.class_unit || '—')}</td>
        <td><span class="badge ${riskBadgeClass(r.risk_level)}">${escapeHtml(r.risk_level)}</span></td>
        <td><span class="badge ${statusBadgeClass(r.status)}">${escapeHtml(r.status)}</span></td>
      </tr>
    `).join('');

    const body = `
      ${adminHeader('PERA Archive', 'Archived PERAs are hidden from the main PERA list but stay viewable here. Click a record to view it, or restore it to bring it back to the main list.')}
      ${adminTabs('pera-archive')}
      <form id="pera-restore-form" method="post" action="/admin/pera/restore" onsubmit="return confirm('Restore the selected PERA record(s) to the main PERA list?');" style="margin-bottom:10px;">
        <button type="submit" id="restore-selected-btn" class="btn btn-secondary" disabled>Restore selected</button>
      </form>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th style="width:1%;"><input type="checkbox" onchange="document.querySelectorAll('input[name=ids][form=pera-restore-form]').forEach((cb) => cb.checked = this.checked); document.getElementById('restore-selected-btn').disabled = !this.checked;"></th>
              <th>Activity</th>
              <th>Class / unit</th>
              <th>Risk</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="5" style="text-align:center;color:#6B6659;padding:24px;">No PERA records archived.</td></tr>'}</tbody>
        </table>
      </div>
    `;

    res.send(page({ title: 'PERA Archive', active: 'admin', body }));
  } catch (err) {
    next(err);
  }
});

app.post('/admin/pera/archive', requireRole('admin'), async (req, res, next) => {
  try {
    const ids = toArray(req.body.ids).map((id) => parseInt(id, 10)).filter((id) => Number.isInteger(id));
    if (ids.length) {
      await pool.query("UPDATE pera_records SET archived = true, updated_at = now() WHERE id = ANY($1::int[])", [ids]);
      const namesResult = await pool.query('SELECT id, activity_name, version FROM pera_records WHERE id = ANY($1::int[])', [ids]);
      for (const row of namesResult.rows) {
        await pool.query(
          `INSERT INTO pera_change_log (pera_id, changed_by, action, version, summary, brief) VALUES ($1,$2,'Archived',$3,'Archived (removed from the main PERA list)','Archived')`,
          [row.id, req.staffUser ? req.staffUser.name : null, row.version]
        );
      }
    }
    res.redirect(req.body.redirect_to && req.body.redirect_to.startsWith('/') ? req.body.redirect_to : '/pera');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/pera/restore', requireRole('admin'), async (req, res, next) => {
  try {
    const ids = toArray(req.body.ids).map((id) => parseInt(id, 10)).filter((id) => Number.isInteger(id));
    if (ids.length) {
      await pool.query("UPDATE pera_records SET archived = false, updated_at = now() WHERE id = ANY($1::int[])", [ids]);
      const namesResult = await pool.query('SELECT id, version FROM pera_records WHERE id = ANY($1::int[])', [ids]);
      for (const row of namesResult.rows) {
        await pool.query(
          `INSERT INTO pera_change_log (pera_id, changed_by, action, version, summary, brief) VALUES ($1,$2,'Restored',$3,'Restored to the main PERA list','Restored')`,
          [row.id, req.staffUser ? req.staffUser.name : null, row.version]
        );
      }
    }
    res.redirect(req.body.redirect_to && req.body.redirect_to.startsWith('/') ? req.body.redirect_to : '/admin/pera/archive');
  } catch (err) {
    next(err);
  }
});

app.get('/admin/cara', requireRole('admin'), async (req, res, next) => {
  try {
    const caraResult = await pool.query('SELECT * FROM cara_records ORDER BY id');

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
      ${adminHeader('CARA records', 'Click any record to edit or delete it.')}
      ${adminTabs('cara')}
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

    res.send(page({ title: 'CARA records', active: 'admin', body }));
  } catch (err) {
    next(err);
  }
});

app.get('/admin/equipment', requireRole('admin'), async (req, res, next) => {
  try {
    const equipmentResult = await pool.query(`
      SELECT e.*, rm.name AS room_name
      FROM equipment_items e
      LEFT JOIN rooms rm ON rm.id = e.room_id
      ORDER BY e.name ASC
    `);

    const equipmentRows = equipmentResult.rows.map((r) => `
      <tr class="row-link" onclick="window.location='/admin/equipment/${r.id}/edit'">
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.room_name || '—')}</td>
        <td><span class="badge ${equipmentBadgeClass(r.status)}">${escapeHtml(r.status)}</span></td>
      </tr>
    `).join('');

    const body = `
      ${adminHeader('Equipment', 'Click any item to edit or delete it.')}
      ${adminTabs('equipment')}
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Location</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>${equipmentRows || '<tr><td colspan="3" style="text-align:center;color:#6B6659;padding:24px;">No equipment recorded yet.</td></tr>'}</tbody>
        </table>
      </div>
    `;

    res.send(page({ title: 'Equipment', active: 'admin', body }));
  } catch (err) {
    next(err);
  }
});

// ---------- Admin: staff accounts ----------

function roleLabel(role) {
  return { system_admin: 'System Administrator', admin: 'Admin', approver: 'Approver', submitter: 'Submitter' }[role] || role;
}

const ADMIN_ROLES = ['system_admin', 'admin'];

function requireSystemAdmin(req, res, next) {
  if (!req.staffUser) return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
  if (!req.staffUser.isSystemAdmin) return res.status(403).send('Only a System Administrator can do that. <a href="/">Back to dashboard</a>');
  next();
}

// Who may give someone the System Administrator role, or change/disable/delete
// a System Administrator: another System Administrator — or, only while no
// System Administrator exists yet, an Admin (so the first one can be set up).
async function canManageSystemAdmins(user) {
  if (user.isSystemAdmin) return true;
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM staff_users WHERE role = 'system_admin'`);
  return rows[0].n === 0;
}

// Safety net so an admin can't lock everyone out by disabling/deleting the
// last remaining enabled admin account (themselves or someone else).
async function isLastEnabledAdmin(staffId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM staff_users WHERE role IN ('admin','system_admin') AND disabled = false AND id != $1`,
    [staffId]
  );
  return rows[0].count === 0;
}

// ---------- Admin: Rooms ----------
// Any staff member can pick a room (or add one on the fly) while adding or
// editing equipment -- see roomSelectHtml/resolveRoomIdFromInput above.
// This page is where an admin can rename or archive one, which is the
// actual point of a real Rooms list over free-typed text: a rename here
// changes what every item using that room shows immediately.

app.get('/admin/rooms', requireRole('admin'), async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM rooms ORDER BY archived ASC, name ASC');
    const activeRooms = rows.filter((room) => !room.archived);
    const archivedRooms = rows.filter((room) => room.archived);

    const activeRowsHtml = activeRooms.map((room) => `
      <tr>
        <td>
          <form method="post" action="/admin/rooms/${room.id}" style="display:flex;gap:8px;align-items:center;">
            <input type="text" name="name" value="${escapeHtml(room.name)}" required style="flex:1;padding:6px 8px;border:1px solid #E4DFD3;border-radius:6px;font-size:13px;">
            <button type="submit" class="btn btn-secondary" style="padding:6px 12px;flex-shrink:0;">Save</button>
          </form>
        </td>
        <td style="width:1%;white-space:nowrap;">
          <form method="post" action="/admin/rooms/${room.id}/archive">
            <button type="submit" class="btn btn-secondary" style="padding:6px 12px;">Archive</button>
          </form>
        </td>
      </tr>
    `).join('');

    const archivedHtml = archivedRooms.length ? `
      <div class="form-section-title">Archived rooms</div>
      <div class="form-section-hint" style="margin:0 0 12px 0;">Hidden from the room picker on equipment, but any item already using one keeps showing it.</div>
      <div class="card">
        <table>
          <tbody>
            ${archivedRooms.map((room) => `
              <tr>
                <td>${escapeHtml(room.name)}</td>
                <td style="width:1%;white-space:nowrap;">
                  <form method="post" action="/admin/rooms/${room.id}/restore">
                    <button type="submit" class="btn btn-secondary" style="padding:6px 12px;">Restore</button>
                  </form>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    ` : '';

    const body = `
      ${adminHeader('Rooms', 'The rooms equipment can be assigned to. Rename or archive one here rather than retyping it on every item.')}
      ${adminTabs('rooms')}
      <div class="card">
        <table>
          <thead><tr><th>Room</th><th></th></tr></thead>
          <tbody>${activeRowsHtml || '<tr><td colspan="2" style="text-align:center;color:#6B6659;padding:24px;">No rooms yet -- add one below, or one will appear automatically the first time someone picks "+ Add a new room" on an equipment item.</td></tr>'}</tbody>
        </table>
      </div>

      <div class="form-section-title">Add a room</div>
      <form class="form-card" method="post" action="/admin/rooms" style="max-width:480px;">
        <div class="form-row">
          <label for="name">Room name</label>
          <input type="text" id="name" name="name" required placeholder="e.g. IDT Workshop A">
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Add room</button>
        </div>
      </form>
      ${archivedHtml}
    `;

    res.send(page({ title: 'Rooms', active: 'admin', body }));
  } catch (err) {
    next(err);
  }
});

app.post('/admin/rooms', requireRole('admin'), async (req, res, next) => {
  try {
    const name = normalizeText(req.body.name);
    if (!name) {
      return res.status(400).send('A room name is required. <a href="/admin/rooms">Back</a>');
    }
    // Adding a name that already exists (including one that's archived)
    // just un-archives it, rather than erroring -- there's no reason to
    // make someone hunt down and restore an old room when re-typing its
    // name here does the same thing.
    await pool.query('INSERT INTO rooms (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET archived = false', [name]);
    res.redirect('/admin/rooms');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/rooms/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const name = normalizeText(req.body.name);
    if (!name) {
      return res.status(400).send('A room name is required. <a href="/admin/rooms">Back</a>');
    }
    await pool.query('UPDATE rooms SET name = $1 WHERE id = $2', [name, req.params.id]);
    res.redirect('/admin/rooms');
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(400).send('A room with that name already exists. <a href="/admin/rooms">Back</a>');
    }
    next(err);
  }
});

app.post('/admin/rooms/:id/archive', requireRole('admin'), async (req, res, next) => {
  try {
    await pool.query('UPDATE rooms SET archived = true WHERE id = $1', [req.params.id]);
    res.redirect('/admin/rooms');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/rooms/:id/restore', requireRole('admin'), async (req, res, next) => {
  try {
    await pool.query('UPDATE rooms SET archived = false WHERE id = $1', [req.params.id]);
    res.redirect('/admin/rooms');
  } catch (err) {
    next(err);
  }
});

app.get('/admin/staff', requireRole('admin'), async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM staff_users ORDER BY name ASC');
    const canGrantSys = await canManageSystemAdmins(req.staffUser);

    const staffRows = rows.map((s) => `
      <tr class="row-link" onclick="window.location='/admin/staff/${s.id}/edit'">
        <td>${escapeHtml(s.name)}${s.id === req.staffUser.id ? ' <span style="color:#6B6659;">(you)</span>' : ''}</td>
        <td>${escapeHtml(s.email)}</td>
        <td>${escapeHtml(roleLabel(s.role))}</td>
        <td>${s.disabled ? '<span class="badge badge-changes">Disabled</span>' : '<span class="badge badge-approved">Active</span>'}</td>
      </tr>
    `).join('');

    const body = `
      ${adminHeader('Staff', 'Click any staff member to change their role, disable them, or reset their password.')}
      ${adminTabs('staff')}
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>${staffRows || '<tr><td colspan="4" style="text-align:center;color:#6B6659;padding:24px;">No staff accounts yet.</td></tr>'}</tbody>
        </table>
      </div>

      <div class="form-section-title">Add a staff member</div>
      <form class="form-card" method="post" action="/admin/staff" style="max-width:480px;">
        <div class="form-row">
          <label for="name">Name</label>
          <input type="text" id="name" name="name" required>
        </div>
        <div class="form-row">
          <label for="email">Email</label>
          <input type="email" id="email" name="email" required>
        </div>
        <div class="form-row">
          <label for="role">Role</label>
          <select id="role" name="role" required>
            <option value="submitter">Submitter — create and edit their own records</option>
            <option value="approver">Approver — also approves/rejects PERA and CARA</option>
            <option value="admin">Admin — full access, including managing staff</option>
            ${canGrantSys ? '<option value="system_admin">System Administrator — Admin, plus permanently deleting records</option>' : ''}
          </select>
        </div>
        <div class="form-row">
          <label for="password">Temporary password</label>
          <input type="password" id="password" name="password" minlength="8" required>
          <div class="form-section-hint">Share this with them directly — not by email — and encourage them to note it somewhere safe. There's no self-service "change password" page yet, so if they want a different one later, an admin resets it from here.</div>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Create account</button>
        </div>
      </form>
    `;

    res.send(page({ title: 'Staff', active: 'admin', body }));
  } catch (err) {
    next(err);
  }
});

app.post('/admin/staff', requireRole('admin'), async (req, res, next) => {
  try {
    const { name, email, role, password } = req.body;
    const normalizedName = normalizeText(name || '').trim();
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

    if (!normalizedName || !normalizedEmail || !STAFF_ROLES.includes(role)) {
      return res.status(400).send('Name, email and a valid role are required. <a href="/admin/staff">Back</a>');
    }
    if (!password || password.length < 8) {
      return res.status(400).send('Password must be at least 8 characters. <a href="/admin/staff">Back</a>');
    }
    if (role === 'system_admin' && !(await canManageSystemAdmins(req.staffUser))) {
      return res.status(403).send('Only a System Administrator can create another System Administrator. <a href="/admin/staff">Back</a>');
    }

    await pool.query(
      `INSERT INTO staff_users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)`,
      [normalizedName, normalizedEmail, hashPassword(password), role]
    );

    res.redirect('/admin/staff');
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(400).send('That email is already in use. <a href="/admin/staff">Back</a>');
    }
    next(err);
  }
});

app.get('/admin/staff/:id/edit', requireRole('admin'), async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM staff_users WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).send('Staff account not found.');
    }
    const s = rows[0];

    const canGrantSys = await canManageSystemAdmins(req.staffUser);
    if (s.role === 'system_admin' && !canGrantSys) {
      return res.status(403).send('Only a System Administrator can change a System Administrator account. <a href="/admin/staff">Back</a>');
    }
    const roleOptions = STAFF_ROLES.filter((r) => r !== 'system_admin' || canGrantSys).map((r) =>
      `<option value="${r}"${s.role === r ? ' selected' : ''}>${roleLabel(r)}</option>`
    ).join('');

    const body = `
      <div class="page-header">
        <div>
          <h1 class="page-title">${escapeHtml(s.name)}</h1>
          <p class="page-subtitle">${escapeHtml(s.email)}</p>
        </div>
        <a href="/admin/staff" class="btn btn-secondary">Back to Staff</a>
      </div>

      <form class="form-card" method="post" action="/admin/staff/${s.id}/edit" style="max-width:480px;">
        <div class="form-row">
          <label for="name">Name</label>
          <input type="text" id="name" name="name" value="${escapeHtml(s.name)}" required>
        </div>
        <div class="form-row">
          <label for="email">Email</label>
          <input type="email" id="email" name="email" value="${escapeHtml(s.email)}" required>
        </div>
        <div class="form-row">
          <label for="role">Role</label>
          <select id="role" name="role" required>${roleOptions}</select>
        </div>
        <div class="form-row">
          <label for="new_password">Reset password (leave blank to keep it unchanged)</label>
          <input type="password" id="new_password" name="new_password" minlength="8">
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Save changes</button>
        </div>
      </form>

      <form method="post" action="/admin/staff/${s.id}/${s.disabled ? 'enable' : 'disable'}" style="margin-top:16px;">
        <button type="submit" class="btn btn-secondary">${s.disabled ? 'Re-enable this account' : 'Disable this account'}</button>
      </form>
      ${s.id !== req.staffUser.id ? `
      <form method="post" action="/admin/staff/${s.id}/delete" style="margin-top:16px;" onsubmit="return confirm('Delete this staff account permanently? Any records they created stay in place, just no longer linked to their account. This cannot be undone.');">
        <button type="submit" class="btn btn-secondary" style="color:#B3261E;">Delete this account</button>
      </form>` : ''}
    `;

    res.send(page({ title: s.name, active: 'admin', body }));
  } catch (err) {
    next(err);
  }
});

app.post('/admin/staff/:id/edit', requireRole('admin'), async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM staff_users WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).send('Staff account not found.');
    }
    const existing = rows[0];

    const { name, email, role, new_password } = req.body;
    const normalizedName = normalizeText(name || '').trim();
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

    if (!normalizedName || !normalizedEmail || !STAFF_ROLES.includes(role)) {
      return res.status(400).send('Name, email and a valid role are required. <a href="/admin/staff/' + existing.id + '/edit">Back</a>');
    }
    if ((role === 'system_admin' || existing.role === 'system_admin') && role !== existing.role && !(await canManageSystemAdmins(req.staffUser))) {
      return res.status(403).send('Only a System Administrator can give or remove the System Administrator role. <a href="/admin/staff/' + existing.id + '/edit">Back</a>');
    }
    if (existing.role === 'system_admin' && !(await canManageSystemAdmins(req.staffUser))) {
      return res.status(403).send('Only a System Administrator can change a System Administrator account. <a href="/admin/staff">Back</a>');
    }
    if (ADMIN_ROLES.includes(existing.role) && !ADMIN_ROLES.includes(role) && await isLastEnabledAdmin(existing.id)) {
      return res.status(400).send('Cannot change the last remaining admin to another role — promote someone else to Admin first. <a href="/admin/staff/' + existing.id + '/edit">Back</a>');
    }
    if (new_password && new_password.length < 8) {
      return res.status(400).send('New password must be at least 8 characters. <a href="/admin/staff/' + existing.id + '/edit">Back</a>');
    }

    if (new_password) {
      await pool.query(
        `UPDATE staff_users SET name = $1, email = $2, role = $3, password_hash = $4, updated_at = now() WHERE id = $5`,
        [normalizedName, normalizedEmail, role, hashPassword(new_password), existing.id]
      );
    } else {
      await pool.query(
        `UPDATE staff_users SET name = $1, email = $2, role = $3, updated_at = now() WHERE id = $4`,
        [normalizedName, normalizedEmail, role, existing.id]
      );
    }

    res.redirect('/admin/staff');
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(400).send('That email is already in use. <a href="/admin/staff/' + req.params.id + '/edit">Back</a>');
    }
    next(err);
  }
});

app.post('/admin/staff/:id/disable', requireRole('admin'), async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM staff_users WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).send('Staff account not found.');
    }
    if (rows[0].role === 'system_admin' && !(await canManageSystemAdmins(req.staffUser))) {
      return res.status(403).send('Only a System Administrator can disable a System Administrator account. <a href="/admin/staff">Back</a>');
    }
    if (ADMIN_ROLES.includes(rows[0].role) && await isLastEnabledAdmin(rows[0].id)) {
      return res.status(400).send('Cannot disable the last remaining admin account. <a href="/admin/staff">Back</a>');
    }
    await pool.query('UPDATE staff_users SET disabled = true, updated_at = now() WHERE id = $1', [req.params.id]);
    res.redirect('/admin/staff');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/staff/:id/enable', requireRole('admin'), async (req, res, next) => {
  try {
    await pool.query('UPDATE staff_users SET disabled = false, updated_at = now() WHERE id = $1', [req.params.id]);
    res.redirect('/admin/staff');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/staff/:id/delete', requireRole('admin'), async (req, res, next) => {
  try {
    if (Number(req.params.id) === req.staffUser.id) {
      return res.status(400).send('You cannot delete your own account while signed in as it. <a href="/admin/staff">Back</a>');
    }
    const { rows } = await pool.query('SELECT * FROM staff_users WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).send('Staff account not found.');
    }
    if (rows[0].role === 'system_admin' && !(await canManageSystemAdmins(req.staffUser))) {
      return res.status(403).send('Only a System Administrator can delete a System Administrator account. <a href="/admin/staff">Back</a>');
    }
    if (ADMIN_ROLES.includes(rows[0].role) && await isLastEnabledAdmin(rows[0].id)) {
      return res.status(400).send('Cannot delete the last remaining admin account. <a href="/admin/staff">Back</a>');
    }
    await pool.query('DELETE FROM staff_users WHERE id = $1', [req.params.id]);
    res.redirect('/admin/staff');
  } catch (err) {
    next(err);
  }
});

// ---------- Admin: edit a record ----------

app.get('/admin/pera/:id/edit', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM pera_records WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).send('PERA record not found.');
    }
    const r = result.rows[0];

    const riskOptions = RISK_LEVELS.map((l) => `<option value="${l}" ${l === r.risk_level ? 'selected' : ''}>${l}</option>`).join('');
    const statusOptions = STATUSES.map((s) => `<option value="${s}" ${s === r.status ? 'selected' : ''}>${s}</option>`).join('');

    const body = `
      <a class="back-link" href="/admin/pera">← Back to PERA</a>
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
          <a class="btn btn-secondary" href="/admin/pera">Cancel</a>
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

app.post('/admin/pera/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const {
      activity_name, class_unit, risk_level, status,
      hazards, control_measures, required_supervision,
      consent_required, submitted_by, approver,
    } = req.body;

    if (!activity_name || !RISK_LEVELS.includes(risk_level) || !STATUSES.includes(status)) {
      return res.status(400).send('Activity name, a valid risk level and a valid status are required.');
    }

    // Content changes on an approved/submitted PERA send it back to Draft here
    // too, so this older admin screen can't keep an approval on edited content.
    const before = (await pool.query('SELECT * FROM pera_records WHERE id = $1', [req.params.id])).rows[0];
    if (!before) return res.status(404).send('PERA record not found.');
    const same = (x, y) => String(x == null ? '' : x).trim() === String(y == null ? '' : y).trim();
    const contentChanged = !same(before.activity_name, normalizeText(activity_name)) || !same(before.class_unit, normalizeText(class_unit))
      || before.risk_level !== risk_level || !same(before.hazards, normalizeText(hazards)) || !same(before.control_measures, normalizeText(control_measures))
      || !same(before.required_supervision, normalizeText(required_supervision)) || Boolean(before.consent_required) !== (consent_required === 'true');
    if (contentChanged && before.status !== 'Draft' && status !== 'Draft') {
      return res.status(400).send('This PERA is ' + escapeHtml(before.status) + '. Changing its content returns it to Draft so it can be re-approved — set Status to Draft to save these changes, or use the normal Edit page. <a href="/admin/pera/' + before.id + '/edit">Back</a>');
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

app.post('/admin/pera/:id/delete', requireRole('admin'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM pera_records WHERE id = $1', [req.params.id]);
    res.redirect('/admin/pera');
  } catch (err) {
    next(err);
  }
});

// ---------- Admin: edit a CARA record ----------

app.get('/admin/cara/:id/edit', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM cara_records WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).send('CARA record not found.');
    }
    const r = result.rows[0];

    const riskOptions = RISK_LEVELS.map((l) => `<option value="${l}" ${l === r.risk_level ? 'selected' : ''}>${l}</option>`).join('');
    const statusOptions = STATUSES.map((s) => `<option value="${s}" ${s === r.status ? 'selected' : ''}>${s}</option>`).join('');

    const body = `
      <a class="back-link" href="/admin/cara">← Back to CARA</a>
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
          <a class="btn btn-secondary" href="/admin/cara">Cancel</a>
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

app.post('/admin/cara/:id', requireRole('admin'), async (req, res, next) => {
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

app.post('/admin/cara/:id/delete', requireRole('admin'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM cara_records WHERE id = $1', [req.params.id]);
    res.redirect('/admin/cara');
  } catch (err) {
    next(err);
  }
});

// ---------- Admin: edit an Equipment item ----------

app.get('/admin/equipment/:id/edit', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM equipment_items WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).send('Equipment item not found.');
    }
    const r = result.rows[0];

    const [maintenanceCategories, inspectionCategories, selectedMaintenanceIds, selectedInspectionIds, rooms] = await Promise.all([
      fetchCriteriaLibrary('maintenance'),
      fetchCriteriaLibrary('inspection'),
      fetchSelectedCriteriaIds('maintenance', r.id),
      fetchSelectedCriteriaIds('inspection', r.id),
      fetchRoomsForSelect(r.room_id),
    ]);

    const peraResult = await pool.query('SELECT id, activity_name FROM pera_records WHERE archived = false OR id = $1 ORDER BY activity_name ASC', [r.pera_id]);
    // "Operational" is deliberately left off this list whenever the item
    // isn't already Operational -- going back into service requires a note
    // on what was done, which only the dedicated "Return to service" form
    // (on the equipment detail page) collects. This form can still move an
    // Operational item to "Needs repair"/"Out of service", and can still
    // move between those two, just never back the other way.
    const editableStatuses = r.status === 'Operational' ? EQUIPMENT_STATUSES : EQUIPMENT_STATUSES.filter((s) => s !== 'Operational');
    const statusOptions = editableStatuses.map((s) => `<option value="${s}" ${s === r.status ? 'selected' : ''}>${s}</option>`).join('');
    const statusHint = r.status !== 'Operational' ? '<div class="form-section-hint">To mark this item Operational again, use "Return to service" on the equipment page instead — it requires a note on what was done.</div>' : '';
    const peraOptions = [
      '<option value="">— None —</option>',
      ...peraResult.rows.map((p) => `<option value="${p.id}" ${p.id === r.pera_id ? 'selected' : ''}>${escapeHtml(p.activity_name)}</option>`),
    ].join('');
    const body = `
      <a class="back-link" href="/admin/equipment">← Back to Equipment</a>
      <h1 class="page-title" style="margin-bottom:24px;">Edit: ${escapeHtml(r.name)}</h1>
      <form class="form-card" method="post" action="/admin/equipment/${r.id}">
        <div class="form-row">
          <label for="name">Name</label>
          <input type="text" id="name" name="name" value="${escapeHtml(r.name)}" required>
        </div>
        <div class="form-row">
          <label for="make">Make</label>
          <input type="text" id="make" name="make" value="${escapeHtml(r.make || '')}" placeholder="e.g. Hafco">
        </div>
        <div class="form-row">
          <label for="model">Model</label>
          <input type="text" id="model" name="model" value="${escapeHtml(r.model || '')}" placeholder="e.g. PT-254">
        </div>
        <div class="form-row">
          <label for="serial_number">Serial number</label>
          <input type="text" id="serial_number" name="serial_number" value="${escapeHtml(r.serial_number || '')}">
        </div>
        <div class="form-row">
          <label for="supplier">Supplier</label>
          <input type="text" id="supplier" name="supplier" value="${escapeHtml(r.supplier || '')}">
        </div>
        <div class="form-row">
          <label for="purchase_date">Purchase date</label>
          <input type="date" id="purchase_date" name="purchase_date" value="${toDateInputValue(r.purchase_date)}">
        </div>
        <div class="form-row">
          <label for="room_id">Location</label>
          ${roomSelectHtml(rooms, r.room_id)}
        </div>
        <div class="form-row">
          <label for="status">Status</label>
          <select id="status" name="status" required>${statusOptions}</select>
          ${statusHint}
        </div>
        <div class="form-row">
          <label for="pera_id">Linked PERA</label>
          <select id="pera_id" name="pera_id">${peraOptions}</select>
        </div>
        <div class="form-row">
          <label for="inspection_frequency">Inspection frequency</label>
          <select id="inspection_frequency" name="inspection_frequency">
            <option value="">— None —</option>
            ${equipmentFrequencyOptions(r.inspection_frequency || '')}
          </select>
        </div>
        ${criteriaPickerHtml('inspection', inspectionCategories, selectedInspectionIds)}
        <div class="form-row">
          <label for="maintenance_frequency">Maintenance frequency</label>
          <select id="maintenance_frequency" name="maintenance_frequency">
            <option value="">— None —</option>
            ${equipmentFrequencyOptions(r.maintenance_frequency || '')}
          </select>
        </div>
        ${criteriaPickerHtml('maintenance', maintenanceCategories, selectedMaintenanceIds)}
        <div class="form-row">
          <label for="notes">Notes</label>
          <textarea id="notes" name="notes">${escapeHtml(r.notes || '')}</textarea>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Save changes</button>
          <a class="btn btn-secondary" href="/admin/equipment">Cancel</a>
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

app.post('/admin/equipment/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const {
      name, make, model, serial_number, supplier, purchase_date, room_id, new_room_name, status, pera_id, notes,
      inspection_frequency, maintenance_frequency,
      maintenance_criteria_ids, new_maintenance_criteria, inspection_criteria_ids, new_inspection_criteria,
    } = req.body;

    if (!name || !EQUIPMENT_STATUSES.includes(status)) {
      return res.status(400).send('Name and a valid status are required.');
    }

    // Server-side backstop for the same rule the edit form's status dropdown
    // enforces (by leaving "Operational" out of its options): this route
    // can never be the thing that puts an item back into service, even if
    // posted to directly, because that always needs the note collected by
    // the dedicated /equipment/:id/return-to-service flow.
    const currentResult = await pool.query('SELECT status FROM equipment_items WHERE id = $1', [req.params.id]);
    if (currentResult.rows.length === 0) {
      return res.status(404).send('Equipment item not found.');
    }
    if (status === 'Operational' && currentResult.rows[0].status !== 'Operational') {
      return res.status(400).send('Use "Return to service" on the equipment page to mark an item Operational again -- it requires a note on what was done. <a href="/admin/equipment/' + req.params.id + '/edit">Back</a>');
    }

    const frequency = EQUIPMENT_FREQUENCIES.includes(inspection_frequency) ? inspection_frequency : null;
    const maintFrequency = EQUIPMENT_FREQUENCIES.includes(maintenance_frequency) ? maintenance_frequency : null;
    const resolvedRoomId = await resolveRoomIdFromInput(room_id, new_room_name);

    // last_inspected/next_inspection_due and last_maintained/next_maintenance_due
    // are intentionally left alone here -- they're no longer editable by hand,
    // only ever set by actually logging an inspection/maintenance check.
    await pool.query(
      `UPDATE equipment_items SET
         name = $1, make = $2, model = $3, serial_number = $4, supplier = $5, purchase_date = $6,
         room_id = $7, status = $8, pera_id = $9,
         notes = $10, inspection_frequency = $11, maintenance_frequency = $12, updated_at = now()
       WHERE id = $13`,
      [
        normalizeText(name), normalizeText(make) || null, normalizeText(model) || null,
        normalizeText(serial_number) || null, normalizeText(supplier) || null, purchase_date || null,
        resolvedRoomId, status,
        pera_id || null, normalizeText(notes) || null,
        frequency, maintFrequency,
        req.params.id,
      ]
    );

    await saveEquipmentCriteria('maintenance', req.params.id, maintenance_criteria_ids, new_maintenance_criteria);
    await saveEquipmentCriteria('inspection', req.params.id, inspection_criteria_ids, new_inspection_criteria);

    res.redirect(`/admin/equipment/${req.params.id}/edit`);
  } catch (err) {
    next(err);
  }
});

app.post('/admin/equipment/:id/delete', requireRole('admin'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM equipment_items WHERE id = $1', [req.params.id]);
    res.redirect('/admin/equipment');
  } catch (err) {
    next(err);
  }
});

// ---------- Staff Equipment Induction ----------
//
// Built from the uploaded "Staff Equipment Induction Register" (Qld DETE
// ITD template) plus Sean's written spec. Reuses staff_users (role
// submitter = self-assessing staff member; approver = authorised
// inductor/assessor; admin = authorised school leader + everything an
// approver can do -- see canActAsAssessor/canAuthoriseSchoolLeader below),
// equipment_items and pera_records rather than a second staff/equipment
// list. See db.js for the full table set and the "why" behind each one.

const INDUCTION_STEP_LABELS = {
  1: 'Read and understand the SOP and risk assessment',
  2: 'Practical instruction and demonstration from a competent person',
  3: 'Hands-on practice / supervised logbook',
  4: 'Content / theory competency test',
  5: 'Induction record complete — inductor and inductee sign-off',
};

const DECLARATION_LABELS = {
  not_assessed: 'Not assessed',
  C: 'C — Self-assessed competent',
  NYC: 'NYC — Not yet competent',
  NA: 'Not applicable',
};
const DECLARATION_BADGE = {
  not_assessed: 'badge-draft',
  C: 'badge-approved',
  NYC: 'badge-changes',
  NA: 'badge-draft',
};

const STEP_STATUS_LABELS = { not_started: 'Not started', in_progress: 'In progress', complete: 'Complete' };
const STEP_STATUS_BADGE = { not_started: 'badge-draft', in_progress: 'badge-pending', complete: 'badge-approved' };

const ASSESSMENT_RESULT_LABELS = {
  not_assessed: 'Not assessed',
  demonstrated: 'Demonstrated',
  not_yet_demonstrated: 'Not yet demonstrated',
  not_applicable: 'Not applicable',
};
const ASSESSMENT_RESULT_BADGE = {
  not_assessed: 'badge-draft',
  demonstrated: 'badge-approved',
  not_yet_demonstrated: 'badge-changes',
  not_applicable: 'badge-draft',
};

// Brisbane (Qld) doesn't observe daylight saving, but we still ask the
// Intl API for the named zone rather than hardcoding +10 so this stays
// correct regardless of where the server itself is hosted.
function formatBrisbaneDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Brisbane' });
}
function formatBrisbaneDateTime(d) {
  if (!d) return '—';
  const date = new Date(d);
  const datePart = date.toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Australia/Brisbane' });
  const timePart = date.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Australia/Brisbane' });
  return `${datePart}, ${timePart} (Brisbane)`;
}
function formatHours(minutes) {
  if (!minutes) return '0 h';
  return `${(minutes / 60).toFixed(1)} h`;
}

// Who can act as the inductor/assessor for someone else's induction
// (verify steps, run a machine-competency assessment, verify a logbook
// entry, record assessor-verified competency). Mapped onto the app's
// existing three roles rather than inventing new ones -- see the note to
// Sean in this round's write-up for how to ask for finer-grained roles
// later if admin/approver turns out to be too coarse.
function canActAsAssessor(role) {
  return role === 'admin' || role === 'approver';
}
// Who can record school authorisation to operate equipment / supervise
// students -- kept narrower than "assessor" on purpose (section 6 of the
// spec treats this as a distinct school-leader decision).
function canAuthoriseSchoolLeader(role) {
  return role === 'admin';
}
// "Staff must not approve their own competency or authorisation" --
// applied to every verify/sign/authorise action in this module,
// regardless of the acting user's role (even an admin can't sign off on
// themselves).
function blockSelfAction(res, actorId, targetStaffId) {
  if (Number(actorId) === Number(targetStaffId)) {
    res.status(403).send('You cannot verify, sign off on, or authorise your own induction record. Ask another authorised staff member to do this. <a href="javascript:history.back()">Back</a>');
    return true;
  }
  return false;
}

async function logInductionChange({ staffId, inductionItemId, contextType, contextId, summary, changedByStaffId }) {
  await pool.query(
    `INSERT INTO induction_change_log (staff_id, induction_item_id, context_type, context_id, summary, changed_by_staff_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [staffId, inductionItemId || null, contextType, contextId || null, summary, changedByStaffId || null]
  );
}

async function getInductionCategoriesWithItems({ onlyAvailable = true } = {}) {
  const { rows } = await pool.query(
    `SELECT i.id, i.name, i.sort_order, i.category_id, i.pera_id, i.available_at_school,
            c.name AS category_name, c.sort_order AS category_sort_order,
            p.activity_name AS pera_name
     FROM induction_equipment_items i
     JOIN induction_equipment_categories c ON c.id = i.category_id
     LEFT JOIN pera_records p ON p.id = i.pera_id
     ${onlyAvailable ? 'WHERE i.available_at_school = true' : ''}
     ORDER BY c.sort_order, i.sort_order`
  );
  const categories = [];
  const byId = new Map();
  for (const row of rows) {
    if (!byId.has(row.category_id)) {
      const cat = { id: row.category_id, name: row.category_name, items: [] };
      byId.set(row.category_id, cat);
      categories.push(cat);
    }
    byId.get(row.category_id).items.push(row);
  }
  return categories;
}

async function getActiveStaffList() {
  const { rows } = await pool.query(`SELECT id, name, email, role FROM staff_users WHERE disabled = false ORDER BY name`);
  return rows;
}

function inductionNavBody(active, inner) {
  return `
    <a class="back-link" href="/induction">← Staff Induction</a>
    ${inner}
  `;
}

// ---------- Simplified induction (teacher landing, PERA/SOP review,
// assessor workspace) -- see induction-simple.js. Registered here, before
// the older induction routes, so /induction/me resolves to the new
// teacher landing page. ----------
const simpleInduction = require('./induction-simple')(app, {
  pool, page, escapeHtml, normalizeText,
  formatBrisbaneDate, formatBrisbaneDateTime,
  canActAsAssessor, canAuthoriseSchoolLeader, blockSelfAction,
  logInductionChange, getCurrentProfileVersion, getActiveLicences,
});

// Assessor/admin-only screens (the full matrix and school-wide reports
// moved out of the teacher's view).
function requireInductionAssessor(req, res, next) {
  if (!canActAsAssessor(req.staffUser.role)) {
    return res.status(403).send('This page is for assessors and administrators. <a href="/induction/me">Back to my induction</a>');
  }
  next();
}

// ---------- Induction: dashboard (assessors/admins; teachers go straight
// to their own landing page) ----------

app.get('/induction', async (req, res, next) => {
  try {
    if (!canActAsAssessor(req.staffUser.role)) return res.redirect('/induction/me');
    const [trainingRequired, pendingVerification, staffCount, itemCount] = await Promise.all([
      pool.query(`
        SELECT COUNT(*)::int AS count FROM staff_induction_declarations d
        JOIN staff_users s ON s.id = d.staff_id AND s.disabled = false
        WHERE d.status = 'NYC'`),
      pool.query(`
        SELECT COUNT(*)::int AS count FROM staff_induction_declarations d
        JOIN staff_users s ON s.id = d.staff_id AND s.disabled = false
        WHERE d.status = 'C'
        AND NOT EXISTS (
          SELECT 1 FROM staff_induction_competency_verifications v
          WHERE v.staff_id = d.staff_id AND v.induction_item_id = d.induction_item_id AND v.verified = true
        )`),
      pool.query(`SELECT COUNT(*)::int AS count FROM staff_users WHERE disabled = false`),
      pool.query(`SELECT COUNT(*)::int AS count FROM induction_equipment_items WHERE available_at_school = true`),
    ]);

    const openAlerts = (await pool.query('SELECT COUNT(*)::int AS count FROM induction_setup_alerts WHERE resolved_at IS NULL')).rows[0].count;
    const cards = [
      ['/induction/me', 'My induction', 'Your own profile, equipment, document review and outstanding actions.'],
      ['/induction/assessor', 'Assessor review workspace', 'Review staff profiles once, check PERA/SOP acknowledgements and record a decision per item.'],
      ['/induction/assessor/documents', 'PERA / SOP versions', 'Document versions staff acknowledge, and recording material changes.'],
      ['/induction/assessor', `School setup required (${openAlerts})`, 'Equipment staff have selected that is missing a PERA or SOP.'],
      ['/induction/matrix', 'Staff / equipment matrix', 'School-wide view of every staff member against every piece of equipment.'],
      ['/induction/training-required', `Training required (${trainingRequired.rows[0].count})`, 'Staff who have declared themselves not yet competent on an item.'],
      ['/induction/pending-verification', `Pending verification (${pendingVerification.rows[0].count})`, 'Self-assessed "competent" declarations an assessor hasn\'t verified yet.'],
    ];

    const body = `
      <h1 class="page-title">Staff Induction</h1>
      <p class="page-subtitle" style="margin-bottom:24px;">Equipment proficiency, induction and competency verification for ${escapeHtml(String(staffCount.rows[0].count))} staff across ${escapeHtml(String(itemCount.rows[0].count))} equipment items.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;margin-bottom:24px;">
        ${cards.map(([href, title, desc]) => `
          <a class="card" href="${href}" style="padding:20px;display:block;text-decoration:none;color:inherit;">
            <div style="font-weight:700;font-size:15px;color:#1A1D1B;margin-bottom:6px;">${escapeHtml(title)}</div>
            <div style="font-size:13px;color:#6B6659;">${escapeHtml(desc)}</div>
          </a>
        `).join('')}
      </div>
      ${req.staffUser.role === 'admin' || req.staffUser.role === 'approver' ? `
      <div class="card" style="padding:20px;">
        <div style="font-weight:700;font-size:14px;margin-bottom:10px;">Admin &amp; assessor tools</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <a href="/induction/review-queue" style="color:#1B5E52;font-weight:600;">Review queue — flagged profile changes &amp; pending verification →</a>
          <a href="/admin/induction/shared-topics" style="color:#1B5E52;font-weight:600;">Manage shared induction topics (emergency procedures, workshop rules) →</a>
          <a href="/admin/induction/items" style="color:#1B5E52;font-weight:600;">Manage the equipment induction list (link to PERA, hide items not at this school) →</a>
        </div>
      </div>` : ''}
    `;
    res.send(page({ title: 'Staff Induction', active: 'induction', body }));
  } catch (err) {
    next(err);
  }
});


// ---------- Induction: staff profile (Section 1 — equipment proficiency register) ----------

app.get('/induction/staff/:staffId', async (req, res, next) => {
  try {
    const staffId = Number(req.params.staffId);
    const isSelf = staffId === req.staffUser.id;
    if (!isSelf && !canActAsAssessor(req.staffUser.role)) {
      return res.status(403).send('You can only view your own induction profile. <a href="/induction">Back</a>');
    }
    const staffResult = await pool.query('SELECT id, name, email, role FROM staff_users WHERE id = $1', [staffId]);
    if (!staffResult.rows.length) return res.status(404).send('Staff member not found.');
    const staff = staffResult.rows[0];

    const [categories, declResult, verifResult, authResult, stepsResult] = await Promise.all([
      getInductionCategoriesWithItems(),
      pool.query('SELECT * FROM staff_induction_declarations WHERE staff_id = $1', [staffId]),
      pool.query('SELECT * FROM staff_induction_competency_verifications WHERE staff_id = $1', [staffId]),
      pool.query('SELECT * FROM staff_induction_authorisations WHERE staff_id = $1', [staffId]),
      pool.query(`SELECT induction_item_id, COUNT(*) FILTER (WHERE status = 'complete')::int AS done, COUNT(*)::int AS total
                  FROM staff_induction_steps WHERE staff_id = $1 GROUP BY induction_item_id`, [staffId]),
    ]);
    const declByItem = new Map(declResult.rows.map((d) => [d.induction_item_id, d]));
    const verifByItem = new Map(verifResult.rows.map((v) => [v.induction_item_id, v]));
    const authByItem = new Map();
    for (const a of authResult.rows) {
      if (!authByItem.has(a.induction_item_id)) authByItem.set(a.induction_item_id, {});
      authByItem.get(a.induction_item_id)[a.authorisation_type] = a;
    }
    const stepsByItem = new Map(stepsResult.rows.map((s) => [s.induction_item_id, s]));
    const simpleState = await simpleInduction.buildTeacherState(staffId, { raiseAlerts: false });
    const entryByItem = new Map(simpleState.entries.map((e) => [e.item.id, e]));

    const categoryBlocks = categories.map((cat) => `
      <div class="form-section-title" style="margin-top:24px;">${escapeHtml(cat.name)}</div>
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#6B6659;border-bottom:1px solid #E4DFD3;">
            <th style="padding:8px 6px;">Equipment / process</th>
            <th style="padding:8px 6px;">Self-assessed</th>
            <th style="padding:8px 6px;">Next required action</th>
            <th style="padding:8px 6px;">Verified competency</th>
            <th style="padding:8px 6px;">Authorised to operate</th>
            <th style="padding:8px 6px;">Authorised to supervise students</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${cat.items.map((item) => {
            const decl = declByItem.get(item.id);
            const status = decl ? decl.status : 'not_assessed';
            const verif = verifByItem.get(item.id);
            const auth = authByItem.get(item.id) || {};
            const steps = stepsByItem.get(item.id);
            const stepsText = steps ? `${steps.done}/5 steps` : '0/5 steps';
            return `
              <tr style="border-bottom:1px solid #F0EDE5;">
                <td style="padding:8px 6px;font-size:13px;">${escapeHtml(item.name)}</td>
                <td style="padding:8px 6px;"><span class="badge ${DECLARATION_BADGE[status]}">${escapeHtml(DECLARATION_LABELS[status])}</span></td>
                <td style="padding:8px 6px;font-size:12px;color:#6B6659;">
                  ${entryByItem.has(item.id)
                    ? `${simpleInduction.workflowBadge(entryByItem.get(item.id).workflow.key)}<div style="margin-top:3px;">${escapeHtml(entryByItem.get(item.id).workflow.next)}</div>`
                    : escapeHtml(status === 'NA' ? 'Not used' : 'Not selected')}
                  <details style="margin-top:3px;"><summary style="cursor:pointer;">View details</summary>Induction steps: ${escapeHtml(stepsText)}</details>
                </td>
                <td style="padding:8px 6px;"><span class="badge ${verif && verif.verified ? 'badge-approved' : 'badge-draft'}">${verif && verif.verified ? 'Verified' : 'Not verified'}</span></td>
                <td style="padding:8px 6px;"><span class="badge ${auth.operate && auth.operate.authorised ? 'badge-approved' : 'badge-draft'}">${auth.operate && auth.operate.authorised ? 'Yes' : 'No'}</span></td>
                <td style="padding:8px 6px;"><span class="badge ${auth.supervise_students && auth.supervise_students.authorised ? 'badge-approved' : 'badge-draft'}">${auth.supervise_students && auth.supervise_students.authorised ? 'Yes' : 'No'}</span></td>
                <td style="padding:8px 6px;text-align:right;"><a href="/induction/staff/${staffId}/item/${item.id}" style="color:#1B5E52;font-weight:600;font-size:13px;">Open →</a></td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    `).join('');

    const body = `
      <a class="back-link" href="${isSelf ? '/induction/me' : '/induction'}">← ${isSelf ? 'My induction' : 'Staff Induction'}</a>
      <div class="page-header">
        <div>
          <h1 class="page-title">${escapeHtml(staff.name)}${isSelf ? ' — detailed record' : ''}</h1>
          <p class="page-subtitle">${escapeHtml(staff.email)} · Faith Lutheran College${isSelf ? ' · This is your induction profile' : ''}</p>
        </div>
        <div style="display:flex;gap:10px;">
          <a class="btn btn-secondary" href="/induction/staff/${staffId}/print">Printable record</a>
          <a class="btn btn-secondary" href="/induction/staff/${staffId}/export.pdf">PDF export</a>
        </div>
      </div>
      ${profileNavLinks(staffId, isSelf)}
      <div class="note-box">Self-assessed ("C") is the staff member's own declaration only — it does not by itself authorise using the equipment or supervising students on it. Only a separate assessor-verified competency and school authorisation (right-hand columns) permit that.</div>
      <div class="card" style="padding:22px;">
        ${categoryBlocks}
      </div>
    `;
    res.send(page({ title: `${staff.name} — Induction`, active: 'induction', body }));
  } catch (err) {
    next(err);
  }
});

// ---------- Induction: per-item workspace (declaration, 5-step workflow,
// machine checklist, logbook, verification, authorisation — all for one
// staff member × one equipment item) ----------

async function getInductionItem(itemId) {
  const { rows } = await pool.query(
    `SELECT i.*, c.name AS category_name, p.activity_name AS pera_name
     FROM induction_equipment_items i
     JOIN induction_equipment_categories c ON c.id = i.category_id
     LEFT JOIN pera_records p ON p.id = i.pera_id
     WHERE i.id = $1`,
    [itemId]
  );
  return rows[0] || null;
}

function evidenceListHtml(evidenceRows, staffNameById) {
  if (!evidenceRows.length) return '<div class="form-section-hint" style="margin:4px 0 0;">No evidence attached.</div>';
  return `<div style="margin-top:6px;display:flex;flex-direction:column;gap:4px;">${evidenceRows.map((e) => `
    <div style="font-size:12px;color:#6B6659;">
      ${e.url ? `<a href="${escapeHtml(e.url)}" target="_blank" rel="noopener" style="color:#1B5E52;font-weight:600;">${escapeHtml(e.title)}</a>` : `<strong>${escapeHtml(e.title)}</strong>`}
      ${e.notes ? ` — ${escapeHtml(e.notes)}` : ''}
      <span style="color:#B0AA9A;"> · ${escapeHtml(staffNameById.get(e.added_by_staff_id) || 'Unknown')}, ${formatBrisbaneDateTime(e.added_at)}</span>
    </div>`).join('')}</div>`;
}

app.get('/induction/staff/:staffId/item/:itemId', async (req, res, next) => {
  try {
    const staffId = Number(req.params.staffId);
    const itemId = Number(req.params.itemId);
    const isSelf = staffId === req.staffUser.id;
    const isAssessor = canActAsAssessor(req.staffUser.role);
    const isSchoolLeader = canAuthoriseSchoolLeader(req.staffUser.role);
    if (!isSelf && !isAssessor) {
      return res.status(403).send('You can only view your own induction profile. <a href="/induction">Back</a>');
    }

    const [staffResult, item, allStaff] = await Promise.all([
      pool.query('SELECT id, name, email, role FROM staff_users WHERE id = $1', [staffId]),
      getInductionItem(itemId),
      getActiveStaffList(),
    ]);
    if (!staffResult.rows.length) return res.status(404).send('Staff member not found.');
    if (!item) return res.status(404).send('Equipment item not found.');
    const staff = staffResult.rows[0];
    const staffNameById = new Map(allStaff.map((s) => [s.id, s.name]));

    const physicalEquipment = item.pera_id
      ? (await pool.query('SELECT id, name, status FROM equipment_items WHERE pera_id = $1 ORDER BY name', [item.pera_id])).rows
      : [];

    const [decl, steps, template, logbook, target, verif, authRows, changeLog] = await Promise.all([
      pool.query('SELECT * FROM staff_induction_declarations WHERE staff_id = $1 AND induction_item_id = $2', [staffId, itemId]),
      pool.query('SELECT * FROM staff_induction_steps WHERE staff_id = $1 AND induction_item_id = $2 ORDER BY step_number', [staffId, itemId]),
      pool.query('SELECT * FROM induction_checklist_templates WHERE induction_item_id = $1 ORDER BY created_at DESC LIMIT 1', [itemId]),
      pool.query('SELECT * FROM induction_logbook_entries WHERE staff_id = $1 AND induction_item_id = $2 ORDER BY session_date DESC, id DESC', [staffId, itemId]),
      pool.query('SELECT * FROM induction_practice_targets WHERE staff_id = $1 AND induction_item_id = $2', [staffId, itemId]),
      pool.query('SELECT * FROM staff_induction_competency_verifications WHERE staff_id = $1 AND induction_item_id = $2', [staffId, itemId]),
      pool.query('SELECT * FROM staff_induction_authorisations WHERE staff_id = $1 AND induction_item_id = $2', [staffId, itemId]),
      pool.query('SELECT * FROM induction_change_log WHERE staff_id = $1 AND induction_item_id = $2 ORDER BY changed_at DESC LIMIT 25', [staffId, itemId]),
    ]);
    const declaration = decl.rows[0] || null;

    // Competency profile: what's already on file for this staff member that
    // applies to this item, any shared topics it draws on, and any unresolved
    // "this may need re-checking" flags -- shown read-only here; it's
    // pre-filled information, never a status by itself.
    const [profileAppsByItem, profileFlags, sharedTopicsResult, equipGroups] = await Promise.all([
      getProfileApplicationsByItem(staffId),
      pool.query('SELECT * FROM staff_profile_review_flags WHERE staff_id = $1 AND induction_item_id = $2 AND resolved = false ORDER BY created_at DESC', [staffId, itemId]),
      pool.query(
        `SELECT t.*, ack.acknowledged_at, ack.acknowledged_by_staff_id
         FROM induction_item_shared_topics its
         JOIN induction_shared_topics t ON t.id = its.topic_id AND t.archived = false
         LEFT JOIN staff_shared_topic_acknowledgements ack ON ack.topic_id = t.id AND ack.staff_id = $2
         WHERE its.induction_item_id = $1
         ORDER BY t.sort_order`,
        [itemId, staffId]
      ),
      getProfileEquipmentGroups(staffId),
    ]);
    const itemProfileApps = profileAppsByItem.get(itemId) || { evidence: [], licences: [] };
    const claimsGroupForItem = equipGroups.some((g) => g.category_id === item.category_id);

    const [itemProfileVersion, itemProfileLicences] = await Promise.all([getCurrentProfileVersion(staffId), getActiveLicences(staffId)]);
    const sourceProfilePanel = `
      <details class="card" style="padding:18px 22px;margin-bottom:16px;">
        <summary class="ind-summary">Supporting information from ${isSelf ? 'your' : `${escapeHtml(staff.name)}'s`} profile</summary>
        <div style="margin-top:12px;">${simpleInduction.profileSummaryHtml(itemProfileVersion, itemProfileLicences, { compact: true })}</div>
        <div class="form-section-hint" style="margin:10px 0 10px;">Entered once in the <a href="/induction/staff/${staffId}/profile" style="color:#1B5E52;font-weight:600;">profile</a> and reused here. It does not mark this item competent, verified or authorised.</div>
        ${profileFlags.rows.length ? `
        <div class="note-box" style="border-color:#C96A3A;color:#8A3E1C;">This item's profile information has changed since it was applied — flagged for review: ${profileFlags.rows.map((f) => escapeHtml(f.reason)).join('; ')}</div>
        ` : ''}
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
          <span class="badge ${claimsGroupForItem ? 'badge-approved' : 'badge-draft'}">${claimsGroupForItem ? 'Claims experience with this equipment group' : 'No equipment-group experience claimed'}</span>
        </div>
        ${itemProfileApps.licences.length ? `
          <div class="detail-value" style="margin-bottom:6px;"><strong>Licences applied:</strong> ${itemProfileApps.licences.map((l) => `${escapeHtml(l.name)}${l.expiry_date ? ` (expires ${formatBrisbaneDate(l.expiry_date)})` : ''}${l.active ? '' : ' — superseded'}`).join(', ')}</div>
        ` : ''}
        ${itemProfileApps.evidence.length ? `
          <div class="detail-value" style="margin-bottom:6px;"><strong>Evidence applied:</strong> ${itemProfileApps.evidence.map((e) => e.removed ? `<span style="color:#B0AA9A;">${escapeHtml(e.title)} (removed)</span>` : (e.url ? `<a href="${escapeHtml(e.url)}" target="_blank" rel="noopener" style="color:#1B5E52;font-weight:600;">${escapeHtml(e.title)}</a>` : escapeHtml(e.title))).join(', ')}</div>
        ` : ''}
        ${!itemProfileApps.licences.length && !itemProfileApps.evidence.length && !claimsGroupForItem ? '<div class="form-section-hint" style="margin:0;">Nothing from the profile has been applied to this item yet.</div>' : ''}
        ${sharedTopicsResult.rows.length ? `
        <div style="margin-top:14px;border-top:1px solid #E4DFD3;padding-top:12px;">
          <div style="font-weight:600;font-size:13px;margin-bottom:8px;">Shared topics for this equipment</div>
          ${sharedTopicsResult.rows.map((t) => `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid #F0EDE5;">
              <div>
                <strong style="font-size:13px;">${escapeHtml(t.name)}</strong>
                ${t.description ? `<div style="font-size:12px;color:#6B6659;">${escapeHtml(t.description)}</div>` : ''}
              </div>
              ${t.acknowledged_at
                ? `<span class="badge badge-approved" style="white-space:nowrap;">Acknowledged ${formatBrisbaneDate(t.acknowledged_at)}</span>`
                : (isSelf || req.staffUser.role === 'admin') ? `
                  <form method="post" action="/induction/staff/${staffId}/shared-topic/${t.id}/acknowledge" style="margin:0;">
                    <button type="submit" class="btn btn-secondary" style="white-space:nowrap;">Acknowledge</button>
                  </form>` : `<span class="badge badge-draft" style="white-space:nowrap;">Not acknowledged</span>`}
            </div>
          `).join('')}
        </div>
        ` : ''}
      </details>
    `;

    let criteria = [];
    let latestAssessment = null;
    let results = [];
    if (template.rows.length) {
      const tpl = template.rows[0];
      const [critResult, assessResult] = await Promise.all([
        pool.query('SELECT * FROM induction_checklist_criteria WHERE template_id = $1 ORDER BY sort_order', [tpl.id]),
        pool.query('SELECT * FROM staff_induction_assessments WHERE staff_id = $1 AND template_id = $2 ORDER BY id DESC LIMIT 1', [staffId, tpl.id]),
      ]);
      criteria = critResult.rows;
      latestAssessment = assessResult.rows[0] || null;
      if (latestAssessment) {
        results = (await pool.query('SELECT * FROM staff_induction_assessment_results WHERE assessment_id = $1', [latestAssessment.id])).rows;
      }
    }
    const resultByCriterion = new Map(results.map((r) => [r.criterion_id, r]));

    // Evidence: pull everything relevant to this staff+item in one go,
    // keyed by its context so each section below can find its own.
    const evidenceContextIds = {
      declaration: declaration ? [declaration.id] : [],
      step: steps.rows.map((s) => s.id),
      assessment: latestAssessment ? [latestAssessment.id] : [],
      verification: verif.rows.length ? [verif.rows[0].id] : [],
      authorisation: authRows.rows.map((a) => a.id),
      logbook: logbook.rows.map((l) => l.id),
    };
    const evidenceRows = {};
    for (const [ctxType, ids] of Object.entries(evidenceContextIds)) {
      if (!ids.length) { evidenceRows[ctxType] = new Map(); continue; }
      const r = await pool.query('SELECT * FROM staff_induction_evidence WHERE context_type = $1 AND context_id = ANY($2::int[]) ORDER BY added_at', [ctxType, ids]);
      const m = new Map();
      for (const row of r.rows) {
        if (!m.has(row.context_id)) m.set(row.context_id, []);
        m.get(row.context_id).push(row);
      }
      evidenceRows[ctxType] = m;
    }

    const staffOptions = allStaff.filter((s) => s.id !== staffId).map((s) => `<option value="${s.id}">${escapeHtml(s.name)} (${s.role})</option>`).join('');

    // ---- Declaration panel ----
    const declStatus = declaration ? declaration.status : 'not_assessed';
    const declarationPanel = `
      <div class="card" style="padding:22px;margin-bottom:20px;">
        <div class="form-section-title" style="margin-top:0;padding-top:0;border-top:none;">Self-assessed competence</div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
          <span class="badge ${DECLARATION_BADGE[declStatus]}">${escapeHtml(DECLARATION_LABELS[declStatus])}</span>
          ${declaration && declaration.declared_at ? `<span style="font-size:12px;color:#6B6659;">Declared ${formatBrisbaneDateTime(declaration.declared_at)}</span>` : ''}
        </div>
        ${declaration && declaration.qualifications_experience ? `<div class="detail-value" style="margin-bottom:8px;"><strong>Qualifications / experience:</strong> ${escapeHtml(declaration.qualifications_experience)}</div>` : ''}
        ${evidenceListHtml(declaration ? (evidenceRows.declaration.get(declaration.id) || []) : [], staffNameById)}
        <div style="margin-top:12px;font-size:13px;">
          HOD acknowledgement: ${declaration && declaration.hod_ack_staff_id
            ? `<span class="badge badge-approved">Acknowledged</span> <span style="color:#6B6659;">by ${escapeHtml(staffNameById.get(declaration.hod_ack_staff_id) || 'Unknown')}, ${formatBrisbaneDateTime(declaration.hod_ack_at)}</span>`
            : '<span class="badge badge-draft">Not yet acknowledged</span>'}
        </div>
        ${(isSelf || req.staffUser.role === 'admin') ? `
        <form method="post" action="/induction/staff/${staffId}/item/${itemId}/declare" style="margin-top:16px;border-top:1px solid #E4DFD3;padding-top:16px;">
          <div class="form-row">
            <label for="decl_status">Rate your competence</label>
            <select id="decl_status" name="status">
              ${Object.keys(DECLARATION_LABELS).map((k) => `<option value="${k}" ${declStatus === k ? 'selected' : ''}>${escapeHtml(DECLARATION_LABELS[k])}</option>`).join('')}
            </select>
          </div>
          <div class="form-row">
            <label for="decl_quals">Qualifications / experience (required for "C")</label>
            <textarea id="decl_quals" name="qualifications_experience" placeholder="e.g. Cert III Cabinet Making 2014; 8 years classroom use">${escapeHtml(declaration ? declaration.qualifications_experience || '' : '')}</textarea>
          </div>
          <div class="form-row"><label for="decl_ev_title">Evidence title (optional)</label><input type="text" id="decl_ev_title" name="evidence_title" placeholder="e.g. Trade certificate scan"></div>
          <div class="form-row"><label for="decl_ev_url">Evidence link (optional)</label><input type="text" id="decl_ev_url" name="evidence_url" placeholder="https://..."></div>
          <div class="form-row"><label for="decl_ev_notes">Evidence / comments (optional)</label><textarea id="decl_ev_notes" name="evidence_notes"></textarea></div>
          <div class="form-actions"><button type="submit" class="btn btn-primary">Save declaration</button></div>
        </form>` : ''}
        ${(isAssessor && !isSelf && declaration) ? `
        <form method="post" action="/induction/staff/${staffId}/item/${itemId}/declare/acknowledge" style="margin-top:12px;">
          <button type="submit" class="btn btn-secondary">${declaration.hod_ack_staff_id ? 'Re-acknowledge' : 'Acknowledge this declaration (HOD)'}</button>
        </form>` : ''}
      </div>
    `;

    // ---- 5-step induction workflow ----
    const stepByNumber = new Map(steps.rows.map((s) => [s.step_number, s]));
    const stepsPanel = `
      <div class="card" style="padding:22px;margin-bottom:20px;">
        <div class="form-section-title" style="margin-top:0;padding-top:0;border-top:none;">Equipment induction process</div>
        <div class="note-box">Required once an item is declared "NYC" — but an assessor can also use this to document a review pathway for an experienced staff member (e.g. "prior trade qualification sighted") rather than repeating every step from scratch.</div>
        ${[1, 2, 3, 4, 5].map((n) => {
          const s = stepByNumber.get(n) || { status: 'not_started' };
          const canEditStep = isAssessor && !isSelf;
          return `
          <div style="border-top:1px solid #E4DFD3;padding:14px 0;">
            <div style="display:flex;align-items:center;gap:10px;">
              <span class="badge ${STEP_STATUS_BADGE[s.status]}">${escapeHtml(STEP_STATUS_LABELS[s.status])}</span>
              <strong style="font-size:13px;">${n}. ${escapeHtml(INDUCTION_STEP_LABELS[n])}</strong>
            </div>
            ${s.completed_at ? `<div style="font-size:12px;color:#6B6659;margin-top:4px;">Completed ${formatBrisbaneDateTime(s.completed_at)}${s.responsible_staff_id ? ` by ${escapeHtml(staffNameById.get(s.responsible_staff_id) || 'Unknown')}` : ''}</div>` : ''}
            ${s.notes ? `<div class="detail-value" style="margin-top:4px;">${escapeHtml(s.notes)}</div>` : ''}
            ${evidenceListHtml(s.id ? (evidenceRows.step.get(s.id) || []) : [], staffNameById)}
            ${n === 5 ? `
              <div style="margin-top:8px;font-size:12px;color:#6B6659;">
                Inductee sign-off: ${s.inductee_signed_staff_id ? `<span class="badge badge-approved">Signed</span> ${escapeHtml(staffNameById.get(s.inductee_signed_staff_id) || '')}, ${formatBrisbaneDateTime(s.inductee_signed_at)}` : '<span class="badge badge-draft">Not signed</span>'}<br>
                Inductor sign-off: ${s.inductor_signed_staff_id ? `<span class="badge badge-approved">Signed</span> ${escapeHtml(staffNameById.get(s.inductor_signed_staff_id) || '')}, ${formatBrisbaneDateTime(s.inductor_signed_at)}` : '<span class="badge badge-draft">Not signed</span>'}
              </div>
              <div style="display:flex;gap:8px;margin-top:8px;">
                ${isSelf && !s.inductee_signed_staff_id ? `<form method="post" action="/induction/staff/${staffId}/item/${itemId}/step/5/sign"><input type="hidden" name="role" value="inductee"><button type="submit" class="btn btn-secondary">Sign as inductee</button></form>` : ''}
                ${isAssessor && !isSelf && !s.inductor_signed_staff_id ? `<form method="post" action="/induction/staff/${staffId}/item/${itemId}/step/5/sign"><input type="hidden" name="role" value="inductor"><button type="submit" class="btn btn-secondary">Sign as inductor</button></form>` : ''}
              </div>
            ` : ''}
            ${canEditStep ? `
            <form method="post" action="/induction/staff/${staffId}/item/${itemId}/step/${n}" style="margin-top:10px;background:#FAF8F3;padding:12px;border-radius:8px;">
              <div class="form-row">
                <label>Status</label>
                <select name="status">
                  ${Object.keys(STEP_STATUS_LABELS).map((k) => `<option value="${k}" ${s.status === k ? 'selected' : ''}>${escapeHtml(STEP_STATUS_LABELS[k])}</option>`).join('')}
                </select>
              </div>
              <div class="form-row"><label>Responsible person</label><select name="responsible_staff_id"><option value="">— None —</option>${allStaff.map((st) => `<option value="${st.id}" ${s.responsible_staff_id === st.id ? 'selected' : ''}>${escapeHtml(st.name)}</option>`).join('')}</select></div>
              <div class="form-row"><label>Notes</label><textarea name="notes" placeholder="What was covered / observed">${escapeHtml(s.notes || '')}</textarea></div>
              <div class="form-row"><label>Session date (optional — logs a dated session without changing overall status)</label><input type="date" name="session_date"></div>
              <div class="form-row"><label>Evidence title (optional)</label><input type="text" name="evidence_title"></div>
              <div class="form-row"><label>Evidence link (optional)</label><input type="text" name="evidence_url"></div>
              <div class="form-actions"><button type="submit" class="btn btn-primary">Save step ${n}</button></div>
            </form>` : ''}
          </div>`;
        }).join('')}
      </div>
    `;

    // ---- Machine competency checklist ----
    const checklistPanel = `
      <div class="card" style="padding:22px;margin-bottom:20px;">
        <div class="form-section-title" style="margin-top:0;padding-top:0;border-top:none;">Machine competency checklist</div>
        ${!template.rows.length ? `
          <div class="form-section-hint" style="margin:0;">No checklist template yet for this equipment type.</div>
          ${isAssessor ? `<a class="btn btn-secondary" href="/induction/item/${itemId}/checklist" style="margin-top:10px;display:inline-block;">Create a checklist template</a>` : ''}
        ` : `
          <div style="font-size:12px;color:#6B6659;margin-bottom:10px;">
            ${criteria.length} criteria · ${template.rows[0].approved_at ? `<span class="badge badge-approved">Approved</span> by ${escapeHtml(staffNameById.get(template.rows[0].approved_by_staff_id) || 'Unknown')}, ${formatBrisbaneDateTime(template.rows[0].approved_at)}` : '<span class="badge badge-pending">Draft — not yet approved</span>'}
            ${isAssessor ? ` · <a href="/induction/item/${itemId}/checklist" style="color:#1B5E52;font-weight:600;">Edit template →</a>` : ''}
          </div>
          ${!criteria.length ? '<div class="form-section-hint" style="margin:0;">No criteria added yet — nothing can be assessed until a competent person adds some.</div>' : `
            ${latestAssessment ? `
              <div style="font-size:12px;color:#6B6659;margin-bottom:8px;">
                Assessment ${latestAssessment.status === 'complete' ? `<span class="badge badge-approved">Complete</span>` : `<span class="badge badge-pending">In progress</span>`}
                ${latestAssessment.assessor_staff_id ? ` · Assessor: ${escapeHtml(staffNameById.get(latestAssessment.assessor_staff_id) || 'Unknown')}` : ''}
                ${latestAssessment.assessment_date ? ` · ${formatBrisbaneDate(latestAssessment.assessment_date)}` : ''}
              </div>
            ` : '<div class="form-section-hint" style="margin:0 0 8px;">No assessment started yet.</div>'}
            <table style="width:100%;border-collapse:collapse;margin-bottom:10px;">
              <tbody>
                ${criteria.map((c) => {
                  const r = resultByCriterion.get(c.id);
                  const result = r ? r.result : 'not_assessed';
                  return `<tr style="border-bottom:1px solid #F0EDE5;">
                    <td style="padding:6px;font-size:13px;">${escapeHtml(c.description)}</td>
                    <td style="padding:6px;"><span class="badge ${ASSESSMENT_RESULT_BADGE[result]}">${escapeHtml(ASSESSMENT_RESULT_LABELS[result])}</span>${r && r.na_reason ? ` <span style="font-size:11px;color:#6B6659;">(${escapeHtml(r.na_reason)})</span>` : ''}</td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
            ${latestAssessment && latestAssessment.operating_restrictions ? `<div class="detail-value"><strong>Operating restrictions:</strong> ${escapeHtml(latestAssessment.operating_restrictions)}</div>` : ''}
            ${latestAssessment && latestAssessment.comments ? `<div class="detail-value" style="margin-top:4px;"><strong>Assessor comments:</strong> ${escapeHtml(latestAssessment.comments)}</div>` : ''}
            ${latestAssessment && latestAssessment.assessor_competence_evidence ? `<div class="detail-value" style="margin-top:4px;"><strong>Assessor's competence/evidence:</strong> ${escapeHtml(latestAssessment.assessor_competence_evidence)}</div>` : ''}
            ${isAssessor && !isSelf ? `
            <form method="post" action="/induction/staff/${staffId}/item/${itemId}/assessment/save" style="margin-top:14px;border-top:1px solid #E4DFD3;padding-top:14px;">
              <div class="form-section-title" style="margin-top:0;padding-top:0;border-top:none;font-size:13px;">Record / update assessment</div>
              ${criteria.map((c) => {
                const r = resultByCriterion.get(c.id);
                const result = r ? r.result : 'not_assessed';
                return `
                <div class="form-row">
                  <label>${escapeHtml(c.description)}</label>
                  <select name="result_${c.id}">
                    ${Object.keys(ASSESSMENT_RESULT_LABELS).map((k) => `<option value="${k}" ${result === k ? 'selected' : ''}>${escapeHtml(ASSESSMENT_RESULT_LABELS[k])}</option>`).join('')}
                  </select>
                  <input type="text" name="na_reason_${c.id}" placeholder="Reason if Not applicable" value="${escapeHtml(r ? r.na_reason || '' : '')}" style="margin-top:4px;">
                </div>`;
              }).join('')}
              <div class="form-row"><label>Assessor's relevant competence / supporting evidence</label><textarea name="assessor_competence_evidence">${escapeHtml(latestAssessment ? latestAssessment.assessor_competence_evidence || '' : '')}</textarea></div>
              <div class="form-row"><label>Operating restrictions (if any)</label><textarea name="operating_restrictions">${escapeHtml(latestAssessment ? latestAssessment.operating_restrictions || '' : '')}</textarea></div>
              <div class="form-row"><label>Comments</label><textarea name="comments">${escapeHtml(latestAssessment ? latestAssessment.comments || '' : '')}</textarea></div>
              <div class="form-row"><label>Assessment date</label><input type="date" name="assessment_date" value="${latestAssessment && latestAssessment.assessment_date ? new Date(latestAssessment.assessment_date).toISOString().slice(0, 10) : ''}"></div>
              <div class="form-row" style="flex-direction:row;align-items:center;gap:8px;"><input type="checkbox" name="mark_complete" id="mark_complete" style="width:auto;"><label for="mark_complete" style="margin:0;">Mark this assessment complete (only allowed once every criterion above has a result)</label></div>
              <div class="form-actions"><button type="submit" class="btn btn-primary">Save assessment</button></div>
            </form>` : ''}
          `}
        `}
      </div>
    `;

    // ---- Supervised equipment logbook ----
    const totalVerifiedMinutes = logbook.rows.filter((l) => l.verified).reduce((sum, l) => sum + l.duration_minutes, 0);
    const targetRow = target.rows[0];
    const logbookPanel = `
      <div class="card" style="padding:22px;margin-bottom:20px;">
        <div class="form-section-title" style="margin-top:0;padding-top:0;border-top:none;">Supervised equipment logbook</div>
        <div style="font-size:13px;margin-bottom:10px;">
          Verified practice: <strong>${formatHours(totalVerifiedMinutes)}</strong>${targetRow ? ` of ${formatHours(targetRow.target_minutes)} agreed nominal hours` : ' · No nominal hours agreed yet'}
          ${targetRow ? `<div style="font-size:11px;color:#6B6659;margin-top:2px;">Agreed by ${escapeHtml(staffNameById.get(targetRow.agreed_by_staff_id) || 'Unknown')}, ${formatBrisbaneDateTime(targetRow.agreed_at)}. Reaching this target does not by itself award competency.</div>` : ''}
        </div>
        ${isAssessor && !isSelf ? `
        <form method="post" action="/induction/staff/${staffId}/item/${itemId}/target" style="margin-bottom:14px;">
          <div class="form-row" style="flex-direction:row;gap:8px;align-items:flex-end;">
            <div style="flex:1;"><label>Agreed nominal practice hours</label><input type="number" step="0.1" min="0.1" name="target_hours" value="${targetRow ? (targetRow.target_minutes / 60) : ''}"></div>
            <button type="submit" class="btn btn-secondary">Set target</button>
          </div>
        </form>` : ''}
        <table style="width:100%;border-collapse:collapse;margin-bottom:12px;">
          <thead><tr style="text-align:left;font-size:11px;text-transform:uppercase;color:#6B6659;border-bottom:1px solid #E4DFD3;"><th style="padding:6px;">Date</th><th style="padding:6px;">Task</th><th style="padding:6px;">Duration</th><th style="padding:6px;">Supervisor</th><th style="padding:6px;">Verified</th></tr></thead>
          <tbody>
            ${logbook.rows.length ? logbook.rows.map((l) => `
              <tr style="border-bottom:1px solid #F0EDE5;">
                <td style="padding:6px;font-size:13px;">${formatBrisbaneDate(l.session_date)}</td>
                <td style="padding:6px;font-size:13px;">${escapeHtml(l.task_description)}${l.feedback ? `<div style="font-size:11px;color:#6B6659;">${escapeHtml(l.feedback)}</div>` : ''}${evidenceListHtml(evidenceRows.logbook.get(l.id) || [], staffNameById)}</td>
                <td style="padding:6px;font-size:13px;">${formatHours(l.duration_minutes)}</td>
                <td style="padding:6px;font-size:13px;">${escapeHtml(staffNameById.get(l.supervisor_staff_id) || '—')}</td>
                <td style="padding:6px;">
                  ${l.verified ? `<span class="badge badge-approved">Verified</span>` : `<span class="badge badge-draft">Unverified</span>`}
                  ${(!l.verified && isAssessor && req.staffUser.id !== staffId) ? `<form method="post" action="/induction/staff/${staffId}/item/${itemId}/logbook/${l.id}/verify" style="margin-top:4px;"><button type="submit" class="btn btn-secondary" style="font-size:11px;padding:4px 8px;">Verify</button></form>` : ''}
                </td>
              </tr>`).join('') : '<tr><td colspan="5" style="padding:6px;font-size:13px;color:#6B6659;">No sessions logged yet.</td></tr>'}
          </tbody>
        </table>
        ${isSelf || isAssessor ? `
        <form method="post" action="/induction/staff/${staffId}/item/${itemId}/logbook" style="border-top:1px solid #E4DFD3;padding-top:14px;">
          <div class="form-section-title" style="margin-top:0;padding-top:0;border-top:none;font-size:13px;">Log a session</div>
          <div class="form-row"><label>Physical equipment (optional)</label><select name="equipment_id"><option value="">— Not specified —</option>${physicalEquipment.map((e) => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('')}</select></div>
          <div class="form-row"><label>Date</label><input type="date" name="session_date" required></div>
          <div class="form-row"><label>Task / process completed</label><textarea name="task_description" required></textarea></div>
          <div class="form-row"><label>Duration (hours)</label><input type="number" step="0.1" min="0.1" name="duration_hours" required></div>
          <div class="form-row"><label>Supervisor</label><select name="supervisor_staff_id"><option value="">— None —</option>${allStaff.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}</select></div>
          <div class="form-row"><label>Feedback</label><textarea name="feedback"></textarea></div>
          <div class="form-row"><label>Evidence title (optional)</label><input type="text" name="evidence_title"></div>
          <div class="form-row"><label>Evidence link (optional)</label><input type="text" name="evidence_url"></div>
          <div class="form-actions"><button type="submit" class="btn btn-primary">Add logbook entry</button></div>
        </form>` : ''}
      </div>
    `;

    // ---- Verification & authorisation ----
    const verification = verif.rows[0];
    const authByType = {};
    for (const a of authRows.rows) authByType[a.authorisation_type] = a;
    const verificationPanel = `
      <div class="card" style="padding:22px;margin-bottom:20px;">
        <div class="form-section-title" style="margin-top:0;padding-top:0;border-top:none;">Assessor-verified competency</div>
        <div style="margin-bottom:10px;">
          <span class="badge ${verification && verification.verified ? 'badge-approved' : 'badge-draft'}">${verification && verification.verified ? 'Verified' : 'Not verified'}</span>
          ${verification && verification.verified ? ` <span style="font-size:12px;color:#6B6659;">by ${escapeHtml(staffNameById.get(verification.verified_by_staff_id) || 'Unknown')}, ${formatBrisbaneDateTime(verification.verified_at)}</span>` : ''}
        </div>
        ${verification && verification.basis ? `<div class="detail-value"><strong>Basis:</strong> ${escapeHtml(verification.basis)}</div>` : ''}
        ${verification && verification.notes ? `<div class="detail-value" style="margin-top:4px;">${escapeHtml(verification.notes)}</div>` : ''}
        ${verification && verification.review_date ? `<div style="font-size:12px;color:#6B6659;margin-top:4px;">Review due ${formatBrisbaneDate(verification.review_date)}</div>` : ''}
        ${isAssessor && !isSelf ? `
        <form method="post" action="/induction/staff/${staffId}/item/${itemId}/verify" style="margin-top:14px;border-top:1px solid #E4DFD3;padding-top:14px;">
          <div class="form-row" style="flex-direction:row;align-items:center;gap:8px;"><input type="checkbox" name="verified" id="verified" style="width:auto;" ${verification && verification.verified ? 'checked' : ''}><label for="verified" style="margin:0;">Competency verified</label></div>
          <div class="form-row"><label>Basis (e.g. machine checklist completed, prior qualification reviewed)</label><input type="text" name="basis" value="${escapeHtml(verification ? verification.basis || '' : '')}"></div>
          <div class="form-row"><label>Notes</label><textarea name="notes">${escapeHtml(verification ? verification.notes || '' : '')}</textarea></div>
          <div class="form-row"><label>Review date</label><input type="date" name="review_date" value="${verification && verification.review_date ? new Date(verification.review_date).toISOString().slice(0, 10) : ''}"></div>
          <div class="form-actions"><button type="submit" class="btn btn-primary">Save verification</button></div>
        </form>` : ''}
      </div>
      <div class="card" style="padding:22px;margin-bottom:20px;">
        <div class="form-section-title" style="margin-top:0;padding-top:0;border-top:none;">School authorisation</div>
        ${['operate', 'supervise_students'].map((type) => {
          const a = authByType[type];
          const label = type === 'operate' ? 'Authorised to operate this equipment' : 'Authorised to supervise student use';
          return `
          <div style="border-top:1px solid #E4DFD3;padding:14px 0;">
            <div style="font-weight:600;font-size:13px;margin-bottom:6px;">${label}</div>
            <span class="badge ${a && a.authorised ? 'badge-approved' : 'badge-draft'}">${a && a.authorised ? 'Authorised' : 'Not authorised'}</span>
            ${a && a.authorised ? ` <span style="font-size:12px;color:#6B6659;">by ${escapeHtml(staffNameById.get(a.decision_by_staff_id) || 'Unknown')}, ${formatBrisbaneDateTime(a.decision_at)}</span>` : ''}
            ${a && a.permitted_operations ? `<div class="detail-value" style="margin-top:4px;"><strong>Permitted:</strong> ${escapeHtml(a.permitted_operations)}</div>` : ''}
            ${a && a.restrictions ? `<div class="detail-value" style="margin-top:4px;"><strong>Restrictions:</strong> ${escapeHtml(a.restrictions)}</div>` : ''}
            ${a && a.review_date ? `<div style="font-size:12px;color:#6B6659;margin-top:4px;">Review due ${formatBrisbaneDate(a.review_date)}</div>` : ''}
            ${evidenceListHtml(a ? (evidenceRows.authorisation.get(a.id) || []) : [], staffNameById)}
            ${isSchoolLeader && !isSelf ? `
            <form method="post" action="/induction/staff/${staffId}/item/${itemId}/authorise" style="margin-top:10px;background:#FAF8F3;padding:12px;border-radius:8px;">
              <input type="hidden" name="authorisation_type" value="${type}">
              <div class="form-row" style="flex-direction:row;align-items:center;gap:8px;"><input type="checkbox" name="authorised" id="auth_${type}" style="width:auto;" ${a && a.authorised ? 'checked' : ''}><label for="auth_${type}" style="margin:0;">${label}</label></div>
              <div class="form-row"><label>Permitted operations</label><textarea name="permitted_operations">${escapeHtml(a ? a.permitted_operations || '' : '')}</textarea></div>
              <div class="form-row"><label>Restrictions</label><textarea name="restrictions">${escapeHtml(a ? a.restrictions || '' : '')}</textarea></div>
              <div class="form-row"><label>Review date</label><input type="date" name="review_date" value="${a && a.review_date ? new Date(a.review_date).toISOString().slice(0, 10) : ''}"></div>
              <div class="form-actions"><button type="submit" class="btn btn-primary">Save authorisation</button></div>
            </form>` : ''}
          </div>`;
        }).join('')}
      </div>
    `;

    const changeLogPanel = `
      <details class="card" style="padding:22px;">
        <summary class="form-section-title" style="cursor:pointer;margin-top:0;padding-top:0;border-top:none;">Change history</summary>
        ${changeLog.rows.length ? `<div style="margin-top:12px;display:flex;flex-direction:column;gap:8px;">${changeLog.rows.map((c) => `
          <div style="font-size:12px;color:#6B6659;border-bottom:1px solid #F0EDE5;padding-bottom:8px;">
            <strong style="color:#1A1D1B;">${escapeHtml(c.summary)}</strong><br>
            ${escapeHtml(staffNameById.get(c.changed_by_staff_id) || 'Unknown')} · ${formatBrisbaneDateTime(c.changed_at)}
          </div>`).join('')}</div>` : '<div class="form-section-hint" style="margin:8px 0 0;">No changes recorded yet.</div>'}
      </details>
    `;

    // Simplified layout: a short summary first, then every detailed form in
    // its own expandable section. Training/logbook sections are only shown
    // to the teacher once training is assigned or requested (or if records
    // already exist, so nothing previously entered is hidden).
    const itemState = await simpleInduction.buildTeacherState(staffId, { raiseAlerts: false });
    const entry = itemState.entries.find((e) => e.item.id === itemId) || null;
    const trainingActive = Boolean(entry && (entry.workflow.key === 'training' || entry.openRequests.some((r) => r.request_type === 'training')))
      || steps.rows.length > 0 || logbook.rows.length > 0;
    const showTraining = !isSelf || trainingActive;
    const section = (title, inner, open = false) => `
      <details class="ind-detail-wrap" ${open ? 'open' : ''}>
        <summary class="ind-detail-summary">${escapeHtml(title)}</summary>
        ${inner}
      </details>`;
    const summaryCard = `
      <div class="card" style="padding:20px;margin-bottom:16px;">
        ${entry ? `
          <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start;">
            <div>
              <div>${simpleInduction.workflowBadge(entry.workflow.key)}</div>
              <div style="margin-top:6px;font-weight:600;">Next: ${escapeHtml(entry.workflow.next)}</div>
              <div class="ind-muted" style="margin-top:4px;">Self-assessment: ${escapeHtml(simpleInduction.ANSWER_LABELS[entry.decl.status] || '')}</div>
            </div>
            ${simpleInduction.permissionIndicators(entry)}
          </div>
          <div style="margin-top:12px;border-top:1px solid #F0EDE5;padding-top:10px;font-size:13px;">
            <strong>PERA / SOP:</strong> ${simpleInduction.ackStatusText(entry.docState, entry.ack)}
            ${entry.docState === 'missing' ? `<div class="ind-setup" style="margin-top:6px;">School setup required. ${escapeHtml(entry.docs.missing.map((m) => m.detail).join(' '))}</div>`
              : `<span class="ind-muted"> · ${escapeHtml(entry.docs.peraVersion.version_label)} · SOP ${escapeHtml(entry.docs.sopVersion.version_label)}</span>
                 ${isSelf && entry.docState !== 'acknowledged' ? ' · <a class="ind-link" href="/induction/me/documents">Review documents →</a>' : ''}`}
          </div>
          ${entry.openRequests.length ? `<div style="margin-top:10px;">${entry.openRequests.map((r) => `<div class="ind-update"><strong>${r.request_type === 'evidence' ? 'Evidence requested' : 'Training assigned'}</strong>${r.details ? `: ${escapeHtml(r.details)}` : ''}</div>`).join('')}</div>` : ''}
        ` : `
          <div class="ind-muted">${isSelf ? 'You haven\'t selected this equipment as equipment you use.' : 'Not selected by this staff member.'}${isSelf ? ' <a class="ind-link" href="/induction/me/equipment">Update my equipment →</a>' : ''}</div>
          <div style="margin-top:8px;font-size:12px;">Authorised to operate: <strong>${authRows.rows.some((a) => a.authorisation_type === 'operate' && a.authorised) ? 'Yes' : 'No'}</strong> · Authorised to supervise students: <strong>${authRows.rows.some((a) => a.authorisation_type === 'supervise_students' && a.authorised) ? 'Yes' : 'No'}</strong></div>
        `}
      </div>`;

    const body = `
      <a class="back-link" href="${isSelf ? '/induction/me' : `/induction/assessor/staff/${staffId}`}">← ${isSelf ? 'My induction' : `Review — ${escapeHtml(staff.name)}`}</a>
      <div class="page-header">
        <div>
          <h1 class="page-title">${escapeHtml(item.name)}</h1>
          <p class="page-subtitle">${escapeHtml(item.category_name)}${item.pera_name ? ` · Linked PERA: ${escapeHtml(item.pera_name)}` : ' · No PERA linked yet'} · For ${escapeHtml(staff.name)}</p>
        </div>
      </div>
      ${summaryCard}
      ${physicalEquipment.length ? `
      <div class="note-box">Physical equipment covered by this PERA: ${physicalEquipment.map((e) => `<a href="/equipment/${e.id}" style="color:#1B5E52;font-weight:600;">${escapeHtml(e.name)}</a> (${escapeHtml(e.status)})`).join(', ')}</div>
      ` : ''}
      ${sourceProfilePanel}
      ${section('Self-assessment and evidence', declarationPanel)}
      ${showTraining ? section('Training sessions (induction steps)', stepsPanel, isSelf && trainingActive) : ''}
      ${showTraining || template.rows.length ? section('Machine competency checklist', checklistPanel) : ''}
      ${showTraining ? section('Supervised logbook', logbookPanel, isSelf && trainingActive) : ''}
      ${section('Verification and authorisation', verificationPanel)}
      ${changeLogPanel}
      ${simpleInduction.clientCss()}
      <style>
        .ind-detail-wrap{margin-bottom:12px}
        .ind-detail-wrap>summary.ind-detail-summary{cursor:pointer;font-weight:700;font-size:14px;padding:14px 18px;background:#fff;border:1px solid #E4DFD3;border-radius:10px;margin-bottom:8px}
        .ind-detail-wrap[open]>summary.ind-detail-summary{border-bottom-left-radius:0;border-bottom-right-radius:0}
      </style>
    `;
    res.send(page({ title: `${item.name} — ${staff.name}`, active: 'induction', body }));
  } catch (err) {
    next(err);
  }
});

// ---------- Induction: declaration ----------

app.post('/induction/staff/:staffId/item/:itemId/declare', async (req, res, next) => {
  try {
    const staffId = Number(req.params.staffId);
    const itemId = Number(req.params.itemId);
    const isSelf = staffId === req.staffUser.id;
    if (!isSelf && req.staffUser.role !== 'admin') {
      return res.status(403).send('Only the staff member themselves (or an admin) can record this declaration. <a href="javascript:history.back()">Back</a>');
    }
    const { status, qualifications_experience, evidence_title, evidence_url, evidence_notes } = req.body;
    if (!['not_assessed', 'C', 'NYC', 'NA'].includes(status)) return res.status(400).send('Invalid status.');
    if (status === 'C' && !normalizeText(qualifications_experience || '').trim()) {
      return res.status(400).send('A "C — Self-assessed competent" declaration needs the qualifications/experience that support it. <a href="javascript:history.back()">Back</a>');
    }

    const { rows } = await pool.query(
      `INSERT INTO staff_induction_declarations (staff_id, induction_item_id, status, qualifications_experience, declared_at)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (staff_id, induction_item_id) DO UPDATE SET
         status = EXCLUDED.status, qualifications_experience = EXCLUDED.qualifications_experience,
         declared_at = now(), updated_at = now()
       RETURNING id`,
      [staffId, itemId, status, normalizeText(qualifications_experience) || null]
    );
    const declarationId = rows[0].id;

    if (normalizeText(evidence_title || '').trim()) {
      await pool.query(
        `INSERT INTO staff_induction_evidence (context_type, context_id, title, url, notes, added_by_staff_id) VALUES ('declaration',$1,$2,$3,$4,$5)`,
        [declarationId, normalizeText(evidence_title), normalizeText(evidence_url) || null, normalizeText(evidence_notes) || null, req.staffUser.id]
      );
    }

    await logInductionChange({
      staffId, inductionItemId: itemId, contextType: 'declaration', contextId: declarationId,
      summary: `Self-declaration set to "${DECLARATION_LABELS[status]}"`, changedByStaffId: req.staffUser.id,
    });

    res.redirect(`/induction/staff/${staffId}/item/${itemId}`);
  } catch (err) {
    next(err);
  }
});

app.post('/induction/staff/:staffId/item/:itemId/declare/acknowledge', async (req, res, next) => {
  try {
    const staffId = Number(req.params.staffId);
    const itemId = Number(req.params.itemId);
    if (!canActAsAssessor(req.staffUser.role)) return res.status(403).send('You do not have permission to do that.');
    if (blockSelfAction(res, req.staffUser.id, staffId)) return;

    const { rows } = await pool.query(
      `UPDATE staff_induction_declarations SET hod_ack_staff_id = $1, hod_ack_at = now(), updated_at = now()
       WHERE staff_id = $2 AND induction_item_id = $3 RETURNING id`,
      [req.staffUser.id, staffId, itemId]
    );
    if (!rows.length) return res.status(404).send('No declaration to acknowledge yet.');

    await logInductionChange({
      staffId, inductionItemId: itemId, contextType: 'declaration', contextId: rows[0].id,
      summary: 'Declaration acknowledged by HOD', changedByStaffId: req.staffUser.id,
    });
    res.redirect(`/induction/staff/${staffId}/item/${itemId}`);
  } catch (err) {
    next(err);
  }
});

// ---------- Induction: five-step workflow ----------

app.post('/induction/staff/:staffId/item/:itemId/step/:stepNumber', async (req, res, next) => {
  try {
    const staffId = Number(req.params.staffId);
    const itemId = Number(req.params.itemId);
    const stepNumber = Number(req.params.stepNumber);
    if (!canActAsAssessor(req.staffUser.role)) return res.status(403).send('You do not have permission to do that.');
    if (blockSelfAction(res, req.staffUser.id, staffId)) return;
    if (!(stepNumber >= 1 && stepNumber <= 5)) return res.status(400).send('Invalid step.');

    const { status, responsible_staff_id, notes, session_date, evidence_title, evidence_url } = req.body;
    if (!['not_started', 'in_progress', 'complete'].includes(status)) return res.status(400).send('Invalid status.');

    const { rows } = await pool.query(
      `INSERT INTO staff_induction_steps (staff_id, induction_item_id, step_number, status, completed_at, responsible_staff_id, notes, updated_at)
       VALUES ($1,$2,$3,$4,CASE WHEN $4 = 'complete' THEN now() ELSE NULL END,$5,$6,now())
       ON CONFLICT (staff_id, induction_item_id, step_number) DO UPDATE SET
         status = EXCLUDED.status,
         completed_at = CASE WHEN EXCLUDED.status = 'complete' THEN now() ELSE NULL END,
         responsible_staff_id = EXCLUDED.responsible_staff_id, notes = EXCLUDED.notes, updated_at = now()
       RETURNING id`,
      [staffId, itemId, stepNumber, status, responsible_staff_id || null, normalizeText(notes) || null]
    );
    const stepId = rows[0].id;

    if (session_date) {
      await pool.query(
        `INSERT INTO staff_induction_step_sessions (step_id, session_date, notes, recorded_by_staff_id) VALUES ($1,$2,$3,$4)`,
        [stepId, session_date, normalizeText(notes) || null, req.staffUser.id]
      );
    }
    if (normalizeText(evidence_title || '').trim()) {
      await pool.query(
        `INSERT INTO staff_induction_evidence (context_type, context_id, title, url, added_by_staff_id) VALUES ('step',$1,$2,$3,$4)`,
        [stepId, normalizeText(evidence_title), normalizeText(evidence_url) || null, req.staffUser.id]
      );
    }

    await logInductionChange({
      staffId, inductionItemId: itemId, contextType: 'step', contextId: stepId,
      summary: `Step ${stepNumber} (${INDUCTION_STEP_LABELS[stepNumber]}) set to "${STEP_STATUS_LABELS[status]}"`,
      changedByStaffId: req.staffUser.id,
    });
    res.redirect(`/induction/staff/${staffId}/item/${itemId}`);
  } catch (err) {
    next(err);
  }
});

app.post('/induction/staff/:staffId/item/:itemId/step/5/sign', async (req, res, next) => {
  try {
    const staffId = Number(req.params.staffId);
    const itemId = Number(req.params.itemId);
    const { role } = req.body;
    if (!['inductor', 'inductee'].includes(role)) return res.status(400).send('Invalid role.');
    const isSelf = staffId === req.staffUser.id;
    if (role === 'inductee' && !isSelf) return res.status(403).send('Only the inductee themselves can sign as inductee.');
    if (role === 'inductor') {
      if (!canActAsAssessor(req.staffUser.role)) return res.status(403).send('You do not have permission to do that.');
      if (blockSelfAction(res, req.staffUser.id, staffId)) return;
    }

    await pool.query(
      `INSERT INTO staff_induction_steps (staff_id, induction_item_id, step_number, status) VALUES ($1,$2,5,'in_progress')
       ON CONFLICT (staff_id, induction_item_id, step_number) DO NOTHING`,
      [staffId, itemId]
    );
    const col = role === 'inductee' ? 'inductee_signed_staff_id' : 'inductor_signed_staff_id';
    const atCol = role === 'inductee' ? 'inductee_signed_at' : 'inductor_signed_at';
    const { rows } = await pool.query(
      `UPDATE staff_induction_steps SET ${col} = $1, ${atCol} = now(), updated_at = now()
       WHERE staff_id = $2 AND induction_item_id = $3 AND step_number = 5 RETURNING *`,
      [req.staffUser.id, staffId, itemId]
    );
    const step = rows[0];
    if (step.inductee_signed_staff_id && step.inductor_signed_staff_id && step.status !== 'complete') {
      await pool.query(`UPDATE staff_induction_steps SET status = 'complete', completed_at = now() WHERE id = $1`, [step.id]);
    }

    await logInductionChange({
      staffId, inductionItemId: itemId, contextType: 'step', contextId: step.id,
      summary: `Step 5 signed off by ${role}`, changedByStaffId: req.staffUser.id,
    });
    res.redirect(`/induction/staff/${staffId}/item/${itemId}`);
  } catch (err) {
    next(err);
  }
});

// ---------- Induction: machine competency checklist template ----------
// A competent person develops the criteria list here, then approves it.
// Deliberately seeded with nothing -- the source register doesn't supply
// machine performance criteria, and none should be invented (see spec).

async function getOrCreateChecklistTemplate(itemId, createdByStaffId) {
  const existing = await pool.query('SELECT * FROM induction_checklist_templates WHERE induction_item_id = $1 ORDER BY created_at DESC LIMIT 1', [itemId]);
  if (existing.rows.length) return existing.rows[0];
  const { rows } = await pool.query(
    'INSERT INTO induction_checklist_templates (induction_item_id, created_by_staff_id) VALUES ($1,$2) RETURNING *',
    [itemId, createdByStaffId]
  );
  return rows[0];
}

app.get('/induction/item/:itemId/checklist', async (req, res, next) => {
  try {
    if (!canActAsAssessor(req.staffUser.role)) return res.status(403).send('You do not have permission to do that. <a href="/induction">Back</a>');
    const itemId = Number(req.params.itemId);
    const item = await getInductionItem(itemId);
    if (!item) return res.status(404).send('Equipment item not found.');
    const template = await pool.query('SELECT * FROM induction_checklist_templates WHERE induction_item_id = $1 ORDER BY created_at DESC LIMIT 1', [itemId]);
    const tpl = template.rows[0] || null;
    const criteria = tpl ? (await pool.query('SELECT * FROM induction_checklist_criteria WHERE template_id = $1 ORDER BY sort_order', [tpl.id])).rows : [];
    const staffList = await getActiveStaffList();
    const staffNameById = new Map(staffList.map((s) => [s.id, s.name]));

    const body = `
      <a class="back-link" href="/induction">← Staff Induction</a>
      <h1 class="page-title">Machine competency checklist — ${escapeHtml(item.name)}</h1>
      <p class="page-subtitle" style="margin-bottom:24px;">Built and approved by a person competent in the use of this item. No criteria are pre-filled — add exactly what this school checks for.</p>
      <div class="card" style="padding:22px;">
        ${tpl ? `
          <div style="margin-bottom:14px;">
            ${tpl.approved_at
              ? `<span class="badge badge-approved">Approved</span> by ${escapeHtml(staffNameById.get(tpl.approved_by_staff_id) || 'Unknown')}, ${formatBrisbaneDateTime(tpl.approved_at)}`
              : `<span class="badge badge-pending">Draft — not yet approved</span>`}
          </div>
          <table style="width:100%;border-collapse:collapse;margin-bottom:14px;">
            <tbody>
              ${criteria.map((c) => `
                <tr style="border-bottom:1px solid #F0EDE5;">
                  <td style="padding:8px 6px;font-size:13px;">${escapeHtml(c.description)}</td>
                  <td style="padding:8px 6px;text-align:right;">
                    <form method="post" action="/induction/item/${itemId}/checklist/criteria/${c.id}/delete" style="display:inline;">
                      <button type="submit" class="btn btn-secondary" style="font-size:12px;padding:4px 10px;">Remove</button>
                    </form>
                  </td>
                </tr>`).join('') || '<tr><td style="padding:8px 6px;font-size:13px;color:#6B6659;">No criteria yet.</td></tr>'}
            </tbody>
          </table>
          <form method="post" action="/induction/item/${itemId}/checklist/criteria" style="margin-bottom:14px;">
            <div class="form-row" style="flex-direction:row;gap:8px;align-items:flex-end;">
              <div style="flex:1;"><label>Add a criterion</label><input type="text" name="description" placeholder="e.g. Sets blade guard to correct height before starting" required></div>
              <button type="submit" class="btn btn-secondary">Add</button>
            </div>
          </form>
          <form method="post" action="/induction/item/${itemId}/checklist/approve">
            <button type="submit" class="btn btn-primary" ${criteria.length ? '' : 'disabled'}>${tpl.approved_at ? 'Re-approve template' : 'Approve template'}</button>
          </form>
        ` : `
          <div class="form-section-hint" style="margin:0 0 14px;">No template started yet for this equipment item.</div>
          <form method="post" action="/induction/item/${itemId}/checklist/criteria">
            <div class="form-row"><label>First criterion</label><input type="text" name="description" placeholder="e.g. Checks guard and riving knife before use" required></div>
            <div class="form-actions"><button type="submit" class="btn btn-primary">Start template</button></div>
          </form>
        `}
      </div>
    `;
    res.send(page({ title: `Checklist — ${item.name}`, active: 'induction', body }));
  } catch (err) {
    next(err);
  }
});

app.post('/induction/item/:itemId/checklist/criteria', async (req, res, next) => {
  try {
    if (!canActAsAssessor(req.staffUser.role)) return res.status(403).send('You do not have permission to do that.');
    const itemId = Number(req.params.itemId);
    const description = normalizeText(req.body.description || '').trim();
    if (!description) return res.status(400).send('A criterion needs a description. <a href="javascript:history.back()">Back</a>');

    const tpl = await getOrCreateChecklistTemplate(itemId, req.staffUser.id);
    const countResult = await pool.query('SELECT COUNT(*)::int AS count FROM induction_checklist_criteria WHERE template_id = $1', [tpl.id]);
    await pool.query('INSERT INTO induction_checklist_criteria (template_id, description, sort_order) VALUES ($1,$2,$3)', [tpl.id, description, countResult.rows[0].count]);

    // Adding a criterion after an assessment was already marked complete
    // means that assessment is now missing a result for it -- re-open it
    // rather than silently leaving a "complete" assessment with a gap.
    await pool.query(`UPDATE staff_induction_assessments SET status = 'in_progress', updated_at = now() WHERE template_id = $1 AND status = 'complete'`, [tpl.id]);

    res.redirect(`/induction/item/${itemId}/checklist`);
  } catch (err) {
    next(err);
  }
});

app.post('/induction/item/:itemId/checklist/criteria/:critId/delete', async (req, res, next) => {
  try {
    if (!canActAsAssessor(req.staffUser.role)) return res.status(403).send('You do not have permission to do that.');
    await pool.query('DELETE FROM induction_checklist_criteria WHERE id = $1', [req.params.critId]);
    res.redirect(`/induction/item/${req.params.itemId}/checklist`);
  } catch (err) {
    next(err);
  }
});

app.post('/induction/item/:itemId/checklist/approve', async (req, res, next) => {
  try {
    if (!canActAsAssessor(req.staffUser.role)) return res.status(403).send('You do not have permission to do that.');
    const itemId = Number(req.params.itemId);
    const tpl = await pool.query('SELECT * FROM induction_checklist_templates WHERE induction_item_id = $1 ORDER BY created_at DESC LIMIT 1', [itemId]);
    if (!tpl.rows.length) return res.status(404).send('No template to approve.');
    const criteriaCount = await pool.query('SELECT COUNT(*)::int AS count FROM induction_checklist_criteria WHERE template_id = $1', [tpl.rows[0].id]);
    if (criteriaCount.rows[0].count === 0) return res.status(400).send('Add at least one criterion before approving. <a href="javascript:history.back()">Back</a>');
    await pool.query('UPDATE induction_checklist_templates SET approved_by_staff_id = $1, approved_at = now(), updated_at = now() WHERE id = $2', [req.staffUser.id, tpl.rows[0].id]);
    res.redirect(`/induction/item/${itemId}/checklist`);
  } catch (err) {
    next(err);
  }
});

// ---------- Induction: machine competency assessment ----------

app.post('/induction/staff/:staffId/item/:itemId/assessment/save', async (req, res, next) => {
  try {
    const staffId = Number(req.params.staffId);
    const itemId = Number(req.params.itemId);
    if (!canActAsAssessor(req.staffUser.role)) return res.status(403).send('You do not have permission to do that.');
    if (blockSelfAction(res, req.staffUser.id, staffId)) return;

    const tplResult = await pool.query('SELECT * FROM induction_checklist_templates WHERE induction_item_id = $1 ORDER BY created_at DESC LIMIT 1', [itemId]);
    if (!tplResult.rows.length) return res.status(400).send('No checklist template exists for this item yet.');
    const template = tplResult.rows[0];
    const criteria = (await pool.query('SELECT * FROM induction_checklist_criteria WHERE template_id = $1', [template.id])).rows;
    if (!criteria.length) return res.status(400).send('This template has no criteria yet — nothing to assess.');

    const existing = await pool.query('SELECT * FROM staff_induction_assessments WHERE staff_id = $1 AND template_id = $2 ORDER BY id DESC LIMIT 1', [staffId, template.id]);
    const { assessor_competence_evidence, operating_restrictions, comments, assessment_date, mark_complete } = req.body;

    let assessmentId;
    if (existing.rows.length) {
      assessmentId = existing.rows[0].id;
      await pool.query(
        `UPDATE staff_induction_assessments SET assessor_staff_id = $1, assessor_competence_evidence = $2,
         operating_restrictions = $3, comments = $4, assessment_date = $5, updated_at = now() WHERE id = $6`,
        [req.staffUser.id, normalizeText(assessor_competence_evidence) || null, normalizeText(operating_restrictions) || null,
         normalizeText(comments) || null, assessment_date || null, assessmentId]
      );
    } else {
      const { rows } = await pool.query(
        `INSERT INTO staff_induction_assessments (staff_id, template_id, assessor_staff_id, assessor_competence_evidence, operating_restrictions, comments, assessment_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [staffId, template.id, req.staffUser.id, normalizeText(assessor_competence_evidence) || null, normalizeText(operating_restrictions) || null,
         normalizeText(comments) || null, assessment_date || null]
      );
      assessmentId = rows[0].id;
    }

    let unansweredCount = 0;
    for (const c of criteria) {
      const result = req.body[`result_${c.id}`] || 'not_assessed';
      if (!['not_assessed', 'demonstrated', 'not_yet_demonstrated', 'not_applicable'].includes(result)) continue;
      if (result === 'not_assessed') unansweredCount += 1;
      const naReason = result === 'not_applicable' ? (normalizeText(req.body[`na_reason_${c.id}`]) || null) : null;
      await pool.query(
        `INSERT INTO staff_induction_assessment_results (assessment_id, criterion_id, result, na_reason)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (assessment_id, criterion_id) DO UPDATE SET result = EXCLUDED.result, na_reason = EXCLUDED.na_reason, updated_at = now()`,
        [assessmentId, c.id, result, naReason]
      );
    }

    // Non-negotiable: missing criteria can never produce a "complete"
    // assessment, even if the assessor ticked the box.
    const wantsComplete = mark_complete === 'on' || mark_complete === 'true';
    const canComplete = wantsComplete && unansweredCount === 0;
    await pool.query(
      `UPDATE staff_induction_assessments SET status = $1, completed_at = CASE WHEN $1 = 'complete' THEN now() ELSE NULL END WHERE id = $2`,
      [canComplete ? 'complete' : 'in_progress', assessmentId]
    );

    await logInductionChange({
      staffId, inductionItemId: itemId, contextType: 'assessment', contextId: assessmentId,
      summary: canComplete ? 'Machine competency assessment completed' : (wantsComplete ? `Assessment saved — could not be marked complete (${unansweredCount} criteria still not assessed)` : 'Machine competency assessment updated'),
      changedByStaffId: req.staffUser.id,
    });

    if (wantsComplete && !canComplete) {
      return res.status(400).send(`Saved, but could not be marked complete — ${unansweredCount} criteria still have no result. <a href="/induction/staff/${staffId}/item/${itemId}">Back to the assessment</a>`);
    }
    res.redirect(`/induction/staff/${staffId}/item/${itemId}`);
  } catch (err) {
    next(err);
  }
});

// ---------- Induction: supervised logbook ----------

app.post('/induction/staff/:staffId/item/:itemId/logbook', async (req, res, next) => {
  try {
    const staffId = Number(req.params.staffId);
    const itemId = Number(req.params.itemId);
    const isSelf = staffId === req.staffUser.id;
    if (!isSelf && !canActAsAssessor(req.staffUser.role)) return res.status(403).send('You do not have permission to do that.');

    const { equipment_id, session_date, task_description, duration_hours, supervisor_staff_id, feedback, evidence_title, evidence_url } = req.body;
    const minutes = Math.round(Number(duration_hours) * 60);
    if (!session_date || !normalizeText(task_description || '').trim() || !(minutes > 0)) {
      return res.status(400).send('Date, task description and a positive duration are required. <a href="javascript:history.back()">Back</a>');
    }

    const { rows } = await pool.query(
      `INSERT INTO induction_logbook_entries (staff_id, induction_item_id, equipment_id, session_date, task_description, duration_minutes, supervisor_staff_id, feedback)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [staffId, itemId, equipment_id || null, session_date, normalizeText(task_description), minutes, supervisor_staff_id || null, normalizeText(feedback) || null]
    );
    const entryId = rows[0].id;
    if (normalizeText(evidence_title || '').trim()) {
      await pool.query(
        `INSERT INTO staff_induction_evidence (context_type, context_id, title, url, added_by_staff_id) VALUES ('logbook',$1,$2,$3,$4)`,
        [entryId, normalizeText(evidence_title), normalizeText(evidence_url) || null, req.staffUser.id]
      );
    }
    await logInductionChange({
      staffId, inductionItemId: itemId, contextType: 'logbook', contextId: entryId,
      summary: `Logbook entry added (${formatHours(minutes)})`, changedByStaffId: req.staffUser.id,
    });
    res.redirect(`/induction/staff/${staffId}/item/${itemId}`);
  } catch (err) {
    next(err);
  }
});

app.post('/induction/staff/:staffId/item/:itemId/logbook/:entryId/verify', async (req, res, next) => {
  try {
    const staffId = Number(req.params.staffId);
    const itemId = Number(req.params.itemId);
    if (!canActAsAssessor(req.staffUser.role)) return res.status(403).send('You do not have permission to do that.');
    if (blockSelfAction(res, req.staffUser.id, staffId)) return;

    const { rows } = await pool.query(
      `UPDATE induction_logbook_entries SET verified = true, verified_by_staff_id = $1, verified_at = now()
       WHERE id = $2 AND staff_id = $3 RETURNING id, duration_minutes`,
      [req.staffUser.id, req.params.entryId, staffId]
    );
    if (!rows.length) return res.status(404).send('Logbook entry not found.');
    await logInductionChange({
      staffId, inductionItemId: itemId, contextType: 'logbook', contextId: rows[0].id,
      summary: `Logbook entry verified (${formatHours(rows[0].duration_minutes)} now counts toward practice hours)`,
      changedByStaffId: req.staffUser.id,
    });
    res.redirect(`/induction/staff/${staffId}/item/${itemId}`);
  } catch (err) {
    next(err);
  }
});

app.post('/induction/staff/:staffId/item/:itemId/target', async (req, res, next) => {
  try {
    const staffId = Number(req.params.staffId);
    const itemId = Number(req.params.itemId);
    if (!canActAsAssessor(req.staffUser.role)) return res.status(403).send('You do not have permission to do that.');
    if (blockSelfAction(res, req.staffUser.id, staffId)) return;

    const minutes = Math.round(Number(req.body.target_hours) * 60);
    if (!(minutes > 0)) return res.status(400).send('Enter a positive number of hours. <a href="javascript:history.back()">Back</a>');

    await pool.query(
      `INSERT INTO induction_practice_targets (staff_id, induction_item_id, target_minutes, agreed_by_staff_id, agreed_at)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (staff_id, induction_item_id) DO UPDATE SET target_minutes = EXCLUDED.target_minutes, agreed_by_staff_id = EXCLUDED.agreed_by_staff_id, agreed_at = now()`,
      [staffId, itemId, minutes, req.staffUser.id]
    );
    await logInductionChange({
      staffId, inductionItemId: itemId, contextType: 'logbook', contextId: null,
      summary: `Agreed nominal practice hours set to ${formatHours(minutes)}`, changedByStaffId: req.staffUser.id,
    });
    res.redirect(`/induction/staff/${staffId}/item/${itemId}`);
  } catch (err) {
    next(err);
  }
});

// ---------- Induction: verification & authorisation ----------

app.post('/induction/staff/:staffId/item/:itemId/verify', async (req, res, next) => {
  try {
    const staffId = Number(req.params.staffId);
    const itemId = Number(req.params.itemId);
    if (!canActAsAssessor(req.staffUser.role)) return res.status(403).send('You do not have permission to do that.');
    if (blockSelfAction(res, req.staffUser.id, staffId)) return;

    const verified = req.body.verified === 'on' || req.body.verified === 'true';
    const { basis, notes, review_date } = req.body;
    if (verified) {
      const st = await simpleInduction.buildTeacherState(staffId, { raiseAlerts: false });
      const entry = st && st.entries.find((e) => e.item.id === itemId);
      if (!entry || entry.docState !== 'acknowledged') {
        return res.status(400).send('Competency can only be verified once the staff member has selected this equipment and acknowledged its current PERA and SOP. <a href="javascript:history.back()">Back</a>');
      }
      if (!normalizeText(basis || '').trim()) {
        return res.status(400).send('Record the basis for verifying competency. <a href="javascript:history.back()">Back</a>');
      }
    }
    const { rows } = await pool.query(
      `INSERT INTO staff_induction_competency_verifications (staff_id, induction_item_id, verified, verified_by_staff_id, verified_at, basis, notes, review_date)
       VALUES ($1,$2,$3,$4,now(),$5,$6,$7)
       ON CONFLICT (staff_id, induction_item_id) DO UPDATE SET
         verified = EXCLUDED.verified, verified_by_staff_id = EXCLUDED.verified_by_staff_id, verified_at = now(),
         basis = EXCLUDED.basis, notes = EXCLUDED.notes, review_date = EXCLUDED.review_date, updated_at = now()
       RETURNING id`,
      [staffId, itemId, verified, req.staffUser.id, normalizeText(basis) || null, normalizeText(notes) || null, review_date || null]
    );
    await logInductionChange({
      staffId, inductionItemId: itemId, contextType: 'verification', contextId: rows[0].id,
      summary: `Assessor-verified competency set to "${verified ? 'Verified' : 'Not verified'}"`, changedByStaffId: req.staffUser.id,
    });
    res.redirect(`/induction/staff/${staffId}/item/${itemId}`);
  } catch (err) {
    next(err);
  }
});

app.post('/induction/staff/:staffId/item/:itemId/authorise', async (req, res, next) => {
  try {
    const staffId = Number(req.params.staffId);
    const itemId = Number(req.params.itemId);
    if (!canAuthoriseSchoolLeader(req.staffUser.role)) return res.status(403).send('Only an authorised school leader can record this.');
    if (blockSelfAction(res, req.staffUser.id, staffId)) return;

    const { authorisation_type, permitted_operations, restrictions, review_date } = req.body;
    if (!['operate', 'supervise_students'].includes(authorisation_type)) return res.status(400).send('Invalid authorisation type.');
    const authorised = req.body.authorised === 'on' || req.body.authorised === 'true';
    if (authorised) {
      const problems = await simpleInduction.authorisationProblems(staffId, itemId);
      if (problems.length) return res.status(400).send(`Can't authorise yet: ${escapeHtml(problems.join(' '))} <a href="javascript:history.back()">Back</a>`);
    }

    const { rows } = await pool.query(
      `INSERT INTO staff_induction_authorisations (staff_id, induction_item_id, authorisation_type, authorised, permitted_operations, restrictions, decision_by_staff_id, decision_at, review_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8)
       ON CONFLICT (staff_id, induction_item_id, authorisation_type) DO UPDATE SET
         authorised = EXCLUDED.authorised, permitted_operations = EXCLUDED.permitted_operations, restrictions = EXCLUDED.restrictions,
         decision_by_staff_id = EXCLUDED.decision_by_staff_id, decision_at = now(), review_date = EXCLUDED.review_date, updated_at = now()
       RETURNING id`,
      [staffId, itemId, authorisation_type, authorised, normalizeText(permitted_operations) || null, normalizeText(restrictions) || null, req.staffUser.id, review_date || null]
    );
    await logInductionChange({
      staffId, inductionItemId: itemId, contextType: 'authorisation', contextId: rows[0].id,
      summary: `School authorisation to ${authorisation_type === 'operate' ? 'operate this equipment' : 'supervise student use'} set to "${authorised ? 'Authorised' : 'Not authorised'}"`,
      changedByStaffId: req.staffUser.id,
    });
    res.redirect(`/induction/staff/${staffId}/item/${itemId}`);
  } catch (err) {
    next(err);
  }
});

// ---------- Induction: reports ----------

app.get('/induction/matrix', requireInductionAssessor, async (req, res, next) => {
  try {
    const [categories, staffList, declResult] = await Promise.all([
      getInductionCategoriesWithItems(),
      getActiveStaffList(),
      pool.query('SELECT staff_id, induction_item_id, status FROM staff_induction_declarations'),
    ]);
    const declByKey = new Map(declResult.rows.map((d) => [`${d.staff_id}:${d.induction_item_id}`, d.status]));

    const categoryBlocks = categories.map((cat) => `
      <div class="form-section-title" style="margin-top:20px;">${escapeHtml(cat.name)}</div>
      <div style="overflow-x:auto;">
      <table style="border-collapse:collapse;min-width:100%;">
        <thead>
          <tr style="text-align:left;font-size:11px;text-transform:uppercase;color:#6B6659;border-bottom:1px solid #E4DFD3;">
            <th style="padding:6px;position:sticky;left:0;background:#fff;">Equipment</th>
            ${staffList.map((s) => `<th style="padding:6px;white-space:nowrap;">${escapeHtml(s.name)}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${cat.items.map((item) => `
            <tr style="border-bottom:1px solid #F0EDE5;">
              <td style="padding:6px;font-size:12px;white-space:nowrap;position:sticky;left:0;background:#fff;">${escapeHtml(item.name)}</td>
              ${staffList.map((s) => {
                const status = declByKey.get(`${s.id}:${item.id}`) || 'not_assessed';
                return `<td style="padding:6px;text-align:center;"><a href="/induction/staff/${s.id}/item/${item.id}" class="badge ${DECLARATION_BADGE[status]}" style="text-decoration:none;">${status === 'not_assessed' ? '—' : escapeHtml(status)}</a></td>`;
              }).join('')}
            </tr>`).join('')}
        </tbody>
      </table>
      </div>
    `).join('');

    const body = `
      <a class="back-link" href="/induction">← Staff Induction</a>
      <h1 class="page-title">Staff / equipment matrix</h1>
      <p class="page-subtitle" style="margin-bottom:24px;">Self-assessed status for every active staff member against every equipment item available at this school. Click a cell to open that record.</p>
      <div class="card" style="padding:22px;">${categoryBlocks}</div>
    `;
    res.send(page({ title: 'Staff / Equipment Matrix', active: 'induction', body }));
  } catch (err) {
    next(err);
  }
});

app.get('/induction/training-required', requireInductionAssessor, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.id AS staff_id, s.name AS staff_name, i.id AS item_id, i.name AS item_name, c.name AS category_name,
        (SELECT COUNT(*)::int FROM staff_induction_steps st WHERE st.staff_id = s.id AND st.induction_item_id = i.id AND st.status = 'complete') AS steps_done
      FROM staff_induction_declarations d
      JOIN staff_users s ON s.id = d.staff_id AND s.disabled = false
      JOIN induction_equipment_items i ON i.id = d.induction_item_id AND i.available_at_school = true
      JOIN induction_equipment_categories c ON c.id = i.category_id
      WHERE d.status = 'NYC'
      ORDER BY s.name, c.sort_order, i.sort_order
    `);
    const body = `
      <a class="back-link" href="/induction">← Staff Induction</a>
      <h1 class="page-title">Training required</h1>
      <p class="page-subtitle" style="margin-bottom:24px;">Staff who have declared themselves "not yet competent" on an item, with how far the induction process has got.</p>
      <div class="card" style="padding:22px;">
        ${rows.length ? `
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr style="text-align:left;font-size:11px;text-transform:uppercase;color:#6B6659;border-bottom:1px solid #E4DFD3;"><th style="padding:6px;">Staff</th><th style="padding:6px;">Equipment</th><th style="padding:6px;">Induction progress</th><th></th></tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr style="border-bottom:1px solid #F0EDE5;">
                <td style="padding:8px 6px;font-size:13px;">${escapeHtml(r.staff_name)}</td>
                <td style="padding:8px 6px;font-size:13px;">${escapeHtml(r.category_name)} — ${escapeHtml(r.item_name)}</td>
                <td style="padding:8px 6px;"><span class="badge ${r.steps_done === 5 ? 'badge-approved' : (r.steps_done > 0 ? 'badge-pending' : 'badge-draft')}">${r.steps_done}/5 steps</span></td>
                <td style="padding:8px 6px;text-align:right;"><a href="/induction/staff/${r.staff_id}/item/${r.item_id}" style="color:#1B5E52;font-weight:600;font-size:13px;">Open →</a></td>
              </tr>`).join('')}
          </tbody>
        </table>` : '<div class="empty-state">Nothing outstanding — no staff currently declare themselves not yet competent on an available item.</div>'}
      </div>
    `;
    res.send(page({ title: 'Training Required', active: 'induction', body }));
  } catch (err) {
    next(err);
  }
});

app.get('/induction/pending-verification', requireInductionAssessor, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.id AS staff_id, s.name AS staff_name, i.id AS item_id, i.name AS item_name, c.name AS category_name, d.declared_at
      FROM staff_induction_declarations d
      JOIN staff_users s ON s.id = d.staff_id AND s.disabled = false
      JOIN induction_equipment_items i ON i.id = d.induction_item_id AND i.available_at_school = true
      JOIN induction_equipment_categories c ON c.id = i.category_id
      WHERE d.status = 'C'
      AND NOT EXISTS (
        SELECT 1 FROM staff_induction_competency_verifications v
        WHERE v.staff_id = d.staff_id AND v.induction_item_id = d.induction_item_id AND v.verified = true
      )
      ORDER BY d.declared_at ASC
    `);
    const body = `
      <a class="back-link" href="/induction">← Staff Induction</a>
      <h1 class="page-title">Pending verification</h1>
      <p class="page-subtitle" style="margin-bottom:24px;">Staff who have self-declared "C — competent" but an assessor hasn't yet recorded verified competency. A self-declaration alone never authorises use.</p>
      <div class="card" style="padding:22px;">
        ${rows.length ? `
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr style="text-align:left;font-size:11px;text-transform:uppercase;color:#6B6659;border-bottom:1px solid #E4DFD3;"><th style="padding:6px;">Staff</th><th style="padding:6px;">Equipment</th><th style="padding:6px;">Declared</th><th></th></tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr style="border-bottom:1px solid #F0EDE5;">
                <td style="padding:8px 6px;font-size:13px;">${escapeHtml(r.staff_name)}</td>
                <td style="padding:8px 6px;font-size:13px;">${escapeHtml(r.category_name)} — ${escapeHtml(r.item_name)}</td>
                <td style="padding:8px 6px;font-size:12px;color:#6B6659;">${formatBrisbaneDateTime(r.declared_at)}</td>
                <td style="padding:8px 6px;text-align:right;"><a href="/induction/staff/${r.staff_id}/item/${r.item_id}" style="color:#1B5E52;font-weight:600;font-size:13px;">Review →</a></td>
              </tr>`).join('')}
          </tbody>
        </table>` : '<div class="empty-state">Nothing pending — every "C" declaration has been verified or is no longer current.</div>'}
      </div>
    `;
    res.send(page({ title: 'Pending Verification', active: 'induction', body }));
  } catch (err) {
    next(err);
  }
});

app.get('/induction/item/:itemId/history', async (req, res, next) => {
  try {
    const itemId = Number(req.params.itemId);
    const item = await getInductionItem(itemId);
    if (!item) return res.status(404).send('Equipment item not found.');
    const { rows } = await pool.query(`
      SELECT s.id AS staff_id, s.name AS staff_name,
        d.status AS decl_status, d.declared_at,
        (SELECT COUNT(*)::int FROM staff_induction_steps st WHERE st.staff_id = s.id AND st.induction_item_id = $1 AND st.status = 'complete') AS steps_done,
        v.verified, v.verified_at,
        ao.authorised AS operate_authorised, asup.authorised AS supervise_authorised
      FROM staff_users s
      LEFT JOIN staff_induction_declarations d ON d.staff_id = s.id AND d.induction_item_id = $1
      LEFT JOIN staff_induction_competency_verifications v ON v.staff_id = s.id AND v.induction_item_id = $1
      LEFT JOIN staff_induction_authorisations ao ON ao.staff_id = s.id AND ao.induction_item_id = $1 AND ao.authorisation_type = 'operate'
      LEFT JOIN staff_induction_authorisations asup ON asup.staff_id = s.id AND asup.induction_item_id = $1 AND asup.authorisation_type = 'supervise_students'
      WHERE s.disabled = false
      ORDER BY s.name
    `, [itemId]);
    const body = `
      <a class="back-link" href="/induction">← Staff Induction</a>
      <h1 class="page-title">${escapeHtml(item.name)} — training history</h1>
      <p class="page-subtitle" style="margin-bottom:24px;">${escapeHtml(item.category_name)}${item.pera_name ? ` · Linked PERA: ${escapeHtml(item.pera_name)}` : ''}</p>
      <div class="card" style="padding:22px;">
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr style="text-align:left;font-size:11px;text-transform:uppercase;color:#6B6659;border-bottom:1px solid #E4DFD3;"><th style="padding:6px;">Staff</th><th style="padding:6px;">Self-assessed</th><th style="padding:6px;">Steps</th><th style="padding:6px;">Verified</th><th style="padding:6px;">Operate</th><th style="padding:6px;">Supervise</th><th></th></tr></thead>
          <tbody>
            ${rows.map((r) => {
              const status = r.decl_status || 'not_assessed';
              return `<tr style="border-bottom:1px solid #F0EDE5;">
                <td style="padding:8px 6px;font-size:13px;">${escapeHtml(r.staff_name)}</td>
                <td style="padding:8px 6px;"><span class="badge ${DECLARATION_BADGE[status]}">${escapeHtml(DECLARATION_LABELS[status])}</span></td>
                <td style="padding:8px 6px;font-size:12px;color:#6B6659;">${r.steps_done || 0}/5</td>
                <td style="padding:8px 6px;"><span class="badge ${r.verified ? 'badge-approved' : 'badge-draft'}">${r.verified ? 'Verified' : 'No'}</span></td>
                <td style="padding:8px 6px;"><span class="badge ${r.operate_authorised ? 'badge-approved' : 'badge-draft'}">${r.operate_authorised ? 'Yes' : 'No'}</span></td>
                <td style="padding:8px 6px;"><span class="badge ${r.supervise_authorised ? 'badge-approved' : 'badge-draft'}">${r.supervise_authorised ? 'Yes' : 'No'}</span></td>
                <td style="padding:8px 6px;text-align:right;"><a href="/induction/staff/${r.staff_id}/item/${itemId}" style="color:#1B5E52;font-weight:600;font-size:13px;">Open →</a></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
    res.send(page({ title: `${item.name} — History`, active: 'induction', body }));
  } catch (err) {
    next(err);
  }
});

// ---------- Induction: printable record & PDF export ----------

async function buildInductionRecordRows(staffId) {
  const [categories, declResult, verifResult, authResult, stepsResult] = await Promise.all([
    getInductionCategoriesWithItems(),
    pool.query('SELECT * FROM staff_induction_declarations WHERE staff_id = $1', [staffId]),
    pool.query('SELECT * FROM staff_induction_competency_verifications WHERE staff_id = $1', [staffId]),
    pool.query('SELECT * FROM staff_induction_authorisations WHERE staff_id = $1', [staffId]),
    pool.query(`SELECT induction_item_id, COUNT(*) FILTER (WHERE status = 'complete')::int AS done FROM staff_induction_steps WHERE staff_id = $1 GROUP BY induction_item_id`, [staffId]),
  ]);
  const declByItem = new Map(declResult.rows.map((d) => [d.induction_item_id, d]));
  const verifByItem = new Map(verifResult.rows.map((v) => [v.induction_item_id, v]));
  const authByItem = new Map();
  for (const a of authResult.rows) {
    if (!authByItem.has(a.induction_item_id)) authByItem.set(a.induction_item_id, {});
    authByItem.get(a.induction_item_id)[a.authorisation_type] = a;
  }
  const stepsByItem = new Map(stepsResult.rows.map((s) => [s.induction_item_id, s.done]));

  const out = [];
  for (const cat of categories) {
    for (const item of cat.items) {
      const decl = declByItem.get(item.id);
      if (!decl || decl.status === 'not_assessed') continue; // only print items with an actual record
      out.push({
        category: cat.name,
        item: item.name,
        status: decl.status,
        declaredAt: decl.declared_at,
        stepsDone: stepsByItem.get(item.id) || 0,
        verified: !!(verifByItem.get(item.id) && verifByItem.get(item.id).verified),
        operate: !!((authByItem.get(item.id) || {}).operate && (authByItem.get(item.id) || {}).operate.authorised),
        supervise: !!((authByItem.get(item.id) || {}).supervise_students && (authByItem.get(item.id) || {}).supervise_students.authorised),
      });
    }
  }
  return out;
}

app.get('/induction/staff/:staffId/print', async (req, res, next) => {
  try {
    const staffId = Number(req.params.staffId);
    if (staffId !== req.staffUser.id && !canActAsAssessor(req.staffUser.role)) {
      return res.status(403).send('You can only print your own induction record.');
    }
    const staffResult = await pool.query('SELECT id, name, email FROM staff_users WHERE id = $1', [staffId]);
    if (!staffResult.rows.length) return res.status(404).send('Staff member not found.');
    const staff = staffResult.rows[0];
    const rows = await buildInductionRecordRows(staffId);

    res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Staff Induction Record — ${escapeHtml(staff.name)} — ${BRAND}</title>
<link rel="stylesheet" href="/style.css">
<style>
  body { background:#fff; padding:32px; }
  .print-btn { margin-bottom:16px; }
  table { width:100%; border-collapse:collapse; margin-top:12px; }
  th, td { padding:6px 8px; font-size:12px; text-align:left; border-bottom:1px solid #E4DFD3; }
  th { text-transform:uppercase; letter-spacing:0.04em; color:#6B6659; font-size:10px; }
  @media print { .print-btn { display:none; } }
</style>
</head>
<body>
  <button class="btn btn-primary print-btn" onclick="window.print()">Print</button>
  <h1 class="page-title">Staff Equipment Induction Record</h1>
  <p class="page-subtitle">${escapeHtml(staff.name)} · ${escapeHtml(staff.email)} · Faith Lutheran College · Generated ${escapeHtml(formatBrisbaneDateTime(new Date()))} · ${BRAND}</p>
  <table>
    <thead><tr><th>Category</th><th>Equipment</th><th>Self-assessed</th><th>Induction steps</th><th>Verified competency</th><th>Authorised: operate</th><th>Authorised: supervise students</th></tr></thead>
    <tbody>
      ${rows.length ? rows.map((r) => `<tr>
        <td>${escapeHtml(r.category)}</td>
        <td>${escapeHtml(r.item)}</td>
        <td>${escapeHtml(DECLARATION_LABELS[r.status])}</td>
        <td>${r.stepsDone}/5</td>
        <td>${r.verified ? 'Verified' : 'Not verified'}</td>
        <td>${r.operate ? 'Yes' : 'No'}</td>
        <td>${r.supervise ? 'Yes' : 'No'}</td>
      </tr>`).join('') : '<tr><td colspan="7">No equipment items assessed yet.</td></tr>'}
    </tbody>
  </table>
</body>
</html>`);
  } catch (err) {
    next(err);
  }
});

app.get('/induction/staff/:staffId/export.pdf', async (req, res, next) => {
  try {
    const staffId = Number(req.params.staffId);
    if (staffId !== req.staffUser.id && !canActAsAssessor(req.staffUser.role)) {
      return res.status(403).send('You can only export your own induction record.');
    }
    const staffResult = await pool.query('SELECT id, name, email FROM staff_users WHERE id = $1', [staffId]);
    if (!staffResult.rows.length) return res.status(404).send('Staff member not found.');
    const staff = staffResult.rows[0];
    const rows = await buildInductionRecordRows(staffId);

    const safeName = (staff.name || 'Staff').replace(/[^a-z0-9 \-_.]/gi, '').trim() || 'Staff';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Staff Induction Record - ${safeName}.pdf"`);

    const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true, info: { Creator: BRAND } });
    doc.pipe(res);

    doc.fontSize(16).fillColor('#1A1D1B').text('Staff Equipment Induction Record', { align: 'left' });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor('#6B6659').text(`${staff.name} — ${staff.email} — Faith Lutheran College`);
    doc.text(`Generated ${formatBrisbaneDateTime(new Date())} — ${BRAND}`);
    doc.moveDown(1);

    let currentCategory = null;
    for (const r of rows) {
      if (doc.y > 720) doc.addPage();
      if (r.category !== currentCategory) {
        currentCategory = r.category;
        doc.moveDown(0.4);
        doc.fontSize(12).fillColor('#1B5E52').text(currentCategory);
        doc.moveDown(0.2);
      }
      doc.fontSize(10).fillColor('#1A1D1B').text(r.item, { continued: false });
      doc.fontSize(9).fillColor('#6B6659').text(
        `Self-assessed: ${DECLARATION_LABELS[r.status]}   ·   Induction steps: ${r.stepsDone}/5   ·   Verified competency: ${r.verified ? 'Yes' : 'No'}   ·   Authorised to operate: ${r.operate ? 'Yes' : 'No'}   ·   Authorised to supervise students: ${r.supervise ? 'Yes' : 'No'}`
      );
      doc.moveDown(0.5);
    }
    if (!rows.length) {
      doc.fontSize(10).fillColor('#6B6659').text('No equipment items assessed yet.');
    }

    doc.end();
  } catch (err) {
    next(err);
  }
});

// ---------- Induction: admin — equipment list management ----------

app.get('/admin/induction/items', requireRole('admin'), async (req, res, next) => {
  try {
    const [categories, peraResult] = await Promise.all([
      getInductionCategoriesWithItems({ onlyAvailable: false }),
      pool.query('SELECT id, activity_name FROM pera_records WHERE archived = false ORDER BY activity_name'),
    ]);
    const peraOptions = peraResult.rows.map((p) => `<option value="${p.id}">${escapeHtml(p.activity_name)}</option>`).join('');

    const body = `
      <a class="back-link" href="/induction">← Staff Induction</a>
      <h1 class="page-title">Manage the equipment induction list</h1>
      <p class="page-subtitle" style="margin-bottom:24px;">Link each item to its PERA (this also shows the matching physical equipment), and hide anything that isn't actually at this school.</p>
      <div class="card" style="padding:22px;">
        ${categories.map((cat) => `
          <div class="form-section-title" style="margin-top:20px;">${escapeHtml(cat.name)}</div>
          ${cat.items.map((item) => `
            <form method="post" action="/admin/induction/items/${item.id}" style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #F0EDE5;">
              <div style="flex:1;font-size:13px;${item.available_at_school ? '' : 'color:#B0AA9A;text-decoration:line-through;'}">${escapeHtml(item.name)}</div>
              <select name="pera_id" style="max-width:260px;">
                <option value="">— No PERA linked —</option>
                ${peraResult.rows.map((p) => `<option value="${p.id}" ${item.pera_id === p.id ? 'selected' : ''}>${escapeHtml(p.activity_name)}</option>`).join('')}
              </select>
              <label style="display:flex;align-items:center;gap:4px;font-size:12px;white-space:nowrap;">
                <input type="checkbox" name="available_at_school" style="width:auto;" ${item.available_at_school ? 'checked' : ''}> At this school
              </label>
              <button type="submit" class="btn btn-secondary" style="font-size:12px;padding:4px 10px;">Save</button>
            </form>
          `).join('')}
        `).join('')}
      </div>
    `;
    res.send(page({ title: 'Manage Induction Equipment List', active: 'induction', body }));
  } catch (err) {
    next(err);
  }
});

app.post('/admin/induction/items/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const availableAtSchool = req.body.available_at_school === 'on';
    await pool.query(
      'UPDATE induction_equipment_items SET pera_id = $1, available_at_school = $2, updated_at = now() WHERE id = $3',
      [req.body.pera_id || null, availableAtSchool, req.params.id]
    );
    res.redirect('/admin/induction/items');
  } catch (err) {
    next(err);
  }
});

// ---------- Staff Competency Profile ----------
//
// Reduces repeated data entry in the Staff Equipment Induction module
// above. One profile per staff member (qualifications/trade background,
// teaching/industry experience, licences with expiry dates, reusable
// evidence, and claimed equipment-group experience), reused across many
// equipment items instead of re-entering the same thing on each one. See
// db.js for the full table set and the "why" behind each one. Everything
// here only ever writes to staff_competency_profile_versions /
// staff_profile_licences / staff_profile_evidence / the application and
// batch tables, or -- for the actual declaration/verification decision --
// upserts the exact same per-item tables the induction module already
// uses, under the exact same rules (nothing preselected, no self-
// verification, no automatic authorisation). This module never writes to
// staff_induction_authorisations at all.

async function getCurrentProfileVersion(staffId) {
  const { rows } = await pool.query(
    'SELECT * FROM staff_competency_profile_versions WHERE staff_id = $1 ORDER BY recorded_at DESC, id DESC LIMIT 1',
    [staffId]
  );
  return rows[0] || null;
}

async function getActiveLicences(staffId) {
  const { rows } = await pool.query(
    'SELECT * FROM staff_profile_licences WHERE staff_id = $1 AND active = true ORDER BY expiry_date ASC NULLS LAST, name ASC',
    [staffId]
  );
  return rows;
}

async function getActiveEvidence(staffId) {
  const { rows } = await pool.query(
    'SELECT * FROM staff_profile_evidence WHERE staff_id = $1 AND removed = false ORDER BY added_at DESC',
    [staffId]
  );
  return rows;
}

async function getProfileEquipmentGroups(staffId) {
  const { rows } = await pool.query(
    `SELECT g.*, c.name AS category_name FROM staff_profile_equipment_groups g
     JOIN induction_equipment_categories c ON c.id = g.category_id
     WHERE g.staff_id = $1 ORDER BY c.sort_order`,
    [staffId]
  );
  return rows;
}

// Every application of profile evidence/a licence to an item, for a given
// staff member -- used both to show "source profile information" on an
// item's workspace and to pre-fill the grouped self-assessment screen
// with what's already been applied.
async function getProfileApplicationsByItem(staffId) {
  const [evidenceResult, licenceResult] = await Promise.all([
    pool.query(
      `SELECT a.induction_item_id, e.id, e.title, e.url, e.notes, e.removed
       FROM staff_profile_evidence_applications a
       JOIN staff_profile_evidence e ON e.id = a.profile_evidence_id
       WHERE a.staff_id = $1`,
      [staffId]
    ),
    pool.query(
      `SELECT a.induction_item_id, l.id, l.name, l.expiry_date, l.active
       FROM staff_profile_licence_applications a
       JOIN staff_profile_licences l ON l.id = a.profile_licence_id
       WHERE a.staff_id = $1`,
      [staffId]
    ),
  ]);
  const byItem = new Map();
  const ensure = (itemId) => {
    if (!byItem.has(itemId)) byItem.set(itemId, { evidence: [], licences: [] });
    return byItem.get(itemId);
  };
  for (const row of evidenceResult.rows) {
    const seen = new Set();
    const entry = ensure(row.induction_item_id);
    if (!seen.has(row.id)) { entry.evidence.push(row); seen.add(row.id); }
  }
  for (const row of licenceResult.rows) {
    ensure(row.induction_item_id).licences.push(row);
  }
  return byItem;
}

// "When qualifications, evidence or expiry dates change, flag affected
// records for review." Called whenever a profile component that other
// records may have relied on is edited, superseded or removed -- never
// changes the records themselves, just queues a prompt.
async function flagForReview({ staffId, inductionItemId, reason, sourceType, sourceId }) {
  await pool.query(
    `INSERT INTO staff_profile_review_flags (staff_id, induction_item_id, reason, source_type, source_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [staffId, inductionItemId || null, reason, sourceType, sourceId || null]
  );
}

function profileNavLinks(staffId, isSelf) {
  return `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px;">
      <a class="btn btn-secondary" href="/induction/staff/${staffId}/profile">Competency profile</a>
      <a class="btn btn-secondary" href="${isSelf ? '/induction/me/equipment' : `/induction/staff/${staffId}/assess`}">Self-assessment</a>
      ${isSelf ? '<a class="btn btn-secondary" href="/induction/me">My induction</a>' : ''}
    </div>
  `;
}

// ---------- Competency profile: view/edit ----------

app.get('/induction/staff/:staffId/profile', async (req, res, next) => {
  try {
    const staffId = Number(req.params.staffId);
    const isSelf = staffId === req.staffUser.id;
    const canEdit = isSelf || req.staffUser.role === 'admin';
    if (!isSelf && !canActAsAssessor(req.staffUser.role)) {
      return res.status(403).send('You can only view your own competency profile. <a href="/induction">Back</a>');
    }
    const staffResult = await pool.query('SELECT id, name, email FROM staff_users WHERE id = $1', [staffId]);
    if (!staffResult.rows.length) return res.status(404).send('Staff member not found.');
    const staff = staffResult.rows[0];

    const [profile, licences, groups, categories] = await Promise.all([
      getCurrentProfileVersion(staffId),
      getActiveLicences(staffId),
      getProfileEquipmentGroups(staffId),
      getInductionCategoriesWithItems(),
    ]);
    const groupCategoryIds = new Set(groups.map((g) => g.category_id));
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const licenceRowsHtml = licences.map((l) => {
      const expired = l.expiry_date && new Date(l.expiry_date) < today;
      const expSoon = l.expiry_date && !expired && (new Date(l.expiry_date) - today) / 86400000 <= 30;
      return `
      <tr style="border-bottom:1px solid #F0EDE5;">
        <td style="padding:8px 6px;font-size:13px;">${escapeHtml(l.name)}${l.issuing_body ? ` <span style="color:#6B6659;">(${escapeHtml(l.issuing_body)})</span>` : ''}${l.licence_number ? `<div style="font-size:11px;color:#B0AA9A;">${escapeHtml(l.licence_number)}</div>` : ''}</td>
        <td style="padding:8px 6px;"><span class="badge ${expired ? 'badge-changes' : (expSoon ? 'badge-pending' : 'badge-approved')}">${l.expiry_date ? formatBrisbaneDate(l.expiry_date) : 'No expiry'}${expired ? ' — expired' : (expSoon ? ' — expiring soon' : '')}</span></td>
        <td style="padding:8px 6px;text-align:right;">
          ${canEdit ? `<form method="post" action="/induction/staff/${staffId}/profile/licences/${l.id}/remove" style="display:inline;" onsubmit="return confirm('Remove this licence? Records that already applied it will be flagged for review.');"><button type="submit" class="btn btn-secondary" style="padding:4px 10px;font-size:12px;">Remove</button></form>` : ''}
        </td>
      </tr>`;
    }).join('');

    const groupCheckboxesHtml = categories.map((cat) => `
      <label style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px;">
        <input type="checkbox" name="category_id" value="${cat.id}" ${groupCategoryIds.has(cat.id) ? 'checked' : ''} ${canEdit ? '' : 'disabled'}>
        ${escapeHtml(cat.name)}
      </label>
    `).join('');

    const body = `
      <a class="back-link" href="/induction/staff/${staffId}">← ${escapeHtml(staff.name)}</a>
      <div class="page-header">
        <div>
          <h1 class="page-title">Competency profile — ${escapeHtml(staff.name)}</h1>
          <p class="page-subtitle">Kept in one place and reused across every equipment record — never automatically marks anything competent, verified or authorised.</p>
        </div>
      </div>
      <div class="note-box">A profile only supplies supporting information. Equipment-specific competence, induction, verification and authorisation are always recorded separately against each item.</div>

      <div class="form-section-title">Qualifications, trade background &amp; experience</div>
      <form class="form-card" method="post" action="/induction/staff/${staffId}/profile">
        <div class="form-row">
          <label for="qualifications_trade">Qualifications and trade background</label>
          <textarea id="qualifications_trade" name="qualifications_trade" rows="3" ${canEdit ? '' : 'disabled'}>${escapeHtml(profile ? profile.qualifications_trade || '' : '')}</textarea>
        </div>
        <div class="form-row">
          <label for="teaching_industry_experience">Teaching and industry experience</label>
          <textarea id="teaching_industry_experience" name="teaching_industry_experience" rows="3" ${canEdit ? '' : 'disabled'}>${escapeHtml(profile ? profile.teaching_industry_experience || '' : '')}</textarea>
        </div>
        ${profile ? `<div class="form-section-hint">Last updated ${formatBrisbaneDateTime(profile.recorded_at)}.</div>` : ''}
        ${canEdit ? `<div class="form-actions"><button type="submit" class="btn btn-primary">Save profile</button></div>` : ''}
      </form>

      <div class="form-section-title" style="margin-top:28px;">Licences &amp; certificates</div>
      <div class="form-section-hint" style="margin:0 0 10px;">Full certificate details are kept on file at the school — refer to HR for the original document. Just the name and expiry are tracked here.</div>
      <div class="card">
        <table style="width:100%;border-collapse:collapse;">
          <tbody>${licenceRowsHtml || `<tr><td style="padding:16px;text-align:center;color:#6B6659;">No licences recorded yet.</td></tr>`}</tbody>
        </table>
      </div>
      ${canEdit ? `
      <form class="form-card" method="post" action="/induction/staff/${staffId}/profile/licences" style="max-width:560px;margin-top:12px;">
        <div class="form-row"><label for="licence_name">Licence / certificate name</label><input type="text" id="licence_name" name="name" required placeholder="e.g. White Card"></div>
        <div class="form-row"><label for="expiry_date">Expiry date</label><input type="date" id="expiry_date" name="expiry_date"></div>
        <div class="form-actions"><button type="submit" class="btn btn-secondary">Add licence</button></div>
      </form>` : ''}

      <div class="form-section-title" style="margin-top:28px;">Equipment groups with experience</div>
      <form class="form-card" method="post" action="/induction/staff/${staffId}/profile/equipment-groups">
        <div class="form-section-hint" style="margin:0 0 10px;">Used to pre-select relevant items on the self-assessment screen — a group here is never itself a declaration of competence.</div>
        ${groupCheckboxesHtml}
        ${canEdit ? `<div class="form-actions" style="margin-top:12px;"><button type="submit" class="btn btn-secondary">Save equipment groups</button></div>` : ''}
      </form>
    `;
    res.send(page({ title: `Competency Profile — ${staff.name}`, active: 'induction', body }));
  } catch (err) {
    next(err);
  }
});

app.post('/induction/staff/:staffId/profile', async (req, res, next) => {
  try {
    const staffId = Number(req.params.staffId);
    const isSelf = staffId === req.staffUser.id;
    if (!isSelf && req.staffUser.role !== 'admin') {
      return res.status(403).send('Only the staff member themselves (or an admin) can edit this profile. <a href="javascript:history.back()">Back</a>');
    }
    const { qualifications_trade, teaching_industry_experience } = req.body;
    const previous = await getCurrentProfileVersion(staffId);
    const newQuals = normalizeText(qualifications_trade) || null;
    const newExp = normalizeText(teaching_industry_experience) || null;
    const changed = !previous || previous.qualifications_trade !== newQuals || previous.teaching_industry_experience !== newExp;

    const { rows } = await pool.query(
      `INSERT INTO staff_competency_profile_versions (staff_id, qualifications_trade, teaching_industry_experience, recorded_by_staff_id)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [staffId, newQuals, newExp, req.staffUser.id]
    );

    if (changed && previous) {
      // Flag every item this staff member already has a "C" declaration or
      // a verified competency on -- the profile text that supported those
      // just changed, so they're worth another look. Never touches the
      // declaration/verification rows themselves.
      const affected = await pool.query(
        `SELECT DISTINCT induction_item_id FROM staff_induction_declarations WHERE staff_id = $1 AND status = 'C'
         UNION
         SELECT DISTINCT induction_item_id FROM staff_induction_competency_verifications WHERE staff_id = $1 AND verified = true`,
        [staffId]
      );
      for (const row of affected.rows) {
        await flagForReview({
          staffId, inductionItemId: row.induction_item_id,
          reason: 'Qualifications/experience summary was updated — check this still supports the declared or verified competence.',
          sourceType: 'profile_updated', sourceId: rows[0].id,
        });
      }
    }

    await logInductionChange({
      staffId, contextType: 'profile', contextId: rows[0].id,
      summary: 'Competency profile (qualifications/experience) updated', changedByStaffId: req.staffUser.id,
    });
    res.redirect(`/induction/staff/${staffId}/profile`);
  } catch (err) {
    next(err);
  }
});

app.post('/induction/staff/:staffId/profile/licences', async (req, res, next) => {
  try {
    const staffId = Number(req.params.staffId);
    if (staffId !== req.staffUser.id && req.staffUser.role !== 'admin') {
      return res.status(403).send('Only the staff member themselves (or an admin) can edit this profile. <a href="javascript:history.back()">Back</a>');
    }
    const { name, issuing_body, licence_number, expiry_date, notes } = req.body;
    if (!normalizeText(name || '').trim()) return res.status(400).send('A licence/certificate name is required. <a href="javascript:history.back()">Back</a>');
    const { rows } = await pool.query(
      `INSERT INTO staff_profile_licences (staff_id, name, issuing_body, licence_number, expiry_date, notes, recorded_by_staff_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [staffId, normalizeText(name), normalizeText(issuing_body) || null, normalizeText(licence_number) || null, expiry_date || null, normalizeText(notes) || null, req.staffUser.id]
    );
    await logInductionChange({ staffId, contextType: 'profile_licence', contextId: rows[0].id, summary: `Licence "${normalizeText(name)}" added to profile`, changedByStaffId: req.staffUser.id });
    res.redirect(`/induction/staff/${staffId}/profile`);
  } catch (err) {
    next(err);
  }
});

app.post('/induction/staff/:staffId/profile/licences/:licenceId/remove', async (req, res, next) => {
  try {
    const staffId = Number(req.params.staffId);
    const licenceId = Number(req.params.licenceId);
    if (staffId !== req.staffUser.id && req.staffUser.role !== 'admin') {
      return res.status(403).send('Only the staff member themselves (or an admin) can edit this profile. <a href="javascript:history.back()">Back</a>');
    }
    const { rows } = await pool.query('UPDATE staff_profile_licences SET active = false WHERE id = $1 AND staff_id = $2 RETURNING name', [licenceId, staffId]);
    if (!rows.length) return res.status(404).send('Licence not found.');

    const affected = await pool.query('SELECT DISTINCT induction_item_id FROM staff_profile_licence_applications WHERE profile_licence_id = $1', [licenceId]);
    for (const row of affected.rows) {
      await flagForReview({
        staffId, inductionItemId: row.induction_item_id,
        reason: `Licence "${rows[0].name}" was removed from the profile — check whether this record still has the support it needs.`,
        sourceType: 'licence_removed', sourceId: licenceId,
      });
    }
    await logInductionChange({ staffId, contextType: 'profile_licence', contextId: licenceId, summary: `Licence "${rows[0].name}" removed from profile`, changedByStaffId: req.staffUser.id });
    res.redirect(`/induction/staff/${staffId}/profile`);
  } catch (err) {
    next(err);
  }
});

app.post('/induction/staff/:staffId/profile/evidence', async (req, res, next) => {
  try {
    const staffId = Number(req.params.staffId);
    if (staffId !== req.staffUser.id && req.staffUser.role !== 'admin') {
      return res.status(403).send('Only the staff member themselves (or an admin) can edit this profile. <a href="javascript:history.back()">Back</a>');
    }
    const { title, url, notes } = req.body;
    if (!normalizeText(title || '').trim()) return res.status(400).send('A title is required. <a href="javascript:history.back()">Back</a>');
    const { rows } = await pool.query(
      `INSERT INTO staff_profile_evidence (staff_id, title, url, notes, added_by_staff_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [staffId, normalizeText(title), normalizeText(url) || null, normalizeText(notes) || null, req.staffUser.id]
    );
    await logInductionChange({ staffId, contextType: 'profile_evidence', contextId: rows[0].id, summary: `Evidence "${normalizeText(title)}" added to profile`, changedByStaffId: req.staffUser.id });
    res.redirect(`/induction/staff/${staffId}/profile`);
  } catch (err) {
    next(err);
  }
});

app.post('/induction/staff/:staffId/profile/evidence/:evidenceId/remove', async (req, res, next) => {
  try {
    const staffId = Number(req.params.staffId);
    const evidenceId = Number(req.params.evidenceId);
    if (staffId !== req.staffUser.id && req.staffUser.role !== 'admin') {
      return res.status(403).send('Only the staff member themselves (or an admin) can edit this profile. <a href="javascript:history.back()">Back</a>');
    }
    const { rows } = await pool.query('UPDATE staff_profile_evidence SET removed = true, removed_at = now() WHERE id = $1 AND staff_id = $2 RETURNING title', [evidenceId, staffId]);
    if (!rows.length) return res.status(404).send('Evidence not found.');

    const affected = await pool.query('SELECT DISTINCT induction_item_id FROM staff_profile_evidence_applications WHERE profile_evidence_id = $1', [evidenceId]);
    for (const row of affected.rows) {
      await flagForReview({
        staffId, inductionItemId: row.induction_item_id,
        reason: `Evidence "${rows[0].title}" was removed from the profile — check whether this record still has the support it needs.`,
        sourceType: 'evidence_removed', sourceId: evidenceId,
      });
    }
    await logInductionChange({ staffId, contextType: 'profile_evidence', contextId: evidenceId, summary: `Evidence "${rows[0].title}" removed from profile`, changedByStaffId: req.staffUser.id });
    res.redirect(`/induction/staff/${staffId}/profile`);
  } catch (err) {
    next(err);
  }
});

app.post('/induction/staff/:staffId/profile/equipment-groups', async (req, res, next) => {
  try {
    const staffId = Number(req.params.staffId);
    if (staffId !== req.staffUser.id && req.staffUser.role !== 'admin') {
      return res.status(403).send('Only the staff member themselves (or an admin) can edit this profile. <a href="javascript:history.back()">Back</a>');
    }
    let categoryIds = req.body.category_id;
    if (!categoryIds) categoryIds = [];
    if (!Array.isArray(categoryIds)) categoryIds = [categoryIds];
    categoryIds = categoryIds.map(Number).filter((n) => Number.isInteger(n));

    await pool.query('DELETE FROM staff_profile_equipment_groups WHERE staff_id = $1 AND category_id != ALL($2::int[])', [staffId, categoryIds.length ? categoryIds : [0]]);
    for (const categoryId of categoryIds) {
      await pool.query(
        `INSERT INTO staff_profile_equipment_groups (staff_id, category_id, added_by_staff_id) VALUES ($1,$2,$3)
         ON CONFLICT (staff_id, category_id) DO NOTHING`,
        [staffId, categoryId, req.staffUser.id]
      );
    }
    await logInductionChange({ staffId, contextType: 'profile_equipment_groups', summary: 'Equipment groups with experience updated', changedByStaffId: req.staffUser.id });
    res.redirect(`/induction/staff/${staffId}/profile`);
  } catch (err) {
    next(err);
  }
});

// ---------- Competency profile: grouped self-assessment ----------
// "Complete profile → select relevant equipment → review pre-filled
// information → record exceptions → submit declaration." One submission
// here still writes/updates the real per-item staff_induction_declarations
// row for every selected item (never a replacement for it) -- see the
// staff_declaration_batches comment in db.js for why.

app.get('/induction/staff/:staffId/assess', async (req, res, next) => {
  try {
    const staffId = Number(req.params.staffId);
    if (staffId === req.staffUser.id) return res.redirect('/induction/me/equipment');
    if (staffId !== req.staffUser.id && req.staffUser.role !== 'admin') {
      return res.status(403).send('You can only complete your own self-assessment. <a href="/induction">Back</a>');
    }
    const staffResult = await pool.query('SELECT id, name FROM staff_users WHERE id = $1', [staffId]);
    if (!staffResult.rows.length) return res.status(404).send('Staff member not found.');
    const staff = staffResult.rows[0];

    const [categories, declResult, profile, licences, groups] = await Promise.all([
      getInductionCategoriesWithItems(),
      pool.query('SELECT induction_item_id, status FROM staff_induction_declarations WHERE staff_id = $1', [staffId]),
      getCurrentProfileVersion(staffId),
      getActiveLicences(staffId),
      getProfileEquipmentGroups(staffId),
    ]);
    const declByItem = new Map(declResult.rows.map((d) => [d.induction_item_id, d.status]));
    const groupCategoryIds = new Set(groups.map((g) => g.category_id));
    const hasProfileText = Boolean((profile && (profile.qualifications_trade || profile.teaching_industry_experience)));

    const categoryBlocks = categories.map((cat) => `
      <div class="form-section-title" style="margin-top:20px;">${escapeHtml(cat.name)} ${groupCategoryIds.has(cat.id) ? '<span class="badge badge-approved" style="margin-left:8px;">You\'ve claimed experience here</span>' : ''}</div>
      <table style="width:100%;border-collapse:collapse;">
        <tbody>
          ${cat.items.map((item) => {
            const current = declByItem.get(item.id) || 'not_assessed';
            const preTick = groupCategoryIds.has(cat.id);
            return `
            <tr style="border-bottom:1px solid #F0EDE5;">
              <td style="padding:8px 6px;width:1%;"><input type="checkbox" name="item_id" value="${item.id}" ${preTick ? 'checked' : ''}></td>
              <td style="padding:8px 6px;font-size:13px;">${escapeHtml(item.name)}<div style="font-size:11px;color:#B0AA9A;">Currently: ${escapeHtml(DECLARATION_LABELS[current])}</div></td>
              <td style="padding:8px 6px;">
                <select name="item_status_${item.id}" style="font-size:12px;padding:4px;">
                  <option value="">(use selection above)</option>
                  <option value="C">C — Competent</option>
                  <option value="NYC">NYC — Not yet competent</option>
                  <option value="NA">Not applicable</option>
                </select>
              </td>
              <td style="padding:8px 6px;"><input type="text" name="item_comment_${item.id}" placeholder="Exception / comment" style="width:100%;font-size:12px;padding:4px;"></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `).join('');

    const licenceCheckboxes = licences.map((l) => `
      <label style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px;">
        <input type="checkbox" name="licence_id" value="${l.id}">
        ${escapeHtml(l.name)}
      </label>`).join('');

    const body = `
      <a class="back-link" href="/induction/staff/${staffId}">← ${escapeHtml(staff.name)}</a>
      <h1 class="page-title">Self-assessment — ${escapeHtml(staff.name)}</h1>
      <p class="page-subtitle" style="margin-bottom:18px;">Select the equipment this applies to, declare a status, and submit one authenticated declaration. Untouched items stay "Not assessed".</p>
      <div class="note-box">A "Competent" declaration here is still only a self-declaration — it does not by itself authorise using the equipment or supervising students. <a href="/induction/staff/${staffId}/profile">Edit your Competency Profile</a> first if it needs updating.</div>
      ${!hasProfileText ? `<div class="note-box" style="border-color:#C9A227;">Your Competency Profile has no qualifications/experience text yet — add some, or cite a supporting licence below, before declaring "Competent".</div>` : ''}
      <form class="form-card" method="post" action="/induction/staff/${staffId}/assess">
        <div class="form-row">
          <label>Declare selected items as</label>
          <select name="batch_status" required>
            <option value="C">C — Self-assessed competent</option>
            <option value="NYC">NYC — Not yet competent</option>
            <option value="NA">Not applicable</option>
          </select>
        </div>
        <label style="display:flex;align-items:flex-start;gap:8px;font-size:13px;margin:10px 0;">
          <input type="checkbox" name="confirmed_quals_support" value="on">
          I confirm the qualifications and experience in my Competency Profile (and/or the licence(s) selected below) support competence for every item I've selected as Competent.
        </label>
        ${licenceCheckboxes ? `<div class="form-section-title">Cite supporting profile licences (optional, reused)</div><div style="margin-top:8px;">${licenceCheckboxes}</div>` : ''}
        <div class="form-row" style="margin-top:14px;">
          <label for="notes">Notes (applies to the whole declaration)</label>
          <textarea id="notes" name="notes" rows="2"></textarea>
        </div>
        <div class="form-section-title">Equipment</div>
        ${categoryBlocks}
        <div class="form-actions" style="margin-top:16px;">
          <button type="submit" class="btn btn-primary">Submit declaration</button>
        </div>
      </form>
    `;
    res.send(page({ title: `Self-Assessment — ${staff.name}`, active: 'induction', body }));
  } catch (err) {
    next(err);
  }
});

app.post('/induction/staff/:staffId/assess', async (req, res, next) => {
  try {
    const staffId = Number(req.params.staffId);
    if (staffId !== req.staffUser.id && req.staffUser.role !== 'admin') {
      return res.status(403).send('You can only complete your own self-assessment. <a href="/induction">Back</a>');
    }
    const { batch_status, notes } = req.body;
    if (!['C', 'NYC', 'NA'].includes(batch_status)) return res.status(400).send('Invalid status. <a href="javascript:history.back()">Back</a>');
    const confirmedQualsSupport = req.body.confirmed_quals_support === 'on' || req.body.confirmed_quals_support === 'true';

    let itemIds = req.body.item_id;
    if (!itemIds) itemIds = [];
    if (!Array.isArray(itemIds)) itemIds = [itemIds];
    itemIds = itemIds.map(Number).filter((n) => Number.isInteger(n));
    if (!itemIds.length) return res.status(400).send('Select at least one equipment item. <a href="javascript:history.back()">Back</a>');

    let evidenceIds = req.body.evidence_id;
    if (!evidenceIds) evidenceIds = [];
    if (!Array.isArray(evidenceIds)) evidenceIds = [evidenceIds];
    evidenceIds = evidenceIds.map(Number).filter((n) => Number.isInteger(n));

    let licenceIds = req.body.licence_id;
    if (!licenceIds) licenceIds = [];
    if (!Array.isArray(licenceIds)) licenceIds = [licenceIds];
    licenceIds = licenceIds.map(Number).filter((n) => Number.isInteger(n));

    // Resolve each item's effective status (batch default, or its own
    // individual exception) before checking whether any of them need the
    // competence confirmation / supporting profile content.
    const effective = itemIds.map((id) => {
      const override = req.body[`item_status_${id}`];
      const status = ['C', 'NYC', 'NA'].includes(override) ? override : batch_status;
      return { id, status, comment: normalizeText(req.body[`item_comment_${id}`]) || null };
    });
    const anyCompetent = effective.some((e) => e.status === 'C');
    if (anyCompetent && !confirmedQualsSupport) {
      return res.status(400).send('Declaring any item "Competent" requires confirming your qualifications/experience support it. <a href="javascript:history.back()">Back</a>');
    }
    const profile = await getCurrentProfileVersion(staffId);
    const hasProfileSupport = Boolean(profile && (profile.qualifications_trade || profile.teaching_industry_experience)) || evidenceIds.length > 0 || licenceIds.length > 0;
    if (anyCompetent && !hasProfileSupport) {
      return res.status(400).send('Add qualifications/experience or a licence to your Competency Profile before declaring an item competent. <a href="javascript:history.back()">Back</a>');
    }

    const batchResult = await pool.query(
      `INSERT INTO staff_declaration_batches (staff_id, batch_status, confirmed_quals_support, profile_version_id, notes, declared_by_staff_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [staffId, batch_status, confirmedQualsSupport, profile ? profile.id : null, normalizeText(notes) || null, req.staffUser.id]
    );
    const batchId = batchResult.rows[0].id;

    const qualsSnapshot = profile ? [profile.qualifications_trade, profile.teaching_industry_experience].filter(Boolean).join('\n\n') : null;

    for (const item of effective) {
      await pool.query(
        `INSERT INTO staff_declaration_batch_items (batch_id, induction_item_id, status, comment) VALUES ($1,$2,$3,$4)
         ON CONFLICT (batch_id, induction_item_id) DO UPDATE SET status = EXCLUDED.status, comment = EXCLUDED.comment`,
        [batchId, item.id, item.status, item.comment]
      );
      const declResult = await pool.query(
        `INSERT INTO staff_induction_declarations (staff_id, induction_item_id, status, qualifications_experience, declared_at)
         VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (staff_id, induction_item_id) DO UPDATE SET
           status = EXCLUDED.status, qualifications_experience = EXCLUDED.qualifications_experience,
           declared_at = now(), updated_at = now()
         RETURNING id`,
        [staffId, item.id, item.status, qualsSnapshot]
      );
      for (const evidenceId of evidenceIds) {
        await pool.query(
          `INSERT INTO staff_profile_evidence_applications (profile_evidence_id, staff_id, induction_item_id, declaration_batch_id, applied_by_staff_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [evidenceId, staffId, item.id, batchId, req.staffUser.id]
        );
      }
      for (const licenceId of licenceIds) {
        await pool.query(
          `INSERT INTO staff_profile_licence_applications (profile_licence_id, staff_id, induction_item_id, declaration_batch_id, applied_by_staff_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [licenceId, staffId, item.id, batchId, req.staffUser.id]
        );
      }
      await logInductionChange({
        staffId, inductionItemId: item.id, contextType: 'declaration', contextId: declResult.rows[0].id,
        summary: `Self-declaration set to "${DECLARATION_LABELS[item.status]}" via bulk self-assessment (batch #${batchId})`,
        changedByStaffId: req.staffUser.id,
      });
    }

    res.redirect(`/induction/staff/${staffId}`);
  } catch (err) {
    next(err);
  }
});

// ---------- Competency profile: experienced-staff review pathway ----------
// "Let an authorised assessor review the staff profile and relevant
// equipment together... only allow bulk verification where the assessor
// explicitly confirms the evidence supports each selected item... keep a
// separate verification record for every item." Submitting still writes
// one row per item into the existing staff_induction_competency_verifications
// table -- this batch is the record of the review session, not a
// substitute. Never writes to staff_induction_authorisations.

app.get('/induction/staff/:staffId/review', async (req, res, next) => {
  try {
    const staffId = Number(req.params.staffId);
    if (!canActAsAssessor(req.staffUser.role)) return res.status(403).send('You do not have permission to do that.');
    if (blockSelfAction(res, req.staffUser.id, staffId)) return;
    if (req.query.legacy !== '1') return res.redirect(`/induction/assessor/staff/${staffId}`);

    const staffResult = await pool.query('SELECT id, name FROM staff_users WHERE id = $1', [staffId]);
    if (!staffResult.rows.length) return res.status(404).send('Staff member not found.');
    const staff = staffResult.rows[0];

    const [categories, declResult, verifResult, profile, licences] = await Promise.all([
      getInductionCategoriesWithItems(),
      pool.query('SELECT induction_item_id, status FROM staff_induction_declarations WHERE staff_id = $1', [staffId]),
      pool.query('SELECT induction_item_id, verified FROM staff_induction_competency_verifications WHERE staff_id = $1', [staffId]),
      getCurrentProfileVersion(staffId),
      getActiveLicences(staffId),
    ]);
    const declByItem = new Map(declResult.rows.map((d) => [d.induction_item_id, d.status]));
    const verifByItem = new Map(verifResult.rows.map((v) => [v.induction_item_id, v.verified]));

    const categoryBlocks = categories.map((cat) => `
      <div class="form-section-title" style="margin-top:18px;">${escapeHtml(cat.name)}</div>
      <table style="width:100%;border-collapse:collapse;">
        <tbody>
          ${cat.items.map((item) => {
            const declStatus = declByItem.get(item.id) || 'not_assessed';
            const verified = verifByItem.get(item.id);
            const suggested = declStatus === 'C' && !verified;
            return `
            <tr style="border-bottom:1px solid #F0EDE5;">
              <td style="padding:8px 6px;width:1%;"><input type="checkbox" name="item_id" value="${item.id}" ${suggested ? 'checked' : ''}></td>
              <td style="padding:8px 6px;font-size:13px;">${escapeHtml(item.name)}
                <div style="font-size:11px;color:#B0AA9A;">Self-assessed: ${escapeHtml(DECLARATION_LABELS[declStatus])}${verified ? ' · Already verified' : ''}</div>
              </td>
              <td style="padding:8px 6px;"><input type="text" name="item_gaps_${item.id}" placeholder="Gaps / restrictions for this item" style="width:100%;font-size:12px;padding:4px;"></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `).join('');

    const licenceList = licences.map((l) => `<li style="font-size:13px;">${escapeHtml(l.name)}${l.expiry_date ? ` (expires ${formatBrisbaneDate(l.expiry_date)})` : ''}</li>`).join('') || '<li style="color:#6B6659;font-size:13px;">None recorded.</li>';

    const body = `
      <a class="back-link" href="/induction/staff/${staffId}">← ${escapeHtml(staff.name)}</a>
      <h1 class="page-title">Review — ${escapeHtml(staff.name)}</h1>
      <p class="page-subtitle" style="margin-bottom:18px;">Review the profile and relevant equipment together, then record verified competency per item. Items already self-assessed "Competent" and not yet verified are pre-selected.</p>
      <div class="card" style="padding:18px;margin-bottom:16px;">
        <div class="form-section-title" style="margin-top:0;">Profile summary</div>
        <div style="font-size:13px;white-space:pre-wrap;">${escapeHtml(profile ? (profile.qualifications_trade || '') : '') || '<span style="color:#6B6659;">No qualifications/trade background recorded.</span>'}</div>
        <div style="font-size:13px;white-space:pre-wrap;margin-top:6px;">${escapeHtml(profile ? (profile.teaching_industry_experience || '') : '') || '<span style="color:#6B6659;">No teaching/industry experience recorded.</span>'}</div>
        <div style="margin-top:12px;">
          <div style="font-size:11px;text-transform:uppercase;color:#6B6659;">Licences</div><ul style="margin:4px 0 0 18px;">${licenceList}</ul>
        </div>
        <a href="/induction/staff/${staffId}/profile" style="display:inline-block;margin-top:10px;color:#1B5E52;font-weight:600;font-size:13px;">Open full Competency Profile →</a>
      </div>
      <div class="note-box">Bulk verification only proceeds once you explicitly confirm the profile above supports every item selected. A separate verification record is still kept for each one.</div>
      <form class="form-card" method="post" action="/induction/staff/${staffId}/review">
        <div class="form-row"><label for="basis">Basis for recognising existing competence</label><textarea id="basis" name="basis" rows="3" required placeholder="e.g. Qualified trade carpenter (Cert III Carpentry, sighted), 8 years industry experience operating fixed wood machinery."></textarea></div>
        <label style="display:flex;align-items:flex-start;gap:8px;font-size:13px;margin:10px 0;">
          <input type="checkbox" name="confirmed_evidence_supports" value="on" required>
          I confirm the profile and licence(s) above support verified competency for every item I've selected below.
        </label>
        <div class="form-row"><label for="remaining_requirements">Any remaining local induction requirements</label><textarea id="remaining_requirements" name="remaining_requirements" rows="2" placeholder="e.g. Still needs this school's workshop-specific emergency procedures."></textarea></div>
        <div class="form-section-title">Equipment</div>
        ${categoryBlocks}
        <div class="form-actions" style="margin-top:16px;"><button type="submit" class="btn btn-primary">Record verification for selected items</button></div>
      </form>
    `;
    res.send(page({ title: `Review — ${staff.name}`, active: 'induction', body }));
  } catch (err) {
    next(err);
  }
});

app.post('/induction/staff/:staffId/review', async (req, res, next) => {
  try {
    const staffId = Number(req.params.staffId);
    if (!canActAsAssessor(req.staffUser.role)) return res.status(403).send('You do not have permission to do that.');
    if (blockSelfAction(res, req.staffUser.id, staffId)) return;

    const { basis, remaining_requirements } = req.body;
    if (!normalizeText(basis || '').trim()) return res.status(400).send('A basis for recognising existing competence is required. <a href="javascript:history.back()">Back</a>');
    const confirmedEvidenceSupports = req.body.confirmed_evidence_supports === 'on' || req.body.confirmed_evidence_supports === 'true';
    if (!confirmedEvidenceSupports) return res.status(400).send('Bulk verification requires confirming the profile supports every selected item. <a href="javascript:history.back()">Back</a>');

    let itemIds = req.body.item_id;
    if (!itemIds) itemIds = [];
    if (!Array.isArray(itemIds)) itemIds = [itemIds];
    itemIds = itemIds.map(Number).filter((n) => Number.isInteger(n));
    if (!itemIds.length) return res.status(400).send('Select at least one equipment item. <a href="javascript:history.back()">Back</a>');

    const reviewState = await simpleInduction.buildTeacherState(staffId, { raiseAlerts: false });
    const notReady = itemIds.filter((id) => {
      const entry = reviewState && reviewState.entries.find((e) => e.item.id === id);
      return !entry || entry.docState !== 'acknowledged';
    });
    if (notReady.length) {
      return res.status(400).send('Every selected item must be selected by the staff member and have its current PERA and SOP acknowledged before competency can be verified. Nothing was saved. <a href="javascript:history.back()">Back</a>');
    }

    const profile = await getCurrentProfileVersion(staffId);
    const batchResult = await pool.query(
      `INSERT INTO staff_verification_batches (staff_id, assessor_staff_id, basis, confirmed_evidence_supports, remaining_requirements, profile_version_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [staffId, req.staffUser.id, normalizeText(basis), confirmedEvidenceSupports, normalizeText(remaining_requirements) || null, profile ? profile.id : null]
    );
    const batchId = batchResult.rows[0].id;

    for (const itemId of itemIds) {
      const gaps = normalizeText(req.body[`item_gaps_${itemId}`]) || null;
      await pool.query(
        `INSERT INTO staff_verification_batch_items (batch_id, induction_item_id, gaps_or_restrictions) VALUES ($1,$2,$3)
         ON CONFLICT (batch_id, induction_item_id) DO UPDATE SET gaps_or_restrictions = EXCLUDED.gaps_or_restrictions`,
        [batchId, itemId, gaps]
      );
      const verifResult = await pool.query(
        `INSERT INTO staff_induction_competency_verifications (staff_id, induction_item_id, verified, verified_by_staff_id, verified_at, basis, notes)
         VALUES ($1,$2,true,$3,now(),$4,$5)
         ON CONFLICT (staff_id, induction_item_id) DO UPDATE SET
           verified = true, verified_by_staff_id = EXCLUDED.verified_by_staff_id, verified_at = now(),
           basis = EXCLUDED.basis, notes = EXCLUDED.notes, updated_at = now()
         RETURNING id`,
        [staffId, itemId, req.staffUser.id, normalizeText(basis), gaps]
      );
      await logInductionChange({
        staffId, inductionItemId: itemId, contextType: 'verification', contextId: verifResult.rows[0].id,
        summary: `Assessor-verified competency recorded via bulk review (batch #${batchId})`, changedByStaffId: req.staffUser.id,
      });
    }

    res.redirect(`/induction/staff/${staffId}`);
  } catch (err) {
    next(err);
  }
});

// ---------- Competency profile: review queue (unresolved flags +
// staff pending bulk verification + expiring/expired licences) ----------

app.get('/induction/review-queue', async (req, res, next) => {
  try {
    if (!canActAsAssessor(req.staffUser.role)) return res.status(403).send('You do not have permission to do that.');

    const [flagsResult, pendingResult, licenceResult] = await Promise.all([
      pool.query(`
        SELECT f.*, s.name AS staff_name, i.name AS item_name
        FROM staff_profile_review_flags f
        JOIN staff_users s ON s.id = f.staff_id
        LEFT JOIN induction_equipment_items i ON i.id = f.induction_item_id
        WHERE f.resolved = false ORDER BY f.created_at ASC`),
      pool.query(`
        SELECT s.id AS staff_id, s.name AS staff_name, COUNT(*)::int AS pending_count
        FROM staff_induction_declarations d
        JOIN staff_users s ON s.id = d.staff_id AND s.disabled = false
        WHERE d.status = 'C'
        AND NOT EXISTS (SELECT 1 FROM staff_induction_competency_verifications v WHERE v.staff_id = d.staff_id AND v.induction_item_id = d.induction_item_id AND v.verified = true)
        GROUP BY s.id, s.name ORDER BY s.name`),
      pool.query(`
        SELECT l.*, s.name AS staff_name FROM staff_profile_licences l
        JOIN staff_users s ON s.id = l.staff_id
        WHERE l.active = true AND l.expiry_date IS NOT NULL AND l.expiry_date <= (CURRENT_DATE + INTERVAL '30 days')
        ORDER BY l.expiry_date ASC`),
    ]);

    const body = `
      <a class="back-link" href="/induction">← Staff Induction</a>
      <h1 class="page-title">Review queue</h1>
      <p class="page-subtitle" style="margin-bottom:24px;">Staff pending bulk verification, profile changes flagged for review, and licences expired or expiring within 30 days.</p>

      <div class="form-section-title">Staff pending verification</div>
      <div class="card" style="padding:18px;margin-bottom:20px;">
        ${pendingResult.rows.length ? pendingResult.rows.map((r) => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #F0EDE5;">
            <span style="font-size:13px;">${escapeHtml(r.staff_name)} — ${r.pending_count} item(s) awaiting verification</span>
            <a href="/induction/staff/${r.staff_id}/review" class="btn btn-secondary" style="padding:6px 12px;">Review →</a>
          </div>`).join('') : '<div class="empty-state">Nobody pending verification.</div>'}
      </div>

      <div class="form-section-title">Flagged for review</div>
      <div class="card" style="padding:18px;margin-bottom:20px;">
        ${flagsResult.rows.length ? flagsResult.rows.map((f) => `
          <div style="padding:10px 0;border-bottom:1px solid #F0EDE5;">
            <div style="font-size:13px;"><strong>${escapeHtml(f.staff_name)}</strong>${f.item_name ? ` — ${escapeHtml(f.item_name)}` : ' — profile-wide'}</div>
            <div style="font-size:12px;color:#6B6659;margin:2px 0 6px;">${escapeHtml(f.reason)} <span style="color:#B0AA9A;">· ${formatBrisbaneDateTime(f.created_at)}</span></div>
            <form method="post" action="/induction/review-queue/flags/${f.id}/resolve" style="display:flex;gap:8px;">
              <input type="text" name="resolution_notes" placeholder="Resolution notes (optional)" style="flex:1;font-size:12px;padding:4px 8px;">
              <button type="submit" class="btn btn-secondary" style="padding:4px 10px;font-size:12px;">Mark resolved</button>
            </form>
          </div>`).join('') : '<div class="empty-state">Nothing flagged.</div>'}
      </div>

      <div class="form-section-title">Licences expired or expiring within 30 days</div>
      <div class="card" style="padding:18px;">
        ${licenceResult.rows.length ? licenceResult.rows.map((l) => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #F0EDE5;">
            <span style="font-size:13px;">${escapeHtml(l.staff_name)} — ${escapeHtml(l.name)}</span>
            <span class="badge ${new Date(l.expiry_date) < new Date() ? 'badge-changes' : 'badge-pending'}">${formatBrisbaneDate(l.expiry_date)}</span>
          </div>`).join('') : '<div class="empty-state">No licences expiring soon.</div>'}
      </div>
    `;
    res.send(page({ title: 'Review Queue', active: 'induction', body }));
  } catch (err) {
    next(err);
  }
});

app.post('/induction/review-queue/flags/:flagId/resolve', async (req, res, next) => {
  try {
    if (!canActAsAssessor(req.staffUser.role)) return res.status(403).send('You do not have permission to do that.');
    const flagId = Number(req.params.flagId);
    await pool.query(
      `UPDATE staff_profile_review_flags SET resolved = true, resolved_by_staff_id = $1, resolved_at = now(), resolution_notes = $2 WHERE id = $3`,
      [req.staffUser.id, normalizeText(req.body.resolution_notes) || null, flagId]
    );
    res.redirect('/induction/review-queue');
  } catch (err) {
    next(err);
  }
});

// ---------- Competency profile: shared topics ----------
// "Workshop emergency procedures and general workshop rules" recorded
// once and referenced by whichever items an admin links them to. Kept
// deliberately separate from machine-specific SOP acknowledgement /
// practical assessment (staff_induction_steps / staff_induction_assessments
// above) -- acknowledging a shared topic never substitutes for those.

app.get('/admin/induction/shared-topics', requireRole('admin'), async (req, res, next) => {
  try {
    const [topicsResult, categories, linksResult] = await Promise.all([
      pool.query('SELECT * FROM induction_shared_topics ORDER BY archived ASC, sort_order ASC'),
      getInductionCategoriesWithItems(),
      pool.query('SELECT * FROM induction_item_shared_topics'),
    ]);
    const linkedItemIdsByTopic = new Map();
    for (const row of linksResult.rows) {
      if (!linkedItemIdsByTopic.has(row.topic_id)) linkedItemIdsByTopic.set(row.topic_id, new Set());
      linkedItemIdsByTopic.get(row.topic_id).add(row.induction_item_id);
    }

    const topicBlocks = topicsResult.rows.map((topic) => {
      const linkedIds = linkedItemIdsByTopic.get(topic.id) || new Set();
      return `
      <div class="card" style="padding:18px;margin-bottom:14px;${topic.archived ? 'opacity:0.6;' : ''}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div>
            <div style="font-weight:700;font-size:14px;">${escapeHtml(topic.name)}</div>
            <div style="font-size:12px;color:#6B6659;">${escapeHtml(topic.description || '')}</div>
          </div>
          <form method="post" action="/admin/induction/shared-topics/${topic.id}/${topic.archived ? 'restore' : 'archive'}">
            <button type="submit" class="btn btn-secondary" style="padding:4px 10px;font-size:12px;">${topic.archived ? 'Restore' : 'Archive'}</button>
          </form>
        </div>
        <form method="post" action="/admin/induction/shared-topics/${topic.id}/items" style="margin-top:10px;">
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:4px;max-height:220px;overflow-y:auto;border:1px solid #F0EDE5;border-radius:6px;padding:10px;">
            ${categories.map((cat) => cat.items.map((item) => `
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;">
                <input type="checkbox" name="item_id" value="${item.id}" ${linkedIds.has(item.id) ? 'checked' : ''}>
                ${escapeHtml(item.name)}
              </label>`).join('')).join('')}
          </div>
          <div class="form-actions" style="margin-top:8px;"><button type="submit" class="btn btn-secondary" style="padding:6px 12px;font-size:12px;">Save linked equipment</button></div>
        </form>
      </div>`;
    }).join('');

    const body = `
      ${adminHeader('Shared induction topics', 'Recorded once and referenced by whichever equipment items you link below, instead of repeating it on every item.')}
      ${topicBlocks || '<div class="empty-state">No shared topics yet.</div>'}
      <div class="form-section-title">Add a shared topic</div>
      <form class="form-card" method="post" action="/admin/induction/shared-topics" style="max-width:560px;">
        <div class="form-row"><label for="name">Name</label><input type="text" id="name" name="name" required></div>
        <div class="form-row"><label for="description">Description</label><textarea id="description" name="description" rows="2"></textarea></div>
        <div class="form-actions"><button type="submit" class="btn btn-primary">Add topic</button></div>
      </form>
    `;
    res.send(page({ title: 'Shared Induction Topics', active: 'admin', body }));
  } catch (err) {
    next(err);
  }
});

app.post('/admin/induction/shared-topics', requireRole('admin'), async (req, res, next) => {
  try {
    const name = normalizeText(req.body.name || '').trim();
    if (!name) return res.status(400).send('A name is required. <a href="javascript:history.back()">Back</a>');
    await pool.query('INSERT INTO induction_shared_topics (name, description) VALUES ($1,$2)', [name, normalizeText(req.body.description) || null]);
    res.redirect('/admin/induction/shared-topics');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/induction/shared-topics/:topicId/archive', requireRole('admin'), async (req, res, next) => {
  try {
    await pool.query('UPDATE induction_shared_topics SET archived = true WHERE id = $1', [Number(req.params.topicId)]);
    res.redirect('/admin/induction/shared-topics');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/induction/shared-topics/:topicId/restore', requireRole('admin'), async (req, res, next) => {
  try {
    await pool.query('UPDATE induction_shared_topics SET archived = false WHERE id = $1', [Number(req.params.topicId)]);
    res.redirect('/admin/induction/shared-topics');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/induction/shared-topics/:topicId/items', requireRole('admin'), async (req, res, next) => {
  try {
    const topicId = Number(req.params.topicId);
    let itemIds = req.body.item_id;
    if (!itemIds) itemIds = [];
    if (!Array.isArray(itemIds)) itemIds = [itemIds];
    itemIds = itemIds.map(Number).filter((n) => Number.isInteger(n));

    await pool.query('DELETE FROM induction_item_shared_topics WHERE topic_id = $1 AND induction_item_id != ALL($2::int[])', [topicId, itemIds.length ? itemIds : [0]]);
    for (const itemId of itemIds) {
      await pool.query('INSERT INTO induction_item_shared_topics (topic_id, induction_item_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [topicId, itemId]);
    }
    res.redirect('/admin/induction/shared-topics');
  } catch (err) {
    next(err);
  }
});

app.post('/induction/staff/:staffId/shared-topic/:topicId/acknowledge', async (req, res, next) => {
  try {
    const staffId = Number(req.params.staffId);
    const topicId = Number(req.params.topicId);
    if (staffId !== req.staffUser.id && req.staffUser.role !== 'admin') {
      return res.status(403).send('Only the staff member themselves (or an admin) can acknowledge this. <a href="javascript:history.back()">Back</a>');
    }
    await pool.query(
      `INSERT INTO staff_shared_topic_acknowledgements (staff_id, topic_id, acknowledged_by_staff_id) VALUES ($1,$2,$3)
       ON CONFLICT (staff_id, topic_id) DO UPDATE SET acknowledged_at = now(), acknowledged_by_staff_id = EXCLUDED.acknowledged_by_staff_id`,
      [staffId, topicId, req.staffUser.id]
    );
    await logInductionChange({ staffId, contextType: 'shared_topic', contextId: topicId, summary: 'Shared induction topic acknowledged', changedByStaffId: req.staffUser.id });
    res.redirect(req.get('referer') || `/induction/staff/${staffId}`);
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
      console.log(`${BRAND} listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to run database migration:', err);
    process.exit(1);
  });
