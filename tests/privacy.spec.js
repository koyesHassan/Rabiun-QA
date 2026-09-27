// @ts-check
// Privacy and tracking plumbing, the other half of pixel.spec.js:
// - shoppers who haven't accepted cookies aren't tracked (UK law, and it keeps
//   the store in good standing with Meta and Google),
// - Microsoft Clarity is installed, so heatmaps and recordings keep coming in,
// - public pages show no email address except the shop's own.
const { test, expect } = require('@playwright/test');
const { PRODUCT_PAGES } = require('./pages');
const { useUkMarket, blockAnalyticsBeacons, consentRequired } = require('./helpers');

// Cookies that only marketing/analytics tools set. Seeing any of these before
// a shopper clicks Accept means a tag is ignoring the consent banner.
// _fbp Meta, _ga GA4, _gcl Google Ads, _pin Pinterest, _ttp TikTok,
// _clck/_clsk Clarity, _shopify_marketing/_shopify_analytics Shopify.
const TRACKING_COOKIES = /^(_fbp|_fbc|_ga|_gcl|_pin|_ttp|_clck|_clsk|_shopify_marketing|_shopify_analytics)/;

// Let the Clarity script itself load but keep its uploads blocked, so the
// test can see Clarity is installed without CI runs becoming recordings.
// Routes registered later win, so this overrides blockAnalyticsBeacons for
// the tag URL only.
async function allowClarityTag(page) {
  await page.route(/www\.clarity\.ms\/(tag|s)\//, (route) => route.continue());
}

test.beforeEach(async ({ page }) => {
  await useUkMarket(page);
  await blockAnalyticsBeacons(page);
});

test('Cookie consent — no tracking before a shopper accepts', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'Consent behaviour is the same on every device');
  await allowClarityTag(page);
  const pixelCalls = [];
  await page.route(/facebook\.com\/tr/, (route) => {
    pixelCalls.push(route.request().method());
    route.abort('blockedbyclient').catch(() => {});
  });

  await page.goto(PRODUCT_PAGES[0].path, { waitUntil: 'domcontentloaded' });
  // Shopify decides by IP whether a banner is needed. If this runner's region
  // doesn't get one, tags may legitimately fire straight away.
  test.skip(!(await consentRequired(page)), "No consent banner for this runner's region");
  await page.waitForTimeout(6000);

  const cookies = (await page.context().cookies()).map((c) => c.name).filter((n) => TRACKING_COOKIES.test(n));
  expect(cookies, `Tracking cookies set before consent: ${cookies.join(', ')}`).toEqual([]);
  expect(pixelCalls.length, 'Meta pixel fired before the shopper accepted cookies').toBe(0);
});

test('Microsoft Clarity — installed and loading', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'Install check only needs one device');
  await allowClarityTag(page);
  const tag = page.waitForResponse(/www\.clarity\.ms\/tag\//, { timeout: 15_000 }).catch(() => null);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const res = await tag;
  expect(res, 'Clarity tag was never requested — has the Clarity app been removed?').toBeTruthy();
  expect(res?.status(), `Clarity tag returned HTTP ${res?.status()}`).toBeLessThan(400);
  await expect
    .poll(() => page.evaluate(() => typeof (/** @type {any} */ (window).clarity)), {
      message: 'Clarity script loaded but window.clarity never appeared',
      timeout: 10_000,
    })
    .toBe('function');
});

// The shop's own contact address is meant to be public. Anything else that
// looks like an email address on a public page is probably a leak (a personal
// address in a policy template, a theme comment, an app's settings). Only the
// allowed patterns go in this file, so the check never has to name the
// address it's guarding against.
const ALLOWED_EMAILS = [/^rabiun[\w.+-]*@/i, /@(shopify\.com|example\.com)$/i];
const EMAIL = /[a-z0-9._%+-]+(?:@|%40|&#0*64;|&#x0*40;|\\u0040)[a-z0-9.-]+\.[a-z]{2,}/gi;

test('Public pages — no email address except the shop’s own', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'Page source is the same on every device');
  const paths = [
    '/',
    '/pages/contact',
    '/collections/all',
    '/policies/contact-information',
    '/policies/privacy-policy',
    '/policies/refund-policy',
    '/policies/shipping-policy',
    '/policies/terms-of-service',
    ...PRODUCT_PAGES.map((p) => p.path),
  ];
  const unexpected = new Set();
  for (const path of paths) {
    const res = await page.request.get(path);
    if (!res.ok()) continue; // missing policy pages are site-health's job
    const html = await res.text();
    for (const raw of html.match(EMAIL) || []) {
      const email = raw.replace(/%40|&#0*64;|&#x0*40;|\\u0040/i, '@');
      if (!ALLOWED_EMAILS.some((re) => re.test(email))) unexpected.add(path);
    }
  }
  // Report the page, never the address: this output is public.
  expect([...unexpected], `Unexpected email address found on: ${[...unexpected].join(', ')}`).toEqual([]);
});
