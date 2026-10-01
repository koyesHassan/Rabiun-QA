// @ts-check
const { defineConfig, devices } = require('@playwright/test');

const BASE_URL = process.env.SITE_BASE_URL || 'https://rabiun.com';

// Test traffic says openly that it's a bot. Blocking analytics beacons stops
// tracking pixels, but Shopify still counted QA runs as sessions and
// add-to-carts server-side (~850 "direct US" sessions, 23 Sep - 1 Oct 2026),
// which skews conversion rates. A self-declared bot user agent gives Shopify's
// "human or bot" session label the strongest signal we can send. The mobile
// project keeps the iPhone user agent (so the theme serves its mobile layout)
// with the same tag on the end.
const BOT_TAG = 'RabiunQA-bot/1.0 (+https://github.com/koyesHassan/Rabiun-QA)';

module.exports = defineConfig({
  testDir: './tests',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0, // one retry in CI so a flaky network blip doesn't cry wolf
  outputDir: 'test-results/artifacts',
  // Screenshot baselines live under data/ so the workflow restores them from,
  // and saves them to, the qa-data branch along with the history CSVs.
  snapshotPathTemplate: 'data/snapshots/{testFileName}/{arg}{-projectName}{ext}',
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/results.json' }],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Never let a Shopify preview-theme cookie leak into a run: a stale preview
    // cookie can make an old or unpublished theme render on a plain rabiun.com
    // URL. Fresh context per test avoids that.
    storageState: undefined,
  },
  projects: [
    {
      name: 'desktop-chrome',
      use: { ...devices['Desktop Chrome'], userAgent: `Mozilla/5.0 (compatible; ${BOT_TAG})` },
    },
    {
      // iPhone viewport/UA, but run in Chromium. The iPhone device preset
      // defaults to WebKit, which the workflow doesn't install — every mobile
      // test in run #1 died on "Executable doesn't exist ... webkit". Chromium
      // with mobile emulation is what we need for layout checks anyway.
      name: 'mobile',
      use: { ...devices['iPhone 13'], browserName: 'chromium', userAgent: `${devices['iPhone 13'].userAgent} ${BOT_TAG}` },
    },
  ],
});
