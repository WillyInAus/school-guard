// CARA emergency confirmation (first aid kit location, first aider, confirmed
// by/at) and the "insert reviewed first aid wording" buttons. Shared by the
// CARA and project forms so first-aid treatment text always comes from the
// reviewed library in first-aid.js, never from free AI text.

const firstAid = require('./first-aid');

function firstAidButtonsHtml(targetId, escapeHtml) {
  return `
    <div class="fa-insert">
      <span>Insert reviewed first aid wording:</span>
      ${firstAid.LIBRARY.map((e) => `<button type="button" class="btn btn-secondary btn-sm" data-fa-target="${targetId}" data-fa-text="${escapeHtml(firstAid.libraryText(e.key))}">${escapeHtml(e.title)}</button>`).join('')}
    </div>
    <script>
    (function () {
      document.querySelectorAll('[data-fa-target="${targetId}"]').forEach(function (b) {
        if (b.dataset.faReady) return; b.dataset.faReady = '1';
        b.addEventListener('click', function () {
          var t = document.getElementById(b.dataset.faTarget); if (!t) return;
          var add = b.dataset.faText;
          var head = add.split('\\n')[0];
          if (t.value.indexOf(head) >= 0) { b.textContent = 'Already added'; return; }
          t.value = (t.value.trim() ? t.value.trim() + '\\n\\n' : '') + add;
          t.dispatchEvent(new Event('input', { bubbles: true }));
          b.textContent = 'Added ✓';
        });
      });
    })();
    </script>`;
}

function emergencyFormHtml(r, escapeHtml) {
  const v = (k) => escapeHtml(r && r[k] != null ? String(r[k]) : '');
  return `
        ${firstAidButtonsHtml('emergency_first_aid', escapeHtml)}
        <div class="cohort-grid" id="emergency_confirm">
          <div class="form-row" style="grid-column: span 2;">
            <label for="first_aid_kit_location">First aid kit location (for this activity)</label>
            <input type="text" id="first_aid_kit_location" name="first_aid_kit_location" value="${v('first_aid_kit_location')}" placeholder="Where exactly">
          </div>
          <div class="form-row">
            <label for="first_aid_person">Person with current first aid</label>
            <input type="text" id="first_aid_person" name="first_aid_person" value="${v('first_aid_person')}" placeholder="Name">
          </div>
        </div>
        <label class="checkbox-row"><input type="checkbox" name="emergency_confirmed" value="true"${r && r.emergency_confirmed ? ' checked' : ''}> I have checked these emergency and first aid arrangements for this activity's location</label>
        ${r && r.emergency_confirmed && r.emergency_confirmed_by ? `<p class="form-section-hint">Confirmed by ${escapeHtml(r.emergency_confirmed_by)}.</p>` : ''}`;
}

const clean = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s || null;
};

function emergencyFromBody(b) {
  return {
    first_aid_kit_location: clean(b.first_aid_kit_location),
    first_aid_person: clean(b.first_aid_person),
    emergency_confirmed: b.emergency_confirmed === 'true',
  };
}

// Keeps the original confirmer/date if nothing about the arrangement changed.
async function saveEmergency(pool, caraId, e, byName, before) {
  const same = before && before.emergency_confirmed && e.emergency_confirmed
    && (before.first_aid_kit_location || null) === e.first_aid_kit_location && (before.first_aid_person || null) === e.first_aid_person;
  await pool.query(
    `UPDATE cara_records SET first_aid_kit_location = $1, first_aid_person = $2, emergency_confirmed = $3,
       emergency_confirmed_by = CASE WHEN $3 THEN (CASE WHEN $6::boolean THEN emergency_confirmed_by ELSE $4::text END) END,
       emergency_confirmed_at = CASE WHEN $3 THEN (CASE WHEN $6::boolean THEN emergency_confirmed_at ELSE now() END) END
     WHERE id = $5`,
    [e.first_aid_kit_location, e.first_aid_person, e.emergency_confirmed, byName, caraId, !!same]
  );
}

const EMERGENCY_FIELDS = [
  ['first_aid_kit_location', 'First aid kit location'], ['first_aid_person', 'First aid person'], ['emergency_confirmed', 'Emergency arrangements confirmed'],
];

module.exports = { firstAidButtonsHtml, emergencyFormHtml, emergencyFromBody, saveEmergency, EMERGENCY_FIELDS };
