// The plain dashboard. A theme is a module exporting render(data) -> HTML,
// where data is the object from ../data.mjs (see dashboard/data.json).
// Add a new look by adding a file here; pick it with DASHBOARD_THEME.

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

function renderRunHistoryTable(runs) {
  const recent = runs.slice(-30).reverse();
  return `
    <table>
      <thead><tr><th>Date</th><th>Passed</th><th>Failed</th><th>Skipped</th></tr></thead>
      <tbody>
        ${recent
          .map(
            (r) => `<tr class="${r.failed > 0 ? 'row-fail' : 'row-pass'}">
              <td>${escapeHtml(r.date)}</td><td>${r.passed}</td><td>${r.failed}</td><td>${r.skipped}</td>
            </tr>`
          )
          .join('')}
      </tbody>
    </table>`;
}

function renderLighthouseChart({ pages, history }) {
  const width = 720,
    height = 220,
    pad = 30;
  const dates = [...new Set(history.map((r) => r.date))].sort();
  const xStep = dates.length > 1 ? (width - pad * 2) / (dates.length - 1) : 0;
  const colors = ['#e07a3f', '#3f7ae0', '#3fe0a0', '#c93fe0'];

  const lines = pages
    .map((page, i) => {
      const points = history
        .filter((r) => r.page === page && r.performance != null)
        .map((r) => {
          const x = pad + dates.indexOf(r.date) * xStep;
          const y = height - pad - (r.performance / 100) * (height - pad * 2);
          return `${x},${y}`;
        })
        .join(' ');
      return `<polyline points="${points}" fill="none" stroke="${colors[i % colors.length]}" stroke-width="2" />`;
    })
    .join('\n');

  const legend = pages
    .map((page, i) => `<span style="color:${colors[i % colors.length]}">&#9679;</span> ${escapeHtml(page)}`)
    .join('&nbsp;&nbsp;');

  return `
    <svg viewBox="0 0 ${width} ${height}" style="width:100%;max-width:${width}px;background:#111;border-radius:8px">
      <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="#444" />
      <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}" stroke="#444" />
      ${lines}
    </svg>
    <div style="margin-top:8px;font-size:13px">${legend}</div>`;
}

// Meta pixel vs Shopify orders cross-check (scripts/meta-shopify-crosscheck.mjs).
function renderTrackingTile(t) {
  const r = t.latest?.result;
  const [cls, label, detail] =
    r === 'match'
      ? ['status-pass', 'MATCH', `Meta and Shopify agreed for ${escapeHtml(t.latest.forDate)}`]
      : r === 'mismatch'
        ? ['status-fail', 'MISMATCH', `Shopify had orders on ${escapeHtml(t.latest.forDate)} but Meta saw no purchases`]
        : r === 'error'
          ? ['status-warn', 'CHECK FAILED', `Couldn't run the cross-check for ${escapeHtml(t.latest.forDate)}`]
          : ['status-off', 'NOT CONNECTED', 'Cross-check not set up yet'];
  const record = t.daysChecked
    ? `<div class="stats">${t.matchStreakDays}-day match streak · ${t.daysMatched} of ${t.daysChecked} days checked matched</div>`
    : '';
  return `<span class="status ${cls}">${label}</span> &nbsp; ${detail}${record}`;
}

// Shopify sessions trend (indexed, never raw counts) with the change log as
// markers, so a jump can be lined up against what changed that week.
function renderSessions({ history, latest, weekOnWeek, baselineLabel }, changes) {
  if (!history.length) return '<p style="color:#999">Not connected yet.</p>';
  const width = 720,
    height = 220,
    pad = 30;
  const dates = history.map((r) => r.date);
  const xOf = (date) => pad + (dates.length > 1 ? (dates.indexOf(date) / (dates.length - 1)) * (width - pad * 2) : 0);
  const max = Math.max(100, ...history.map((r) => r.total)) * 1.1;
  const yOf = (v) => height - pad - (v / max) * (height - pad * 2);
  const series = [
    ['total', '#eeeeee', 'All visitors'],
    ['social', '#e07a3f', 'Social'],
    ['direct', '#3f7ae0', 'Direct'],
  ];

  const lines = series
    .map(([key, color]) => `<polyline points="${history.map((r) => `${xOf(r.date)},${yOf(r[key])}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2" />`)
    .join('\n');
  const botShading = history
    .filter((r) => r.botAdjusted)
    .map((r) => `<rect x="${xOf(r.date) - 3}" y="${pad}" width="6" height="${height - pad * 2}" fill="#3a321e" />`)
    .join('');
  const markers = changes
    .filter((c) => dates.includes(c.date))
    .map((c) => `<line x1="${xOf(c.date)}" y1="${pad}" x2="${xOf(c.date)}" y2="${height - pad}" stroke="#4ade80" stroke-dasharray="3,3"><title>${escapeHtml(`${c.date} · ${c.channel}: ${c.change}`)}</title></line>`)
    .join('');
  const legend = series.map(([, color, label]) => `<span style="color:${color}">&#9679;</span> ${label}`).join('&nbsp;&nbsp;');
  const wow = weekOnWeek == null ? '' : ` · ${weekOnWeek >= 0 ? '+' : ''}${Math.round(weekOnWeek * 100)}% vs a week earlier`;
  const changeList = changes.length
    ? `<ul class="changes">${changes.map((c) => `<li>${escapeHtml(c.date)} · ${escapeHtml(c.channel)}: ${escapeHtml(c.change)}</li>`).join('')}</ul>`
    : '';

  return `
    <div class="stats" style="margin:0 0 10px">Latest 7-day average: <b style="color:#eee">${latest.total}</b> (${baselineLabel})${wow}</div>
    <svg viewBox="0 0 ${width} ${height}" style="width:100%;max-width:${width}px;background:#111;border-radius:8px">
      ${botShading}
      <line x1="${pad}" y1="${yOf(100)}" x2="${width - pad}" y2="${yOf(100)}" stroke="#333" stroke-dasharray="2,4" />
      <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="#444" />
      <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}" stroke="#444" />
      ${markers}
      ${lines}
    </svg>
    <div style="margin-top:8px;font-size:13px">${legend} &nbsp;&nbsp;<span style="color:#4ade80">┆</span> change made &nbsp;&nbsp;<span style="color:#fbbf24">▮</span> QA bot traffic removed</div>
    ${changeList}`;
}

// Weak spots: advisory checks that don't fail the run. Open ones first,
// oldest first, so long-standing issues stay at the top.
function renderAdvisories(adv) {
  if (!adv || !adv.items.length) return '<p style="color:#999">No advisory checks in this run.</p>';
  const rank = (a) => (a.ok === false ? 0 : a.ok === null ? 1 : 2);
  const items = [...adv.items].sort((a, b) => rank(a) - rank(b) || String(a.openSince).localeCompare(String(b.openSince)));
  const rows = items
    .map((a) => {
      const [cls, label] = a.ok === false ? ['status-warn', 'WEAK'] : a.ok === null ? ['status-off', 'N/A'] : ['status-pass', 'OK'];
      return `<tr><td><span class="status ${cls}">${label}</span></td><td>${escapeHtml(a.id)}</td><td style="color:#999">${escapeHtml(a.detail)}${a.openSince ? ` · open since ${escapeHtml(a.openSince)}` : ''}</td></tr>`;
    })
    .join('');
  return `<div class="stats" style="margin:0 0 8px">${adv.open} open · ${adv.passing} fine. These never fail the run.</div>
    <table style="max-width:900px">${rows}</table>`;
}

export function render(data) {
  const run = data.latestRun || { passed: 0, failed: 0, skipped: 0, checks: [] };
  const failures = run.checks.filter((c) => c.status === 'failed');
  const s = data.stats;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Rabiun QA Dashboard</title>
<style>
  body { font-family: -apple-system, Segoe UI, sans-serif; background:#0b0b0c; color:#eee; margin:0; padding:24px; }
  h1 { font-size:20px; margin-bottom:4px; }
  .subtitle { color:#999; font-size:13px; margin-bottom:24px; }
  .status { display:inline-block; padding:4px 10px; border-radius:6px; font-weight:600; font-size:13px; }
  .status-pass { background:#1e3a2a; color:#4ade80; }
  .status-fail { background:#3a1e1e; color:#f87171; }
  .status-warn { background:#3a321e; color:#fbbf24; }
  .status-off { background:#222; color:#999; }
  .stats { color:#999; font-size:13px; margin-top:10px; }
  section { margin-bottom:32px; }
  table { border-collapse: collapse; width:100%; max-width:600px; font-size:13px; }
  th, td { text-align:left; padding:6px 10px; border-bottom:1px solid #222; }
  .row-fail td { color:#f87171; }
  .row-pass td { color:#ccc; }
  ul.failures { font-size:13px; color:#f87171; }
  ul.changes { font-size:13px; color:#ccc; padding-left:18px; }
</style>
</head>
<body>
  <h1>Rabiun QA Dashboard</h1>
  <div class="subtitle">Last run: ${escapeHtml(data.generatedAt)}</div>

  <section>
    <span class="status ${run.failed > 0 ? 'status-fail' : 'status-pass'}">
      ${run.failed > 0 ? `${run.failed} FAILING` : 'ALL PASSING'}
    </span>
    &nbsp; ${run.passed} passed, ${run.failed} failed, ${run.skipped} skipped
    ${failures.length ? `<ul class="failures">${failures.map((f) => `<li>${escapeHtml(f.name)} (${escapeHtml(f.project)})</li>`).join('')}</ul>` : ''}
    <div class="stats">
      ${s.totalRuns} runs over ${s.daysMonitored} days · ${s.totalChecksRun} checks run ·
      clean-run streak ${s.currentCleanStreak} (best ${s.longestCleanStreak}) ·
      ${pct(s.cleanRunRate30)} of the last 30 runs fully green
    </div>
  </section>

  <section>
    <h2 style="font-size:15px">Weak spots (advisory checks)</h2>
    ${renderAdvisories(data.advisories)}
  </section>

  <section>
    <h2 style="font-size:15px">Store visitors trend (Shopify sessions, 7-day average)</h2>
    ${renderSessions(data.sessions, data.changes)}
  </section>

  <section>
    <h2 style="font-size:15px">Tracking integrity (Meta pixel vs Shopify orders, daily)</h2>
    ${renderTrackingTile(data.tracking)}
  </section>

  <section>
    <h2 style="font-size:15px">Pass/fail history (last 30 runs)</h2>
    ${renderRunHistoryTable(data.runHistory)}
  </section>

  <section>
    <h2 style="font-size:15px">Lighthouse performance trend (mobile, Performance score)</h2>
    ${data.lighthouse.history.length ? renderLighthouseChart(data.lighthouse) : '<p style="color:#999">No Lighthouse data yet.</p>'}
  </section>
</body>
</html>`;
}
