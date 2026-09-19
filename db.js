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
}

module.exports = { pool, migrate };
