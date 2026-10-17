# Changelog

Versions follow [Semantic Versioning](https://semver.org/): MAJOR.MINOR.PATCH. See ["Upgrading" in the README](README.en.md#upgrading) for how to upgrade. 中文：[CHANGELOG.md](CHANGELOG.md)

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
