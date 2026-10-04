// Public front page: the "sales" landing page with the staff sign-in form.
// Shown at / when nobody is signed in, and at /admin/login.

const { escapeHtml, ASSET_VERSION } = require('./views/layout');
const { safetyFlowSvg } = require('./front-flow');

const FLOW_STEPS = [
  { title: 'ASSESS', sub: 'PERA + SOP for each tool' },
  { title: 'APPROVE', sub: 'WHS Coordinator signs off' },
  { title: 'INDUCT', sub: 'Staff read, confirm, verified' },
  { title: 'PLAN', sub: 'CARA for the class activity' },
  { title: 'CHECK', sub: 'Gear tagged, guarded, ready' },
  { title: 'TEACH!', sub: 'Students work safely' },
  { title: 'REVIEW', sub: 'Yearly or after a change' },
];

const FEATURES = [
  {
    icon: '<path d="M9 3h6l1 2h3v16H5V5h3l1-2Z"/><path d="M9 12l2 2 4-4"/>',
    title: 'PERA library',
    text: 'A Plant & Equipment Risk Assessment for every machine and hand tool, with hazards, controls, supervision levels and student-use rules in one place.',
  },
  {
    icon: '<path d="M6 3h9l4 4v14H6Z"/><path d="M14 3v5h5"/><path d="M9 13h7M9 17h5"/>',
    title: 'SOPs attached',
    text: 'Safe operating procedures sit right on the PERA as Word and PDF copies, so the current version is always the one staff open.',
  },
  {
    icon: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/>',
    title: 'CARA for classes',
    text: 'Curriculum Activity Risk Assessments for a class or project, built by picking the tools from the PERA library instead of starting from scratch.',
  },
  {
    icon: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4Z"/>',
    title: 'Equipment register',
    text: 'Every physical machine in every room, linked to its PERA, with its status so anything out of action is flagged straight away.',
  },
  {
    icon: '<path d="M3 9l9-5 9 5-9 5Z"/><path d="M7 11v5c3 2 7 2 10 0v-5"/>',
    title: 'Staff induction',
    text: 'Teachers pick the equipment they use, read and acknowledge the exact PERA and SOP version, and an assessor verifies them. No self-sign-off.',
  },
  {
    icon: '<path d="M12 3l7 3v5c0 5-3.2 8.4-7 10-3.8-1.6-7-5-7-10V6l7-3Z"/><path d="M9 12l2.2 2.2L15.5 9.5"/>',
    title: 'Approvals & records',
    text: 'One approvals screen for the WHS Coordinator, with every decision, note and change kept in the history for audit time.',
  },
];

const SHIELD = '<path d="M12 3l7 3v5c0 5-3.2 8.4-7 10-3.8-1.6-7-5-7-10V6l7-3Z"/><path d="M9 12l2.2 2.2L15.5 9.5"/>';

function icon(paths, size = 24) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

function signInCard({ next, error, user }) {
  if (user) {
    return `
      <div class="lp-signin">
        <h2 class="lp-signin-title">Welcome back</h2>
        <p class="lp-signin-note">Signed in as <strong>${escapeHtml(user.name)}</strong>.</p>
        <a class="lp-btn lp-btn-primary lp-btn-block" href="/">Go to dashboard</a>
        <form method="post" action="/admin/logout" class="lp-signout">
          <button type="submit" class="lp-link-btn">Sign out</button>
        </form>
      </div>`;
  }
  return `
    <div class="lp-signin" id="signin">
      <h2 class="lp-signin-title">Staff sign in</h2>
      ${error ? `<div class="lp-error" role="alert">${escapeHtml(error)}</div>` : ''}
      <form method="post" action="/admin/login">
        <input type="hidden" name="next" value="${escapeHtml(next || '/')}">
        <label class="lp-label" for="email">Email</label>
        <input class="lp-input" type="email" id="email" name="email" autocomplete="username" required>
        <label class="lp-label" for="password">Password</label>
        <input class="lp-input" type="password" id="password" name="password" autocomplete="current-password" required>
        <button type="submit" class="lp-btn lp-btn-primary lp-btn-block">Sign in</button>
      </form>
      <p class="lp-signin-note">Accounts are set up by your school's WHS Coordinator.</p>
    </div>`;
}

function renderLanding({ next = '/', error = '', user = null } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>School Guard — Workshop safety for schools</title>
<meta name="description" content="School Guard keeps practical-subject WHS in one place: PERAs, SOPs, CARAs, equipment, staff induction and approvals.">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=Permanent+Marker&display=swap">
<link rel="stylesheet" href="/style.css?v=${ASSET_VERSION}">
</head>
<body class="lp-body">
  <header class="lp-top">
    <div class="lp-wrap lp-top-inner">
      <a class="lp-brand" href="/">${icon(SHIELD, 26)}<span>School Guard</span></a>
      <a class="lp-btn lp-btn-ghost" href="${user ? '/' : '#signin'}">${user ? 'Dashboard' : 'Sign in'}</a>
    </div>
  </header>

  <section class="lp-hero">
    <div class="lp-wrap lp-hero-inner">
      <div class="lp-hero-copy">
        <p class="lp-eyebrow">WHS for school workshops</p>
        <h1 class="lp-h1">Safe workshops,<br><span class="lp-marker">minus the paper pile.</span></h1>
        <p class="lp-lead">School Guard keeps every risk assessment, SOP, piece of equipment and staff induction in one place, so teachers know what's approved and the WHS Coordinator can prove it.</p>
        <ul class="lp-ticks">
          <li>PERAs and SOPs for every tool</li>
          <li>Class CARAs built in minutes</li>
          <li>Staff induction with real sign-off</li>
          <li>Works on a phone in the workshop</li>
        </ul>
      </div>
      ${signInCard({ next, error, user })}
    </div>
  </section>

  <section class="lp-section lp-flow-section">
    <div class="lp-wrap">
      <h2 class="lp-h2">One loop. <span class="lp-marker">Every tool, every class.</span></h2>
      <p class="lp-section-lead">Nothing gets used until it has gone round the loop, and nothing drops off it once it has.</p>
      ${safetyFlowSvg(FLOW_STEPS, { bare: true, heading: '', intro: '' })}
    </div>
  </section>

  <section class="lp-section lp-features-section">
    <div class="lp-wrap">
      <h2 class="lp-h2">Everything the workshop needs</h2>
      <div class="lp-features">
        ${FEATURES.map(
          (f) => `
          <div class="lp-feature">
            <div class="lp-feature-icon">${icon(f.icon)}</div>
            <h3>${escapeHtml(f.title)}</h3>
            <p>${escapeHtml(f.text)}</p>
          </div>`
        ).join('')}
      </div>
    </div>
  </section>

  <section class="lp-section lp-built">
    <div class="lp-wrap lp-built-inner">
      <div>
        <h2 class="lp-h2 lp-h2-light">Built in a real school workshop</h2>
        <p>Designed alongside the people who run woodwork, metalwork and VET trade classes in Queensland, around the paperwork they already have to keep.</p>
      </div>
      <a class="lp-btn lp-btn-light" href="${user ? '/' : '#signin'}">${user ? 'Go to dashboard' : 'Staff sign in'}</a>
    </div>
  </section>

  <footer class="lp-footer">
    <div class="lp-wrap">© ${new Date().getFullYear()} School Guard · eduwhs.com</div>
  </footer>
<script>
(function () {
  var svg = document.querySelector('.sg-flow');
  if (!svg || !('IntersectionObserver' in window)) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  svg.classList.add('sg-wait');
  var io = new IntersectionObserver(function (entries) {
    if (entries.some(function (e) { return e.isIntersecting; })) {
      svg.classList.remove('sg-wait');
      svg.classList.add('sg-go');
      io.disconnect();
    }
  }, { threshold: 0.3 });
  io.observe(svg);
})();
</script>
</body>
</html>`;
}

module.exports = { renderLanding };
