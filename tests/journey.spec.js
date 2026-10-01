// @ts-check
// Shopper journeys: the path an ad click has to survive to become a sale.
// Each step here is somewhere a paid visitor can drop out: a dead "Shop now",
// a product missing from the shop page, a size shown as available that can't
// be bought (or the reverse), a cart that won't hand off to checkout.
const { test, expect } = require('@playwright/test');
const { PRODUCT_PAGES } = require('./pages');
const { useUkMarket, addToCartButton, blockAnalyticsBeacons, setConsent } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await useUkMarket(page);
  await blockAnalyticsBeacons(page);
});

// Shopify's public product JSON (/products/<handle>.js): variant ids, titles
// and whether each one can be bought right now.
async function productJson(page, path) {
  const res = await page.request.get(`${path}.js`);
  expect(res.ok(), `${path}.js returned HTTP ${res.status()}`).toBeTruthy();
  return res.json();
}

test('Homepage — "Shop now" leads to products', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await setConsent(page, false);
  const shopNow = page.getByRole('link', { name: /shop (now|all)/i }).filter({ visible: true }).first();
  await expect(shopNow, 'Homepage has no visible "Shop now" / "Shop all" link').toBeVisible();
  await shopNow.click();
  await page.waitForURL(/\/(collections|products)\//, { timeout: 15_000 });
  await expect(
    page.locator('a[href*="/products/"]').filter({ visible: true }).first(),
    `"Shop now" landed on ${new URL(page.url()).pathname} but no products are showing`
  ).toBeVisible();
});

test('Shop all — every product for sale is listed', async ({ page }) => {
  const res = await page.request.get('/products.json?limit=250');
  const { products } = await res.json();
  const forSale = products.filter((p) => p.variants.some((v) => v.available));
  expect(forSale.length, 'No products for sale at all in /products.json').toBeGreaterThan(0);

  await page.goto('/collections/all', { waitUntil: 'domcontentloaded' });
  const missing = [];
  for (const p of forSale) {
    if ((await page.locator(`a[href*="/products/${p.handle}"]`).count()) === 0) missing.push(p.title);
  }
  expect(missing, `For sale but not on /collections/all: ${missing.join(', ')}`).toEqual([]);
});

for (const p of PRODUCT_PAGES) {
  // A size shown as available that can't be bought loses the sale at the last
  // step; a size shown as sold out that's actually in stock loses it silently.
  test(`${p.name} — sold-out sizes match stock`, async ({ page }) => {
    const product = await productJson(page, p.path);
    test.skip(product.variants.length < 2, 'One variant only, no size picker to check');

    await page.goto(p.path, { waitUntil: 'domcontentloaded' });
    const wrong = [];
    let found = 0;
    for (const v of product.variants) {
      // The redesign's size buttons carry the variant id; fall back to the
      // size label so a theme change doesn't make this silently pass.
      let option = page.locator(`[data-variant="${v.id}"], [data-variant-id="${v.id}"]`).first();
      if ((await option.count()) === 0) {
        option = page.getByRole('button', { name: new RegExp(`^\\s*${v.title}\\b`, 'i') }).first();
      }
      if ((await option.count()) === 0) continue;
      found++;
      const shownSoldOut = await option.evaluate(
        (el) =>
          el.hasAttribute('disabled') ||
          el.getAttribute('aria-disabled') === 'true' ||
          /sold out|unavailable/i.test(el.textContent || '')
      );
      if (shownSoldOut === v.available) {
        wrong.push(`${v.title}: shown as ${shownSoldOut ? 'sold out' : 'available'} but Shopify says ${v.available ? 'in stock' : 'sold out'}`);
      }
    }
    expect(found, `${p.name}: size picker not found on the page`).toBeGreaterThan(0);
    expect(wrong, `${p.name}: size availability is wrong — ${wrong.join('; ')}`).toEqual([]);
  });
}

// Stops at the first checkout page, before any customer details, so nothing
// is ordered and no abandoned checkout is recorded. Analytics beacons are
// blocked and cookies declined, so it doesn't count as a checkout either.
test('Checkout — add-to-cart through to the checkout page', async ({ page }) => {
  // First product that has something in stock.
  let target = null;
  for (const p of PRODUCT_PAGES) {
    const product = await productJson(page, p.path);
    if (product.available) {
      target = p;
      break;
    }
  }
  test.skip(!target, 'Everything is sold out, nothing to check out');

  await page.goto(target.path, { waitUntil: 'domcontentloaded' });
  await setConsent(page, false);
  const button = await addToCartButton(page).resolve();
  await button.click();
  await expect
    .poll(async () => (await (await page.request.get('/cart.js')).json()).item_count, {
      message: `${target.name}: nothing in the cart after Add to bag`,
      timeout: 10_000,
    })
    .toBeGreaterThan(0);

  try {
    await page.goto('/cart', { waitUntil: 'domcontentloaded' });
    await setConsent(page, false);
    const checkout = page
      .locator('button[name="checkout"], input[name="checkout"]')
      .or(page.getByRole('button', { name: /check ?out/i }))
      .filter({ visible: true })
      .first();
    await expect(checkout, 'Cart page has no visible Checkout button').toBeVisible();
    await checkout.click();
    await page.waitForURL(/\/checkouts?\//, { timeout: 20_000 });
    expect(new URL(page.url()).pathname, 'Did not reach Shopify checkout').toMatch(/\/checkouts?\//);
  } finally {
    await page.request.post('/cart/clear.js').catch(() => {});
  }
});
