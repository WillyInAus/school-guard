function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function navLink(href, label, iconSvg, active) {
  const activeStyle = active
    ? 'color:#FFFFFF;background:#1B5E52;'
    : 'color:#CFE3DD;background:transparent;';
  return `
    <a href="${href}" style="display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:8px;font-size:14px;font-weight:500;text-decoration:none;${activeStyle}">
      ${iconSvg}
      ${label}
    </a>`;
}

const ICONS = {
  dashboard: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2.5" width="6.5" height="6.5" rx="1.3"/><rect x="11" y="2.5" width="6.5" height="6.5" rx="1.3"/><rect x="2.5" y="11" width="6.5" height="6.5" rx="1.3"/><rect x="11" y="11" width="6.5" height="6.5" rx="1.3"/></svg>',
  risk: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3.5" width="12" height="14" rx="2"/><path d="M7.5 3.5h5v1.6a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1V3.5Z"/><path d="M7.3 11.2l1.8 1.8 3.6-4"/></svg>',
  admin: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2.5l6 2.2v4.3c0 4.3-2.6 6.9-6 8.5-3.4-1.6-6-4.2-6-8.5V4.7l6-2.2Z"/><circle cx="10" cy="9" r="2"/><path d="M10 11v3"/></svg>',
  cara: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 2.8h7.2L16 6.6v10.6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3.8a1 1 0 0 1 1-1Z"/><path d="M12 2.8v3.6a1 1 0 0 0 1 1H16"/><path d="M6.6 10.5h6.4M6.6 13.2h6.4M6.6 7.8h2.6"/></svg>',
};

function page({ title, active, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — School Guard</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<div class="app-shell">
  <div class="sidebar">
    <div class="sidebar-brand">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 5-3.2 8.4-7 10-3.8-1.6-7-5-7-10V6l7-3Z"/><path d="M9 12l2.2 2.2L15.5 9.5"/></svg>
      <span>School Guard</span>
    </div>
    <nav class="sidebar-nav">
      ${navLink('/', 'Dashboard', ICONS.dashboard, active === 'dashboard')}
      ${navLink('/risk-assessments', 'Risk Assessments', ICONS.risk, active === 'risk-assessments')}
      ${navLink('/cara', 'CARA', ICONS.cara, active === 'cara')}
    </nav>
    <nav class="sidebar-nav-bottom">
      ${navLink('/admin', 'Admin', ICONS.admin, active === 'admin')}
    </nav>
    <div class="sidebar-footer">
      <div class="sidebar-footer-label">Signed in as</div>
      <div class="sidebar-footer-name">S. Willmott · WHS Coordinator</div>
    </div>
  </div>
  <div class="main-column">
    <div class="topbar">
      <div class="school-switch">Faith Lutheran College — Plainland</div>
      <div class="topbar-right">
        <div class="avatar">SW</div>
      </div>
    </div>
    <div class="content">
      ${body}
    </div>
  </div>
</div>
</body>
</html>`;
}

module.exports = { page, escapeHtml };
