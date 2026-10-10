// Shows multi-line CARA text nicely: "- " lines as real bullets whose wrapped
// lines line up with the text (not the dot), and short lines ending in ":" as
// bold sub-headings. Browsers can't do that inside a plain <textarea>, so each
// textarea in a form marked data-pretty shows a formatted view while you're
// not typing in it; click (or Tab to) the view to edit. Elements with class
// "pretty-text" (read-only pages) are formatted in place.
(function () {
  var BULLET = /^\s*(?:[-•*–·]|\d+[.)])\s+/;

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  // Placeholders such as [confirm: location] are highlighted when the page
  // provides the rule (window.isPlaceholderText, set by the CARA/project forms).
  function inline(s) {
    var h = esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    if (window.isPlaceholderText) h = h.replace(/\[([^\[\]]{0,100})\]/g, function (m, inner) { return window.isPlaceholderText(inner) ? '<mark class="ph-mark">' + m + '</mark>' : m; });
    return h;
  }

  function render(text) {
    var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    var out = [], list = null, para = null;
    function flushList() { if (list) { out.push('<ul>' + list.map(function (l) { return '<li>' + l + '</li>'; }).join('') + '</ul>'); list = null; } }
    function flushPara() { if (para) { out.push('<p>' + para.join('<br>') + '</p>'); para = null; } }
    lines.forEach(function (raw) {
      if (!raw.trim()) { flushList(); flushPara(); return; }
      if (BULLET.test(raw)) { flushPara(); (list = list || []).push(inline(raw.replace(BULLET, '').trim())); return; }
      if (list && /^\s{2,}/.test(raw)) { list[list.length - 1] += ' ' + inline(raw.trim()); return; }
      flushList();
      var line = raw.trim();
      (para = para || []).push(/:$/.test(line) && line.length <= 150 ? '<strong class="pt-subhead">' + inline(line) + '</strong>' : inline(line));
    });
    flushList(); flushPara();
    return out.join('');
  }

  function setup(ta) {
    if (ta.dataset.prettyReady) return;
    ta.dataset.prettyReady = '1';
    var view = document.createElement('div');
    view.className = 'pretty-view';
    view.tabIndex = 0;
    view.title = 'Click to edit';
    view.setAttribute('role', 'button');
    ta.insertAdjacentElement('afterend', view);
    var last = null;

    function showView() {
      if (document.activeElement === ta) return;
      var v = ta.value;
      if (!v.trim()) { view.style.display = 'none'; ta.style.display = ''; return; }
      if (v !== last) { view.innerHTML = render(v); last = v; }
      view.style.display = '';
      ta.style.display = 'none';
    }
    function edit() {
      var h = view.offsetHeight;
      view.style.display = 'none';
      ta.style.display = '';
      if (h) ta.style.height = Math.max(h, 90) + 'px';
      ta.focus();
    }
    ta.prettyEdit = edit;
    view.addEventListener('click', function (e) { if (!e.target.closest('a')) edit(); });
    view.addEventListener('focus', edit);
    ta.addEventListener('blur', showView);
    // Pick up values set by script (e.g. the AI "Use this" button).
    setInterval(function () { if (document.activeElement !== ta && ta.value !== last) showView(); }, 400);
    showView();
  }

  function init() {
    document.querySelectorAll('form[data-pretty] textarea').forEach(setup);
    document.querySelectorAll('.pretty-text').forEach(function (el) {
      if (el.dataset.prettyReady) return;
      el.dataset.prettyReady = '1';
      var t = el.textContent;
      if (t.trim() && t.trim() !== '—') { el.innerHTML = render(t); el.classList.add('pretty-done'); }
    });
  }
  // Show the real text box (if the formatted view is covering it) so it can
  // take focus — used by issue links and "jump to field".
  window.prettyReveal = function (el) { if (el && el.prettyEdit && el.style.display === 'none') el.prettyEdit(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
