// "Class group" details on a CARA: year level, course, class size, age range
// and prior experience. These describe the class as a whole (no individual
// student information), so unlike the Students notes they ARE given to the AI
// assistant, which uses them to write the Students section without
// [placeholders].

const COHORT_FIELDS = [
  ['year_level', 'Year level'],
  ['course', 'Course / subject'],
  ['class_size', 'Class size'],
  ['age_range', 'Age range'],
  ['prior_experience', 'Prior experience / inductions completed'],
];

const YEAR_OPTIONS = ['Year 7', 'Year 8', 'Year 9', 'Year 10', 'Year 11', 'Year 12', 'Years 10–11', 'Years 11–12', 'Years 10–12'];

function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\r\n?/g, '\n').trim();
  return s || null;
}

function cohortFromBody(body) {
  const size = parseInt(String(body.class_size || '').trim(), 10);
  return {
    year_level: clean(body.year_level),
    course: clean(body.course),
    class_size: Number.isFinite(size) && size > 0 && size < 1000 ? size : null,
    age_range: clean(body.age_range),
    prior_experience: clean(body.prior_experience),
  };
}

async function saveCohort(pool, caraId, c) {
  await pool.query(
    `UPDATE cara_records SET year_level = $1, course = $2, class_size = $3, age_range = $4, prior_experience = $5 WHERE id = $6`,
    [c.year_level, c.course, c.class_size, c.age_range, c.prior_experience, caraId]
  );
}

// One-line summary, e.g. "Year 11 · MEM20422 Engineering · 14 students · ages 16–17"
function cohortSummary(r) {
  const parts = [];
  if (r.year_level) parts.push(r.year_level);
  if (r.course) parts.push(r.course);
  if (r.class_size) parts.push(`${r.class_size} students`);
  if (r.age_range) parts.push(`ages ${r.age_range}`);
  return parts.join(' · ');
}

function cohortContextLines(c) {
  return COHORT_FIELDS.map(([k, label]) => `${label}: ${c[k] ? String(c[k]).slice(0, 600) : '(blank)'}`);
}

function cohortFormHtml(r, escapeHtml) {
  const v = (k) => escapeHtml(r && r[k] != null ? String(r[k]) : '');
  return `
        <div class="form-section-title">Class group</div>
        <p class="form-section-hint">About the class as a whole (no individual student details). The AI assistant uses these to write the Students section.</p>
        <div class="cohort-grid">
          <div class="form-row">
            <label for="year_level">Year level</label>
            <input type="text" id="year_level" name="year_level" list="year_level_options" value="${v('year_level')}" placeholder="e.g. Year 11">
            <datalist id="year_level_options">${YEAR_OPTIONS.map((y) => `<option value="${y}">`).join('')}</datalist>
          </div>
          <div class="form-row">
            <label for="class_size">Class size</label>
            <input type="number" id="class_size" name="class_size" min="1" max="999" value="${v('class_size')}" placeholder="e.g. 14">
          </div>
          <div class="form-row">
            <label for="age_range">Age range</label>
            <input type="text" id="age_range" name="age_range" value="${v('age_range')}" placeholder="e.g. 16–17">
          </div>
        </div>
        <div class="form-row">
          <label for="course" data-label-general="Course / subject" data-label-vet="Qualification (code and title)">Course / subject</label>
          <input type="text" id="course" name="course" value="${v('course')}" placeholder="e.g. MEM20422 Certificate II in Engineering Pathways">
        </div>
        <div class="form-row">
          <label for="prior_experience">Prior experience / inductions completed</label>
          <textarea id="prior_experience" name="prior_experience" rows="2" placeholder="e.g. Completed Year 10 metalwork and the general workshop safety induction; no previous welding or lathe experience">${v('prior_experience')}</textarea>
        </div>
        <script>
        (function () {
          // Suggest an age range from the year level (QLD: Year N is roughly age N+5 to N+6).
          var yl = document.getElementById('year_level'), ar = document.getElementById('age_range');
          if (!yl || !ar) return;
          yl.addEventListener('change', function () {
            if (ar.value.trim()) return;
            var n = (yl.value.match(/\\d+/g) || []).map(Number);
            if (!n.length) return;
            ar.value = (Math.min.apply(null, n) + 5) + '–' + (Math.max.apply(null, n) + 6);
          });
        })();
        </script>`;
}

module.exports = { COHORT_FIELDS, cohortFromBody, saveCohort, cohortSummary, cohortContextLines, cohortFormHtml };
