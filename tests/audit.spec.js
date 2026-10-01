// @ts-check
// Advisories: weak spots worth fixing that aren't breakage. These tests never
// fail the run. Each one records a verdict as an `advisory` annotation, which
// scripts/dashboard/data.mjs turns into the dashboard's "Weak spots" list and
// data/advisory-history.csv (so it can show how long each has been open).
//
// The annotation text is public (dashboard + Actions logs). Only put QA facts
// in `detail`: page names, counts, sizes. Never URLs with query strings,
// tracking IDs or anything read from a private API.
const { test } = require('@playwright/test');
const { PRODUCT_PAGES, OTHER_PAGES } = require('./pages');
const { useUkMarket, addToCartButton, blockAnalyticsBeacons, setConsent } = require('./helpers');

function advise(id, ok, detail) {
  test.info().annotations.push({ type: 'advisory', description: JSON.stringify({ id, ok, detail }) });
}

// Run a check; if the check itself breaks (page down, theme changed), record
// that instead of failing. Real breakage is site-health's and journey's job.
async function check(id, fn) {
  try {
    const [ok, detail] = await fn();
    advise(id, ok, detail);
  } catch (err) {
    advise(id, null, `Could not check: ${String(err && err.message).split('\n')[0].slice(0, 120)}`);
  }
}

const desktopOnly = (testInfo) =>
  test.skip(testInfo.project.name !== 'desktop-chrome', 'Page-source check, same on every device');
const mobileOnly = (testInfo) => test.skip(testInfo.project.name !== 'mobile', 'Mobile-only check');

test.beforeEach(async ({ page }) => {
  await useUkMarket(page);
  await blockAnalyticsBeacons(page);
});

// Google shows price, stock and reviews under a product in search results only
// if the page has Product structured data. The old theme had it; the Sept 2026
// redesign's product template only outputs Organization.
test('Advisory — Product structured data for Google', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  for (const p of PRODUCT_PAGES) {
    await check(`Product structured data — ${p.name}`, async () => {
      const html = await (await page.request.get(p.path)).text();
      const blocks = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
      const types = [];
      let hasOffer = false;
      for (const b of blocks) {
        try {
          for (const item of [].concat(JSON.parse(b))) {
            const t = [].concat(item['@type'] || []);
            types.push(...t);
            if (t.includes('Product') || t.includes('ProductGroup')) hasOffer = Boolean(item.offers || item.hasVariant);
          }
        } catch {
          types.push('(invalid JSON)');
        }
      }
      const ok = types.some((t) => t === 'Product' || t === 'ProductGroup') && hasOffer;
      return [ok, ok ? 'Product with offers' : `No Product schema with price/stock (found: ${types.join(', ') || 'none'})`];
    });
  }
});

test('Advisory — meta descriptions', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  await check('Meta descriptions — key pages', async () => {
    const missing = [];
    for (const p of [...OTHER_PAGES, ...PRODUCT_PAGES]) {
      if (p.path.startsWith('/cart')) continue;
      const html = await (await page.request.get(p.path)).text();
      const m = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i);
      if (!m || !m[1].trim()) missing.push(p.name);
    }
    return [missing.length === 0, missing.length ? `Missing on: ${missing.join(', ')}` : 'All present'];
  });
});

// Alt text is how Google Images and screen readers know what a photo shows.
test('Advisory — image alt text', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  for (const p of PRODUCT_PAGES) {
    await page.goto(p.path, { waitUntil: 'domcontentloaded' });
    await check(`Image alt text — ${p.name}`, async () => {
      const { total, missing } = await page.evaluate(() => {
        const imgs = [...document.querySelectorAll('main img')];
        return { total: imgs.length, missing: imgs.filter((i) => !(i.getAttribute('alt') || '').trim()).length };
      });
      return [missing === 0, `${missing} of ${total} images have no alt text`];
    });
  }
});

// Ads append utm_* (and Meta adds fbclid). If a redirect drops them, the
// visit shows up as "direct" in Shopify and ad reporting can't credit it.
test('Advisory — ad tracking tags survive landing', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  for (const path of ['/', PRODUCT_PAGES[0].path, '/collections/all']) {
    const name = path === '/' ? 'Homepage' : path === '/collections/all' ? 'Shop all' : PRODUCT_PAGES[0].name;
    await check(`UTM tags kept on landing — ${name}`, async () => {
      await page.goto(`${path}?utm_source=qa-check&utm_medium=qa&utm_campaign=qa-check`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      const kept = new URL(page.url()).searchParams.get('utm_campaign') === 'qa-check';
      return [kept, kept ? 'Kept' : 'Dropped by a redirect or script'];
    });
  }
});

test('Advisory — JavaScript errors', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  for (const p of [OTHER_PAGES[0], ...PRODUCT_PAGES]) {
    const errors = [];
    // Skip "Failed to fetch" errors: those are scripts reacting to the
    // analytics beacons this suite blocks, not bugs a shopper would hit.
    const onError = (err) => {
      if (!/failed to fetch|network failure/i.test(err.message)) errors.push(err.message);
    };
    page.on('pageerror', onError);
    await page.goto(p.path, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    page.off('pageerror', onError);
    // Count only: error messages can include URLs and IDs.
    advise(`JavaScript errors — ${p.name}`, errors.length === 0, `${errors.length} uncaught error(s) on load`);
  }
});

// Most ad traffic is on phones. If "Add to bag" is below the first screen,
// shoppers have to scroll before they can buy.
test('Advisory — Add to bag on the first mobile screen', async ({ page }, testInfo) => {
  mobileOnly(testInfo);
  for (const p of PRODUCT_PAGES) {
    await page.goto(p.path, { waitUntil: 'domcontentloaded' });
    await setConsent(page, false);
    await check(`Add to bag without scrolling (mobile) — ${p.name}`, async () => {
      const button = await addToCartButton(page).resolve();
      const box = await button.boundingBox();
      const vh = page.viewportSize()?.height || 0;
      if (!box) return [false, 'Button not rendered'];
      const ok = box.y + box.height <= vh;
      return [ok, ok ? 'Visible on load' : `Bottom edge is ${Math.round(box.y + box.height - vh)}px below the first screen`];
    });
  }
});

// Ad clicks land cold on mobile data. A heavy first load is the classic
// reason paid visitors bounce before the page shows anything.
test('Advisory — mobile page weight', async ({ page }, testInfo) => {
  mobileOnly(testInfo);
  for (const p of [OTHER_PAGES[0], PRODUCT_PAGES[0]]) {
    await page.goto(p.path, { waitUntil: 'load' }).catch(() => {});
    await page.waitForTimeout(3000);
    await check(`Page weight (mobile) — ${p.name}`, async () => {
      const bytes = await page.evaluate(() =>
        performance
          .getEntriesByType('navigation')
          .concat(performance.getEntriesByType('resource'))
          .reduce((sum, e) => sum + (/** @type {PerformanceResourceTiming} */ (e).transferSize || 0), 0)
      );
      const mb = bytes / 1024 / 1024;
      return [mb <= 3, `${mb.toFixed(1)} MB transferred in the first few seconds (aim: under 3 MB)`];
    });
  }
});

// What a dead link (an old ad, a deleted product) does. The TinySEO app turns
// any 404 that gets a few hits into a permanent redirect to the homepage. That
// keeps visitors on the site, but Google treats "everything redirects home" as
// a soft 404, and an ad pointing at a removed product lands on the homepage
// with no explanation. Always the same made-up URL: a new one each run would
// leave a new junk redirect in Shopify admin every day.
test('Advisory — missing pages', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  await check('Missing pages return a real 404', async () => {
    const res = await page.goto('/products/qa-check-this-page-does-not-exist', { waitUntil: 'domcontentloaded' });
    const landed = new URL(page.url()).pathname;
    if (res?.status() === 404) return [true, 'Returns 404'];
    return [false, `Redirects to ${landed === '/' ? 'the homepage' : landed} (HTTP ${res?.status()}) instead of a 404`];
  });
});
