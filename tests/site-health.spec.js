// @ts-check
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { PRODUCT_PAGES, OTHER_PAGES, REDIRECT_CHECKS } = require('./pages');
const { useUkMarket, addToCartButton, blockAnalyticsBeacons, setConsent } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await useUkMarket(page);
  await blockAnalyticsBeacons(page);
});

// ---- Page loads + broken images + SEO basics, for every page in the list ----
for (const p of [...PRODUCT_PAGES, ...OTHER_PAGES]) {
  test(`${p.name} — loads, no broken images, SEO basics present`, async ({ page }) => {
    const failedRequests = [];
    const brokenImages = [];
    // Only count failures that would actually break the page for a customer:
    // the document itself, scripts, styles, images and fonts served from the
    // shop or Shopify's CDN. Analytics beacons (Shopify monorail, Google
    // Merchant Center, /api/collect), Shop Pay prefetches and blob: worker
    // URLs get aborted routinely when a page settles or unloads — run #3
    // flagged those on every page and none of them are real breakage.
    const CRITICAL_TYPES = new Set(['document', 'script', 'stylesheet', 'image', 'font']);
    page.on('requestfailed', (req) => {
      const url = req.url();
      const errorText = req.failure()?.errorText || '';
      if (!CRITICAL_TYPES.has(req.resourceType())) return;
      if (errorText === 'net::ERR_ABORTED') return;
      if (url.startsWith('blob:')) return;
      if (!/rabiun\.com|cdn\.shopify\.com|shopifycdn\.com/.test(url)) return;
      failedRequests.push(`${errorText} ${url}`);
    });
    // Broken images = image requests the CDN answered with an error. This is
    // the definitive check; run #1 used <img>.naturalWidth === 0, which also
    // flags lazy-loaded images that simply haven't been scrolled into view yet.
    page.on('response', (res) => {
      if (res.request().resourceType() === 'image' && res.status() >= 400) {
        brokenImages.push(`${res.status()} ${res.url()}`);
      }
    });

    // domcontentloaded rather than load: the full `load` event waits on every
    // third-party script and can hang for a long time from a US datacentre
    // (the FAQ page took the whole 45s in run #3). The checks below only need
    // the DOM, plus a short settle for images.
    const response = await page.goto(p.path, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    expect(response, `${p.name} should return a response`).toBeTruthy();
    expect(
      response.status(),
      `${p.name} (${p.path}) returned HTTP ${response.status()}`
    ).toBeLessThan(400);
    await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => {});

    // Give lazy images a chance to request by scrolling the page once. Then a
    // short fixed wait — NOT networkidle: pixels and analytics on a Shopify
    // page keep chattering, so networkidle never arrives and run #2 burned
    // the whole test timeout waiting for it.
    await page.evaluate(async () => {
      const max = Math.min(document.body.scrollHeight, 12000);
      for (let y = 0; y < max; y += 800) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 80));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(2500);

    expect(brokenImages, `Broken images on ${p.name}: ${brokenImages.join(', ')}`).toEqual([]);

    // SEO basics
    const title = await page.title();
    expect(title.trim().length, `${p.name} has an empty <title>`).toBeGreaterThan(0);

    // Shopify's /cart page has no meta description by design — don't alert on it.
    if (!p.path.startsWith('/cart') && !p.metaDescriptionOptional) {
      const metaDescription = await page
        .locator('meta[name="description"]')
        .getAttribute('content')
        .catch(() => null);
      expect(
        metaDescription && metaDescription.trim().length > 0,
        `${p.name} is missing a meta description`
      ).toBeTruthy();
    }

    if (PRODUCT_PAGES.includes(p)) {
      const ldJsonCount = await page.locator('script[type="application/ld+json"]').count();
      expect(ldJsonCount, `${p.name} has no structured data (JSON-LD) script tag`).toBeGreaterThan(0);
    }

    expect(failedRequests, `${p.name} had failed network requests: ${failedRequests.join(', ')}`).toEqual([]);
  });
}

// ---- Product page specifics: price + key copy present, add-to-cart works ----
for (const p of PRODUCT_PAGES) {
  test(`${p.name} — price and add-to-cart present and working`, async ({ page }) => {
    await page.goto(p.path, { waitUntil: 'load' });
    // Decline cookies: the banner covers the bottom of the screen on mobile.
    await setConsent(page, false);

    // Price: Shopify's standard og:price meta tags, not a theme CSS class.
    const ogPrice = await page.locator('meta[property="og:price:amount"]').getAttribute('content').catch(() => null);
    const ogCurrency = await page.locator('meta[property="og:price:currency"]').getAttribute('content').catch(() => null);
    expect(ogPrice, `${p.name} is missing the og:price:amount meta tag entirely`).toBeTruthy();
    expect(ogCurrency, `${p.name}: expected GBP pricing but page served ${ogCurrency} — UK market cookie not applied?`).toBe('GBP');
    expect(parseFloat(ogPrice || '0'), `${p.name} price looks wrong: "${ogPrice}"`).toBeGreaterThan(0);
    if (p.expectPriceContains) {
      expect(ogPrice, `${p.name} price changed — expected it to contain "${p.expectPriceContains}"`).toContain(
        p.expectPriceContains
      );
    }

    const button = await addToCartButton(page).resolve();
    await expect(button, `${p.name} has no visible "Add to cart" / "Add to bag" button`).toBeVisible();
    await expect(button, `${p.name} add-to-cart button is disabled (out of stock / bug)`).toBeEnabled();
    await button.scrollIntoViewIfNeeded();
    await button.click();

    // Confirm the cart actually registered the item via Shopify's cart.js —
    // the most theme-independent signal there is.
    await page.waitForTimeout(1500);
    const cartResponse = await page.request.get('/cart.js');
    const cartJson = await cartResponse.json().catch(() => ({ item_count: 0 }));
    expect(
      cartJson.item_count,
      `${p.name}: cart did not register an item after clicking Add to cart (cart.js item_count=${cartJson.item_count})`
    ).toBeGreaterThan(0);

    await page.request.post('/cart/clear.js').catch(() => {});
  });
}

// ---- Redirects ----
for (const r of REDIRECT_CHECKS) {
  test(`Redirect — ${r.name}`, async ({ page }) => {
    const response = await page.goto(r.from, { waitUntil: 'load' });
    expect(response.status(), `${r.name}: unexpected status`).toBeLessThan(400);
    expect(page.url(), `${r.name}: did not land on the expected page`).toContain(r.expectPathContains);
  });
}

// ---- Mobile layout: screenshot for visual-diff tracking (mobile project only) ----
for (const p of PRODUCT_PAGES) {
  test(`${p.name} — mobile layout screenshot`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'Screenshot only needed once, on the mobile project');
    await page.goto(p.path, { waitUntil: 'load' });
    await setConsent(page, false);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1500);

    // Rolling baseline: compare against the previous run's screenshot, then
    // save today's as the new baseline. A regression fails the day it appears;
    // an intended change (new photo, new theme) fails once, then becomes the
    // baseline. Baselines live in data/snapshots/, which the workflow restores
    // from and saves to the qa-data branch — without that, every run would
    // start with no baseline and never compare.
    // "v2" = the Sept 2026 redesign. A new name starts a fresh baseline
    // instead of diffing the new theme against the old one.
    const snapshotName = `v2${p.path.replace(/\//g, '_')}.png`;
    const baselinePath = testInfo.snapshotPath(snapshotName);
    const hadBaseline = fs.existsSync(baselinePath);
    // Screenshot only the product info block (title, price, sizes, add to bag,
    // info tabs): the layout that matters for a sale. The full page isn't
    // stable: the photo gallery and the "Worn by" customer-photo carousel
    // rotate and change as new photos are added. The block is found as the
    // closest ancestor of the buy button that also holds the <h1>, so it
    // doesn't depend on the theme's class names (the old theme's did, and
    // broke in the Sept 2026 redesign).
    const buy = await addToCartButton(page).resolve();
    const productSection = buy.locator('xpath=ancestor::*[.//h1][1]');
    await expect(productSection, `${p.name}: product info block not found`).toBeVisible();
    // Blank out the parts that change on their own: the delivery estimate
    // moves every day, and the "Worn by you" strip grows with each customer
    // photo. Everything else in the block should only change when the site does.
    const mask = [
      productSection.getByText(/estimated delivery/i),
      productSection.locator('section, div').filter({ hasText: /worn by/i }),
    ];
    // Wait for every image in the block (e.g. the "Also in" thumbnail, added
    // late Sept). Under a full parallel run a lazy image could still be blank
    // when the shot was taken, so the baseline and the next run disagreed.
    await productSection.evaluate((el) =>
      Promise.all(
        [...el.querySelectorAll('img')].map((img) => {
          img.loading = 'eager';
          if (img.complete && img.naturalWidth) return null;
          return new Promise((resolve) => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
            setTimeout(resolve, 8000);
          });
        })
      )
    );
    try {
      if (hadBaseline) {
        await expect(productSection).toHaveScreenshot(snapshotName, { maxDiffPixelRatio: 0.01, mask });
      } else {
        testInfo.annotations.push({ type: 'baseline', description: `No baseline yet; recording ${snapshotName}` });
      }
    } finally {
      // scale: 'css' matches toHaveScreenshot (device scale would be 3x on iPhone).
      const shot = await productSection.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css', mask });
      await testInfo.attach('mobile-screenshot', { body: shot, contentType: 'image/png' });
      fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
      fs.writeFileSync(baselinePath, shot);
    }
  });
}
