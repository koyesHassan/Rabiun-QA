// Shared helpers for the test specs.

// Pin the storefront to the UK market. Shopify Markets picks currency from the
// visitor's IP and GitHub's runners are in the US — runs #1 and #2 saw the jeans
// at 205.00 USD instead of £150. Shopify stores the choice in two plain cookies
// (checked on the live site: localization=GB, cart_currency=GBP), so set those
// directly. Run #2 tried POSTing to /localization instead and it didn't take.
async function useUkMarket(page) {
  const host = new URL(process.env.SITE_BASE_URL || 'https://rabiun.com').hostname;
  await page.context().addCookies([
    { name: 'localization', value: 'GB', domain: host, path: '/' },
    { name: 'cart_currency', value: 'GBP', domain: host, path: '/' },
  ]);
}

// The main add-to-cart button. Themes often render a second, sticky copy that
// sits off-screen until you scroll, and `.first()` can land on that one and
// then fail with "element is outside of the viewport" (run #1). Only visible
// buttons count, sticky ones are excluded, then fall back to Shopify's
// conventional button[name="add"]. The Sept 2026 redesign relabelled it
// "Add to bag", so either wording matches.
const ADD_TO_CART_TEXT = /add to (cart|bag)/i;

function addToCartButton(page) {
  const nonSticky = page
    .locator('button:not([class*="sticky"])')
    .filter({ hasText: ADD_TO_CART_TEXT, visible: true })
    .first();
  return {
    async resolve() {
      if ((await nonSticky.count()) > 0) return nonSticky;
      return page.locator('button[name="add"]').first();
    },
  };
}

// --- Cookie consent ---
// Since the Sept 2026 redesign the store shows Shopify's cookie banner, and
// the Meta pixel (plus GA and Pinterest) only loads once a visitor accepts
// marketing cookies. Run of 26 Sep saw zero pixel calls because nobody
// accepted. The banner also sits over the bottom of the page, where it can
// swallow clicks on mobile.
const BANNER = '.shopify-pc__banner';

// True if Shopify wants a consent banner for this visitor's region (decided by
// IP, so it can differ between a UK laptop and a US GitHub runner).
async function consentRequired(page) {
  await page.waitForFunction(() => window.Shopify && window.Shopify.customerPrivacy, null, { timeout: 10_000 }).catch(() => {});
  return page
    .evaluate(() => {
      const cp = window.Shopify && window.Shopify.customerPrivacy;
      return cp && typeof cp.shouldShowBanner === 'function' ? Boolean(cp.shouldShowBanner()) : false;
    })
    .catch(() => false);
}

// Accept (for tracking tests) or decline (everything else) via the banner if
// it's showing, otherwise through Shopify's Customer Privacy API. Declining is
// the default: it's what a privacy-minded shopper does, and it keeps test runs
// out of every tracking tool.
async function setConsent(page, accept) {
  const button = page.locator(`${BANNER}__btn-${accept ? 'accept' : 'decline'}`);
  if (await button.isVisible({ timeout: 4_000 }).catch(() => false)) {
    await button.click();
    await page.locator(BANNER).waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
    return;
  }
  await page
    .evaluate((yes) => {
      const cp = window.Shopify && window.Shopify.customerPrivacy;
      if (!cp || typeof cp.setTrackingConsent !== 'function') return;
      return new Promise((resolve) => {
        cp.setTrackingConsent({ analytics: yes, marketing: yes, preferences: yes, sale_of_data: yes }, resolve);
        setTimeout(resolve, 3000);
      });
    }, accept)
    .catch(() => {});
}

// --- Meta Pixel event capture ---
// On rabiun.com the Meta Pixel is loaded by a Shopify *custom pixel*, which
// runs inside a sandboxed same-origin iframe (/web-pixels@.../sandbox/...).
// Its network calls go out as beacons whose body Playwright can't read, so
// run #2 saw facebook.com/tr requests but no event names. Instead, hook fbq()
// itself in every frame before any page script runs, and record the event
// name of each track call. A Proxy keeps fbq's own properties (queue,
// callMethod, loaded...) intact so the real pixel keeps working normally.
async function installPixelHook(page) {
  await page.addInitScript(() => {
    window.__fbEvents = [];
    let real;
    Object.defineProperty(window, 'fbq', {
      configurable: true,
      enumerable: true,
      get() {
        return real;
      },
      set(fn) {
        if (typeof fn !== 'function') {
          real = fn;
          return;
        }
        real = new Proxy(fn, {
          apply(target, thisArg, args) {
            const cmd = args[0];
            if (cmd === 'track' || cmd === 'trackCustom') window.__fbEvents.push(String(args[1]));
            if (cmd === 'trackSingle' || cmd === 'trackSingleCustom') window.__fbEvents.push(String(args[2]));
            return Reflect.apply(target, thisArg, args);
          },
        });
      },
    });
  });
}

// Collect recorded pixel events from every frame (the custom pixel lives in an
// iframe, so the main frame alone would come back empty).
async function pixelEvents(page) {
  const all = [];
  for (const frame of page.frames()) {
    const events = await frame.evaluate(() => window.__fbEvents || []).catch(() => []);
    all.push(...events);
  }
  return all;
}

function isMetaPixelRequest(url) {
  return url.includes('facebook.com/tr') || url.includes('connect.facebook.net');
}

// Network-level capture of pixel events. Run #3 showed facebook.com/tr calls
// going out (4 on load, 2 more on add-to-cart) while the fbq() hook above saw
// nothing — so the events fire, but from somewhere the hook doesn't reach.
// Intercepting with page.route() exposes the request body (beacon POSTs
// included), which a plain 'request' listener does not. Each call logs only
// its method, type, parsed event name and body length: the logs are public,
// so no request bodies or URLs (they carry the pixel ID and page state).
async function installPixelNetworkCapture(page) {
  const seen = [];
  await page.route(/facebook\.com\/tr/, async (route) => {
    // Everything here is wrapped so a parsing surprise can never throw inside
    // the route handler — run #4/#5 hit "URIError: URI malformed" from a raw
    // decodeURIComponent on a ~26KB beacon body, which killed the test AND
    // left the request un-continued. Always continue, whatever happens.
    try {
      const req = route.request();
      const url = req.url();
      const body = req.postData() || '';
      const ev = extractPixelEventName(url, body);
      seen.push({ ev, method: req.method(), type: req.resourceType(), url: url.slice(0, 160), bodyLen: body.length });
      // eslint-disable-next-line no-console
      console.log(`[pixel] ${req.method()} ${req.resourceType()} ev=${ev} bodyLen=${body.length}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(`[pixel] capture error (ignored): ${err && err.message}`);
    } finally {
      // Abort rather than continue: we've already recorded that the browser
      // fired the event, which is what the test checks. Letting it through
      // would send a real AddToCart/ViewContent to Meta from a US datacentre
      // on every run, polluting the ad-optimisation signal (and Shopify's
      // conversion analytics) with fake US "shoppers" who never check out.
      await route.abort('blockedbyclient').catch(() => {});
    }
  });
  return seen;
}

// Keep the test runner out of Shopify's own analytics for the same reason:
// every run adds to cart from a US IP and never checks out, which shows up
// in Shopify as US sessions with abandoned carts. Blocking the storefront
// analytics beacons means the runs don't count as sessions at all. The cart
// API calls themselves (add/clear) still go through, so add-to-cart is
// tested for real.
// Shopify also sends a same-origin beacon (/.well-known/shopify/monorail/...),
// which the first version of this list missed, so runs kept counting as US
// sessions. facebook.com/tr is here too so the non-pixel tests stop sending
// Meta fake PageViews/AddToCarts; the pixel tests register their capture
// route after this one, so it still sees (then aborts) every event first.
// scripts/lighthouse-log.mjs blocks the same list.
// Microsoft Clarity (session recordings + heatmaps) is blocked too, so CI runs
// never show up as recordings from a US datacentre. tests/tracking.spec.js
// lets the Clarity tag itself load to check it's installed, but still blocks
// its uploads.
const ANALYTICS_BEACONS =
  /\/\.well-known\/shopify\/monorail|monorail-edge\.shopifysvc\.com|\/api\/collect|google-analytics\.com|analytics\.google\.com|merchant-center-analytics\.goog|clarity\.ms|facebook\.com\/tr/;

async function blockAnalyticsBeacons(page) {
  await page.route(ANALYTICS_BEACONS, (route) =>
    route.abort('blockedbyclient').catch(() => {})
  );
}

// Pull the Meta event name out of a pixel request. Tries, in order: the URL
// query string, the POST body as form data, the POST body as JSON, then a
// tolerant regex over both. Never throws.
function extractPixelEventName(url, body) {
  try {
    const q = new URL(url).searchParams.get('ev');
    if (q) return q;
  } catch {}
  if (body) {
    try {
      const f = new URLSearchParams(body).get('ev');
      if (f) return f;
    } catch {}
    try {
      const j = JSON.parse(body);
      const ev = j && (j.ev || j.event || j.event_name || (Array.isArray(j) && j[0] && j[0].ev));
      if (typeof ev === 'string') return ev;
    } catch {}
  }
  const m = `${url} ${body}`.match(/(?:^|[?&\s"])ev(?:%22)?[=:"]+([A-Za-z]+)/);
  return m ? m[1] : null;
}

module.exports = {
  useUkMarket,
  addToCartButton,
  ADD_TO_CART_TEXT,
  consentRequired,
  setConsent,
  installPixelHook,
  pixelEvents,
  isMetaPixelRequest,
  installPixelNetworkCapture,
  blockAnalyticsBeacons,
};
