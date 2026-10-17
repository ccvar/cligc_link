# Changelog

Versions follow [Semantic Versioning](https://semver.org/): MAJOR.MINOR.PATCH. See ["Upgrading" in the README](README.en.md#upgrading) for how to upgrade. 中文：[CHANGELOG.md](CHANGELOG.md)

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
