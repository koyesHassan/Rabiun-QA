// Runs Lighthouse against the homepage + 3 product pages, appends one row per
// page per day to data/lighthouse-history.csv (saved to the qa-data branch by
// the workflow), so scores are a time series, not a one-off number.
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = process.env.SITE_BASE_URL || 'https://rabiun.com';
const PAGES = [
  { name: 'homepage', path: '/' },
  { name: 'jeans', path: '/products/rabiun-heavyweight-selvedge-denim-forest-green-yellow-overdye' },
  { name: 'hat-green-leopard', path: '/products/rabiun-double-brim-painters-hat-green-and-leopard' },
  { name: 'hat-black-zebra', path: '/products/double-brim-painters-hat-black-and-zebra-print' },
  // Ad landing page for the Oct 2026 Meta carousel.
  { name: 'hats-collection', path: '/collections/hats' },
];

const CSV_PATH = path.join(process.cwd(), 'data', 'lighthouse-history.csv');
const CSV_HEADER = 'date,page,performance,seo,accessibility,best_practices,lcp_ms,cls,tbt_ms\n';

function ensureCsv() {
  fs.mkdirSync(path.dirname(CSV_PATH), { recursive: true });
  if (!fs.existsSync(CSV_PATH)) fs.writeFileSync(CSV_PATH, CSV_HEADER);
}

async function runLighthouseFor(url) {
  const chrome = await chromeLauncher.launch({
    chromePath: process.env.CHROME_PATH || undefined,
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'],
  });
  try {
    const result = await lighthouse(url, {
      port: chrome.port,
      output: 'json',
      onlyCategories: ['performance', 'seo', 'accessibility', 'best-practices'],
      formFactor: 'mobile',
      // Same self-declared bot tag as playwright.config.js, so Shopify can
      // label these visits as bots too.
      emulatedUserAgent: 'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse RabiunQA-bot/1.0 (+https://github.com/koyesHassan/Rabiun-QA)',
      // Same beacons tests/helpers.js blocks, so Lighthouse runs don't show
      // up as Shopify sessions or Meta events.
      blockedUrlPatterns: [
        '*/.well-known/shopify/monorail*',
        '*monorail-edge.shopifysvc.com*',
        '*/api/collect*',
        '*google-analytics.com*',
        '*analytics.google.com*',
        '*merchant-center-analytics.goog*',
        '*clarity.ms*',
        '*facebook.com/tr*',
        '*ct.pinterest.com*',
        '*googleadservices.com*',
        '*doubleclick.net*',
        '*analytics.tiktok.com*',
      ],
      screenEmulation: { mobile: true, width: 390, height: 844, deviceScaleFactor: 2, disabled: false },
    });
    return result.lhr;
  } finally {
    await chrome.kill();
  }
}

async function main() {
  ensureCsv();
  const today = new Date().toISOString().slice(0, 10);
  const rows = [];

  for (const p of PAGES) {
    const url = `${BASE_URL}${p.path}`;
    console.log(`Running Lighthouse for ${p.name} (${url})...`);
    try {
      const lhr = await runLighthouseFor(url);
      const score = (id) => Math.round((lhr.categories[id]?.score ?? 0) * 100);
      const audit = (id) => lhr.audits[id]?.numericValue ?? null;
      rows.push(
        [
          today,
          p.name,
          score('performance'),
          score('seo'),
          score('accessibility'),
          score('best-practices'),
          Math.round(audit('largest-contentful-paint') ?? 0),
          (audit('cumulative-layout-shift') ?? 0).toFixed(3),
          Math.round(audit('total-blocking-time') ?? 0),
        ].join(',')
      );
    } catch (err) {
      console.error(`Lighthouse failed for ${p.name}: ${err.message}`);
      rows.push([today, p.name, 'ERROR', 'ERROR', 'ERROR', 'ERROR', '', '', ''].join(','));
    }
  }

  fs.appendFileSync(CSV_PATH, rows.join('\n') + '\n');
  console.log(`Appended ${rows.length} rows to ${CSV_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
