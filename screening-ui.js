// Hazard screening questions UI, shared by the CARA and project forms.
// Broad questions first; follow-ups appear when an answer makes them
// relevant; construction screening stays available (and is required unless
// the work is "not construction-type"); questions matched to the activity are
// shown first, the rest are in "More hazard questions". Hidden or unanswered
// questions are never treated as "No" (see project-rules.js).

const rules = require('./project-rules');

function questionsHtml(answers, escapeHtml, opts = {}) {
  const a = answers || {};
  // CARA forms ask about "the activity"; project forms keep "the project".
  const say = (t) => (opts.subject === 'activity' ? t.replace(/\bthe project\b/g, 'the activity').replace(/\bThe project\b/g, 'The activity') : t);
  // noConstruction: the construction-type work question and its follow-ups
  // (used for SWMS / high risk construction work) are not asked.
  const skip = new Set();
  if (opts.noConstruction) for (const q of rules.QUESTIONS) if (q.key === 'construction_work' || q.hideIfNo === 'construction_work' || skip.has(q.showIf)) skip.add(q.key);
  const QS = rules.QUESTIONS.filter((q) => !skip.has(q.key));
  const groups = [...new Set(QS.map((q) => q.group))];
  return `
    <fieldset class="prj-qgroup prj-qrelevant" id="prj_relevant"><legend>Most relevant to this activity</legend>
      <p class="form-section-hint prj-relevant-empty">Describe the work, materials and equipment to bring the relevant questions here.</p>
    </fieldset>
    <div class="prj-screen-head"><strong>Hazard screening (${escapeHtml(rules.JURISDICTION)})</strong> — answer every question marked <span class="prj-crit">*</span>. "Unsure" is fine; a reviewer will settle it.</div>
    ${groups.map((g, gi) => `
    <fieldset class="prj-qgroup" id="prj_g${gi}"><legend>${escapeHtml(g)}</legend>
      ${QS.filter((q) => q.group === g).map((q) => `
        <div class="prj-q" id="q_${q.key}" data-q="${q.key}" data-home="prj_g${gi}" data-critical="${q.critical === true ? 'yes' : (q.critical || 'no')}"${q.showIf ? ` data-show-if="${q.showIf}"` : ''}${q.hideIfNo ? ` data-hide-if-no="${q.hideIfNo}"` : ''}${q.onlyWhenRelevant ? ' data-only-relevant="1"' : ''}>
          <div class="prj-q-text" id="qt_${q.key}">${escapeHtml(say(q.text))} <span class="prj-crit" title="Must be answered">*</span></div>${q.key === 'construction_work' ? '<p class="prj-gate-hint">Answer this first. Construction follow-up questions appear only if it is Yes or Unsure.</p>' : ''}
          <div class="prj-q-opts" role="radiogroup" aria-labelledby="qt_${q.key}">${['Yes', 'No', 'Unsure'].map((v) => `
            <label><input type="radio" name="q_${q.key}" value="${v}"${a[q.key] === v ? ' checked' : ''}> ${v}</label>`).join('')}</div>
          ${q.note ? `<details class="prj-q-note"><summary>More info</summary>${escapeHtml(say(q.note))}</details>` : ''}
          <p class="prj-unsure-note">Unsure — left open for the reviewer to settle.</p>
        </div>`).join('')}
    </fieldset>`).join('')}
    <details class="prj-qgroup prj-more" id="prj_more"><summary>More hazard questions (not matched to this activity — open if any apply)</summary></details>`;
}

// textIds: ids of inputs whose words drive relevance; peraName: checkbox name
// for equipment; templateId: optional template <select>.
function clientScript({ formId, textIds, peraName, templateId, noConstruction }) {
  return `
  <script>
  (function () {
    var form = document.getElementById(${JSON.stringify(formId)}); if (!form) return;
    var TEMPLATES = ${JSON.stringify(rules.TEMPLATES).replace(/</g, '\\u003c')};
    var RELEVANCE = ${JSON.stringify(rules.RELEVANCE_MAP.map(([re, ks]) => [re.source, ks])).replace(/</g, '\\u003c')};
    var ORDER = ${JSON.stringify(rules.QUESTIONS.map((q) => q.key))};
    var TEXT_IDS = ${JSON.stringify(textIds)}, PERA = ${JSON.stringify(peraName)}, TPL = ${JSON.stringify(templateId || null)};
    function ans(k) { var c = form.querySelector('input[name="q_' + k + '"]:checked'); return c ? c.value : ''; }
    function refresh() {
      var tpl = (TPL && TEMPLATES[(document.getElementById(TPL) || {}).value]) || { focus: [] };
      var words = TEXT_IDS.map(function (id) { return (document.getElementById(id) || {}).value || ''; }).join(' ');
      form.querySelectorAll('input[name="' + PERA + '"]:checked').forEach(function (c) { var l = form.querySelector('label[for="' + c.id + '"]'); if (l) words += ' ' + l.textContent; });
      words = words.toLowerCase();
      var rel = {}; tpl.focus.forEach(function (k) { rel[k] = 1; });
      RELEVANCE.forEach(function (r) { if (new RegExp(r[0]).test(words)) r[1].forEach(function (k) { rel[k] = 1; }); });
      var construction = ${noConstruction ? 'false' : "ans('construction_work') !== 'No'"};
      var box = document.getElementById('prj_relevant'), more = document.getElementById('prj_more');
      // Same rule as project-rules.js visibleQuestions: a follow-up shows only
      // when the question it depends on is shown and answered Yes or Unsure.
      var vis = {};
      function opens(k) { var v = ans(k); return vis[k] && (v === 'Yes' || v === 'Unsure'); }
      ORDER.forEach(function (key) {
        var el = document.getElementById('q_' + key); if (!el) return;
        var ok = true;
        if (el.dataset.showIf && !opens(el.dataset.showIf)) ok = false;
        if (el.dataset.hideIfNo && !opens(el.dataset.hideIfNo)) ok = false;
        vis[key] = ok;
      });
      var gate = document.getElementById('q_construction_work');
      if (gate) gate.classList.toggle('prj-q-gate-open', !ans('construction_work'));
      form.querySelectorAll('.prj-q').forEach(function (el) {
        var key = el.dataset.q, parentKey = el.dataset.showIf;
        var isRel = rel[key] || (parentKey && rel[parentKey]);
        var shown = !!vis[key];
        el.style.display = shown ? '' : 'none';
        el.classList.toggle('prj-q-unsure', shown && ans(key) === 'Unsure');
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
    // Run again once the whole page (later scripts and fields) is ready.
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh);
  })();
  </script>`;
}

module.exports = { questionsHtml, clientScript };
