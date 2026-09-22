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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS equipment_records (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      asset_tag TEXT,
      category TEXT NOT NULL CHECK (category IN
        ('Power tool','Hand tool','Fixed machinery','Electrical test equipment','PPE','Mobile plant/vehicle','Other')),
      location TEXT,
      manufacturer TEXT,
      serial_number TEXT,
      status TEXT NOT NULL DEFAULT 'In service' CHECK (status IN
        ('In service','Under repair','Out of service','Awaiting disposal')),
      condition_notes TEXT,
      responsible_person TEXT,
      purchase_date DATE,
      inspection_frequency_months INTEGER,
      last_inspection_date DATE,
      next_inspection_due DATE,
      test_tag_number TEXT,
      pera_id INTEGER REFERENCES pera_records(id) ON DELETE SET NULL,
      archived BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Admin-managed list of workshop/area names for the Equipment Register's
  // Location dropdown, so Sean can add/rename/remove areas from Admin instead
  // of areas being hardcoded or free-typed.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS equipment_locations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    INSERT INTO equipment_locations (name)
    VALUES ('Metalwork workshop'), ('Woodwork workshop'), ('Electrotechnology workshop'), ('Storage/store room')
    ON CONFLICT (name) DO NOTHING;
  `);

  // Maintenance checklist log — a maintenance person works through a
  // checklist for a piece of equipment; each submission is kept as a
  // history record and also updates the equipment's inspection dates/status.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS equipment_checks (
      id SERIAL PRIMARY KEY,
      equipment_id INTEGER NOT NULL REFERENCES equipment_records(id) ON DELETE CASCADE,
      checked_by TEXT,
      notes TEXT,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Older deploys had the checklist as six fixed boolean columns on
  // equipment_checks. Different tools need different checklists (a disk
  // sander needs "sanding disk condition"/"vibration", a drop saw doesn't),
  // so the checklist is now per-equipment and dynamic — drop those columns;
  // there's no real check history yet to preserve.
  await pool.query(`ALTER TABLE equipment_checks DROP COLUMN IF EXISTS equipment_working;`);
  await pool.query(`ALTER TABLE equipment_checks DROP COLUMN IF EXISTS guards_in_place;`);
  await pool.query(`ALTER TABLE equipment_checks DROP COLUMN IF EXISTS estop_isolation_ok;`);
  await pool.query(`ALTER TABLE equipment_checks DROP COLUMN IF EXISTS test_tag_in_date;`);
  await pool.query(`ALTER TABLE equipment_checks DROP COLUMN IF EXISTS area_clean_tidy;`);
  await pool.query(`ALTER TABLE equipment_checks DROP COLUMN IF EXISTS sop_available_updated;`);

  // The checklist items themselves — an editable, ordered list per piece of
  // equipment, managed from that item's Edit screen in Admin.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS equipment_check_items (
      id SERIAL PRIMARY KEY,
      equipment_id INTEGER NOT NULL REFERENCES equipment_records(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (equipment_id, label)
    );
  `);

  // What was actually ticked for a given submitted check, snapshotting the
  // item's label at the time (so history still reads correctly even if the
  // item is later renamed or removed from the equipment's checklist).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS equipment_check_results (
      id SERIAL PRIMARY KEY,
      check_id INTEGER NOT NULL REFERENCES equipment_checks(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      ok BOOLEAN NOT NULL DEFAULT false,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Inspection frequency is now chosen from a fixed set of school-calendar
  // intervals (Daily/Week/Term/Semester/Yearly) rather than typed in as a
  // number of months — easier for Sean to set consistently across the
  // register. The CHECK is re-applied every migration (drop + re-add) so
  // adding a new option later (like Daily) takes effect on an existing
  // column, not just a freshly created one.
  await pool.query(`ALTER TABLE equipment_records ADD COLUMN IF NOT EXISTS inspection_frequency TEXT;`);
  await pool.query(`ALTER TABLE equipment_records DROP CONSTRAINT IF EXISTS equipment_records_inspection_frequency_check;`);
  await pool.query(`ALTER TABLE equipment_records ADD CONSTRAINT equipment_records_inspection_frequency_check CHECK (inspection_frequency IN ('Daily','Week','Term','Semester','Yearly'));`);
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'equipment_records' AND column_name = 'inspection_frequency_months'
      ) THEN
        UPDATE equipment_records SET inspection_frequency = CASE
          WHEN inspection_frequency_months IS NULL THEN NULL
          WHEN inspection_frequency_months <= 1 THEN 'Week'
          WHEN inspection_frequency_months <= 4 THEN 'Term'
          WHEN inspection_frequency_months <= 8 THEN 'Semester'
          ELSE 'Yearly'
        END
        WHERE inspection_frequency IS NULL;
        ALTER TABLE equipment_records DROP COLUMN inspection_frequency_months;
      END IF;
    END $$;
  `);

  // Give any equipment that doesn't yet have a checklist (created before
  // per-tool checklists existed) the same six starter items Sean's original
  // checklist had. New equipment is seeded the same way at creation time in
  // the app; equipment that already has items (customised or not) is
  // untouched.
  await pool.query(`
    INSERT INTO equipment_check_items (equipment_id, label, sort_order)
    SELECT e.id, item.label, item.sort_order
    FROM equipment_records e
    CROSS JOIN (VALUES
      ('Equipment in working order', 1),
      ('Guards in place', 2),
      ('Emergency stop and isolation switches in good working condition', 3),
      ('Test & tagged in date', 4),
      ('Area clean and tidy', 5),
      ('SOP available and updated', 6)
    ) AS item(label, sort_order)
    WHERE NOT EXISTS (
      SELECT 1 FROM equipment_check_items ci WHERE ci.equipment_id = e.id
    )
    ON CONFLICT (equipment_id, label) DO NOTHING;
  `);
}

module.exports = { pool, migrate };
