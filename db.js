const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('DATABASE_URL environment variable is not set.');
}

// SSL: Render's managed Postgres needs it; a local/self-hosted Postgres
// (Docker Compose, "localhost") normally doesn't have certs configured, so
// skip it there. DATABASE_SSL lets a deployment override this explicitly
// either way instead of relying on guessing from the hostname.
let sslOption;
if (process.env.DATABASE_SSL === 'false') {
  sslOption = false;
} else if (process.env.DATABASE_SSL === 'true') {
  sslOption = { rejectUnauthorized: false };
} else {
  sslOption = connectionString && connectionString.includes('localhost')
    ? false
    : { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString,
  ssl: sslOption,
});

async function migrate() {
  // Align with Queensland Dept of Education terminology: what this app called
  // "risk assessments" for tools/equipment is their Plant & Equipment Risk
  // Assessment (PERA). Rename the existing production table/column in place
  // (safe/idempotent — no-ops once already renamed) before the CREATE TABLE
  // IF NOT EXISTS statements below, which use the new names.
  await pool.query(`ALTER TABLE IF EXISTS risk_assessments RENAME TO pera_records;`);
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'cara_tool_links' AND column_name = 'risk_assessment_id'
      ) THEN
        ALTER TABLE cara_tool_links RENAME COLUMN risk_assessment_id TO pera_id;
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pera_records (
      id SERIAL PRIMARY KEY,
      activity_name TEXT NOT NULL,
      class_unit TEXT,
      location TEXT,
      risk_level TEXT NOT NULL CHECK (risk_level IN ('Low','Medium','High','Extreme')),
      status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft','Pending approval','Approved','Changes requested')),
      hazards TEXT,
      control_measures TEXT,
      required_supervision TEXT,
      consent_required BOOLEAN NOT NULL DEFAULT false,
      submitted_by TEXT,
      approver TEXT,
      approved_at TIMESTAMPTZ,
      next_review_date DATE,
      review_notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cara_records (
      id SERIAL PRIMARY KEY,
      activity_name TEXT NOT NULL,
      class_unit TEXT,
      activity_scope TEXT,
      risk_level TEXT NOT NULL CHECK (risk_level IN ('Low','Medium','High','Extreme')),
      status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft','Pending approval','Approved','Changes requested')),

      students_notes TEXT,
      emergency_first_aid TEXT,
      induction_instruction TEXT,
      consent_required BOOLEAN NOT NULL DEFAULT false,

      supervision_notes TEXT,
      supervisor_qualification TEXT,
      facilities_equipment TEXT,

      environmental_hazards TEXT,
      environmental_controls TEXT,
      facilities_hazards TEXT,
      facilities_controls TEXT,
      student_hazards TEXT,
      student_controls TEXT,

      submitted_by TEXT,
      approver TEXT,
      approved_at TIMESTAMPTZ,
      next_review_date DATE,
      review_notes TEXT,

      reviewed_at TIMESTAMPTZ,
      monitoring_new_hazards BOOLEAN,
      monitoring_controls_effective BOOLEAN,
      monitoring_further_action BOOLEAN,
      monitoring_details TEXT,

      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cara_tool_links (
      cara_id INTEGER NOT NULL REFERENCES cara_records(id) ON DELETE CASCADE,
      pera_id INTEGER NOT NULL REFERENCES pera_records(id) ON DELETE CASCADE,
      PRIMARY KEY (cara_id, pera_id)
    );
  `);

  await pool.query(`ALTER TABLE cara_records ADD COLUMN IF NOT EXISTS teacher_signature TEXT;`);
  await pool.query(`ALTER TABLE cara_records ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE cara_records ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;`);

  // Change history for CARA edits (teacher-facing edit form). One row per
  // edit that actually changed something, with a pre-formatted human
  // readable summary of what changed (field-by-field old -> new).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cara_change_log (
      id SERIAL PRIMARY KEY,
      cara_id INTEGER NOT NULL REFERENCES cara_records(id) ON DELETE CASCADE,
      changed_by TEXT,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      summary TEXT NOT NULL
    );
  `);

  // Short one-line label for the collapsed row of the change history tree
  // (e.g. "Updated supervision", "CARA created"), computed and stored at
  // write time -- see server.js. Rows saved before this column existed are
  // NULL and fall back to a best-effort label derived from "summary".
  await pool.query(`ALTER TABLE cara_change_log ADD COLUMN IF NOT EXISTS brief TEXT;`);

  // One-off cleanup: some existing records (older seed data / text pasted
  // from Word) have Windows-style \r\n line endings saved in their text
  // fields. Browsers silently normalise \r\n to \n when rendering the HTML
  // pages, so this was invisible there, but the CARA PDF export uses
  // PDFKit's built-in fonts directly, which have no glyph for a lone \r and
  // render it as a stray "Ð" at the end of every line. Strip it from
  // whatever's already stored (new saves are cleaned in server.js before
  // they ever reach here). Safe to run every startup: idempotent, and each
  // UPDATE only touches rows that still contain a \r.
  await pool.query(`
    UPDATE pera_records SET
      activity_name = regexp_replace(activity_name, E'\\r\\n?', E'\\n', 'g'),
      class_unit = regexp_replace(class_unit, E'\\r\\n?', E'\\n', 'g'),
      hazards = regexp_replace(hazards, E'\\r\\n?', E'\\n', 'g'),
      control_measures = regexp_replace(control_measures, E'\\r\\n?', E'\\n', 'g'),
      required_supervision = regexp_replace(required_supervision, E'\\r\\n?', E'\\n', 'g'),
      submitted_by = regexp_replace(submitted_by, E'\\r\\n?', E'\\n', 'g'),
      approver = regexp_replace(approver, E'\\r\\n?', E'\\n', 'g'),
      review_notes = regexp_replace(review_notes, E'\\r\\n?', E'\\n', 'g')
    WHERE activity_name LIKE '%' || chr(13) || '%'
       OR class_unit LIKE '%' || chr(13) || '%'
       OR hazards LIKE '%' || chr(13) || '%'
       OR control_measures LIKE '%' || chr(13) || '%'
       OR required_supervision LIKE '%' || chr(13) || '%'
       OR submitted_by LIKE '%' || chr(13) || '%'
       OR approver LIKE '%' || chr(13) || '%'
       OR review_notes LIKE '%' || chr(13) || '%';
  `);

  await pool.query(`
    UPDATE cara_records SET
      activity_name = regexp_replace(activity_name, E'\\r\\n?', E'\\n', 'g'),
      class_unit = regexp_replace(class_unit, E'\\r\\n?', E'\\n', 'g'),
      activity_scope = regexp_replace(activity_scope, E'\\r\\n?', E'\\n', 'g'),
      students_notes = regexp_replace(students_notes, E'\\r\\n?', E'\\n', 'g'),
      emergency_first_aid = regexp_replace(emergency_first_aid, E'\\r\\n?', E'\\n', 'g'),
      induction_instruction = regexp_replace(induction_instruction, E'\\r\\n?', E'\\n', 'g'),
      supervision_notes = regexp_replace(supervision_notes, E'\\r\\n?', E'\\n', 'g'),
      supervisor_qualification = regexp_replace(supervisor_qualification, E'\\r\\n?', E'\\n', 'g'),
      facilities_equipment = regexp_replace(facilities_equipment, E'\\r\\n?', E'\\n', 'g'),
      environmental_hazards = regexp_replace(environmental_hazards, E'\\r\\n?', E'\\n', 'g'),
      environmental_controls = regexp_replace(environmental_controls, E'\\r\\n?', E'\\n', 'g'),
      facilities_hazards = regexp_replace(facilities_hazards, E'\\r\\n?', E'\\n', 'g'),
      facilities_controls = regexp_replace(facilities_controls, E'\\r\\n?', E'\\n', 'g'),
      student_hazards = regexp_replace(student_hazards, E'\\r\\n?', E'\\n', 'g'),
      student_controls = regexp_replace(student_controls, E'\\r\\n?', E'\\n', 'g'),
      submitted_by = regexp_replace(submitted_by, E'\\r\\n?', E'\\n', 'g'),
      approver = regexp_replace(approver, E'\\r\\n?', E'\\n', 'g'),
      review_notes = regexp_replace(review_notes, E'\\r\\n?', E'\\n', 'g'),
      monitoring_details = regexp_replace(monitoring_details, E'\\r\\n?', E'\\n', 'g')
    WHERE activity_name LIKE '%' || chr(13) || '%'
       OR class_unit LIKE '%' || chr(13) || '%'
       OR activity_scope LIKE '%' || chr(13) || '%'
       OR students_notes LIKE '%' || chr(13) || '%'
       OR emergency_first_aid LIKE '%' || chr(13) || '%'
       OR induction_instruction LIKE '%' || chr(13) || '%'
       OR supervision_notes LIKE '%' || chr(13) || '%'
       OR supervisor_qualification LIKE '%' || chr(13) || '%'
       OR facilities_equipment LIKE '%' || chr(13) || '%'
       OR environmental_hazards LIKE '%' || chr(13) || '%'
       OR environmental_controls LIKE '%' || chr(13) || '%'
       OR facilities_hazards LIKE '%' || chr(13) || '%'
       OR facilities_controls LIKE '%' || chr(13) || '%'
       OR student_hazards LIKE '%' || chr(13) || '%'
       OR student_controls LIKE '%' || chr(13) || '%'
       OR submitted_by LIKE '%' || chr(13) || '%'
       OR approver LIKE '%' || chr(13) || '%'
       OR review_notes LIKE '%' || chr(13) || '%'
       OR monitoring_details LIKE '%' || chr(13) || '%';
  `);

  await pool.query(`
    UPDATE cara_change_log SET
      summary = regexp_replace(summary, E'\\r\\n?', E'\\n', 'g')
    WHERE summary LIKE '%' || chr(13) || '%';
  `);

  // Equipment register: a simple list of the school's actual physical tools
  // and machinery. This is deliberately separate from PERA, which is the
  // risk-assessment paperwork for a *type* of tool/activity -- an equipment
  // item is a specific physical thing (e.g. "Guillotine #2, Workshop A") that
  // can optionally link to the PERA covering it, so a physical item can be
  // traced straight to its risk assessment.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS equipment_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      location TEXT,
      status TEXT NOT NULL DEFAULT 'Operational' CHECK (status IN ('Operational','Needs repair','Out of service')),
      pera_id INTEGER REFERENCES pera_records(id) ON DELETE SET NULL,
      last_inspected DATE,
      next_inspection_due DATE,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // How often each item needs to be checked (drives next_inspection_due
  // whenever a check is logged), and the list of things to look at during a
  // check (e.g. "Blade guard", "Power cord condition") — a plain JSON array
  // of strings, since these are just a checklist, not records in their own
  // right.
  await pool.query(`ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS inspection_frequency TEXT;`);
  await pool.query(`ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS checklist_items JSONB NOT NULL DEFAULT '[]'::jsonb;`);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'equipment_items_inspection_frequency_check'
      ) THEN
        ALTER TABLE equipment_items
          ADD CONSTRAINT equipment_items_inspection_frequency_check
          CHECK (inspection_frequency IS NULL OR inspection_frequency IN ('Daily','Week','Term','Semester','Yearly'));
      END IF;
    END $$;
  `);

  // One row per logged check ("I checked this today, here's what I looked
  // at"). Kept separate from equipment_items so the history isn't lost every
  // time a new check overwrites last_inspected/next_inspection_due.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS equipment_checks (
      id SERIAL PRIMARY KEY,
      equipment_id INTEGER NOT NULL REFERENCES equipment_items(id) ON DELETE CASCADE,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      checked_by TEXT,
      completed_items JSONB NOT NULL DEFAULT '[]'::jsonb,
      notes TEXT
    );
  `);
  // Defensive: an equipment_checks table may already exist from an earlier,
  // differently-shaped attempt at this feature. ADD COLUMN IF NOT EXISTS is
  // a no-op wherever the column's already there, and safely backfills a
  // default for any existing rows otherwise, so this can't fail or clobber
  // data even if the table predates this exact column set.
  await pool.query(`ALTER TABLE equipment_checks ADD COLUMN IF NOT EXISTS equipment_id INTEGER REFERENCES equipment_items(id) ON DELETE CASCADE;`);
  await pool.query(`ALTER TABLE equipment_checks ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ NOT NULL DEFAULT now();`);
  await pool.query(`ALTER TABLE equipment_checks ADD COLUMN IF NOT EXISTS checked_by TEXT;`);
  await pool.query(`ALTER TABLE equipment_checks ADD COLUMN IF NOT EXISTS completed_items JSONB NOT NULL DEFAULT '[]'::jsonb;`);
  await pool.query(`ALTER TABLE equipment_checks ADD COLUMN IF NOT EXISTS notes TEXT;`);

  // ---------------------------------------------------------------
  // Staff accounts (individual logins with a role) -- replaces the old
  // single shared ADMIN_PASSWORD. Three roles:
  //   admin     - everything, including managing other staff accounts
  //   approver  - everything a submitter can do, plus approve/reject
  //               PERA and CARA records
  //   submitter - create records and edit their own; can't approve
  // password_hash is "salt:hash" (both hex), produced by crypto.scrypt --
  // see hashPassword()/verifyPassword() in server.js. No extra npm
  // dependency needed for this (Node's built-in crypto module covers it).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','approver','submitter')),
      disabled BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Who created each record, so a submitter can be limited to editing their
  // own work. Nullable and ON DELETE SET NULL so removing a staff account
  // later never breaks or deletes the records they created.
  await pool.query(`ALTER TABLE pera_records ADD COLUMN IF NOT EXISTS created_by_staff_id INTEGER REFERENCES staff_users(id) ON DELETE SET NULL;`);
  await pool.query(`ALTER TABLE cara_records ADD COLUMN IF NOT EXISTS created_by_staff_id INTEGER REFERENCES staff_users(id) ON DELETE SET NULL;`);
  await pool.query(`ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS created_by_staff_id INTEGER REFERENCES staff_users(id) ON DELETE SET NULL;`);

  // ---------------------------------------------------------------
  // Structured PERA: turns the original handful of free-text fields
  // (hazards / control_measures / required_supervision, still on
  // pera_records above) into queryable structured data, following the
  // Queensland Plant & Equipment Risk Assessment template. The three old
  // free-text columns are deliberately kept and never written to by the new
  // form -- they're shown as a read-only fallback on records saved before
  // this change (see server.js), so nothing already on file is lost or
  // silently rewritten.
  await pool.query(`ALTER TABLE pera_records ADD COLUMN IF NOT EXISTS activity_process TEXT;`);
  await pool.query(`ALTER TABLE pera_records ADD COLUMN IF NOT EXISTS materials_used TEXT;`);
  await pool.query(`ALTER TABLE pera_records ADD COLUMN IF NOT EXISTS student_use TEXT;`);
  await pool.query(`ALTER TABLE pera_records ADD COLUMN IF NOT EXISTS operating_conditions TEXT;`);
  await pool.query(`ALTER TABLE pera_records ADD COLUMN IF NOT EXISTS supervision_details TEXT;`);
  await pool.query(`ALTER TABLE pera_records ADD COLUMN IF NOT EXISTS training_competency TEXT;`);
  await pool.query(`ALTER TABLE pera_records ADD COLUMN IF NOT EXISTS approval_decision TEXT;`);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'pera_records_approval_decision_check'
      ) THEN
        ALTER TABLE pera_records
          ADD CONSTRAINT pera_records_approval_decision_check
          CHECK (approval_decision IS NULL OR approval_decision IN ('Approved as submitted','Approved with conditions','Not approved'));
      END IF;
    END $$;
  `);
  await pool.query(`ALTER TABLE pera_records ADD COLUMN IF NOT EXISTS approval_conditions TEXT;`);
  await pool.query(`ALTER TABLE pera_records ADD COLUMN IF NOT EXISTS approver_role TEXT;`);
  // Bumped on every saved edit (see /pera/:id/edit in server.js) and stored
  // against each pera_change_log row, so the change history can show "v4"
  // etc. rather than relying on row order alone.
  await pool.query(`ALTER TABLE pera_records ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;`);

  // Structured hazard rows. A PERA can have any number of these; the old
  // free-text "hazards"/"control_measures" columns above become the
  // fallback display only for records that have none.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pera_hazards (
      id SERIAL PRIMARY KEY,
      pera_id INTEGER NOT NULL REFERENCES pera_records(id) ON DELETE CASCADE,
      category TEXT,
      description TEXT NOT NULL,
      risk_level TEXT CHECK (risk_level IN ('Low','Medium','High','Extreme')),
      control_measure TEXT,
      control_type TEXT CHECK (control_type IN ('Engineering','Administrative','PPE','Procedural')),
      mandatory BOOLEAN NOT NULL DEFAULT false,
      applies_to TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Fixed Minimum Safety Requirements checklist, seeded from
  // MIN_SAFETY_REQUIREMENTS (server.js) whenever a PERA is created. Kept as
  // rows rather than a JSON blob so the tick/notes on each item survive
  // independently of the seed list ever being edited later.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pera_min_requirements (
      id SERIAL PRIMARY KEY,
      pera_id INTEGER NOT NULL REFERENCES pera_records(id) ON DELETE CASCADE,
      requirement TEXT NOT NULL,
      met BOOLEAN NOT NULL DEFAULT false,
      notes TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Related documents -- a link/reference (e.g. to a SOP, manufacturer
  // manual, or a file kept elsewhere), not an upload, so this needs no new
  // dependency.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pera_documents (
      id SERIAL PRIMARY KEY,
      pera_id INTEGER NOT NULL REFERENCES pera_records(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      url TEXT,
      notes TEXT,
      added_by TEXT,
      added_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Annual review history -- a PERA is approved with a next_review_date,
  // and each time it's actually reviewed (whether or not anything changed)
  // that gets its own row here, independent of pera_change_log (which is
  // content edits, not review sign-offs).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pera_annual_reviews (
      id SERIAL PRIMARY KEY,
      pera_id INTEGER NOT NULL REFERENCES pera_records(id) ON DELETE CASCADE,
      reviewed_by TEXT,
      reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      outcome TEXT CHECK (outcome IN ('Still current','Updated','Superseded')),
      notes TEXT,
      next_review_date DATE
    );
  `);

  // Full change history/audit trail for PERA edits and decisions -- same
  // shape as cara_change_log (summary/brief), plus "action" and "version"
  // so the change history tree on the PERA detail page can group entries by
  // year and label each one (Created / Edited / Approved / Not approved /
  // Reviewed).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pera_change_log (
      id SERIAL PRIMARY KEY,
      pera_id INTEGER NOT NULL REFERENCES pera_records(id) ON DELETE CASCADE,
      changed_by TEXT,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      action TEXT NOT NULL DEFAULT 'Edited',
      version INTEGER,
      summary TEXT NOT NULL,
      brief TEXT
    );
  `);

  // ---------------------------------------------------------------
  // Structured PERA, round two -- brings the fields in line with what the
  // source Queensland P&ERA template actually asks for: structured
  // supervision (not one free-text paragraph), training split by staff vs
  // students, a Current/Required/Due Soon/Missing status per minimum
  // requirement (not just a tick), a category on each related document, and
  // explicit unchanged/changed flags on each annual review. The first round
  // of structured-PERA columns (supervision_details, training_competency)
  // are left in place but no longer written to by the form -- same
  // never-rewrite-old-data approach as the original free-text fallback.
  await pool.query(`ALTER TABLE pera_records ADD COLUMN IF NOT EXISTS student_use_permitted BOOLEAN;`);
  await pool.query(`ALTER TABLE pera_records ADD COLUMN IF NOT EXISTS supervision_level TEXT;`);
  await pool.query(`ALTER TABLE pera_records ADD COLUMN IF NOT EXISTS supervisor_competency TEXT;`);
  await pool.query(`ALTER TABLE pera_records ADD COLUMN IF NOT EXISTS student_induction_required BOOLEAN;`);
  await pool.query(`ALTER TABLE pera_records ADD COLUMN IF NOT EXISTS competency_demonstration_required BOOLEAN;`);
  await pool.query(`ALTER TABLE pera_records ADD COLUMN IF NOT EXISTS max_operators INTEGER;`);
  await pool.query(`ALTER TABLE pera_records ADD COLUMN IF NOT EXISTS safe_working_zone_required BOOLEAN;`);
  await pool.query(`ALTER TABLE pera_records ADD COLUMN IF NOT EXISTS staff_training TEXT;`);
  await pool.query(`ALTER TABLE pera_records ADD COLUMN IF NOT EXISTS student_training TEXT;`);
  // What level of sign-off this activity's risk requires (Principal /
  // Delegate / HOD / WHS Officer) -- distinct from approver/approver_role,
  // which record who actually signed it and their own title.
  await pool.query(`ALTER TABLE pera_records ADD COLUMN IF NOT EXISTS approval_required_level TEXT;`);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'pera_records_approval_required_level_check'
      ) THEN
        ALTER TABLE pera_records
          ADD CONSTRAINT pera_records_approval_required_level_check
          CHECK (approval_required_level IS NULL OR approval_required_level IN ('Principal','Delegate','HOD','WHS Officer'));
      END IF;
    END $$;
  `);

  // Lets admins move a PERA out of the main list without deleting it --
  // same idea as the existing cara_records.archived flag. Hidden from the
  // main list, tool pickers, and equipment links by default; still fully
  // viewable (read-only) via the PERA Archive admin page and can be
  // restored at any time.
  await pool.query(`ALTER TABLE pera_records ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;`);

  // Status per checklist item, replacing the plain tick. "met" is kept
  // (unused by the form going forward) so nothing breaks for any row saved
  // by the first round of this feature before "status" existed.
  await pool.query(`ALTER TABLE pera_min_requirements ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Required';`);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'pera_min_requirements_status_check'
      ) THEN
        ALTER TABLE pera_min_requirements
          ADD CONSTRAINT pera_min_requirements_status_check
          CHECK (status IN ('Current','Required','Due Soon','Missing'));
      END IF;
    END $$;
  `);

  // Which staff/students/both a hazard's control applies to. The very
  // first round of this feature let "applies to" be free text, so before
  // locking it down to a fixed set of values, map anything already saved
  // that isn't one of them onto the closest match (defaulting to "Both"
  // for anything mentioning students, since that's the safer assumption)
  // rather than letting the migration fail on real data.
  await pool.query(`
    UPDATE pera_hazards
    SET applies_to = CASE
      WHEN applies_to ILIKE '%staff%' AND applies_to ILIKE '%student%' THEN 'Both'
      WHEN applies_to ILIKE '%staff%' THEN 'Staff'
      WHEN applies_to ILIKE '%student%' THEN 'Students'
      ELSE NULL
    END
    WHERE applies_to IS NOT NULL AND applies_to NOT IN ('Staff','Students','Both');
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'pera_hazards_applies_to_check'
      ) THEN
        ALTER TABLE pera_hazards
          ADD CONSTRAINT pera_hazards_applies_to_check
          CHECK (applies_to IS NULL OR applies_to IN ('Staff','Students','Both'));
      END IF;
    END $$;
  `);

  await pool.query(`ALTER TABLE pera_documents ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'Other';`);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'pera_documents_category_check'
      ) THEN
        ALTER TABLE pera_documents
          ADD CONSTRAINT pera_documents_category_check
          CHECK (category IN ('SOP','Manufacturer manual','Equipment Maintenance Record','Student induction record','Staff competency record','Previous risk assessment','Other'));
      END IF;
    END $$;
  `);

  await pool.query(`ALTER TABLE pera_annual_reviews ADD COLUMN IF NOT EXISTS risk_unchanged BOOLEAN;`);
  await pool.query(`ALTER TABLE pera_annual_reviews ADD COLUMN IF NOT EXISTS controls_unchanged BOOLEAN;`);
  await pool.query(`ALTER TABLE pera_annual_reviews ADD COLUMN IF NOT EXISTS staffing_unchanged BOOLEAN;`);
  await pool.query(`ALTER TABLE pera_annual_reviews ADD COLUMN IF NOT EXISTS reviewer_designation TEXT;`);
  // outcome was previously chosen directly on the form; it's now derived
  // from the three unchanged flags above (see server.js), so make it
  // optional for new rows while leaving old ones exactly as they were.
  await pool.query(`ALTER TABLE pera_annual_reviews ALTER COLUMN outcome DROP NOT NULL;`);
}

module.exports = { pool, migrate };
