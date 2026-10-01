// The dashboard's data layer. Everything a dashboard might show is worked out
// here and handed to a theme as one plain object (also published as
// dashboard/data.json). Themes only draw it, so a new look never has to touch
// the numbers, and the numbers never have to know about the look.
//
// Public repo: only QA facts go in here (check names, pass/fail, timings,
// Lighthouse scores). Never test stdout or annotations, which can carry
// tracking IDs, with one exception: `advisory` annotations from
// tests/audit.spec.js, whose text is written to be public (see that file). From the private-API cross-check, only its one-word result
// (match / mismatch / error / skipped), never counts. Shopify sessions only
// as an index (baseline = 100), never raw counts.
import fs from 'node:fs';
import path from 'node:path';
import { readCsv, appendCsv } from './csv.mjs';

export const SCHEMA_VERSION = 1;

const ROOT = process.cwd();
const RESULTS_JSON = path.join(ROOT, 'test-results', 'results.json');
const RUN_HISTORY_CSV = path.join(ROOT, 'data', 'run-history.csv');
const CHECK_HISTORY_CSV = path.join(ROOT, 'data', 'check-history.csv');
const LIGHTHOUSE_CSV = path.join(ROOT, 'data', 'lighthouse-history.csv');
const TRACKING_CSV = path.join(ROOT, 'data', 'tracking-history.csv');
const ADVISORY_CSV = path.join(ROOT, 'data', 'advisory-history.csv');
// Both live on main in insights/, updated by PR (not by CI). The sessions
// trend is imported by hand (see scripts/shopify-sessions.mjs); changes.csv
// is the public list of site/social changes shown as chart markers.
const SESSIONS_CSV = path.join(ROOT, 'insights', 'sessions-trend.csv');
const CHANGES_CSV = path.join(ROOT, 'insights', 'changes.csv');

// New columns only ever go on the end (see appendCsv).
const RUN_COLUMNS = ['date', 'passed', 'failed', 'skipped', 'time', 'flaky', 'duration_ms'];
const CHECK_COLUMNS = ['date', 'time', 'check', 'project', 'status', 'retries', 'duration_ms'];
const ADVISORY_COLUMNS = ['date', 'time', 'advisory', 'project', 'ok', 'detail'];

// Groups checks by what they protect. Handy for any theme that wants zones,
// classes or categories rather than one long list.
function categoryOf(file, title) {
  if (file.includes('audit')) return 'advisory';
  if (file.includes('pixel') || /Clarity|consent/i.test(title)) return 'tracking';
  if (file.includes('privacy')) return 'privacy';
  if (file.includes('journey')) return 'shopping';
  if (/^Redirect/.test(title)) return 'redirects';
  if (/mobile layout/.test(title)) return 'layout';
  if (/add-to-cart/.test(title)) return 'shopping';
  return 'health';
}

function readThisRun() {
  if (!fs.existsSync(RESULTS_JSON)) return null;
  const raw = JSON.parse(fs.readFileSync(RESULTS_JSON, 'utf8'));
  const started = raw.stats?.startTime ? new Date(raw.stats.startTime) : new Date();
  const checks = [];
  const advisories = [];

  function walk(suite, file) {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        const results = test.results || [];
        const last = results[results.length - 1];
        // Playwright's per-test verdict: expected / unexpected / flaky / skipped.
        const status =
          test.status === 'skipped' || last?.status === 'skipped'
            ? 'skipped'
            : test.status === 'flaky'
              ? 'flaky'
              : last?.status === 'passed'
                ? 'passed'
                : 'failed';
        checks.push({
          name: spec.title,
          project: test.projectName,
          category: categoryOf(file, spec.title),
          status,
          retries: Math.max(0, results.length - 1),
          durationMs: Math.round(results.reduce((sum, r) => sum + (r.duration || 0), 0)),
        });
        for (const a of last?.annotations || test.annotations || []) {
          if (a.type !== 'advisory') continue;
          try {
            const { id, ok, detail } = JSON.parse(a.description);
            advisories.push({ id: String(id), project: test.projectName, ok: ok === null ? null : Boolean(ok), detail: String(detail || '') });
          } catch {}
        }
      }
    }
    for (const s of suite.suites || []) walk(s, file);
  }
  for (const s of raw.suites || []) walk(s, s.file || '');

  const count = (st) => checks.filter((c) => c.status === st).length;
  return {
    date: started.toISOString().slice(0, 10),
    time: started.toISOString().slice(11, 19),
    // Flaky checks passed on retry, so they count as passed (as they always have).
    passed: count('passed') + count('flaky'),
    failed: count('failed'),
    skipped: count('skipped'),
    flaky: count('flaky'),
    durationMs: Math.round(raw.stats?.duration || 0),
    checks,
    advisories,
  };
}

// Adds this run to data/*.csv. The workflow saves those back to qa-data.
function recordRun(run) {
  appendCsv(RUN_HISTORY_CSV, RUN_COLUMNS, [
    { ...run, duration_ms: run.durationMs },
  ]);
  appendCsv(
    CHECK_HISTORY_CSV,
    CHECK_COLUMNS,
    run.checks.map((c) => ({ date: run.date, time: run.time, check: c.name, project: c.project, status: c.status, retries: c.retries, duration_ms: c.durationMs }))
  );
  appendCsv(
    ADVISORY_CSV,
    ADVISORY_COLUMNS,
    run.advisories.map((a) => ({ date: run.date, time: run.time, advisory: a.id, project: a.project, ok: a.ok === null ? '' : a.ok ? 1 : 0, detail: a.detail }))
  );
}

// Weak spots from tests/audit.spec.js: today's verdicts, each with the date it
// has been open since (start of its current unbroken run of warnings), so a
// fix shows up as the warning disappearing and a regression as a fresh date.
function advisoryData(rows, latest) {
  const openSince = new Map();
  for (const r of rows) {
    const key = `${r.advisory}|${r.project}`;
    if (r.ok === '0') {
      if (!openSince.has(key)) openSince.set(key, r.date);
    } else if (r.ok === '1') openSince.delete(key);
  }
  const items = (latest || []).map((a) => ({ ...a, openSince: a.ok === false ? openSince.get(`${a.id}|${a.project}`) || null : null }));
  return {
    open: items.filter((a) => a.ok === false).length,
    passing: items.filter((a) => a.ok === true).length,
    items,
  };
}

const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

function streaks(runs) {
  let longest = 0,
    current = 0;
  for (const r of runs) {
    current = r.failed === 0 ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return { current, longest };
}

function checkStats(rows) {
  const byKey = new Map();
  for (const r of rows) {
    if (r.status === 'skipped') continue;
    const key = `${r.check}|${r.project}`;
    const s = byKey.get(key) || { name: r.check, project: r.project, runs: 0, failures: 0, flakes: 0, avgDurationMs: 0 };
    s.runs++;
    if (r.status === 'failed') s.failures++;
    if (r.status === 'flaky') s.flakes++;
    s.avgDurationMs += num(r.duration_ms) || 0;
    byKey.set(key, s);
  }
  return [...byKey.values()].map((s) => ({
    ...s,
    avgDurationMs: Math.round(s.avgDurationMs / s.runs),
    passRate: (s.runs - s.failures) / s.runs,
  }));
}

function lighthouseData(rows) {
  const history = rows.map((r) => ({
    date: r.date,
    page: r.page,
    performance: num(r.performance),
    seo: num(r.seo),
    accessibility: num(r.accessibility),
    bestPractices: num(r.best_practices),
    lcpMs: num(r.lcp_ms),
    cls: num(r.cls),
    tbtMs: num(r.tbt_ms),
  }));
  const pages = [...new Set(history.map((r) => r.page))];
  const latest = Object.fromEntries(
    pages.map((p) => [p, history.filter((r) => r.page === p && r.performance != null).at(-1) || null])
  );
  return { pages, latest, history };
}

// Meta vs Shopify cross-check. It runs several times a day for the same
// "yesterday", so each day is judged by its last real result — a later
// error or skip doesn't erase a match or mismatch already found.
function trackingData(rows) {
  const isReal = (result) => result === 'match' || result === 'mismatch';
  const byDay = new Map();
  for (const r of rows) {
    if (isReal(r.result) || !isReal(byDay.get(r.for_date))) byDay.set(r.for_date, r.result);
  }
  const days = [...byDay].map(([date, result]) => ({ date, result })).sort((a, b) => a.date.localeCompare(b.date));
  const checked = days.filter((d) => isReal(d.result));
  let matchStreakDays = 0;
  for (let i = days.length - 1; i >= 0 && days[i].result === 'match'; i--) matchStreakDays++;
  return {
    latest: rows.length ? { date: rows.at(-1).date, forDate: rows.at(-1).for_date, result: rows.at(-1).result } : null,
    daysChecked: checked.length,
    daysMatched: checked.filter((d) => d.result === 'match').length,
    matchStreakDays,
    history: days,
  };
}

// Sessions trend from scripts/shopify-sessions.mjs: 7-day rolling averages,
// indexed so the baseline month's daily average = 100.
function sessionsData(rows) {
  const history = rows.map((r) => ({
    date: r.date,
    total: num(r.total),
    direct: num(r.direct),
    social: num(r.social),
    search: num(r.search),
    botAdjusted: r.bot_adjusted === '1',
  }));
  const latest = history.at(-1) || null;
  const weekAgo = latest && history.find((r) => r.date === shiftDate(latest.date, -7));
  return {
    baselineLabel: 'Aug 2026 daily average = 100',
    latest,
    weekOnWeek: weekAgo?.total ? (latest.total - weekAgo.total) / weekAgo.total : null,
    history,
  };
}

function shiftDate(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function buildDashboardData({ record = true } = {}) {
  const thisRun = readThisRun();
  if (thisRun && record) recordRun(thisRun);

  const runs = readCsv(RUN_HISTORY_CSV).map((r) => ({
    date: r.date,
    time: r.time || null,
    passed: num(r.passed) ?? 0,
    failed: num(r.failed) ?? 0,
    skipped: num(r.skipped) ?? 0,
    flaky: num(r.flaky),
    durationMs: num(r.duration_ms),
  }));
  const last30 = runs.slice(-30);
  const { current, longest } = streaks(runs);

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    site: 'rabiun.com',
    latestRun: thisRun,
    stats: {
      totalRuns: runs.length,
      totalChecksRun: runs.reduce((sum, r) => sum + r.passed + r.failed, 0),
      firstRunDate: runs[0]?.date || null,
      daysMonitored: new Set(runs.map((r) => r.date)).size,
      cleanRunRate30: last30.length ? last30.filter((r) => r.failed === 0).length / last30.length : null,
      currentCleanStreak: current,
      longestCleanStreak: longest,
    },
    checks: checkStats(readCsv(CHECK_HISTORY_CSV)),
    runHistory: runs,
    lighthouse: lighthouseData(readCsv(LIGHTHOUSE_CSV)),
    tracking: trackingData(readCsv(TRACKING_CSV)),
    advisories: advisoryData(readCsv(ADVISORY_CSV), thisRun?.advisories),
    sessions: sessionsData(readCsv(SESSIONS_CSV)),
    changes: readCsv(CHANGES_CSV).filter((c) => c.date),
  };
}
