# Changelog

Versions follow [Semantic Versioning](https://semver.org/): MAJOR.MINOR.PATCH. See ["Upgrading" in the README](README.en.md#upgrading) for how to upgrade. 中文：[CHANGELOG.md](CHANGELOG.md)

## v1.9.0 · 2026-10-19

Manage GA4 from the admin: create site tracking, get the tracking code, set key events, and create or delete events. You can also generate a temporary token so an AI can do all this through an API.

### New

- **Create site tracking**: the "+" at the top right of the Sites list. Pick a Google account and GA4 account and enter the site URL; a GA4 property and web data stream are created, and you get the tracking code. The site shows up in the list on its own. If you don't have a GA4 account yet, you can create one here too (accept Google's terms, then come back and refresh). You're warned first if the domain already has a property
- **Event management**: a new "Events" dropdown at the top of the site page with two dialogs, "Event list" and "Tracking code"
  - The event list shows the events received in the last 28 days with counts, tagged by type: Auto (collected by GA4, including enhanced measurement), Recommended (event names recommended by Google) and Custom; filter by type
  - Turn any event into a key event, or back, with one switch
  - Create events with rules (for example, record sign_up when a URL is visited or a link is clicked) and delete rules
  - The tracking code dialog shows the measurement ID, the gtag snippet and an example of sending a custom event, each with a copy button
  - The "No conversions" suggestion opens the event list directly
- **AI API**: the "AI API" button on the Sites list generates a temporary token with an expiry. Send the generated message to Claude, ChatGPT or another AI, and it can read site data, create site tracking, set key events, and create or delete events
  - Each token has its own permissions and can be revoked at any time; only a hash of the token is stored
  - Every AI action is logged; deletions run only after you confirm them in the admin, and the button shows how many are waiting
  - Up to 300 requests per token per hour; the API guide is at `GET /api/ai`

### Improved

- The admin no longer uses the browser's native dropdowns; they're replaced with a new dropdown menu
- Dialog close buttons moved to the top right of the title bar; in the event list only the table scrolls, while the title, filters and table header stay in place

### Upgrade notes

- Creating properties and managing events needs GA4 edit access: after upgrading, click "Re-authorize" once when the event list or the create-tracking dialog asks for it (self-hosted setups need the Google Analytics Admin API enabled in their Google Cloud project)
- The database adds the new tables automatically after the upgrade; nothing to do by hand

## v1.8.0 · 2026-10-19

Estimates when each site's content was last updated from its sitemap, a much better admin on phones, and a fix for blank pages on slow connections.

### New

- **Content update time**: the daily sitemap refresh uses page lastmod values and observed changes (new URLs, updated pages) to estimate when a site's content was last updated, and counts pages that appeared in the last 30 days. When most pages share the same lastmod day (usually set on every build), it isn't treated as a content update
  - The site page header shows "Content updated … · N new pages in 30 days", with the basis on hover
  - The Sites list shows the update time under each site name, in orange after 90 days without updates
  - New suggestion "Content not updated for a long time": no new or updated pages for 90+ days while search clicks are dropping
  - The AI analysis report includes the last content update

### Improved (phones)

- Tapping an input no longer zooms the page (iPhone zooms inputs smaller than 16px); small buttons and links have larger tap areas
- Top navigation: the 4th icon is now search; notifications moved into the account menu
- Links list: shows only /suffix, a tidier toolbar, quick create on one row; visit counts line up with the title
- Link page: a more compact header (QR code top-right, five actions in one row); visits listed as two-line rows without sideways scrolling
- Sites list: one-line header, a narrower site column fixed on the left with the scrollbar starting after it; the header sticks to the top when scrolling
- Site page: promoted links table, filter chips and header actions aligned; source / target site tables keep the first column fixed and no longer stretch past the screen
- Overview, notifications and settings: page headers, switches, accordion rows, the Cloudflare usage panel and the daily usage table laid out for phones
- Smaller gaps and card padding, so more fits on one screen

### Fixed

- Pages were blank while loading on slow connections: the loading placeholders were overridden by the sort icon's styles into invisible 10px boxes; they're visible again, with a shimmer
- In the English UI, multi-line tooltips were squashed onto one line and only partly translated; they're now translated line by line

## v1.7.1 · 2026-10-18

A more compact admin on phones.

### Improved

- On phones (narrower than 640px), the page margins, gaps between cards and card padding are smaller, so more fits on one screen; desktop is unchanged
- On phones, the Google account and Bing API Key rows in Settings put their buttons on a second line, so the text is no longer squeezed onto several lines

## v1.7.0 · 2026-10-18

Sitemaps are resubmitted automatically when they change, and updated pages are sent to Bing again.

### New

- **Resubmit sitemaps when URLs are added or updated**: when the daily sitemap refresh finds new URLs or a newer last-modified time (lastmod) on a page, your submitted sitemaps are resubmitted to Google and Bing so they're read again sooner. Google needs an account with submit permission
- **Updated pages are resubmitted to Bing**: the lastmod of every sitemap URL is read; pages with a newer lastmod are submitted to Bing again even if already indexed (once per update, within the daily quota), and Google's indexing status is rechecked within a day. If more than half of the pages change at once (common when a site generator stamps every page with the build date), the dates are treated as unreliable and only the sitemap is resubmitted
- In the Page indexing list, URLs updated in the last 7 days are marked "Updated"; hover a URL to see its last-modified time from the sitemap

### Improved

- Settings → Google integration and Settings → Bing Webmaster each have a "Resubmit sitemaps automatically when URLs are added or updated" switch, on by default; the Google card in Page indexing now shows an "Auto-submit" badge like Bing's
- The Google card's daily inspection quota moved to its own line, so the header is no longer crowded
- Sites list: group tags are on their own third line, and the table header sticks to the top of the page when you scroll

## v1.6.1 · 2026-10-18

Admin screenshots in the README, new features on the home page, and a few UI fixes.

### Improved

- The README now shows admin screenshots at the top and in a "Screenshots" section (one set each in Chinese and English, taken with fictional demo data); new `scripts/demo-data.mjs` (generates the demo data) and `scripts/screenshots.mjs` (takes the screenshots with local Chrome) make it easy to retake them after UI changes
- The home page adds "Every short link has a QR code", "Tap a short link, open the app" and "What to fix, spelled out" (site suggestions), and the site feature tags now include Bing backlinks and Open PageRank
- The "Suggestions" card on the site page is collapsed by default, listing each suggestion's name in the header; click to see details

### Fixed

- In the English UI, country / region lists were separated with Chinese commas
- In the English UI, long titles in the Sites summary cards overlapped the change badge; they're now truncated
- In the English UI, "synced just now" was shown as "synced Just now"

## v1.6.0 · 2026-10-18

New site suggestions: the data already synced is used to point out which sites have problems and what to do.

### New

- **Site suggestions**: based only on data already synced (no extra API calls); sites with very little traffic aren't flagged
  - Whole site: GA4 suddenly reporting nothing for 3 days (the tracking code may be gone), search clicks down 30% or more, many impressions but a CTR well below typical for the position (with the clicks you could gain), a low indexing rate (with the main reasons and what to do), URLs that fail to load or are blocked, sitemaps that can't be read or haven't been submitted, far fewer pages in Bing than in Google, and traffic without any key events
  - The site page also lists pages with many impressions but few clicks, and queries at positions 4–20 that are close to the top 3
  - The "Suggestions" card at the top of the site page is sorted by importance; each item shows the numbers, what to do, and a button that jumps to the matching filter
  - Sites with suggestions get a small badge in the site list, and "Has suggestions" on the right of the filter bar shows only those
  - Suggestions you don't need can be ignored for 30 days or permanently, and restored from the same card

### Improved

- When the site table doesn't fit, lower-priority columns (session share, CTR, session trend) are hidden one by one instead of showing a horizontal scrollbar; it's based on the actual width and adjusts when the window or sidebar changes
- "Key events" is merged into the Sessions column and shown under the session count when there are any

## v1.5.2 · 2026-10-18

Switch sites right from the site page, and the site list picks up changes sooner.

### Improved

- **Switch sites**: the site page has a dropdown arrow after the domain; search by domain or GA4 name and pick a site to jump straight to it (arrow keys + Enter work too). Coming from the site list, sites are listed in the list's current order; when the list is filtered, they're grouped into "Current filter" and "Other sites"
- The site list no longer shows the GA4 property name on each row; it's still in the GA4 icon's tooltip

### Fixed

- After "Sync now" on the Sites page the toast said the list was updated, but the list could still be up to an hour old from the cache; it now always reloads with fresh data after a sync
- New sites, changed site connections and GA4 added dates could take up to an hour to appear in the site list; they now show immediately

## v1.5.1 · 2026-10-18

Google index checks are about twice as fast, and sites show when GA4 was added (roughly when the site went live).

### Improved

- **Faster Google index checks**: they now run alongside the Bing index checks, and each hourly run gives Google 8 minutes instead of 4, checking about 400 URLs an hour (previously about 200). After adding many sites at once, the "Checking" backlog clears in roughly half the time; checks stop at most 12 minutes into the scheduled run, staying within Cloudflare's 15-minute limit
- **Site age**: each row in the site list shows how long ago the site was added to GA4 (from the GA4 web data stream's creation time; hover for the date), and the site page shows "GA4 added … (N months ago)". This is roughly when the site went live (later, if GA4 was installed some time after launch). After upgrading, the next few scheduled runs fill it in (one Google account per run) without waiting a day
- In the hourly scheduled run, notifications and usage alerts now run before the page-index checks, so daily / weekly reports aren't affected by how much checking there is and go out a few minutes earlier

### Fixed

- On the site page, when the right-hand card was short (e.g. GA4 on the "Devices" tab, or no Bing crawl data), the Google / Bing search card on the left overflowed onto the card below; it now shows at least about 5 rows and scrolls the rest inside the card
- In page indexing, with more than 300 URLs the "Showing the first 300" note overlapped the last row; it's now shown as the last row of the list

## v1.5.0 · 2026-10-18

New optional "Backlinks & authority": see the backlinks Bing has found and the Open PageRank domain score on the Sites pages.

### New

- **Backlinks & authority** (Settings → Backlinks & authority; the two parts switch on separately and are both off by default; while off, nothing is requested and nothing extra is shown)
  - **Bing backlinks**: uses your saved Bing Webmaster key (no extra cost) to check, once a week per site, the links from other websites that Bing has found, counted per page; on the site page, open a page to see which URLs link to it
  - **Open PageRank**: paste a free API key (from [Keywords Everywhere](https://keywordseverywhere.com/openpagerank); the free plan covers 30,000 domains a month) to get each domain's score (0–10), global rank, referring domains and monthly scores for the past year, refreshed weekly; subdomain sites show the subdomain's own score
  - When on, the site list gets a sortable "OPR / Backlinks" column and each site page gets a "Backlinks & authority" card (score and change, 13-month trend, pages with the most backlinks); when there's no data the card explains why instead of showing zeros
  - Done in batches by the hourly scheduled task: Bing checks at most 10 sites per run to stay clear of its throttling; the "Update now" button skips sites checked within the last hour

### Fixed

- In the English UI, the tooltip on the site list's "Indexed" column was half untranslated

## v1.4.1 · 2026-10-17

Site data now shows where it comes from, and tables sort by clicking a column header.

### Improved

- In the site table, the search clicks, impressions, CTR, position and indexed columns show source icons (Google Search Console / Bing / both) that follow the Google / Bing / Combined switch; in Combined mode, hovering a number shows the Google and Bing values separately
- Every column of the site table sorts by clicking its header (click again to reverse, and the choice is remembered); the "By sessions / clicks / growth / domain" buttons are gone ("growth" is on the "Session trend" header)
- Data tables on the site page (queries, pages, GA4, Bing…) also sort by clicking a header
- The summary cards on the Sites page and the Sites card on the overview show source icons (GA4 / Search Console / Bing) with explanations on hover; the overview card's search clicks and impressions follow the Sites page's Google / Bing / Combined choice
- The site table no longer scrolls horizontally at 1280 px

## v1.4.0 · 2026-10-17

Short-link QR codes, opening apps, and a large batch of fixes from a full review. **Fixes fresh deployments since v1.1.1 failing to create tables, which made the admin and every link return errors** — please upgrade if you deployed with the button or the CLI.

### New

- **QR codes**: the link page shows the QR code at the top right, and each row in the link list has a QR button; download it as SVG (vector, for print) or a 1024 px PNG
- **Open apps**: destinations can be app links (`tg://`, `weixin://`, `snssdk1128://`…) and Android `intent://`. Visits try to open the app first and fall back to a website (the link's "Website if the app can't open", or the default destination); inside WeChat, QQ, Weibo, Douyin and similar apps visitors are asked to open the link in a browser; iOS visitors are told to tap "Open"; crawlers and link previews go straight to the website
- **Destination type**: the default destination and redirect rules have a "Website / App" switch; App mode adds "Pick a common app" with brand icons and search (Chinese or English names), templates for major Chinese and international apps and app stores, and a custom scheme option for anything not listed

### Fixed

- Fresh deployments ran the schema in the wrong order, rolled back the whole batch and returned 500 everywhere (since v1.1.1); a new test runs the whole schema on an empty database
- The deploy button prefilled local development example secrets (admin password `change-me` and always-passing Turnstile test keys) as production secrets; deployments still using `change-me` are asked to change it after signing in
- Configuring only the Turnstile server secret locked you out of the admin
- Backfilling human visits on upgrade, deleting links and bulk deletes read rows in proportion to the number of links, which could use up a day's read quota at once
- The overview failed to load once you had 100 links (over D1's 100 parameters per statement); bulk actions on many links likewise
- Single-link stats and visit lists read data for the whole site, so reads grew with total traffic
- A wrong two-step code bounced you back to the password step; failed copies still said "Copied"; drawers and dialogs stayed on screen after navigating or when the session expired
- Login brute-force protection counted full IPs, so IPv6 attackers could rotate addresses (IPv6 now counts per /64)
- Malformed percent-encoding in a short-link path returns 404 instead of "temporarily unavailable"

### Improved

- **Usage**: retention cleanup runs in batches (up to 500 per hour on the free plan, more on paid) and the admin estimates how long it will take; daily / weekly / monthly reports scan visits two fewer times; rate-limited AI analysis links no longer write on every request; `/favicon.ico` skips the database; visit counts over 10,000 show as "10,000+"; source tracking recommends the full code, which uses no Workers requests
- **Security**: anti-framing, `nosniff` and related headers on the admin and API; write endpoints only accept same-origin JSON requests; app links reject `javascript:`, Windows / Office system schemes and misspelled `http`
- **Getting started**:
  - Opening the admin on `*.workers.dev` warns that it's usually blocked in mainland China, and the README explains adding a custom domain in the dashboard
  - New "Locked out of the admin" section (forgotten password, lockout, lost phone)
  - Bilingual pages for expired / missing links and errors, including when the D1 quota resets
  - Changing a slug asks for confirmation; "Copy short link" is now "Duplicate"
  - Corrected `wrangler.toml` comments, the Google authorization note and the README's free-tier section
- **UI**:
  - Help text contrast is now at least 4.5:1; dark-mode hovers and overlays are visible
  - Squeezed, clipped or horizontally scrolling layouts at medium and phone widths are fixed (link list, site table, query tables, page indexing…); lists gained an "open in new tab" icon
  - Clicking outside the link editor no longer discards unsaved changes; Tab stays inside dialogs and focus returns to the button that opened them
  - Paging through visits no longer redraws the whole page; overview cards load together instead of pushing content down
  - The home page demos pause when scrolled away, two misalignments are fixed, and the language switch is a dropdown

### Upgrade notes

- New columns, tables and indexes are added automatically on the first request after upgrading
- Write endpoints now require `content-type: application/json` and a same-origin request; add the header if you call the admin API from your own scripts
- Button deployments whose admin password is still `change-me` are asked to change it after signing in

## v1.3.1 · 2026-10-17

More anti-abuse and usage savings, plus a few UI details.

### Improved

- Hammering a short link from many IPs no longer amplifies database reads: a "link + IP + time" index was added, and once one IP hits the limit it's stopped in Worker memory without touching the database, with rapid-repeat counts written in batches
- The tracking script (`/t.js`) no longer queries the database on every load; the on/off setting is cached for a minute
- An "open in new tab" icon after the domain in the site list and after the title in the link list

### Fixed

- A fallback report (`/_fb`) signature could be resubmitted repeatedly to inflate the fallback count
- With the sidebar collapsed, hovering the current menu item merged the tooltip and the selection dot into a blue blob

## v1.3.0 · 2026-10-17

Anti-abuse: hammering a short link no longer floods the database, and hammering the home page no longer uses Workers requests. Short-link counts now show human visits.

### New

- **Short-link anti-abuse**: after more than 10 visits per minute from one IP to one link, visits still redirect but are only counted, not logged in detail, so database writes can't be flooded
- **Static home page**: the home page, robots.txt and the home translation script are built into static files (`public/`) on deploy and served directly by Cloudflare — no Worker, no Workers requests; hammering the home page no longer affects short links

### Improved

- The link list shows human visits (excluding crawlers and suspicious visits) and "Most visited" sorts by them; hover to see the total including machine traffic and rapid repeats that weren't logged
- Link details show total / daily human visits, with the total including machine traffic below
- The language switch at the top right of the home page is now a dropdown

### Upgrade notes

- If you set `HOME_URL` (redirecting the home page elsewhere), enable `run_worker_first = ["/"]` under `[assets]` in `wrangler.toml`. Upgrades via `npm run upgrade` or "sync upstream" do this automatically
- `index`, `index.html` and `i18n` are now reserved and can't be used as short-link slugs
- Human visit counts for existing links are backfilled from existing visit records on the first run after upgrading

## v1.2.0 · 2026-10-17

Faster page indexing with numbers closer to Search Console, and a stoppable, selectable site sync.

### New

- **Page indexing: URLs with search impressions count as indexed**: URLs that appeared in Google search results in the last 28 days are no longer inspected one by one — only the rest are, so the first pass is much faster and saves quota
- **Page indexing: site-wide numbers**: the Google card shows how many pages had search impressions in the last 3 months (a lower bound for "indexed"); the Bing card shows Bing's site-wide "in index" count, matching Bing Webmaster
- **Page indexing: progress and indexed rate**: Google and Bing each show "x / 500 checked · indexed rate", with a note on how it differs from the site-wide numbers
- **Site sync can be stopped**: while syncing, the refresh button becomes a stop button that stops after the current batch; with Bing connected you can sync Google and Bing, Google only or Bing only

### Improved

- Page indexing: due URLs are checked taking turns across sites, so every site gets some checks each hour; Google checks have their own, doubled time budget (about 200 per hour)
- Page indexing: Google stats sit in a card with its logo and the quota next to the title; the sitemaps view gets a Google heading; the URL-count note uses smaller text
- Site page: the Google search / GA4 cards no longer have a fixed height; the left card matches the right one

## v1.1.1 · 2026-10-17

A batch of reliability, performance and UI fixes. Upgrading is recommended.

### Fixed

- When reading a GA4 property's website address occasionally failed, site mappings flipped back and forth and data was repeatedly cleared and refilled
- Page indexing: sites without permission, out of quota or unlinked kept occupying the check queue and stalled other sites
- Reading a huge sitemap (or archive) could crash the whole scheduled job; child sitemaps in an index must now belong to the site
- With more than 100 sites, URL inspection and AI report queries failed
- A throttled Bing key save could delete Bing sites and data; a transient sitemap failure could drop the URL list of Bing-only sites
- "Run now" and the hourly job could run at the same time; manual runs took too long; each scheduled run now has an outgoing-request cap
- Upgrade script: no longer commits `wrangler.toml` with your database ID; deploy-button upgrades no longer fail when upstream adds a workflow; `$` in settings is kept; your own same-name tags are not overwritten
- Bing query CTR could exceed 100%
- The page indexing "Check now" button kept spinning after finishing; there was no retry when loading failed
- Masking also hid file names and could mask twice; domains in input fields are now blurred
- In Bing / combined mode the site summary's growth, active and share figures still used Google data
- Some settings help text was cut off on phones

### Improved

- Far fewer database reads for the site list, indexing counters, sitemap refreshes, schema checks and redirects
- The deploy-button "sync upstream" workflow now only upgrades when you run it (weekly automatic upgrades are opt-in)
- System status: Chinese step names, a Bing check row, and "Check for updates" / "Run now" next to their rows
- Warning toasts use an amber icon and stay longer for long messages; amber text uses a higher-contrast colour
- Tooltips also appear for keyboard users; toggles and tabs expose the selected item; Bing Webmaster added to ⌘K

## v1.1.0 · 2026-10-17

The first formal release (earlier deployments count as 1.0.0).

### New

- **Bing Webmaster**: paste one API key to add Bing clicks, impressions, query / page rankings and crawl stats, merged with Google's data by domain; the site list's search columns switch between Google / Bing / combined
- **Bing index checks and submission**: checks each URL against Bing's index; missing ones can be submitted by hand or automatically every day within the quota; sitemaps can be submitted to Bing too
- **Bing proxy address**: Bing often rate-limits Cloudflare's outgoing IPs, so Bing requests can go through your own server; the admin includes Caddy / nginx configs and a test command
- **Page indexing**: site pages check every URL from the sitemaps and search results for whether Google has indexed it and why not, and show / submit sitemaps; the site list gains an "Indexed" column
- **Search Console scope upgraded** to webmasters (submit sitemaps from the admin); accounts connected earlier with read-only access just need to reconnect once
- **AI analysis reports and weekly SEO changes** include Bing data and indexing rates
- **Masked screenshots**: the eye icon on the overview and sites pages shows every domain as `bl•••.com`
- **System status**: "Run now" for the scheduled job, the running version and new-release notices
- **Upgrade tooling**: `npm run upgrade` (command-line deployments) and the "sync upstream" GitHub Action (deploy-button repositories), keeping your `wrangler.toml` settings

### Improved

- Site list: the Google / Bing / combined switch sits next to the title; summary sparklines moved below the numbers at full card width; sync shows done / total with a progress bar
- Settings: Cloudflare usage is now first; Bing errors state the reason (amber for throttling, red otherwise)
- AI analysis link rows show their sites; the usage refresh is an icon button
- The home page introduces the new features and corrects the Search Console permission note
