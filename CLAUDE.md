# Rabiun-QA

Automated QA suite for rabiun.com (Shopify). Playwright + GitHub Actions, 
checking site health, SEO basics, pricing, add-to-cart, mobile layout, 
and Meta pixel integrity.

## Commands
- Run tests locally: `npx playwright test`
- Run a single file: `npx playwright test tests/site-health.spec.js`
- View HTML report: `npx playwright show-report`

## Known gotchas — don't relearn these
- GitHub runners are US-based, so Shopify Markets serves USD unless
  cookies `localization=GB` + `cart_currency=GBP` are set directly.
- Mobile project must force `browserName: 'chromium'` — the iPhone
  device preset defaults to WebKit, which the workflow doesn't install.
- The Meta pixel is the Facebook & Instagram app's app pixel (Server + Web,
  data access "Always on"; checked 1 Oct 2026), running in a sandboxed iframe; 
  `fbq()` hooks see nothing — capture at the network level via 
  `page.route` instead.
- `networkidle` never fires on Shopify pages (constant pixel chatter);
  use `domcontentloaded`.
- Since the Sept 2026 redesign a Shopify cookie banner gates the Meta pixel,
  GA and Pinterest. Tests call `setConsent(page, accept)` from helpers.js:
  pixel tests accept, everything else declines (the banner also covers the
  bottom of the mobile screen and can swallow clicks). Clarity runs
  cookieless before consent, by design.
- The TinySEO app turns any 404 that gets a few hits into a permanent
  redirect to the homepage. Never probe random made-up URLs: each one ends
  up as a junk redirect in Shopify admin. audit.spec.js uses one fixed URL.
- Blocking analytics beacons makes some Shopify scripts throw "Failed to
  fetch". That's the test, not the site; audit.spec.js ignores those.
- Weak spots that shouldn't turn the run red go in `audit.spec.js` as
  `advisory` annotations (public text: counts and page names only).
- `.github/workflows/qa-daily.yml` is edited by hand by the owner, on
  GitHub's website. The workflow runs with the repo's secrets, so a human
  signs off on every change, and Claude Code's safety check blocks Claude
  from pushing workflow changes itself. (GitHub itself would allow it: the
  local `gh` login has the `workflow` scope.) Claude writes the exact lines
  and line numbers, then reviews the owner's commit.

## Dashboard
- Data and looks are split. `scripts/dashboard/data.mjs` records each run
  into `data/*.csv` and works out every number (streaks, pass rates,
  per-check flakiness, Lighthouse trends), which is also published as
  `dashboard/data.json`. Themes in `scripts/dashboard/themes/` only draw that
  object; `DASHBOARD_THEME` picks one (default `basic`).
- New metric → add it in `data.mjs`. New look → add a theme file. Bump
  `SCHEMA_VERSION` if a field is renamed or removed.
- `data/check-history.csv` keeps one row per check per run. It's the raw
  material for per-check stats and can't be backfilled, so don't drop it.
- Shopify sessions go public only as a trend: `scripts/shopify-sessions.mjs`
  turns a private export into 7-day rolling averages indexed to Aug 2026 =
  100, in `insights/sessions-trend.csv`. Never write raw session counts or
  the baseline. The export is pulled outside CI (Shopify's reports API needs
  Level 2 customer data access, which CI must not hold), kept outside the
  repo, and the CSV lands on `main` by PR.
- `insights/changes.csv` (edited by hand) is the public list of site/social
  changes shown as chart markers.
- Planned: a game-style theme matching rabiun.com, once there's enough
  history to make it worth showing off.

## Public repo — privacy rules
This repo, its Actions logs and the GitHub Pages dashboard are all public.
- Never write customer data, order/sales figures, conversion rate, raw
  session counts, ad spend or ad account details to `data/`, the dashboard,
  test output or `console.log`.
  Scripts that read private APIs log only pass/fail or match/mismatch.
- Don't reference private business docs (ad plans, release logs, strategy
  notes) in code comments or the README.
- Secrets live in GitHub Actions secrets only — never in files.

## Customer security comes first
Customer security outranks every feature, metric and dashboard goal. If
something can't be built without more access to customer data, don't
build it; raise it with the owner instead.
- CI's only store credential is a Dev Dashboard app (client ID + secret,
  swapped each run for a 24-hour token that gets log-masked) with
  `read_orders` only and at most Level 1 protected customer data. Never give
  CI `read_reports`, Level 2 customer data (names, emails, addresses) or
  any write scope.
- Scripts ask for counts (e.g. `ordersCount`), never order records or
  customer fields, even if the token could read them.
- Secrets go only into the `env` of the steps that need them. The workflow
  uses `pull_request`, never `pull_request_target`, so PRs from forks
  never get secrets.
- Any PR touching a script that reads secrets, or the workflow, gets
  checked for new API fields and new log/output lines before merge.
- Before a change touches store APIs, tokens or published data, tell the
  owner up front what becomes public and what the token could reach.

## Workflow
- Branch → PR → suite runs on the PR → merge on green.
- `main` is protected by the "protect main" ruleset: changes land only via
  PR, and the `qa` check must pass. Nothing (including the bot) can push
  to it directly.
- History CSVs live on the `qa-data` branch, not `main`. Each run restores
  them into `data/` (git-ignored on `main`), appends today's results, and the
  bot commits them back to `qa-data`. PR runs only test: they skip saving
  history and publishing the dashboard.
- The workflow queue is split: PR runs get their own queue per PR (a new
  push cancels that PR's older run), while push/schedule/manual runs share
  the `pages` queue and never cancel each other, since they save history to
  `qa-data` and publish the dashboard.
- Refer to PRs as number + short name + link, e.g. "#2 (privacy clean-up)".