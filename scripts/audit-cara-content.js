// Read-only audit of saved CARAs and projects: unsafe first aid wording,
// unfilled placeholders, possible supervision conflicts, and where unsafe
// wording first appeared. Changes nothing.
// Run on the server:  docker compose exec app node scripts/audit-cara-content.js
const { pool } = require('../db');
const { scan, textReport } = require('../content-review');

scan(pool)
  .then((r) => { console.log(textReport(r)); return pool.end(); })
  .catch((e) => { console.error(e); process.exit(1); });
