// One-time migration: reshape the free-text hazards/control_measures and
// required_supervision already sitting on legacy PERA records (created
// before the structured PERA feature existed) into the new structured
// tables/fields, and attach reference links to the matching SOP/Equipment
// Maintenance Record source documents.
//
// Safe to run more than once: every insert/update is guarded so a record
// that already has structured data (hazard rows, a checklist, or has had
// its supervision/training fields filled in) is left untouched rather than
// duplicated or overwritten.
//
// Run with:
//   docker compose exec app node scripts/migrate-legacy-pera-content.js

const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

const DATA_PATH = path.join(__dirname, 'legacy-pera-content.json');

async function main() {
  const entries = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  console.log(`Loaded ${entries.length} records from ${path.basename(DATA_PATH)}`);

  let hazardsAdded = 0;
  let hazardsSkipped = 0;
  let requirementsAdded = 0;
  let requirementsSkipped = 0;
  let supervisionUpdated = 0;
  let supervisionSkipped = 0;
  let documentsAdded = 0;
  let documentsSkipped = 0;
  let missing = 0;

  for (const entry of entries) {
    const recordResult = await pool.query('SELECT id FROM pera_records WHERE id = $1', [entry.id]);
    if (recordResult.rows.length === 0) {
      missing += 1;
      console.log(`  [skip] PERA #${entry.id} (${entry.activity_name}) no longer exists -- skipping`);
      continue;
    }

    // --- Hazard rows -------------------------------------------------
    const existingHazards = await pool.query('SELECT COUNT(*) FROM pera_hazards WHERE pera_id = $1', [entry.id]);
    if (Number(existingHazards.rows[0].count) === 0 && entry.hazards.length) {
      for (let i = 0; i < entry.hazards.length; i += 1) {
        const h = entry.hazards[i];
        await pool.query(
          `INSERT INTO pera_hazards
             (pera_id, description, category, risk_level, control_measure, control_type, mandatory, applies_to, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [entry.id, h.description, h.category, h.risk_level, h.control_measure, h.control_type, h.mandatory, h.applies_to, i]
        );
      }
      hazardsAdded += entry.hazards.length;
    } else {
      hazardsSkipped += 1;
    }

    // --- Minimum Safety Requirements checklist ------------------------
    const existingReqs = await pool.query('SELECT COUNT(*) FROM pera_min_requirements WHERE pera_id = $1', [entry.id]);
    if (Number(existingReqs.rows[0].count) === 0 && entry.requirements.length) {
      for (let i = 0; i < entry.requirements.length; i += 1) {
        const item = entry.requirements[i];
        await pool.query(
          `INSERT INTO pera_min_requirements (pera_id, requirement, status, met, sort_order)
           VALUES ($1,$2,$3,$4,$5)`,
          [entry.id, item.requirement, item.status, item.status === 'Current', i]
        );
      }
      requirementsAdded += entry.requirements.length;
    } else {
      requirementsSkipped += 1;
    }

    // --- Supervision / training defaults -------------------------------
    const currentResult = await pool.query(
      'SELECT supervisor_competency, student_induction_required, student_training FROM pera_records WHERE id = $1',
      [entry.id]
    );
    const current = currentResult.rows[0];
    const untouched = !current.supervisor_competency && current.student_induction_required === null && !current.student_training;
    if (untouched) {
      await pool.query(
        `UPDATE pera_records
         SET supervisor_competency = $1, student_induction_required = $2, student_training = $3
         WHERE id = $4`,
        [entry.supervisor_competency, entry.student_induction_required, entry.student_training, entry.id]
      );
      supervisionUpdated += 1;
    } else {
      supervisionSkipped += 1;
    }

    // --- Related documents (SOP / EMR references) -----------------------
    for (const doc of entry.documents) {
      const dupe = await pool.query(
        'SELECT 1 FROM pera_documents WHERE pera_id = $1 AND title = $2',
        [entry.id, doc.title]
      );
      if (dupe.rows.length === 0) {
        await pool.query(
          `INSERT INTO pera_documents (pera_id, title, url, notes, added_by, category)
           VALUES ($1,$2,NULL,$3,'Migration script',$4)`,
          [entry.id, doc.title, doc.notes, doc.category]
        );
        documentsAdded += 1;
      } else {
        documentsSkipped += 1;
      }
    }
  }

  console.log('');
  console.log('Done.');
  console.log(`  Hazard rows added:        ${hazardsAdded} (${hazardsSkipped} records already had structured hazards, left alone)`);
  console.log(`  Checklist rows added:     ${requirementsAdded} (${requirementsSkipped} records already had a checklist, left alone)`);
  console.log(`  Records given supervision/training defaults: ${supervisionUpdated} (${supervisionSkipped} already had values, left alone)`);
  console.log(`  Document references added: ${documentsAdded} (${documentsSkipped} duplicates skipped)`);
  if (missing) console.log(`  Records in the export no longer found in the database: ${missing}`);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('Migration failed:', err);
    return pool.end().finally(() => process.exit(1));
  });
