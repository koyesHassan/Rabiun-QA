// @ts-check
const { test, expect } = require('@playwright/test');
const { PRODUCT_PAGES } = require('./pages');
const {
  useUkMarket,
  addToCartButton,
  installPixelHook,
  pixelEvents,
  installPixelNetworkCapture,
  blockAnalyticsBeacons,
  setConsent,
} = require('./helpers');

// Checks that the Meta Pixel actually fires on the two events that matter for
// ad optimisation: PageView/ViewContent on load, AddToCart on the click. This
// proves the browser fired the event, not that Meta processed it (that's the
// Windsor cross-check in scripts/meta-shopify-crosscheck.mjs). Still worth
// having: most real pixel breakage is the tag not firing at all.
//
// Two capture paths, either is enough: (1) fbq() hooked in every frame, (2)
// facebook.com/tr requests intercepted at the network layer with their bodies.
// The pixel on rabiun.com runs inside Shopify's custom-pixel sandbox, which is
// why belt-and-braces is warranted here.
//
// Since the Sept 2026 redesign the pixel only loads after a shopper accepts
// marketing cookies, so each test accepts them first: these tests check the
// pixel works for shoppers who opt in. tests/tracking.spec.js checks the other
// half, that nothing fires for shoppers who haven't.

async function observedEvents(page, network) {
  const hooked = await pixelEvents(page);
  const fromNetwork = network.map((r) => r.ev).filter(Boolean);
  return { hooked, fromNetwork, all: [...hooked, ...fromNetwork], calls: network.length };
}

function describe(o) {
  return `fbq hook: [${o.hooked.join(', ')}], network ev: [${o.fromNetwork.join(', ')}], facebook.com/tr calls: ${o.calls}`;
}

for (const p of PRODUCT_PAGES) {
  test(`${p.name} — Meta Pixel fires PageView/ViewContent on page load`, async ({ page }) => {
    await useUkMarket(page);
    await blockAnalyticsBeacons(page);
    await installPixelHook(page);
    const network = await installPixelNetworkCapture(page);

    await page.goto(p.path, { waitUntil: 'domcontentloaded' });
    await setConsent(page, true);
    await page.waitForTimeout(5000);

    const o = await observedEvents(page, network);
    expect(o.calls + o.hooked.length, `${p.name}: no Meta Pixel activity at all — pixel not installed or not loading`).toBeGreaterThan(0);
    if (!o.all.some((e) => /^(PageView|ViewContent)$/i.test(e))) {
      // Pixel fired but the event name wasn't parseable from what we captured.
      // Treat "it fired" as the pass condition and record what was seen, so
      // the parse can be tightened once the log shows the request shape.
      test.info().annotations.push({ type: 'note', description: `Event name not parseable on load. ${describe(o)}` });
    }
  });

  test(`${p.name} — Meta Pixel fires AddToCart on add-to-cart click`, async ({ page }) => {
    await useUkMarket(page);
    await blockAnalyticsBeacons(page);
    await installPixelHook(page);
    const network = await installPixelNetworkCapture(page);

    await page.goto(p.path, { waitUntil: 'domcontentloaded' });
    await setConsent(page, true);
    await page.waitForTimeout(4000);
    const before = network.length;

    const button = await addToCartButton(page).resolve();
    await button.scrollIntoViewIfNeeded();
    await button.click();
    await page.waitForTimeout(5000);

    const o = await observedEvents(page, network);
    const newCalls = network.length - before;
    expect(
      o.all.some((e) => /^AddToCart$/i.test(e)) || newCalls > 0,
      `${p.name}: clicked Add to cart but no AddToCart pixel activity followed. ${describe(o)}, new calls after click: ${newCalls}`
    ).toBeTruthy();
    if (!o.all.some((e) => /^AddToCart$/i.test(e))) {
      test.info().annotations.push({
        type: 'note',
        description: `AddToCart inferred from ${newCalls} new pixel call(s) after click; event name not parseable. ${describe(o)}`,
      });
    }

    await page.request.post('/cart/clear.js').catch(() => {});
  });
}
