// Hazard screening questions UI, shared by the CARA and project forms.
// Broad questions first; follow-ups appear when an answer makes them
// relevant; construction screening stays available (and is required unless
// the work is "not construction-type"); questions matched to the activity are
// shown first, the rest are in "More hazard questions". Hidden or unanswered
// questions are never treated as "No" (see project-rules.js).

const rules = require('./project-rules');

function questionsHtml(answers, escapeHtml) {
  const a = answers || {};
  const groups = [...new Set(rules.QUESTIONS.map((q) => q.group))];
  return `
    <fieldset class="prj-qgroup prj-qrelevant" id="prj_relevant"><legend>Most relevant to this activity</legend>
      <p class="form-section-hint prj-relevant-empty">Describe the work, materials and equipment to bring the relevant questions here.</p>
    </fieldset>
    <div class="prj-screen-head"><strong>Hazard screening (${escapeHtml(rules.JURISDICTION)})</strong> — answer every question marked <span class="prj-crit">*</span>. "Unsure" is fine; a reviewer will settle it.</div>
    ${groups.map((g, gi) => `
    <fieldset class="prj-qgroup" id="prj_g${gi}"><legend>${escapeHtml(g)}</legend>
      ${rules.QUESTIONS.filter((q) => q.group === g).map((q) => `
        <div class="prj-q" id="q_${q.key}" data-q="${q.key}" data-home="prj_g${gi}" data-critical="${q.critical === true ? 'yes' : (q.critical || 'no')}"${q.showIf ? ` data-show-if="${q.showIf}"` : ''}${q.hideIfNo ? ` data-hide-if-no="${q.hideIfNo}"` : ''}${q.onlyWhenRelevant ? ' data-only-relevant="1"' : ''}>
          <div class="prj-q-text" id="qt_${q.key}">${escapeHtml(q.text)} <span class="prj-crit" title="Must be answered">*</span></div>
          <div class="prj-q-opts" role="radiogroup" aria-labelledby="qt_${q.key}">${['Yes', 'No', 'Unsure'].map((v) => `
            <label><input type="radio" name="q_${q.key}" value="${v}"${a[q.key] === v ? ' checked' : ''}> ${v}</label>`).join('')}</div>
          ${q.note ? `<details class="prj-q-note"><summary>More info</summary>${escapeHtml(q.note)}</details>` : ''}
        </div>`).join('')}
    </fieldset>`).join('')}
    <details class="prj-qgroup prj-more" id="prj_more"><summary>More hazard questions (not matched to this activity — open if any apply)</summary></details>`;
}

// textIds: ids of inputs whose words drive relevance; peraName: checkbox name
// for equipment; templateId: optional template <select>.
function clientScript({ formId, textIds, peraName, templateId }) {
  return `
  <script>
  (function () {
    var form = document.getElementById(${JSON.stringify(formId)}); if (!form) return;
    var TEMPLATES = ${JSON.stringify(rules.TEMPLATES).replace(/</g, '\\u003c')};
    var RELEVANCE = ${JSON.stringify(rules.RELEVANCE_MAP.map(([re, ks]) => [re.source, ks])).replace(/</g, '\\u003c')};
    var TEXT_IDS = ${JSON.stringify(textIds)}, PERA = ${JSON.stringify(peraName)}, TPL = ${JSON.stringify(templateId || null)};
    function ans(k) { var c = form.querySelector('input[name="q_' + k + '"]:checked'); return c ? c.value : ''; }
    function refresh() {
      var tpl = (TPL && TEMPLATES[(document.getElementById(TPL) || {}).value]) || { focus: [] };
      var words = TEXT_IDS.map(function (id) { return (document.getElementById(id) || {}).value || ''; }).join(' ');
      form.querySelectorAll('input[name="' + PERA + '"]:checked').forEach(function (c) { var l = form.querySelector('label[for="' + c.id + '"]'); if (l) words += ' ' + l.textContent; });
      words = words.toLowerCase();
      var rel = {}; tpl.focus.forEach(function (k) { rel[k] = 1; });
      RELEVANCE.forEach(function (r) { if (new RegExp(r[0]).test(words)) r[1].forEach(function (k) { rel[k] = 1; }); });
      var construction = ans('construction_work') !== 'No';
      var box = document.getElementById('prj_relevant'), more = document.getElementById('prj_more');
      form.querySelectorAll('.prj-q').forEach(function (el) {
        var key = el.dataset.q, parentKey = el.dataset.showIf;
        var isRel = rel[key] || (parentKey && rel[parentKey]);
        var shown = true;
        if (parentKey) { var pv = ans(parentKey); shown = pv === 'Yes' || pv === 'Unsure'; }
        if (el.dataset.hideIfNo && ans(el.dataset.hideIfNo) === 'No') shown = false;
        el.style.display = shown ? '' : 'none';
        // The work-type question always comes first.
        var target = key === 'construction_work' ? box : (isRel ? box : (el.dataset.onlyRelevant && !ans(key) ? more : document.getElementById(el.dataset.home)));
        if (key === 'construction_work' && box.firstElementChild !== el) box.insertBefore(el, box.querySelector('.prj-q') || null);
        else if (el.parentNode !== target) target.appendChild(el);
        var crit = el.dataset.critical === 'yes' || (el.dataset.critical === 'construction' && construction) || (el.dataset.critical === 'relevant' && isRel);
        el.classList.toggle('prj-q-critical', crit);
        el.classList.toggle('prj-q-missing', crit && shown && !ans(key));
      });
      box.querySelector('.prj-relevant-empty').style.display = box.querySelectorAll('.prj-q').length > 1 ? 'none' : '';
      form.querySelectorAll('.prj-qgroup[id^="prj_g"]').forEach(function (g) {
        g.style.display = Array.prototype.some.call(g.querySelectorAll('.prj-q'), function (q) { return q.style.display !== 'none'; }) ? '' : 'none';
      });
      more.style.display = more.querySelector('.prj-q') ? '' : 'none';
      form.dispatchEvent(new CustomEvent('screening-updated'));
    }
    form.addEventListener('change', function (e) { var n = e.target.name || ''; if (n.indexOf('q_') === 0 || n === PERA || e.target.id === TPL) refresh(); });
    TEXT_IDS.forEach(function (id) { var t = document.getElementById(id); if (t) t.addEventListener('blur', refresh); });
    window.screeningRefresh = refresh;
    refresh();
  })();
  </script>`;
}

module.exports = { questionsHtml, clientScript };
