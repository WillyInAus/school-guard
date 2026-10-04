// Public front page: "coming soon" landing page with the staff testing sign-in form.
// Shown at / when nobody is signed in, and at /admin/login.

const { escapeHtml, ASSET_VERSION } = require('./views/layout');
const { safetyFlowSvg } = require('./front-flow');

const FLOW_STEPS = [
  { title: 'ASSESS', sub: 'PERA + SOP for each tool' },
  { title: 'APPROVE', sub: 'Authorised approver signs off' },
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
    text: 'Plant & Equipment Risk Assessments that bring together hazards, controls, supervision requirements and student-use rules.',
  },
  {
    icon: '<path d="M6 3h9l4 4v14H6Z"/><path d="M14 3v5h5"/><path d="M9 13h7M9 17h5"/>',
    title: 'SOPs attached',
    text: 'Safe operating procedures attached to each PERA, so staff can find the documents they need in one place.',
  },
  {
    icon: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/>',
    title: 'CARA for classes',
    text: 'Class and project risk assessments built by selecting equipment from the PERA library.',
  },
  {
    icon: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4Z"/>',
    title: 'Equipment register',
    text: 'An equipment register linking items to their assessments, operating status and maintenance records.',
  },
  {
    icon: '<path d="M3 9l9-5 9 5-9 5Z"/><path d="M7 11v5c3 2 7 2 10 0v-5"/>',
    title: 'Staff induction',
    text: 'Recorded staff acknowledgements of PERAs and SOPs, with assessor verification of competency.',
  },
  {
    icon: '<path d="M12 3l7 3v5c0 5-3.2 8.4-7 10-3.8-1.6-7-5-7-10V6l7-3Z"/><path d="M9 12l2.2 2.2L15.5 9.5"/>',
    title: 'Approvals & records',
    text: 'Approval decisions, comments and assessment changes recorded in a traceable history.',
  },
];

const SHIELD = '<path d="M12 3l7 3v5c0 5-3.2 8.4-7 10-3.8-1.6-7-5-7-10V6l7-3Z"/><path d="M9 12l2.2 2.2L15.5 9.5"/>';

function icon(paths, size = 24) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

function signInCard({ next, error, user, email }) {
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
      <h2 class="lp-signin-title">Staff testing sign-in</h2>
      <p class="lp-signin-note lp-signin-note-top">Access is currently limited to authorised staff testing the system.</p>
      ${error ? `<div class="lp-error" id="lp-error" role="alert">${escapeHtml(error)}</div>` : ''}
      <form method="post" action="/admin/login">
        <input type="hidden" name="next" value="${escapeHtml(next || '/')}">
        <label class="lp-label" for="email">Email</label>
        <input class="lp-input" type="email" id="email" name="email" autocomplete="username" value="${escapeHtml(email || '')}" required${error ? ' aria-describedby="lp-error"' : ''}>
        <label class="lp-label" for="password">Password</label>
        <input class="lp-input" type="password" id="password" name="password" autocomplete="current-password" required>
        <button type="submit" class="lp-btn lp-btn-primary lp-btn-block">Sign in</button>
      </form>
      <p class="lp-signin-note">Need access? Contact your school WHS coordinator.</p>
    </div>`;
}

function renderLanding({ next = '/', error = '', user = null, email = '' } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>School Guard — Coming soon</title>
<meta name="description" content="School Guard is in development: a simpler way for schools to manage workshop risk assessments, equipment and staff induction.">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=Permanent+Marker&display=swap">
<link rel="stylesheet" href="/style.css?v=${ASSET_VERSION}">
</head>
<body class="lp-body">
  <header class="lp-top">
    <div class="lp-wrap lp-top-inner">
      <a class="lp-brand" href="/">${icon(SHIELD, 26)}<span>School Guard</span></a>
      <a class="lp-btn lp-btn-ghost" href="${user ? '/' : '#signin'}">${user ? 'Dashboard' : 'Staff sign-in'}</a>
    </div>
  </header>

  <section class="lp-hero">
    <div class="lp-wrap lp-hero-inner">
      <div class="lp-hero-copy">
        <p class="lp-badge-row"><span class="lp-soon">Coming soon</span><span class="lp-eyebrow">WHS for school workshops</span></p>
        <h1 class="lp-h1">Safe workshops,<br><span class="lp-marker">minus the paper pile.</span></h1>
        <p class="lp-lead">School Guard is in development. We’re building a simpler way for schools to manage workshop risk assessments, equipment and staff induction.</p>
        <p class="lp-ticks-label" id="lp-dev-label">Capabilities in development</p>
        <ul class="lp-ticks" aria-labelledby="lp-dev-label">
          <li>Risk assessments and SOPs in one place</li>
          <li>Class CARAs built from an equipment library</li>
          <li>Recorded staff induction and competency verification</li>
          <li>Equipment status and maintenance records</li>
        </ul>
      </div>
      ${signInCard({ next, error, user, email })}
    </div>
  </section>

  <section class="lp-section lp-flow-section">
    <div class="lp-wrap">
      <p class="lp-section-eyebrow">The intended workflow</p>
      <h2 class="lp-h2">One loop. <span class="lp-marker">Every tool, every class.</span></h2>
      <p class="lp-section-lead">The process we’re building brings together equipment assessment, approval, staff induction and lesson planning—with checks before use and reviews when things change.</p>
      ${safetyFlowSvg(FLOW_STEPS, { bare: true, heading: '', intro: '' })}
    </div>
  </section>

  <section class="lp-section lp-features-section">
    <div class="lp-wrap">
      <h2 class="lp-h2">What we’re building</h2>
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
        <p>Designed alongside Queensland staff who run woodwork, metalwork and VET trade classes, around the paperwork they already have to keep.</p>
        <p class="lp-built-status"><span class="lp-soon lp-soon-light">Coming soon</span> Currently being developed and tested for school workshop use.</p>
      </div>
      <a class="lp-btn lp-btn-light" href="${user ? '/' : '#signin'}">${user ? 'Go to dashboard' : 'Staff testing sign-in'}</a>
    </div>
  </section>

  <footer class="lp-footer">
    <div class="lp-wrap">© ${new Date().getFullYear()} School Guard · eduwhs.com · In development</div>
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
