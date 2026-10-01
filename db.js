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

  // ---------------------------------------------------------------
  // Equipment: shared Maintenance/Inspection criteria libraries.
  //
  // Replaces the old free-text-per-item equipment_items.checklist_items
  // (left in place, unused, rather than dropped -- see the app's usual
  // never-rewrite-old-data approach) with two shared, categorised master
  // lists -- one for Maintenance (servicing work: "replaced bearing",
  // "tensioned drive belt") and one for Inspection (safety condition
  // checks: "blade is sharp, undamaged...") -- so a category/criterion is
  // defined once and then just ticked "applies to this item" per piece of
  // equipment, instead of being retyped from scratch every time.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS maintenance_categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS maintenance_criteria (
      id SERIAL PRIMARY KEY,
      category_id INTEGER NOT NULL REFERENCES maintenance_categories(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inspection_categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inspection_criteria (
      id SERIAL PRIMARY KEY,
      category_id INTEGER NOT NULL REFERENCES inspection_categories(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Which master criteria apply to a specific physical equipment item --
  // set when the item is added/edited (the "Maintenance Categories" /
  // "Inspection Categories" picker).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS equipment_maintenance_criteria (
      equipment_id INTEGER NOT NULL REFERENCES equipment_items(id) ON DELETE CASCADE,
      criterion_id INTEGER NOT NULL REFERENCES maintenance_criteria(id) ON DELETE CASCADE,
      PRIMARY KEY (equipment_id, criterion_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS equipment_inspection_criteria (
      equipment_id INTEGER NOT NULL REFERENCES equipment_items(id) ON DELETE CASCADE,
      criterion_id INTEGER NOT NULL REFERENCES inspection_criteria(id) ON DELETE CASCADE,
      PRIMARY KEY (equipment_id, criterion_id)
    );
  `);

  // Logged Maintenance/Inspection events -- kept as two separate tables
  // (rather than the old single equipment_checks) since they're now two
  // distinct activities with their own due dates. completed_criteria
  // snapshots the ticked descriptions as text at the time of logging
  // (not a live FK to the criteria table), so a log entry still reads
  // correctly even if that criterion is later reworded or removed from
  // the shared library -- same reasoning as equipment_checks.completed_items
  // before it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS equipment_maintenance_logs (
      id SERIAL PRIMARY KEY,
      equipment_id INTEGER NOT NULL REFERENCES equipment_items(id) ON DELETE CASCADE,
      performed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      performed_by TEXT,
      completed_criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
      notes TEXT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS equipment_inspection_logs (
      id SERIAL PRIMARY KEY,
      equipment_id INTEGER NOT NULL REFERENCES equipment_items(id) ON DELETE CASCADE,
      performed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      performed_by TEXT,
      completed_criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
      notes TEXT
    );
  `);

  // A failed inspection/maintenance check (or a manual edit) can take an
  // item to "Needs repair"/"Out of service". Moving it back to
  // "Operational" is a deliberate, visible decision -- see the
  // hasFailure comment on the inspection-check/maintenance-check routes
  // -- so it only ever happens through the dedicated "Return to service"
  // flow, which requires a note saying what was done. This table is that
  // flow's history, separate from the inspection/maintenance logs above
  // since it records a status change rather than a routine check.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS equipment_service_logs (
      id SERIAL PRIMARY KEY,
      equipment_id INTEGER NOT NULL REFERENCES equipment_items(id) ON DELETE CASCADE,
      performed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      performed_by TEXT,
      previous_status TEXT,
      note TEXT NOT NULL
    );
  `);

  // equipment_items already has inspection_frequency/last_inspected/
  // next_inspection_due; Maintenance gets its own matching set so the two
  // can be due on different schedules (e.g. inspected weekly, serviced
  // yearly).
  await pool.query(`ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS maintenance_frequency TEXT;`);
  await pool.query(`ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS last_maintained DATE;`);
  await pool.query(`ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS next_maintenance_due DATE;`);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'equipment_items_maintenance_frequency_check'
      ) THEN
        ALTER TABLE equipment_items
          ADD CONSTRAINT equipment_items_maintenance_frequency_check
          CHECK (maintenance_frequency IS NULL OR maintenance_frequency IN ('Daily','Week','Term','Semester','Yearly'));
      END IF;
    END $$;
  `);

  // Seed the default Maintenance/Inspection libraries once, only if empty --
  // Sean can freely edit/add/remove afterwards without them being re-seeded
  // on the next startup. "Site Specific" is seeded as an empty category in
  // each so there's somewhere for school-specific custom criteria to go
  // straight away.
  const maintenanceCategoryCount = await pool.query('SELECT COUNT(*)::int AS count FROM maintenance_categories');
  if (maintenanceCategoryCount.rows[0].count === 0) {
    const MAINTENANCE_LIBRARY = [
      ['Bearings', ['Lubricated points/bearings', 'Protected machined surfaces', 'Replaced bearing']],
      ['Belts', ['Adjusted belt tension', 'Aligned belt tracking', 'Replaced sanding belt', 'Tensioned drive belt']],
      ['Blades/Discs/Wheels', ['Replaced blade guides', 'Replaced blade/disc/wheel', 'Sharpened blade']],
      ['Brackets & Mounts', ['Replaced bracket/support', 'Tensioned/adjusted motor mounts']],
      ['Cutters', ['Replaced cutter', 'Replenished cutting fluid', 'Tensioned cutters']],
      ['Dust', ['Cleaned dust, swarf and waste', 'Replaced dust collection bag']],
      ['Electrical', ['Machine inspected, tested and tagged by a competent person', 'Portable/in-line safety switch (RCD) tested', 'Safety switch (ELCB) tested - permanent switchboard installation']],
      ['Fences', ['Adjusted alignment of fence', 'Adjusted saw riving knife']],
      ['Guards', ['Repaired/adjusted guard/shield', 'Replaced guard/shield']],
      ['OTHER', ['Noted in comments']],
      ['Pulleys', ['Aligned pulleys', 'Replaced drive belt']],
      ['Site Specific', []],
    ];
    for (let ci = 0; ci < MAINTENANCE_LIBRARY.length; ci += 1) {
      const [name, criteria] = MAINTENANCE_LIBRARY[ci];
      const catResult = await pool.query(
        'INSERT INTO maintenance_categories (name, sort_order) VALUES ($1,$2) RETURNING id',
        [name, ci]
      );
      const categoryId = catResult.rows[0].id;
      for (let ii = 0; ii < criteria.length; ii += 1) {
        await pool.query(
          'INSERT INTO maintenance_criteria (category_id, description, sort_order) VALUES ($1,$2,$3)',
          [categoryId, criteria[ii], ii]
        );
      }
    }
  }

  const inspectionCategoryCount = await pool.query('SELECT COUNT(*)::int AS count FROM inspection_categories');
  if (inspectionCategoryCount.rows[0].count === 0) {
    const INSPECTION_LIBRARY = [
      ['Blades/Wheels/Discs', ['Blade is sharp, undamaged, tensioned correctly and tracking properly', 'Blades/bits/discs/wheels free of cracks, deformation, broken teeth', 'Disc/wheel/drum/belt displays even wear, without cracks, nicks, chips or tears']],
      ['Electrical', ['All plugs/sockets/cables/leads free of damage', 'Current electrical testing certification evident (tested & tagged) including battery charger where applicable.', 'Machine can be mechanically isolated/disconnected from power supply', 'Start/Stop/Emergency switches comply with AS/NZS 4024.1201:2014', 'Start/Stop/Emergency switches operate properly']],
      ['Gas/Welding', ['Fire extinguisher of correct type appropriately positioned', 'Fume extraction system operational, current maintenance evident', 'Gas Arrestor / Regulator certification evident (tagged)', 'Gas bottle secured appropriately', 'Gas hose/s and handpiece in good condition']],
      ['Guarding', ['Guards are secured with mechanical locking device (where applicable)', 'Guards correctly fitted, adjusted and in good working order. Where applicable, mechanical locking device fitted', 'Interlocking and emergency systems on guards functional (micro switch where available)']],
      ['Housekeeping', ['No flammable gases, liquids or other materials in the machine area', 'Operator zone and work spaces clear and unobstructed', 'Safe Work Zone clearly defined on floor', 'SOP and hazard warning signs displayed next to machine', 'Work area is clean and clear of off cuts, saw dust and other materials']],
      ['Machine Operation', ['Adjusting keys, spanners, wrenches removed from the work surface', 'Dust extraction system operates effectively', 'Moving parts are well lubricated and free of rust and dirt', 'Push sticks, push blocks, featherboards and jigs available and appropriate', 'Thrust bearings and guides in good condition, correctly adjusted and rotate freely']],
      ['Mounts/Stand', ['Base/stand of machine mounted to floor securely', 'Drive belts in good condition and correctly tensioned', 'Machine motor mounts correctly tensioned']],
      ['Other', ['30 minute exposure for noise emission standard does not exceed 97dB(A) (without PPE)', 'Machine area adequately illuminated', 'Personal Protective Equipment available and in good condition', 'Slip resistant flooring evident in machine space']],
      ['Power/Battery Tools', ['Battery charger - current testing certification evident (tested & tagged)', 'Dust collection bag attached and in good condition', 'Electrical cable - current testing certification evident (tested & tagged)', 'Residual Current Device (RCD) connected and operational', 'Start/Stop switch operates properly']],
      ['Site Specific', []],
    ];
    for (let ci = 0; ci < INSPECTION_LIBRARY.length; ci += 1) {
      const [name, criteria] = INSPECTION_LIBRARY[ci];
      const catResult = await pool.query(
        'INSERT INTO inspection_categories (name, sort_order) VALUES ($1,$2) RETURNING id',
        [name, ci]
      );
      const categoryId = catResult.rows[0].id;
      for (let ii = 0; ii < criteria.length; ii += 1) {
        await pool.query(
          'INSERT INTO inspection_criteria (category_id, description, sort_order) VALUES ($1,$2,$3)',
          [categoryId, criteria[ii], ii]
        );
      }
    }
  }

  // A canonical list of rooms so equipment's "Location" is picked from a
  // dropdown instead of free-typed -- free text let "Workshop A" / "IDT
  // Workshop A" / a typo all count as different rooms on the Equipment >
  // By room page. archived hides a room from new selections without
  // touching equipment that already used it. equipment_items keeps its
  // old location TEXT column too (untouched, for anything that still
  // reads it), but room_id is now the source of truth going forward --
  // that's what lets renaming a room here actually change what every
  // item using it shows, which plain text never could.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      archived BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL;`);

  // One-off backfill: turn whatever free-text locations already exist into
  // real rooms, and link each item to its matching room. Safe to run on
  // every startup -- ON CONFLICT/room_id IS NULL make it a no-op once a
  // name's room exists and every matching item is already linked.
  await pool.query(`
    INSERT INTO rooms (name)
    SELECT DISTINCT trim(location) FROM equipment_items
    WHERE room_id IS NULL AND location IS NOT NULL AND trim(location) <> ''
    ON CONFLICT (name) DO NOTHING;
  `);
  await pool.query(`
    UPDATE equipment_items e
    SET room_id = rm.id
    FROM rooms rm
    WHERE e.room_id IS NULL AND e.location IS NOT NULL AND trim(e.location) = rm.name;
  `);

  // Same fix as rooms above, for equipment's "Category" -- it used to just
  // reuse the PERA activity-name list (so the category shown was often a
  // whole risk-assessment title like "Thicknesser — Safe Operating Risk
  // Assessment", duplicating "Linked PERA" right below it) instead of
  // having its own short, purpose-built list. equipment_categories is
  // named distinctly from the existing maintenance_categories/
  // inspection_categories tables (unrelated -- those are criteria
  // libraries, not this).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS equipment_categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      archived BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES equipment_categories(id) ON DELETE SET NULL;`);

  // One-off backfill, same pattern as rooms: whatever text was already in
  // "category" (today, always a PERA activity name) becomes a real
  // category, and the item is linked to it -- nothing changes on screen
  // until Sean renames one in Admin > Categories to something shorter.
  await pool.query(`
    INSERT INTO equipment_categories (name)
    SELECT DISTINCT trim(category) FROM equipment_items
    WHERE category_id IS NULL AND category IS NOT NULL AND trim(category) <> ''
    ON CONFLICT (name) DO NOTHING;
  `);
  await pool.query(`
    UPDATE equipment_items e
    SET category_id = ec.id
    FROM equipment_categories ec
    WHERE e.category_id IS NULL AND e.category IS NOT NULL AND trim(e.category) = ec.name;
  `);

  // Category (and its equipment_categories table above) turned out not to
  // be what was wanted -- it's dropped from the equipment pages in favour
  // of plain asset-record fields below. Neither the table nor
  // category/category_id are removed here (nothing in this codebase drops
  // a column), they're just unused going forward.
  await pool.query(`ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS make TEXT;`);
  await pool.query(`ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS model TEXT;`);
  await pool.query(`ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS serial_number TEXT;`);
  await pool.query(`ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS purchase_date DATE;`);
  await pool.query(`ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS supplier TEXT;`);

  // PERA related documents can now actually be uploaded and stored (as
  // opposed to only being a link to somewhere else) -- stored as bytea
  // directly in Postgres rather than on the container's local disk, since
  // that already has a persistent volume (unlike the app container, whose
  // filesystem is thrown away on every "docker compose up --build").
  await pool.query(`ALTER TABLE pera_documents ADD COLUMN IF NOT EXISTS file_data BYTEA;`);
  await pool.query(`ALTER TABLE pera_documents ADD COLUMN IF NOT EXISTS file_name TEXT;`);
  await pool.query(`ALTER TABLE pera_documents ADD COLUMN IF NOT EXISTS file_mime TEXT;`);
  await pool.query(`ALTER TABLE pera_documents ADD COLUMN IF NOT EXISTS file_size INTEGER;`);

  // Small preview thumbnail (PNG/JPEG bytes) generated at upload time for an
  // uploaded PDF (first page) or image -- null for a link-only document, or
  // an uploaded file type thumbnails aren't generated for (Word/Excel/
  // PowerPoint/text), which just show a generic icon instead.
  await pool.query(`ALTER TABLE pera_documents ADD COLUMN IF NOT EXISTS thumbnail_data BYTEA;`);

  // ---------------------------------------------------------------
  // Staff Equipment Induction module (section references below match the
  // spec this was built from). Reuses staff_users, equipment_items and
  // pera_records rather than introducing a second staff/equipment list.
  // Every "who did this" column is a real FK to staff_users (not a plain
  // TEXT snapshot like the older change-log tables above) so server-side
  // checks can compare IDs -- e.g. "staff must not approve their own
  // competency or authorisation" needs the actual id, not just a name.

  // The master equipment list (Section 1), grouped the way the source
  // register groups it. Seeded below from the uploaded Staff Equipment
  // Induction Register. available_at_school lets an admin hide an item
  // that doesn't exist at this school without deleting its history ("only
  // items that are located at your school need to be responded to -- the
  // table can be edited to suit").
  await pool.query(`
    CREATE TABLE IF NOT EXISTS induction_equipment_categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS induction_equipment_items (
      id SERIAL PRIMARY KEY,
      category_id INTEGER NOT NULL REFERENCES induction_equipment_categories(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      pera_id INTEGER REFERENCES pera_records(id) ON DELETE SET NULL,
      available_at_school BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Section 1 -- one row per staff member per equipment item: the self
  // declaration. Starts 'not_assessed' for everyone (never preselected).
  // A 'C' (self-assessed competent) is explicitly just a declaration --
  // see server.js, which never flips any authorisation table off the back
  // of this row alone.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_induction_declarations (
      id SERIAL PRIMARY KEY,
      staff_id INTEGER NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
      induction_item_id INTEGER NOT NULL REFERENCES induction_equipment_items(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'not_assessed' CHECK (status IN ('not_assessed','C','NYC','NA')),
      qualifications_experience TEXT,
      declared_at TIMESTAMPTZ,
      hod_ack_staff_id INTEGER REFERENCES staff_users(id) ON DELETE SET NULL,
      hod_ack_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (staff_id, induction_item_id)
    );
  `);

  // Evidence/comments attached to a declaration, an induction step, a
  // machine-competency assessment, or an authorisation decision --
  // title + link + notes, the same shape as the existing pera_documents
  // table, since this app has no binary file-upload storage today (see
  // the delivery notes for this round). context_type/context_id is a
  // light polymorphic link rather than four near-identical tables.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_induction_evidence (
      id SERIAL PRIMARY KEY,
      context_type TEXT NOT NULL CHECK (context_type IN ('declaration','step','assessment','authorisation','verification','logbook')),
      context_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      url TEXT,
      notes TEXT,
      added_by_staff_id INTEGER REFERENCES staff_users(id) ON DELETE SET NULL,
      added_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Section "Equipment induction workflow" -- the five steps from the
  // register, tracked per staff per item. Step 5 carries its own
  // inductor/inductee sign-off columns (left null on steps 1-4).
  // responsible_staff_id is whoever delivered/oversaw that step (the
  // inductor for steps 2-4). Multiple sessions before a step is marked
  // complete are logged in staff_induction_step_sessions below, so e.g.
  // "hands-on practice" can span several dates.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_induction_steps (
      id SERIAL PRIMARY KEY,
      staff_id INTEGER NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
      induction_item_id INTEGER NOT NULL REFERENCES induction_equipment_items(id) ON DELETE CASCADE,
      step_number INTEGER NOT NULL CHECK (step_number BETWEEN 1 AND 5),
      status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','in_progress','complete')),
      completed_at TIMESTAMPTZ,
      responsible_staff_id INTEGER REFERENCES staff_users(id) ON DELETE SET NULL,
      notes TEXT,
      sop_pera_id INTEGER REFERENCES pera_records(id) ON DELETE SET NULL,
      inductee_signed_staff_id INTEGER REFERENCES staff_users(id) ON DELETE SET NULL,
      inductee_signed_at TIMESTAMPTZ,
      inductor_signed_staff_id INTEGER REFERENCES staff_users(id) ON DELETE SET NULL,
      inductor_signed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (staff_id, induction_item_id, step_number)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_induction_step_sessions (
      id SERIAL PRIMARY KEY,
      step_id INTEGER NOT NULL REFERENCES staff_induction_steps(id) ON DELETE CASCADE,
      session_date DATE NOT NULL,
      notes TEXT,
      recorded_by_staff_id INTEGER REFERENCES staff_users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // "Machine competency checklist" -- editable templates, not seeded with
  // any criteria (the source register doesn't supply performance criteria,
  // and none should be invented). A competent person builds the criteria
  // list for an equipment item and an assessor (ideally someone else)
  // approves it before it's used for real assessments.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS induction_checklist_templates (
      id SERIAL PRIMARY KEY,
      induction_item_id INTEGER NOT NULL REFERENCES induction_equipment_items(id) ON DELETE CASCADE,
      created_by_staff_id INTEGER REFERENCES staff_users(id) ON DELETE SET NULL,
      approved_by_staff_id INTEGER REFERENCES staff_users(id) ON DELETE SET NULL,
      approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS induction_checklist_criteria (
      id SERIAL PRIMARY KEY,
      template_id INTEGER NOT NULL REFERENCES induction_checklist_templates(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `);

  // An assessment attempt against a template. status can only become
  // 'complete' once every criterion on the template has a result row that
  // isn't 'not_assessed' -- enforced in server.js, not just here, since a
  // criterion added after the fact must re-open a previously "complete"
  // assessment rather than silently leaving a gap.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_induction_assessments (
      id SERIAL PRIMARY KEY,
      staff_id INTEGER NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
      template_id INTEGER NOT NULL REFERENCES induction_checklist_templates(id) ON DELETE CASCADE,
      assessor_staff_id INTEGER REFERENCES staff_users(id) ON DELETE SET NULL,
      assessor_competence_evidence TEXT,
      assessment_date DATE,
      operating_restrictions TEXT,
      comments TEXT,
      status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','complete')),
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_induction_assessment_results (
      id SERIAL PRIMARY KEY,
      assessment_id INTEGER NOT NULL REFERENCES staff_induction_assessments(id) ON DELETE CASCADE,
      criterion_id INTEGER NOT NULL REFERENCES induction_checklist_criteria(id) ON DELETE CASCADE,
      result TEXT NOT NULL DEFAULT 'not_assessed' CHECK (result IN ('not_assessed','demonstrated','not_yet_demonstrated','not_applicable')),
      na_reason TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (assessment_id, criterion_id)
    );
  `);

  // Section "Supervised equipment logbook". duration_minutes keeps the
  // arithmetic exact (summed for the hours-vs-target display); verified
  // defaults false, so an entry contributes to "completed hours" only once
  // a supervisor who isn't the staff member themselves has signed off on
  // it (enforced in server.js).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS induction_logbook_entries (
      id SERIAL PRIMARY KEY,
      staff_id INTEGER NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
      induction_item_id INTEGER NOT NULL REFERENCES induction_equipment_items(id) ON DELETE CASCADE,
      equipment_id INTEGER REFERENCES equipment_items(id) ON DELETE SET NULL,
      session_date DATE NOT NULL,
      task_description TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
      supervisor_staff_id INTEGER REFERENCES staff_users(id) ON DELETE SET NULL,
      feedback TEXT,
      verified BOOLEAN NOT NULL DEFAULT false,
      verified_by_staff_id INTEGER REFERENCES staff_users(id) ON DELETE SET NULL,
      verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Nominal practice hours, agreed per staff member per item (never one
  // fixed figure for every machine) by whoever is supervising them.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS induction_practice_targets (
      id SERIAL PRIMARY KEY,
      staff_id INTEGER NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
      induction_item_id INTEGER NOT NULL REFERENCES induction_equipment_items(id) ON DELETE CASCADE,
      target_minutes INTEGER NOT NULL CHECK (target_minutes > 0),
      agreed_by_staff_id INTEGER REFERENCES staff_users(id) ON DELETE SET NULL,
      agreed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (staff_id, induction_item_id)
    );
  `);

  // Section "Verification and authorisation" -- kept as separate rows
  // from the self-declaration and the raw checklist data on purpose (see
  // spec: "keep separate fields for ..."). 'basis' documents a review
  // pathway (e.g. "prior trade qualification reviewed") rather than
  // forcing every experienced staff member through the full five-step
  // process from scratch.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_induction_competency_verifications (
      id SERIAL PRIMARY KEY,
      staff_id INTEGER NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
      induction_item_id INTEGER NOT NULL REFERENCES induction_equipment_items(id) ON DELETE CASCADE,
      verified BOOLEAN NOT NULL DEFAULT false,
      verified_by_staff_id INTEGER REFERENCES staff_users(id) ON DELETE SET NULL,
      verified_at TIMESTAMPTZ,
      basis TEXT,
      notes TEXT,
      review_date DATE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (staff_id, induction_item_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_induction_authorisations (
      id SERIAL PRIMARY KEY,
      staff_id INTEGER NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
      induction_item_id INTEGER NOT NULL REFERENCES induction_equipment_items(id) ON DELETE CASCADE,
      authorisation_type TEXT NOT NULL CHECK (authorisation_type IN ('operate','supervise_students')),
      authorised BOOLEAN NOT NULL DEFAULT false,
      permitted_operations TEXT,
      restrictions TEXT,
      decision_by_staff_id INTEGER REFERENCES staff_users(id) ON DELETE SET NULL,
      decision_at TIMESTAMPTZ,
      review_date DATE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (staff_id, induction_item_id, authorisation_type)
    );
  `);

  // One shared history log across every part of this module -- "keep
  // version history for changes to evidence, assessment and
  // authorisation". Every write route in the induction module appends one
  // row here alongside its real update, in the same transaction.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS induction_change_log (
      id SERIAL PRIMARY KEY,
      staff_id INTEGER NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
      induction_item_id INTEGER REFERENCES induction_equipment_items(id) ON DELETE CASCADE,
      context_type TEXT NOT NULL,
      context_id INTEGER,
      summary TEXT NOT NULL,
      changed_by_staff_id INTEGER REFERENCES staff_users(id) ON DELETE SET NULL,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Seed the master equipment list from the Staff Equipment Induction
  // Register (Section 1 table) -- only runs once, the same guarded-insert
  // pattern as the Maintenance/Inspection libraries above.
  const inductionCategoryCount = await pool.query('SELECT COUNT(*)::int AS count FROM induction_equipment_categories');
  if (inductionCategoryCount.rows[0].count === 0) {
    const INDUCTION_EQUIPMENT_LIBRARY = [
      ['Wood - Portable Tools (Electrical & battery powered)', ['Electrical Drill', 'Screwdriver - battery', 'Belt sander <75mm', 'Belt sander >75mm <100mm', 'Biscuit cutter/jointer', 'Electric planner < 90mm', 'Orbital sander', 'Ramdom orbit sander', 'Router - hand/plunge', 'Scroll saw', 'Trimmer - laminate', 'Pokerwork tool - hot wire', 'Jig saw', 'Domino machine', 'Circular Saw (185mm)', 'Wet Stone Grinder', 'Electric glue gun']],
      ['Fixed - Wood - Machinery', ['Bandsaw', 'Bench drill (pedestal)', 'Disc and belt linisher sander', 'Disc sander', 'Drop and slide combin. saw', 'Drum sander', 'Jointer/planer', 'Table circular saw', 'Thicknesser', 'Lathe, woodturning', 'Router table/spindle moulder', 'Chisel mortising machine', 'Bobbin Sander', 'Vertical Sheet saw']],
      ['Metal - Fixed Machinery', ['Bench grinder (pedestal)', 'Buffing wheel (pedestal)', 'Guillotine (Foot operated)', 'Panbrake bending machine', 'Metal lathe (long bed)', 'Metal lathe (short bed)', 'Pedestal Drill (Vertical)', 'Bar bending machine', 'Cold Saw', 'Shears, bench, metal']],
      ['Metal - Portable Tools', ['Horizontal Bandsaw', 'Nibbler, portable', 'Metal Craft equipment', 'Electric arc welding - stick', 'MIG electric welding', 'Oxy-Acetylene equipment', 'Spot Welder', 'Soldering iron, electric']],
      ['Plastic – Portable Tools', ['Buffing machine', 'Strip heater', 'Vacuum forming machine', 'Hot air welder', 'Oven (Plastics)']],
      ['Compressed Air Tools', ['Impact wrench', 'Nail gun (Framer)', 'Nail gun (Finisher)', 'Stapler', 'Orbital Sander', 'Portable drills', 'Screw drivers', 'Spray painting equipment', 'Portable Air Compressor Units']],
      ['Construction Equipment', ['Concrete Mixer', 'Laser Level', 'Optic Dumpy Level', 'Water Level', 'Jack Hammer', 'Impact Hammer Drill', 'Brick laying hand tools', 'Plastering hand tools', 'Concreting hand tools', 'Landscaping hand tools (mattock, pick, crowbar, shovels, rakes, sledge hammer, etc)', 'Electric Screw Driver/Drill']],
    ];
    for (let ci = 0; ci < INDUCTION_EQUIPMENT_LIBRARY.length; ci += 1) {
      const [name, items] = INDUCTION_EQUIPMENT_LIBRARY[ci];
      const catResult = await pool.query(
        'INSERT INTO induction_equipment_categories (name, sort_order) VALUES ($1,$2) RETURNING id',
        [name, ci]
      );
      const categoryId = catResult.rows[0].id;
      for (let ii = 0; ii < items.length; ii += 1) {
        await pool.query(
          'INSERT INTO induction_equipment_items (category_id, name, sort_order) VALUES ($1,$2,$3)',
          [categoryId, items[ii], ii]
        );
      }
    }
  }
}

module.exports = { pool, migrate };
