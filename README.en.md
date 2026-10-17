<p align="center">
  <img src="logo.svg" width="64" height="64" alt="cligc link">
</p>

<h1 align="center">cligc link</h1>

<p align="center">
  A free, open-source, self-hostable short link and visit analytics service that runs on Cloudflare Workers + D1.<br>
  Routing by country / region and device · A/B tests · target health checks · source tracking · real-time analytics · GA4 & Search Console site analytics · AI SEO reports · runs for free within the free tier
</p>

<p align="center"><a href="README.md">简体中文</a> · English</p>

<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/ccvar/cligc_link"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare"></a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/runtime-Cloudflare%20Workers-F38020.svg" alt="Cloudflare Workers">
  <img src="https://img.shields.io/badge/database-D1-F38020.svg" alt="Cloudflare D1">
</p>

---

## Features

- **Short links**: custom or generated slugs, disable, expiry, query passthrough; bulk-replace destinations by the original URL.
- **Routing by country / region and device**: one short link sends visitors from different countries, and iPhone / Android / desktop users, to different landing pages (e.g. iOS to the App Store, Android to Google Play), and the two can be combined; everything else goes to the default URL. Hong Kong, Macau and Taiwan can be set separately.
- **A/B tests**: the default URL or any rule can be split across several landing pages by weight, and the same visitor always gets the same variant. With conversion tracking, redirects add `utm_content=ab-a / ab-b` so you can compare conversions in GA4.
- **Target health checks**: every link's destinations are checked regularly; unreachable ones (404, 5xx, timeouts…) are marked red in the list and pushed to Telegram / email, with another notice when they recover.
- **Automatic fallback**: when a regional URL can't be reached on the visitor's network (e.g. blocked), the visitor goes to the default URL instead, and fallbacks are counted.
- **Scheduled reports**: daily / weekly / monthly reports pushed to Telegram or email (Resend / Cloudflare Email Routing) at the time you choose.
- **Source tracking**: Referer is recorded automatically; an optional landing-page snippet detects which search engine visitors came from; generate `?src=` links for each channel so sources are clear even without a Referer. `utm_source` / `utm_campaign` are supported too.
- **Analytics**: visit trends (with previous-period comparison), unique visitors, today's visits, sources, countries / cities, devices / OS / browsers, a weekday × hour heatmap, a live visit feed, rule hits, human / bot / suspicious detection, and CSV export.
- **Site analytics (GA4 + Search Console)**: connect one or more Google accounts; all sites are merged by domain with users, sessions, key events, search clicks / impressions / CTR / position and their changes, over 7 days to 12 months; summary cards with trends and traffic share; groups, sort by growth, CSV export.
- **Bing Webmaster**: paste one API key to add Bing clicks, impressions, query / page rankings and crawl stats, merged with Google's data by domain; the site list's search columns switch between Google / Bing / combined. Page indexing checks whether each URL is in Bing's index, and missing ones can be submitted to Bing by hand or automatically every day (within Bing's daily quota). ChatGPT search, Copilot and DuckDuckGo all use Bing's index.
- **Page indexing**: lists sitemaps (Google / Bing, one-click submit) and checks every URL from the sitemaps and search results for whether it's indexed and why not; the site list shows indexed counts.
- **Masked screenshots**: the eye icon on the overview and sites pages shows every domain as `bl•••.com`, handy for sharing screenshots.
- **Connected to short links**: count each site's short link clicks, unique visitors and **click-out rate** by visit source (`?src=` / Referer), and see which sites each link goes to. Optional **conversion tracking** adds utm parameters to redirects so GA4 shows each link's arrival sessions and key events.
- **AI analysis links**: pick sites and generate a read-only report link to send with a prompt to ChatGPT / Claude; the report pre-computes SEO opportunities such as queries at positions 4–20 and low-CTR / declining / new queries. Expires after 7 days by default, hides sensitive info, logs every open, revocable anytime.
- **Weekly SEO changes**: every Monday, the sites with the biggest click changes and the queries that dropped out of or are close to the top 10.
- **Cloudflare usage**: see the whole account's D1 reads/writes and Worker requests, projected to month-end at the current rate, with alerts before you go over.
- **Change history & undo**: every change to a link's default URL, redirect rules, A/B weights, status and more is recorded (time, device, before and after), kept for a year, and can be undone with one click.
- **Admin**: a single-page app with Chinese / English UI, dark mode and mobile support (tap to see tooltips on touch screens); ⌘K to search links, sites and settings; a "Get started" checklist on new deployments; signed cookie sessions, signed-in device management (sign out other devices), TOTP two-step verification, brute-force protection and optional Cloudflare Turnstile; Google and Cloudflare credentials can be entered right in the admin (stored encrypted).
- **Zero maintenance**: no servers; tables are created on the first request; stats read hourly / daily aggregates, so usage is tiny. "Settings → System status" shows whether the scheduled job, Google sync, push channels, target checks and usage credentials are healthy.

## Quick deploy

### Option 1: one-click deploy

Click **Deploy to Cloudflare** above and follow the prompts; the Worker and D1 database are created for you. Then open `https://<your worker>/admin`, sign in with the default password **`admin`**, and set a new password when asked.

> The default address is `*.workers.dev`, which is **usually blocked in mainland China**. If your visitors are there, [use your own domain](#use-your-own-domain) first; copied short links and QR codes then use it.

### Option 2: command line

You need Node.js 18+ and a Cloudflare account.

```bash
git clone https://github.com/ccvar/cligc_link.git
cd cligc_link
npm install

# Sign in to Cloudflare
npx wrangler login

# Create the D1 database and put the printed database_id in wrangler.toml
npx wrangler d1 create cligc-link

# Deploy
npx wrangler deploy
```

After deploying, open `https://<your worker>/admin` and sign in with the default password **`admin`**. The first sign-in requires a new password; nothing else in the admin works until it's set, and the default password stops working right after.

> Sign in and change the password soon after deploying. You can also set an initial password before deploying with `npx wrangler secret put ADMIN_PASSWORD`, so there's never a default password.

### Use your own domain

The domain must be on Cloudflare. Add to `wrangler.toml`:

```toml
routes = [
  { pattern = "go.example.com", custom_domain = true },
]
```

Then run `npx wrangler deploy` again.

Deployed with the button? In the Cloudflare dashboard open **Workers & Pages → your Worker → Settings → Domains & Routes → Add → Custom domain** and enter the domain (it must also be on Cloudflare). Then open the admin on the new domain so copied short links and QR codes use it.

## Upgrading

Every release is tagged `vX.Y.Z` with notes in [Releases](https://github.com/ccvar/cligc_link/releases) (see also [CHANGELOG.en.md](CHANGELOG.en.md)). "Settings → System status" shows the running version; the scheduled job checks GitHub for the latest release once a day (it only reads the version number and reports nothing), shows a notice there when a newer one is out, and pushes it once to your enabled Telegram / email.

No manual database migration is needed: a new version adds tables and columns on its first run without losing data. If something goes wrong after an upgrade, `npx wrangler rollback` returns to the previously deployed code.

**If you deployed from the command line**, run this in the project folder:

```bash
npm run upgrade
```

It fetches the latest release, keeps your Worker name, routes, D1 database and `[vars]` from `wrangler.toml`, installs dependencies, and deploys after you confirm. To update the code and deploy later: `npm run upgrade -- --no-deploy`; to go to a specific version: `npm run upgrade -- --to v1.2.0`.

**If you used the "Deploy to Cloudflare" button**: the button creates a repository in your GitHub account and has Cloudflare deploy every new commit. In that repository, open **Actions → 同步上游新版本 (sync upstream) → Run workflow**; it merges the latest release into your repository (keeping your `wrangler.toml` settings) and Cloudflare redeploys automatically. It only runs when you start it; to upgrade automatically every Monday, uncomment the two `schedule` lines in `.github/workflows/sync-upstream.yml` (off by default because automatically deployed code can access your stored Google / Bing credentials).

> Deployed before v1.1.0? Your copy doesn't have the upgrade tooling yet. From the command line, `git pull` once (on a `wrangler.toml` conflict, keep your own database ID and routes) and use `npm run upgrade` from then on. With the button, copy `scripts/` and `.github/workflows/sync-upstream.yml` from this repository into yours, then run the workflow above.

## Configuration

**Variables** (in `[vars]` of `wrangler.toml`):

| Name | Description |
| --- | --- |
| `HOME_URL` | Where `/` redirects to; leave empty to show the built-in home page. If you set it, also uncomment `run_worker_first` under `[assets]` (the home page is normally a static file that skips the Worker) |
| `ADMIN_HOST` | Only allow the admin on this hostname; leave empty to allow `/admin` on any hostname |
| `TURNSTILE_SITEKEY` | Cloudflare Turnstile site key; leave empty to skip the bot check at sign-in |

**Secrets** (set with `npx wrangler secret put <NAME>`):

| Name | Required | Description |
| --- | --- | --- |
| `ADMIN_PASSWORD` | No | Initial admin password. Defaults to `admin` when unset, and must be changed on first sign-in |
| `SESSION_SECRET` | Recommended | Session signing key, also used to encrypt tokens and client secrets stored in the database. When unset, it's generated on first run and stored in the database (so if the database is exported or leaked, the encrypted values can be decrypted too); after changing it you need to re-enter client credentials in the admin and reconnect Google |
| `TURNSTILE_SECRET` | No | Turnstile secret key, paired with `TURNSTILE_SITEKEY` |

### Move the generated session secret into a Secret (recommended)

Without `SESSION_SECRET`, the session secret is generated and stored in the database. It also encrypts the Google tokens, client secret and Cloudflare token in the database, so a database leak would expose them. Store **the same value** as a Wrangler Secret — sign-ins and connected Google accounts keep working:

Run these in the project directory (`<database name>` is `database_name` in `wrangler.toml`, `cligc-link` by default):

```bash
# 1. Read the secret from the database and pipe it straight into a Secret (never shown on screen)
npx wrangler d1 execute <database name> --remote --json \
  --command "SELECT value FROM settings WHERE key = 'session_secret'" \
  | node -e "let s='';process.stdin.on('data',(d)=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s)[0].results[0].value))" \
  | npx wrangler secret put SESSION_SECRET

# 2. After confirming the admin still works, delete the copy in the database
npx wrangler d1 execute <database name> --remote --command "DELETE FROM settings WHERE key = 'session_secret'"
```

Deployed with the one-click button and have no local project? In the Cloudflare dashboard open **Storage & Databases → D1 → your database → Console**, run `SELECT value FROM settings WHERE key = 'session_secret'` and copy the result; then open **Workers & Pages → your Worker → Settings → Variables and Secrets → Add**, choose type "Secret", name it `SESSION_SECRET`, paste the value and deploy. Once the admin still works, go back to the D1 console and run `DELETE FROM settings WHERE key = 'session_secret'`.

Note: if you switch to a **new** secret instead, every device is signed out, and you need to re-enter the Google client / Cloudflare token and reconnect Google accounts.

### Admin password

- Priority: password changed in the admin > `ADMIN_PASSWORD` > default password `admin`.
- Change it anytime under "Settings → Change password"; the new password is stored in D1 as a salted PBKDF2 hash, and other devices are signed out.
- If you forget it, delete the stored password to fall back to `ADMIN_PASSWORD` (or the default `admin` if unset, which must then be changed after signing in) — see [Locked out of the admin](#locked-out-of-the-admin).

### Brute-force protection

- 5 wrong passwords in a row from the same IP locks it out, starting at 15 minutes and doubling each time up to 24 hours; a successful sign-in resets it. IPv6 addresses are counted per /64 (a single server usually has a whole /64, so switching addresses doesn't reset the count).
- Passwords are stored as salted PBKDF2 hashes (100,000 iterations), and each wrong attempt is delayed by 0.8 s.
- With Turnstile set up, the bot check runs before the password is checked, so scripts can't try passwords in bulk.
- With two-step verification on, a leaked password isn't enough to sign in; 5 wrong codes in a row locks for 15 minutes.
- If you lock yourself out, wait, or unlock right away as described in [Locked out of the admin](#locked-out-of-the-admin).

### Signed-in devices

Every sign-in is recorded as a device (browser, OS, IP, country / city, sign-in time and last used), listed under "Settings → Signed-in devices". Sign out a device you don't recognize, or "Sign out all other devices" at once; changing the password or turning two-step verification on or off also signs out other devices. Sign-ins are valid for 7 days, and expired devices are cleaned up by the scheduled job.

The session cookie carries the device ID and a signature, so the cookie stops working as soon as its device record is deleted. Sign-ins from older versions are registered as a device automatically on their first request after upgrading, without signing in again.

### Turnstile (recommended)

1. In the Cloudflare dashboard → Turnstile, create a widget for your short link domain.
2. Put the site key in `TURNSTILE_SITEKEY` in `wrangler.toml`.
3. Run `npx wrangler secret put TURNSTILE_SECRET` with the secret key, then redeploy.

### Two-step verification (recommended)

Turn it on under "Settings → Two-step verification": enter your current password, scan the QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…), and confirm with a 6-digit code. After that, signing in needs the password plus a code, so a leaked password can't get anyone into the admin or change your redirects.

- 5 wrong codes in a row locks for 15 minutes; each code can only be used once.
- Turning two-step verification on or off signs out other devices.
- If you lose your phone, turn it off as described in [Locked out of the admin](#locked-out-of-the-admin), then sign in with the password and set it up again.

### Locked out of the admin

Forgot the password, got locked out, or lost your phone? Run one SQL statement against the database, either way:

- **Cloudflare dashboard** (no command line needed, works for one-click deploys too): open **Storage & Databases → D1 → your database → Console** and run the SQL from the table below.
- **Command line** (in the project directory): `npx wrangler d1 execute <database name> --remote --command "<SQL>"`. `<database name>` is `database_name` in `wrangler.toml` (`cligc-link` by default; if you renamed it on the one-click deploy page, use your name).

| Situation | SQL | Then |
| --- | --- | --- |
| Forgot the password | `DELETE FROM settings WHERE key = 'admin_password'` | Sign in with `ADMIN_PASSWORD` (or `admin` if unset) and set a new password |
| Locked out after too many wrong passwords | `DELETE FROM login_guard` | You can sign in again right away |
| Locked out after too many wrong codes | `DELETE FROM settings WHERE key = 'mfa_fail'` | You can enter a code again right away (it also unlocks by itself after 15 minutes) |
| Lost your phone, no codes | `DELETE FROM settings WHERE key IN ('totp', 'mfa_fail')` | Two-step verification is off; sign in with the password and set it up again |

For example, a forgotten password from the command line:

```bash
npx wrangler d1 execute cligc-link --remote --command "DELETE FROM settings WHERE key = 'admin_password'"
```

### Notifications (daily / weekly / monthly / weekly SEO changes / usage alerts / target alerts)

Set them up on the "Notifications" page, pushing to **Telegram** and **email**. Each channel has "Send test", and reports can be previewed. Besides visit reports you can turn on "Weekly SEO changes" (see "Sites"), "Cloudflare usage alerts" (see "Cloudflare usage") and "Target down alerts" (see "Target health checks").

- **Daily**: yesterday's data every day; **weekly**: last week (Mon–Sun) every Monday; **monthly**: last month on the 1st.
- Reports include visits, unique visitors, comparison with the previous period, new links, top links, top sources and countries / regions.
- The send time is an hour in the admin's time zone (follows the browser); the scheduled job in `wrangler.toml` checks hourly and never sends the same report twice.

**Telegram**: message @BotFather with `/newbot` to get a Bot Token; send your bot a message, then open `https://api.telegram.org/bot<Token>/getUpdates` — `chat.id` in the response is the Chat ID (for a group, add the bot to the group and post there first).

**Email**, either:

- **Resend** (recommended): verify a sending domain at [resend.com](https://resend.com) and create an API Key, then enter the key, sender and recipients in the admin. The free tier covers 3,000 emails a month.
- **Cloudflare Email Routing**: no third party. Enable Email Routing on your domain and verify the recipient addresses, then add this binding to `wrangler.toml` and redeploy:

  ```toml
  [[send_email]]
  name = "EMAIL"
  ```

  The sender must be on the domain with Email Routing enabled, and recipients must be verified.

Bot tokens and API keys are stored in D1; the admin only shows the last 4 characters.

## Usage

The admin interface is available in Chinese and English (see "Language" below); the names in this guide follow the English interface.

### Redirect rules

A link can be created first and configured later:

- **Default URL**: visits that match no rule go here. When empty, those visitors see a "Link unavailable" page.
- **Redirect rules**: send visitors to different URLs by country / region (Cloudflare's `request.cf.country`), device (iOS, Android, desktop, from the User-Agent), or both. No countries means all regions; no devices means all devices.
- **Priority**: rules with both country and device > device-only > country-only > default URL. For example, with "China · Android → local app store", "iOS → App Store" and "China → Chinese landing page", iPhone users in China go to the App Store and desktop users in China go to the Chinese landing page. Rules of the same kind can't overlap (a country can belong to only one country-only rule, and so on).

"If a visitor is from …, on …" on the link page shows where any country + device combination goes.

### A/B split

In the "Redirect rules" panel, the default URL and every rule have an A/B split button: the original URL is A, and you add 1–4 more variants (B, C…), each with a weight (relative numbers such as 50 / 30 / 20).

- Visits to that destination are split across the variants by weight. Assignment is by visitor IP, so the same visitor always gets the same variant and repeat clicks don't bounce between pages.
- Split URLs inherit the country / device conditions of their destination; a rule's "Fall back when unreachable" applies to all of its variants.
- Each variant's hits and actual share are shown in the "Redirect rules" panel, and the visit list shows which variant each visit went to.
- With **conversion tracking** on, redirects also add `utm_content=ab-a`, `ab-b`…, so you can compare variants' sessions and key events in GA4 by "Session manual ad content".
- Split URLs are included in target health checks and bulk replace. Deleting a rule deletes its split URLs too; after stopping a split, each variant's visit records are kept.

### Change history

The clock icon at the top right of a link page opens its "Change history": creation, changes to the default URL / title / note / slug / expiry / switches, adding, editing and deleting redirect rules, A/B split changes, bulk enable / disable and bulk replace. Each entry records the time, the device (browser · OS · IP) and the before and after, kept for a year.

"Undo" restores the content before the change, and the undo is recorded too. Only changes that haven't been changed again since can be undone (e.g. if the default URL was changed to B and then to C, "changed to B" can't be undone directly), so newer changes aren't overwritten. A restored rule keeps its original rule ID, so its earlier hit stats carry on.

### Target health checks

The scheduled job checks the default and rule URLs of enabled links in batches every hour (each URL roughly every 6 hours, failing URLs again after 1 hour, 10-second timeout):

- **OK**: 2xx / 3xx (redirects are followed).
- **Down**: 404 / 410 / 5xx, connection failures or timeouts. Only two failures in a row count, to avoid false alarms from blips.
- **Blocked**: 401 / 403 / 429 or a Cloudflare challenge page — usually the site blocked the check, so it doesn't count as down.

Links with problems show "Target down" in the list status (hover for the reason); the link page shows a status dot next to each URL, and "Check targets" checks immediately. Turn on "Target down alerts" on the "Notifications" page to get a push to your Telegram / email channels when a URL goes down or recovers.

### System status

"Settings → System status" summarizes the background jobs: the last scheduled run with each step's duration / errors, aggregation progress, Google account authorization and site sync, push channels, target checks and Cloudflare usage credentials. If the scheduled job hasn't run for more than 3 hours, the overview page shows a warning.

### Quick jump (⌘K)

On any admin page, press ⌘K (Ctrl K on Windows / Linux) or click "Search, jump…" in the sidebar to search links (slug, title, URL), sites and settings; use the arrow keys and Enter to open. With nothing typed, it lists recently visited links. On phones, open it from the account menu at the top right.

### Language

The admin is available in Simplified Chinese and English. It follows the browser language by default and can be switched under "Settings → Language", on the sign-in page, or from ⌘K (saved in the current browser). The home page can switch at the top right too, or add `?lang=en` / `?lang=zh` to the URL. The English dictionaries live in `src/i18n/` and are only loaded for the English interface; reports, push messages and AI analysis reports are still in Chinese for now.

### Groups and bulk actions

Links can be added to groups (tags; a link can have several). Filter the list by group, add or remove groups on a link page, and rename (same names merge) or delete groups under "Manage groups".

Tick the checkboxes on the left of the list (the header selects the whole page) to get a bulk action bar: enable, disable, add to group, remove from group, delete. Deleting also removes redirect rules and visit records; the confirmation shows how many visit records are affected.

### Bulk replace destinations

When a promo URL changes (new domain, new referral code), click "Bulk replace" at the top right of the "Links" page:

- **Exact match**: replaces the whole URL when it exactly matches the original.
- **Partial replace**: replaces only this part wherever it appears, keeping the rest, e.g. `ref=OLD` → `ref=NEW`, `old.example.com` → `new.example.com`.

Default URLs, redirect rules and A/B split URLs are all included. Before running, every "old → new" is listed along with the number of default URLs, rules / split URLs and links affected; the replacements must be valid http / https URLs, and nothing changes until you confirm. It takes effect immediately.

### Source stats

Source priority: `src` parameter > `utm_source` > Referer domain > `(direct)`.

**Use `?src=` to tell channels apart.** Enter site names under "Campaign links" on the link page to get links like `https://go.example.com/spring?src=zhihu` for each channel. Since `src` is part of the link itself, nothing on the other site or app can strip it, making it the most reliable source tag. With Google connected, "Add from site list" picks sites directly and uses the site's domain as `src`, so the "Sites" page counts the clicks toward that site precisely.

**When placing links on web pages, don't add `rel="noreferrer"`.** The Referer is the header the browser sends to tell the short link which site the visitor came from; `noreferrer` stops it, and the visit is recorded as direct. Recommended markup (the `<>` button next to each campaign link copies it):

```html
<a href="https://go.example.com/spring?src=zhihu" target="_blank" rel="noopener">Learn more</a>
```

`rel="noopener"` keeps the new page from controlling the original page and is fine to keep; just don't add `noreferrer`.

Even without `noreferrer`, browsers send no Referer in these cases, and the visit is recorded as `(direct)`:

- the page or site sets `referrerpolicy="no-referrer"` / `Referrer-Policy: no-referrer`;
- it's opened inside apps like WeChat, QQ or Weibo, or from an email client or document;
- it goes from an https page to an http page.

Also, for privacy, browsers only send the referring site's domain (e.g. `www.zhihu.com`) across sites by default, not the page path. So the Referer tells you which site a visit came from; to distinguish placements on the same site, use different `src` values such as `?src=zhihu-answer` and `?src=zhihu-column`.

### Search source tracking (optional)

When visitors reach your landing page from a search engine and then click a short link on it, the link only sees "from the landing page". Turn it on under "Settings → Source tracking" and paste the **full code** from the admin into the landing page (recommended: it runs in the visitor's browser and uses no Workers requests); it detects which search engine (Google, Bing, Baidu, Sogou, 360, Shenma…) or ad click (`gclid` / `msclkid`) the visitor came from and adds `utm_source` to links pointing to your short link domain:

You can instead add a one-line script tag, which picks up rule changes without re-pasting, but every new visitor loading it uses one Workers request (shared with short-link redirects in the free plan's 100k/day), so prefer the full code on busy pages:

```html
<script src="https://go.example.com/t.js" async></script>
```

- Only links to the short link domain are touched; existing `src` and `utm_source` are left alone.
- The visitor's first source is remembered (sessionStorage), so it's kept even after browsing a few pages.
- See it under "Sources · utm_source" on the link page; for links without `src`, `utm_source` also counts directly as the "source".
- Turning the switch off disables `/t.js` (copies already cached in visitors' browsers last until the cache expires); full code already pasted into pages is unaffected.
- Search engines no longer pass search keywords, so you'll know which engine, but not the query.

### Human / bot detection

Every visit is marked as **human**, **bot** or **suspicious**, with the reason:

- **Bot**: the User-Agent says so, e.g. Googlebot, Baidu spider, WeChat / Telegram link previews, curl, Python scripts.
- **Suspicious**: any of —
  - one strong signal: no Accept-Language, 5+ visits to the same link from the same IP within a minute, TLS 1.0 / 1.1;
  - two weak signals together: claims a modern Chrome / Firefox but lacks `Sec-Fetch-*` headers, uses HTTP/1.x, claims a very old OS or browser (e.g. iOS 13, Chrome below 100);
  - a data-center IP with any of the bot traits above. App link-safety scanners (e.g. WeChat), monitors and crawlers usually land here.
- **Human**: everything else.

With "Include bots" off at the top of the admin, stats, live visits and reports count humans only. "Human share" on the overview and "Device · Visitor type" on link pages show the breakdown and reasons; in live visits and the visit list, bot / suspicious / via-proxy visits are tagged, and hovering shows the reason. After upgrading, older records are re-classified automatically from their stored IP, network and User-Agent.

#### Data-center IPs

Common cloud providers are identified by ASN (Tencent Cloud, Alibaba Cloud, Huawei Cloud, Volcano Engine, Baidu Cloud, AWS, Google Cloud, Azure, DigitalOcean, Vultr, Hetzner, OVH, Contabo…), plus other data centers and hosts by network name. Some providers register IPs under a company address (e.g. Tencent Cloud Singapore as "6 COLLYER QUAY"), which names alone would miss, so the ASN wins.

Cloudflare and Akamai IPs don't count as data centers: real users of iCloud Private Relay and Cloudflare WARP use them too.

#### VPN / proxy detection

Most VPN and proxy nodes run in data centers, so "from a data-center IP" alone doesn't mean a bot. Humans via proxy are marked separately and still count as human:

| Case | Result | Tag |
| --- | --- | --- |
| Data-center IP with complete browser traits (HTTP/2 or HTTP/3, full headers, recent OS and browser) | Human | Proxy · via VPN / proxy |
| Data-center IP with any bot trait (e.g. HTTP/1.1, missing headers, old versions like iOS 13) | Suspicious | Suspicious |
| Chinese-speaking visitor (Accept-Language zh) outside Mainland China, Hong Kong, Macau, Taiwan, Singapore and Malaysia | Human | Proxy · possibly via VPN / proxy (hint only) |

"Human share" on the overview shows how many came via proxy, "Visitor type" on link pages shows the share of humans via proxy, and the `proxy` column is 1 in exported CSV.

Records from before the upgrade don't have the connection protocol, so whether browser traits are complete can't be judged; old data-center records stay suspicious, while new visits are told apart normally.

#### Limitations

All of this is inferred from network traits: residential proxies, phone hotspots and corporate gateways look like ordinary broadband and can't be identified as proxies, and scripts running through them may pass as human. Cloudflare Bot Management scores are Enterprise-only and aren't used. Detection only affects stats and never changes where a visitor is redirected.

### Data retention and aggregation

Every visit records a row. Stats pages (ranges of 7 days or more) read hourly / daily aggregates instead of scanning all visits, greatly reducing D1 reads (5 million rows a day on the free plan); visits from the last hour are read live, so stats are always current. The 24-hour range still reads visits directly.

- Aggregate tables: `agg_h` (visits per hour), `agg_d` (visits per day by dimension: source, country, city, device, browser, OS, rule hits, visitor type…), `agg_uv` (unique visitors per day, estimated with HyperLogLog, ~5% error).
- Aggregation runs incrementally on stats requests and in the hourly job, with nothing to do by hand; when visitor-type rules change, aggregates are rebuilt from the retained visits.
- Under "Settings → Data retention", keep visits for 60 / 90 / 180 / 365 days or forever (the default). Expired visits are cleaned up hourly in batches: at most 500 per run on the free plan (about 12,000 a day), or up to 20,000 per run when "Cloudflare usage" is set to (or detects) the paid plan. Each deleted visit takes about 4 row writes (the table plus 3 indexes), so while clearing a backlog the free plan uses up to about 48,000 row writes a day — roughly half the free quota; how many days a backlog takes depends on its size and your daily traffic, and the admin shows an estimate. On a free plan with several thousand visits a day or more, check the write headroom under "Settings → Cloudflare usage" before turning it on; trends, sources, regions and other stats read aggregates and are unaffected. The visit list, CSV export and reports only include retained visits.

### Sites: GA4 and Search Console

After connecting a Google account on the "Sites" page, every GA4 property and Search Console site in the account is listed (paired by domain), with users, sessions, key events, search clicks, impressions, CTR, average position and trends; site pages have daily trends, query / page / country / device rankings (queries show their position change from the previous period and can be filtered to positions 4–20, low CTR, declining and new), GA4 source / medium / page rankings and live users.

The "Page indexing" card on a site page lists sitemaps (status, errors, last read, one-click resubmit) and uses the URL Inspection API to check each URL from the sitemaps and search results (up to 500 per site; the scheduled task checks a batch every hour, taking turns across sites, and re-checks indexed URLs weekly), summarizing indexed / not indexed and the reasons; each URL links to Search Console to request indexing. GA4 asks for read-only access; Search Console asks for `webmasters` (read + submit sitemaps) — accounts connected earlier with read-only access just need to reconnect once.

Setup (each deployment needs its own OAuth client):

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project and enable the **Google Analytics Admin API**, **Google Analytics Data API** and **Google Search Console API**.
2. "OAuth consent screen": user type "External", fill in the app name and email, then click **Publish app**. Unpublished (testing) apps lose authorization after 7 days; personal use doesn't need Google review — when you see "Google hasn't verified this app", click "Continue"; if there's no "Continue" button, click "Advanced", then the "Go to … (unsafe)" link below it — it's your own app, so it's safe to continue.
3. "Credentials → Create credentials → OAuth client ID", type **Web application**, authorized redirect URI `https://<your domain>/api/google/callback`.
4. In the admin, open "Settings → Google integration", enter the client ID and secret and save (the secret is stored encrypted in D1 and only the last 4 characters are shown afterwards).
5. On the "Sites" page, click "Connect a Google account" to authorize.

The client can be changed or deleted under "Settings → Google integration"; changing the client ID disconnects all connected accounts. Clients that older versions kept in environment variables (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`) are imported into the admin automatically the first time they're used after upgrading; you can then delete the environment variables.

Above the list is a summary of the filtered sites (and how many are growing / declining), users, sessions, key events, search clicks and link clicks; the table shows each site's share of sessions (or search clicks).

**Connected to short links** (both directions):
- **Promo links on sites** (primary): links are matched to sites by visit source — `?src=` / `utm_source` first, then the Referer domain. Domain sources match by domain (including subdomains, ignoring www.); dotless names (e.g. `?src=gaterar`) must equal the site's main name. The site list, summary cards and site pages show human clicks on links out of each site, **visitors** (unique by IP, HyperLogLog estimate with ~5% error; the `agg_suv` table stores day × link × source, with old data backfilled once by the scheduled job) and **click-out rate** (link clicks ÷ sessions); "Source sites" on a link page lists which sites it was clicked from.
- **Links that go to a site**: matched by the domain of the link's destinations (default URL, every redirect rule and A/B split URL), shown on site pages and under "Destination sites" on link pages.
- The site list can be filtered by link (counting both directions).

**Groups**: sites can be added to groups (tags; a site can have several). Filter the list by group; search or filter first, then use "Add the current filter's sites to a group" in the group dropdown to add in bulk; add or remove groups on a site page; rename (same names merge) or delete groups under "Manage groups". Summary, export and AI analysis all follow the group filter.

**Export**: the download icon at the top right exports the current filtered and sorted list as CSV (UTF-8, opens directly in Excel).

**Weekly SEO changes**: once on (on the "Notifications" page), every Monday at the send time you get: week-over-week search clicks / impressions / sessions, the sites with the biggest click changes, and queries that dropped out of or are close to the top 10 (only the 10 sites with the most impressions are queried). Search Console is about 3 days behind, so search compares the week from 3–9 days ago; you can limit it to one group and preview it first.

**Conversion tracking** (per link, off by default): redirects add `utm_source=cligc&utm_medium=shortlink&utm_campaign=<slug>` to the destination (left alone if it already has utm parameters). "Destination sites" on the link page shows the matching GA4 arrival sessions, arrival rate (arrival sessions ÷ human clicks) and key events.

Site list results are cached for 5 minutes and invalidated automatically when Google sync, aggregation, links or groups change.

You can connect several Google accounts: click "Add account" at the top right of the "Sites" page and pick another account when authorizing; connected accounts are listed under "Settings → Google integration", where you can disconnect or reconnect them. Sites from all accounts are merged by domain (GA4 can come from one account and Search Console from another; when several accounts see the same site, the earliest connected account is used), and the list can be filtered by account. Each account can be disconnected separately, deleting only sites and data that come from it; if one account's authorization expires, only that account is affected — click "Reconnect".

Refresh tokens are stored in D1, encrypted with the session secret. Daily data is synced in hourly batches by the scheduled job (each site at most every 6 hours; the first sync backfills 16 months, Search Console's retention limit); rankings and live users on site pages are queried on open and cached for an hour. Ranges are the last 7 / 14 / 28 days or 3 / 6 / 12 months, through yesterday, compared with the previous period (no comparison for 12 months); Search Console data is usually 2–3 days behind.

### Bing Webmaster

Add your sites in [Bing Webmaster Tools](https://www.bing.com/webmasters) (sites verified in Search Console can be imported in one click), generate a key under **Settings (gear) → API access → API Key**, and paste it into "Settings → Bing Webmaster" in the admin. Then:

- The scheduled job lists the Bing account's sites daily and merges them with GA4 / GSC by domain; daily clicks / impressions and "pages in index" sync every 12 hours.
- Site pages gain Bing cards, a trend line, query / page rankings (weekly in Bing) and crawl stats / crawl issues.
- The Page indexing card uses `GetUrlInfo` to check whether each URL is in Bing's index (Bing rate-limits this tightly, so about 36 URLs an hour; indexed URLs are re-checked every 30 days, others weekly) and can submit URLs one by one or in bulk; "Auto-submit" is on by default and submits URLs not in the index (and not submitted in the last 30 days) daily within the quota.
- AI analysis reports and the weekly SEO changes include Bing data too.

**If Bing says it's "throttling this IP"**: Bing rate-limits by source IP, and Cloudflare Workers' outgoing IPs are shared by many sites, so they often get blocked. Add a forwarding rule on your own server and enter the proxy address (`https://your-domain/bing-random-string/`) under "Settings → Bing Webmaster"; Bing requests then go out from that machine. Point a domain at the server (if it's on Cloudflare, set it to "DNS only") and open ports 80 / 443. Caddy example (it gets the https certificate automatically; the nginx version and a test command are under "How to set up a proxy" in the admin, which also generates the random path for you):

```caddy
bing.example.com {
    handle_path /bing-replace-with-a-random-string/* {
        rewrite * /webmaster/api.svc/json{uri}
        reverse_proxy https://ssl.bing.com {
            header_up Host ssl.bing.com
        }
    }
}
```

Then enter `https://bing.example.com/bing-that-string/` as the proxy address. It must use https (the API key is in the query string); put a random string in the path that others can't guess.

### AI analysis links

On the "Sites" page (or a site page), click "AI analysis" at the top right, choose sites (one or more, up to 100; above 30 the report uses a compact format with only core metrics and search opportunities per site), a range (28 days / 3 months / 6 months) and sections, and generate a read-only link to send to ChatGPT, Claude or another AI to analyze the sites' SEO.

- The link returns a Markdown report for the AI to read (`?format=json` for structured data, `?download=1` to download): overview, site comparison, core metrics and changes, trends, queries / pages, countries / devices, and pre-computed **opportunities** — high-impression queries at positions 4–20, queries with CTR well below the norm for their position, declining queries and pages, new queries; GA4 channels, source / medium, landing pages and engagement; links that go to these sites.
- After generating, copy the ready-made "prompt for AI" (with the link). Some AIs can't open links; download the Markdown file and upload it instead.
- Security: links use a 128-bit random token, are read-only and include only the selected sites; they expire after 7 days by default (or 30 days / never), and Google account emails, GA4 property IDs and Search Console resource names are hidden by default; each link can be opened at most 60 times an hour; responses carry `X-Robots-Tag: noindex` so search engines don't index them (`robots.txt` allows `/r/`, otherwise AI tools couldn't open them).
- Reports are cached for an hour and generated once in the background right after creation, so the AI's first open is fast.
- Under "Settings → AI analysis links", see each link's open count and which tools opened it (ChatGPT, Claude, Perplexity, Gemini… by User-Agent); click the count to see each open's time, tool, country and IP (the last 200 per link), and revoke anytime.

### Cloudflare usage

"Settings → Cloudflare usage" shows the whole account's D1 rows read / written, Worker requests and D1 storage, plus this project's own usage (enter this project's D1 database ID and Worker name in the panel); each day also lists the databases and Workers using the most (database names need the token to also have **Account · D1 · Read**, otherwise database IDs are shown). The free plan is compared against daily quotas (reset at 0:00 UTC), the paid plan against the month-to-date total and monthly included quota; the plan is detected automatically or can be set by hand. You need:

1. A custom API token from the Cloudflare dashboard with **Account · Account Analytics · Read** (optionally **Account · Billing · Read** to show whether you're on a paid plan).
2. Enter the account ID and token in the panel (optionally the D1 database ID and Worker name to show this project separately) and click "Verify and save". The token is checked against the Cloudflare API before saving, stored encrypted in D1, and only the last 4 characters are shown afterwards.

Credentials that older versions kept in environment variables (`CF_ACCOUNT_ID` / `CF_API_TOKEN` / `D1_DATABASE_ID` / `WORKER_NAME`) are imported into the admin automatically the first time they're used after upgrading; you can then delete the environment variables.

The panel projects usage to the end of the period at the current rate (paid: last 7 days' daily average to month-end; free: to the end of today), showing whether it's enough and when the included quota would run out.

**Usage alerts**: turn on "Cloudflare usage alerts" on the "Notifications" page and pick a threshold (70% / 80% / 90% used). The scheduled job checks hourly and pushes to your Telegram / email channels when usage reaches the threshold, exceeds the included quota, or is projected to exceed it by the end of the period; each case alerts once per billing period per metric.

Results are cached for 5 minutes and can be refreshed by hand.

## Tests

```bash
npm test
```

Uses Node's built-in test runner (no extra dependencies), covering visitor classification, UA parsing, device detection and redirect rule priority, A/B split weights, 24-hour stats helpers, usage forecasts, HyperLogLog unique visitor estimates, site matching and AI report rules. Logic that doesn't depend on the Workers runtime lives in `src/lib.js` for easy testing.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # remove the leading # on the lines you need
npm run dev                      # http://localhost:8787/admin
```

Locally, Turnstile is off and the password is `admin` by default. To try Turnstile locally, uncomment both `TURNSTILE_SITEKEY` and `TURNSTILE_SECRET` in `.dev.vars` (Cloudflare's test keys, which always pass).

## Project structure

```
src/index.js      Worker: redirects, visit logging, admin API, scheduled jobs, automatic table creation
src/lib.js        Runtime-independent logic: visitor classification, redirect rules and A/B split, 24-hour stats helpers, usage forecasts
src/agg.js        Visit aggregation (hourly / daily), HyperLogLog unique visitors
src/google.js     Google integration: OAuth, GA4 / Search Console sync, site–link matching, AI reports, weekly SEO changes
src/bing.js       Bing Webmaster: API key / proxy, daily data sync, queries and crawl stats, index checks and submission
src/gindex.js     Page indexing: sitemaps, Google URL inspection, Bing index checks and auto-submission
src/admin.html    Admin (single file, no build step)
src/home.html     Home page served at / (built into public/ as a static file on deploy; Cloudflare serves it directly, without using Workers requests)
src/i18n/         English UI: the translation script (client.js) and dictionaries for the admin / home page
test/             node --test tests
schema.sql        Database schema (applied automatically on the first request)
migrations/       Upgrade scripts for older databases
wrangler.toml     Cloudflare configuration template
scripts/          Upgrade script (npm run upgrade): fetches a new release and keeps your wrangler.toml settings; build-assets.mjs builds the static home page
.github/workflows/ "Sync upstream" workflow for repositories created by the deploy button
CHANGELOG.md      Changelog
```

## Free tier

Only Workers and D1 are used. Cloudflare's free plan includes 100,000 Worker requests a day, 5 million D1 rows read / 100,000 rows written a day and 5 GB of storage — usually more than enough for individuals and small teams.

What usually runs out first is **D1 writes**: each visit writes one visit record, and D1 also counts a row for each of its 3 indexes and the autoincrement counter; together with the link's visit counter and the hourly aggregates, **a visit takes about 10 rows written on average** (more with many links and scattered traffic). So the free plan records roughly several thousand to 10,000 visits a day in full. **Past the day's read or write quota, D1 rejects every query for the rest of the day: links show a "temporarily unavailable" page and the admin can't load** until the quota resets at 00:00 UTC. "Settings → Cloudflare usage" shows usage; turn on usage alerts on the "Notifications" page to be warned before it runs out. For more traffic, the Workers Paid plan ($5/month, 50 million rows written a month included) is recommended.

Also note that deleting a link deletes all its visit records too, about 4 row writes each: deleting tens of thousands of visit records at once can use up the day's write quota and stop every link for the rest of the day. To just stop it redirecting, disable it instead.

## License

[MIT](LICENSE)
