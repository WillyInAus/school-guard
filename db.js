const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('DATABASE_URL environment variable is not set.');
}

const pool = new Pool({
  connectionString,
  ssl: connectionString && connectionString.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
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
}

module.exports = { pool, migrate };
