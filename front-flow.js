// Hand-drawn style "safety cycle" flowchart for the front page dashboard.
// Pure SVG, no client JS. Each step links to the part of the app that handles it.

const { escapeHtml } = require('./views/layout');

const CX = 390;
const CY = 290;
const RX = 300;
const RY = 205;

function pointAt(deg, rx = RX, ry = RY) {
  const r = (deg * Math.PI) / 180;
  return { x: CX + rx * Math.cos(r), y: CY + ry * Math.sin(r) };
}

function fmt(n) {
  return Math.round(n * 10) / 10;
}

// steps: [{ title, sub, href, badge, badgeTone }]
function safetyFlowSvg(steps, opts = {}) {
  const heading = opts.heading === undefined ? 'How we keep the workshop safe' : opts.heading;
  const intro = opts.intro === undefined ? 'Every tool and every class goes round this loop. Tap a step to jump to it.' : opts.intro;
  const n = steps.length;
  const angles = steps.map((_, i) => -90 + (360 / n) * i);

  // Arrows between neighbouring steps, drawn as slightly bowed curves along the ellipse.
  const arrows = angles
    .map((a, i) => {
      const b = i === n - 1 ? angles[0] + 360 : angles[i + 1];
      const gap = 17;
      const s = pointAt(a + gap);
      const e = pointAt(b - gap);
      const mid = pointAt((a + b) / 2, RX + 34, RY + 30);
      const d = `M${fmt(s.x)},${fmt(s.y)} Q${fmt(mid.x)},${fmt(mid.y)} ${fmt(e.x)},${fmt(e.y)}`;
      return `<path class="sg-flow-arrow" style="--d:${(i * 0.18).toFixed(2)}s" d="${d}" marker-end="url(#sg-flow-head)"/>`;
    })
    .join('');

  const nodes = steps
    .map((step, i) => {
      const p = pointAt(angles[i]);
      const inner = `
        <rect class="sg-flow-hit" x="${fmt(p.x - 78)}" y="${fmt(p.y - 34)}" width="156" height="${step.badge ? 84 : 66}" rx="14"/>
        <text class="sg-flow-title" x="${fmt(p.x)}" y="${fmt(p.y - 2)}" text-anchor="middle">${escapeHtml(step.title)}</text>
        <text class="sg-flow-sub" x="${fmt(p.x)}" y="${fmt(p.y + 18)}" text-anchor="middle">${escapeHtml(step.sub)}</text>
        ${
          step.badge
            ? `<text class="sg-flow-badge sg-flow-badge-${step.badgeTone || 'plain'}" x="${fmt(p.x)}" y="${fmt(p.y + 38)}" text-anchor="middle">${escapeHtml(step.badge)}</text>`
            : ''
        }`;
      const body = step.href
        ? `<a href="${escapeHtml(step.href)}" class="sg-flow-link" aria-label="${escapeHtml(`${step.title}: ${step.sub}`)}">${inner}</a>`
        : inner;
      return `<g class="sg-flow-node" style="--d:${(0.25 + i * 0.18).toFixed(2)}s">${body}</g>`;
    })
    .join('');

  return `
  <div class="${opts.bare ? 'sg-flow-bare' : 'card sg-flow-card'}">
    ${heading || intro ? `<div class="sg-flow-head">
      ${heading ? `<h2 class="sg-flow-heading">${escapeHtml(heading)}</h2>` : ''}
      ${intro ? `<p class="sg-flow-intro">${escapeHtml(intro)}</p>` : ''}
    </div>` : ''}
    <svg class="sg-flow" viewBox="0 0 780 590" role="img" aria-labelledby="sg-flow-t">
      <title id="sg-flow-t">Safety cycle: ${steps.map((s) => escapeHtml(s.title)).join(', then ')}, then back to the start.</title>
      <defs>
        <filter id="sg-flow-rough" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="7"/>
          <feDisplacementMap in="SourceGraphic" scale="3.2"/>
        </filter>
        <marker id="sg-flow-head" viewBox="0 0 12 12" refX="9" refY="6" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
          <path d="M1,1.5 L10,6 L1,10.5" class="sg-flow-headpath"/>
        </marker>
      </defs>
      <g filter="url(#sg-flow-rough)">${arrows}</g>
      <g class="sg-flow-centre">
        <ellipse class="sg-flow-ring" cx="${CX}" cy="${CY}" rx="112" ry="64" filter="url(#sg-flow-rough)"/>
        <ellipse class="sg-flow-ring sg-flow-ring2" cx="${CX + 3}" cy="${CY - 2}" rx="118" ry="60" filter="url(#sg-flow-rough)"/>
        <text class="sg-flow-centre-text" x="${CX}" y="${CY - 6}" text-anchor="middle">SAFE</text>
        <text class="sg-flow-centre-text" x="${CX}" y="${CY + 28}" text-anchor="middle">WORKSHOP</text>
      </g>
      ${nodes}
    </svg>
    <ol class="sg-flow-list">
      ${steps
        .map((step) => {
          const inner = `<span class="sg-flow-list-title">${escapeHtml(step.title)}</span>
            <span class="sg-flow-list-sub">${escapeHtml(step.sub)}</span>
            ${step.badge ? `<span class="sg-flow-badge-html sg-flow-badge-${step.badgeTone || 'plain'}">${escapeHtml(step.badge)}</span>` : ''}`;
          return `<li>${step.href ? `<a href="${escapeHtml(step.href)}">${inner}</a>` : `<div>${inner}</div>`}</li>`;
        })
        .join('')}
      <li class="sg-flow-list-loop">↺ and back round to ${escapeHtml(steps[0].title)}</li>
    </ol>
  </div>`;
}

module.exports = { safetyFlowSvg };
