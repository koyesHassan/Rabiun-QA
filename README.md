# Rabiun QA

**Daily automated QA for [rabiun.com](https://rabiun.com), the live Shopify store I founded and run.**

Every day this suite opens my store in a real browser, on desktop and on mobile, and checks what a
customer would hit: pages load, prices are right, add-to-cart works, Meta ad tracking fires, and
performance isn't slipping. The results go to a public dashboard:

**📊 [Live dashboard →](https://koyeshassan.github.io/Rabiun-QA/)**

Built with Playwright, Lighthouse and GitHub Actions, with [Claude Code](https://claude.com/claude-code)
as my engineering partner.

---

## What it checks

| Area | What's checked | Why it matters |
|---|---|---|
| **Page health** | Homepage, product pages, cart and contact page load with no errors, broken images or failed requests | A broken page is a lost sale |
| **Pricing** | Each product shows the right price, in **GBP** | Catches pricing mistakes and currency bugs before customers do |
| **Add to cart** | The button is visible and enabled, and actually adds the item | This is the one flow that has to work |
| **Shopper journey** | "Shop now" leads to products, every product for sale is in the shop, sold-out sizes match real stock, and the cart hands off to Shopify checkout | Every step is somewhere a paid visitor can drop out |
| **Mobile layout** | Each product's info block (title, price, sizes, add to bag) is compared with the previous run's screenshot | Catches a broken layout on the device most customers use |
| **SEO basics** | Title, meta description and structured data are present | Keeps products findable on Google |
| **Meta pixel** | For shoppers who accept cookies, PageView, ViewContent and AddToCart fire, checked at the network level | If tracking silently breaks, ad spend goes blind |
| **Consent and privacy** | Nothing tracks a shopper before they accept cookies, Microsoft Clarity is installed, and no email address other than the shop's appears on public pages | UK privacy law, and a leak caught the day it appears |
| **Weak spots** | Advisory checks that never fail the run: Google product data, alt text, whether ad tracking tags survive landing, "Add to bag" on the first mobile screen, page weight, dead-link handling | A to-do list for conversion and SEO, with how long each item has been open |
| **Performance** | Lighthouse scores (performance, SEO, accessibility, best practices) for every page, every day | Trends over time, not a one-off snapshot |

About 55 checks across a desktop and a mobile browser, run every day and on every pull request.

## What it's found so far

**A redesign that broke every test except the site.** In September 2026 I rebuilt the storefront.
The next morning 21 checks failed, but the store was fine: the button now said "Add to bag", and a
new cookie banner meant the Meta pixel waited for shoppers to accept. The fix was to make the tests
act like a real shopper (decline or accept cookies, look for either wording) and to add a check that
nothing tracks anyone before they accept. The audit that followed turned up weak spots that the old
tests couldn't see: product pages had lost the structured data Google uses for price and stock, and
an SEO app was quietly redirecting every dead link to the homepage.

**The homepage is the slowest page on the site.** On mobile it scores **38/100** for performance
and takes about **7.9 seconds** to show its main content. The product pages score 56–63. That's a
concrete, measurable thing to fix, and the daily trend will show whether the fix works.

**A test that could never fail.** The mobile layout check was meant to compare each product page
against the day before, but every run starts on a fresh machine with no previous screenshot, so it
saved a new one and passed. It never compared anything. The screenshots now live on the `qa-data`
branch, and the check compares only the product section: the "Worn by you" customer-photo carousel
rotates on every load and changes as new customers are added, so it can't be a stable baseline. It was
verified to fail on a real change and to stay stable across repeat runs.

**Getting from 0 to 33 passing tests.** The first run passed **0 of 33**. Two days later it passed
**33 of 33**. The failures weren't bugs in the store. The tests weren't yet measuring it correctly.
Each one had a real cause worth understanding:

- **Wrong currency.** GitHub's test machines are in the US, so Shopify served USD prices. Setting
  Shopify's market cookies directly makes every run see the store as a UK customer does.
- **Wrong browser.** The iPhone test profile defaults to Safari's engine, which wasn't installed.
  Mobile tests now run Chromium at iPhone size.
- **Invisible pixel.** Rabiun's Meta pixel runs inside a sandboxed iframe, so the usual ways of
  checking it see nothing. The suite watches the network traffic instead, which is what proves an
  event was actually sent.
- **Pages that never go quiet.** Shopify pages constantly send tracking requests, so "wait until the
  network is idle" never happens. Tests wait for the page content instead.

## How it's built

```
GitHub Actions (daily + every PR)
  ├─ Playwright tests ──────┐
  ├─ Lighthouse audit ──────┼─→ results history (qa-data branch) ─→ public dashboard (GitHub Pages)
  └─ Meta/Shopify check ────┘
```

- **Every change goes through a pull request**, and the tests have to pass before it can merge.
  `main` is protected, so nothing gets pushed around the checks.
- **Results history lives on its own branch** (`qa-data`), so the daily bot never needs to touch the
  protected `main` branch.
- **Nothing private is public.** This repo, its logs and its dashboard are all public, so scripts
  that read private data (orders, ad accounts) only ever report "match" or "mismatch", never the
  numbers. Credentials live in GitHub's encrypted secrets.
- **Costs nothing to run.** It uses GitHub's free tier, with no servers and no paid services.

## How I work

I'm a solo founder. I built Rabiun and I run it myself. The brand, the product and the creative
direction are all mine. I use Claude Code as my engineering partner: it handles the day-to-day
upkeep of keeping the site healthy, and I decide what's worth checking, judge whether a result is
real, and catch it when something is off. [`CLAUDE.md`](CLAUDE.md) is our shared playbook of
lessons learned, so neither of us has to learn them twice.

## Known gaps (being worked on)

- **The Meta vs Shopify cross-check is built but switched off** until API keys are added.
- **Shopify still counts test visits.** Blocking tracking beacons keeps tests out of Meta and other
  ad tools, but Shopify counts sessions on its own servers. Test traffic now openly identifies as a
  bot so Shopify can label it; whether Shopify's bot filter picks it up is still being checked.

## Run it yourself

```bash
npm install
npx playwright install --with-deps chromium
npx playwright test          # functional + pixel tests
npm run lighthouse           # performance scores
npm run dashboard            # builds dashboard/index.html
```

<details>
<summary>Project layout</summary>

```
tests/
  pages.js                  pages and products under test
  site-health.spec.js       page loads, price, add-to-cart, SEO, mobile screenshots
  journey.spec.js           shop page, sizes vs stock, cart to checkout
  pixel.spec.js             Meta pixel checks
  privacy.spec.js           cookie consent, Clarity, no stray emails
  audit.spec.js             weak spots (advisory, never fails the run)
scripts/
  lighthouse-log.mjs        Lighthouse audit, appends to the history CSV
  meta-shopify-crosscheck.mjs   Meta vs Shopify tracking check (optional)
  build-dashboard.mjs       builds the dashboard page
.github/workflows/qa-daily.yml  daily schedule, PR checks, dashboard publish
```

</details>
