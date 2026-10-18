// 生成一份完全虚构的演示数据（README 截图用），不含任何真实域名、账号、搜索词或 IP。
// 用法（在项目目录下）：
//   1. 用单独的数据目录启动本地服务：npx wrangler dev --port 8790 --persist-to .wrangler/demo
//   2. 打开一次 http://127.0.0.1:8790/admin，让它自动建表
//   3. node scripts/demo-data.mjs > .wrangler/demo-seed.sql
//      npx wrangler d1 execute DB --local --persist-to .wrangler/demo --file .wrangler/demo-seed.sql
//   4. 脚本会把登录令牌写到 .wrangler/demo-token.txt：在 http://127.0.0.1:8790 的页面里执行
//      document.cookie = 'sl_session=<令牌>; path=/' 后刷新即可（用 127.0.0.1 而不是 localhost，不影响平时本地后台的登录）
// 演示环境里所有站点都标记为“刚同步过”，不会去请求 Google / Bing / Open PageRank；站点详情页的 Google 数据放在缓存里。
// 需要 .dev.vars 里的 SESSION_SECRET 和 ADMIN_PASSWORD（加密配置、签发登录令牌用）。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';
import { seal } from '../src/google.js';

const vars = Object.fromEntries(readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').split('\n')
  .map((l) => l.match(/^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const SECRET = vars.SESSION_SECRET;
if (!SECRET || !vars.ADMIN_PASSWORD) throw new Error('.dev.vars 里需要 SESSION_SECRET 和 ADMIN_PASSWORD');

const DAY = 86400000, NOW = Date.now();
const ymd = (t) => new Date(t).toISOString().slice(0, 10);
const day = (n) => ymd(NOW - n * DAY);
// 固定种子的随机数：每次生成的数据一样
let seed = 20261018;
const rnd = () => {   // mulberry32
  let t = (seed = (seed + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const wpick = (pairs) => { let r = rnd() * pairs.reduce((a, [, w]) => a + w, 0); for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; } return pairs[0][0]; };
const noise = (v, p = 0.18) => Math.max(0, Math.round(v * (1 + (rnd() * 2 - 1) * p)));
const q = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
// 先清掉上一次生成的演示数据，脚本可以重复运行
const out = ['clicks', 'link_targets', 'link_tags', 'links', 'agg_h', 'agg_d', 'agg_suv', 'agg_uv', 'g_daily', 'g_urls', 'g_sitemaps', 'g_cache', 'g_sites', 'g_accounts',
  'site_tags', 'site_ignores', 'url_health', 'sessions'].map((t) => `DELETE FROM ${t};`).concat("DELETE FROM settings WHERE key LIKE 'agg%';");
const ins = (table, row) => out.push(`INSERT OR REPLACE INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.values(row).map(q).join(', ')});`);
const setting = (key, value) => ins('settings', { key, value: typeof value === 'string' ? value : JSON.stringify(value), updated_at: NOW });

// ---------------------------------------------------------------- 站点
const ACCT = 'demo-account';
const SITES = [
  { host: 'blog.example.com', name: 'Example Blog', ses: 210, grow: 1.55, clk: 44, imp: 1500, pos: 8.6, age: 700, tags: ['内容'], urls: 120, yes: 0.86, opr: 2.41, ref: 18, bl: 37 },
  { host: 'shop.example.com', name: 'Example Shop', ses: 120, grow: 1.3, clk: 22, imp: 950, pos: 11.4, age: 420, tags: ['电商'], urls: 90, yes: 0.78, opr: 1.86, ref: 9, bl: 14 },
  { host: 'docs.example.com', name: 'Developer Docs', ses: 70, grow: 1.12, clk: 11, imp: 920, pos: 6.2, age: 380, tags: ['内容'], urls: 80, yes: 0.9, opr: 2.02, ref: 11, bl: 21 },
  { host: 'app.example.com', name: 'Example App', ses: 46, grow: 1.05, clk: 9, imp: 300, pos: 9.8, age: 260, tags: ['App'], urls: 30, yes: 0.83, stopped: true, opr: 0.9, ref: 3, bl: 4 },
  { host: 'news.example.com', name: 'Example News', ses: 34, grow: 0.82, clk: 14, imp: 640, pos: 12.5, age: 210, tags: ['内容'], urls: 70, yes: 0.7, drop: true, opr: 0.65, ref: 2, bl: 3 },
  { host: 'forum.example.com', name: 'Community', ses: 26, grow: 1.4, clk: 5, imp: 280, pos: 17.3, age: 95, tags: [], urls: 60, yes: 0.23, opr: 0.31, ref: 1, bl: 0 },
  { host: 'deals.example.com', name: 'Deals', ses: 19, grow: 2.1, clk: 4, imp: 210, pos: 14.1, age: 48, tags: ['电商'], urls: 40, yes: 0.6, noConv: true, bad: 4, opr: null, bl: 0 },
  { host: 'guide.example.com', name: 'Starter Guide', ses: 8, grow: 3.5, clk: 1, imp: 60, pos: 22.4, age: 19, tags: [], urls: 24, yes: 0.25, opr: null, bl: null },
];
const CH = [['Direct', 0.42], ['Organic Search', 0.31], ['Referral', 0.13], ['Organic Social', 0.08], ['Unassigned', 0.06]];
const PATHS = ['/', '/about', '/pricing', '/blog/launch', '/blog/roadmap-2026', '/guides/getting-started', '/guides/link-tracking', '/guides/utm-parameters', '/docs/api',
  '/docs/redirect-rules', '/changelog', '/case-studies/retail', '/case-studies/saas', '/compare/alternatives', '/tools/qr-code', '/tools/utm-builder', '/faq', '/contact'];
const QUERIES = ['short link analytics', 'url shortener cloudflare', 'free link shortener', 'self hosted url shortener', 'link tracking tool', 'utm builder', 'qr code generator free',
  'bitly alternative', 'branded short links', 'geo redirect link', 'ab test landing page', 'link click analytics', 'deep link to app', 'short url api', 'campaign link tracking',
  'open source link shortener', 'track link clicks by country', 'cloudflare workers d1 example'];

const users = (s, n) => {
  if (s.stopped && n <= 4) return 0;
  const base = s.ses * (n <= 28 ? 1 : 1 / s.grow) * (1 + (28 - Math.min(n, 56)) / 140);
  const wk = [1, 1.05, 1.08, 1.06, 1, 0.78, 0.74][new Date(NOW - n * DAY).getUTCDay()];
  return noise(base * wk);
};
const daily = {};
for (const s of SITES) {
  daily[s.host] = [];
  for (let n = 1; n <= 60; n++) {
    const ses = users(s, n), clk = noise(s.clk * (n <= 28 ? 1 : 0.8) * (s.drop && n <= 9 ? 0.45 : 1)), imp = noise(s.imp * (n <= 28 ? 1 : 0.85));
    const ch = Object.fromEntries(CH.map(([k, w]) => [k, Math.round(ses * w)]));
    const r = {
      host: s.host, date: day(n), users: Math.round(ses * 0.82), sessions: ses, views: Math.round(ses * 2.4), key_events: s.noConv ? 0 : Math.round(ses * 0.05),
      engagement: +(0.55 + rnd() * 0.15).toFixed(3), clicks: clk, impressions: imp, ctr: imp ? +(clk / imp).toFixed(4) : 0, position: +(s.pos * (0.92 + rnd() * 0.16)).toFixed(1),
      channels: JSON.stringify(ch), b_clicks: Math.round(clk * 0.27), b_impressions: Math.round(imp * 0.31),
    };
    daily[s.host].push(r);
    ins('g_daily', r);
  }
}
const sum = (host, a, b, f) => daily[host].filter((r) => { const n = Math.round((NOW - Date.parse(r.date)) / DAY); return n >= a && n <= b; }).reduce((x, r) => x + (Number(f(r)) || 0), 0);

const found = { props: [], gsc: [], errors: [], at: NOW };
SITES.forEach((s, i) => {
  const prop = String(400000000 + i * 1111);
  found.props.push({ id: prop, name: s.name, account: 'Example Inc.', host: s.host, created: NOW - s.age * DAY });
  found.gsc.push({ url: `sc-domain:${s.host}`, host: s.host });
  const u28 = Math.round(sum(s.host, 1, 28, (r) => r.users) * 0.86), p28 = Math.round(sum(s.host, 29, 56, (r) => r.users) * 0.86);
  const hist = Array.from({ length: 13 }, (_, k) => [ymd(NOW - (12 - k) * 30.4 * DAY).slice(0, 7), s.opr == null ? null : +(s.opr * (0.7 + k * 0.025)).toFixed(2)]);
  const top = s.bl ? PATHS.slice(0, 6).map((p, k) => [`https://${s.host}${p}`, Math.max(1, Math.round(s.bl * [0.42, 0.2, 0.14, 0.1, 0.08, 0.06][k]))]) : [];
  ins('g_sites', {
    host: s.host, ga4_property: prop, ga4_name: s.name, ga4_account: 'Example Inc.', ga4_acct: ACCT, ga4_created: NOW - s.age * DAY,
    gsc_site: `sc-domain:${s.host}`, gsc_acct: ACCT, users: JSON.stringify({ 28: u28, p28: p28, 7: Math.round(u28 / 3.6), p7: Math.round(u28 / 4) }),
    synced_at: NOW, ch_at: NOW, error: '', updated_at: NOW,
    bing_site: `https://${s.host}/`, b_synced_at: NOW, b_error: '', b_in_index: Math.round(s.urls * 0.6),
    bl_total: s.bl == null ? -1 : s.bl, bl_pages: top.length, bl_more: 0, bl_prev: s.bl == null ? -1 : Math.max(0, s.bl - 3), bl_top: top.length ? JSON.stringify(top) : '', bl_error: '', bl_at: NOW,
    opr: s.opr == null ? -1 : s.opr, opr_rank: s.opr == null ? 0 : Math.round(9e7 / (s.opr * s.opr + 1)), opr_ref: s.ref || 0,
    opr_hist: s.opr == null ? '' : JSON.stringify(hist.filter((h) => h[1] != null)), opr_at: NOW,
  });
  for (const t of s.tags) ins('site_tags', { host: s.host, tag: t });

  // 网页索引：网址清单和检查结果（一部分未编入，一部分有问题），都已检查过、下次检查在几天后
  const urls = Array.from({ length: s.urls }, (_, k) => `https://${s.host}${k < PATHS.length ? PATHS[k] : `/posts/${['how-to', 'guide', 'tips', 'review', 'update'][k % 5]}-${k}`}`);
  let yes = 0, done = 0, byes = 0, bdone = 0;
  urls.forEach((u, k) => {
    const bad = s.bad && k >= s.urls - s.bad;
    const ok = !bad && rnd() < s.yes;
    const state = bad ? 'Not found (404)' : ok ? 'Submitted and indexed' : wpick([['Discovered - currently not indexed', 3], ['Crawled - currently not indexed', 2], ['URL is unknown to Google', 2], ['Duplicate, Google chose different canonical than user', 1]]);
    const bState = ok && rnd() < 0.75 ? 'yes' : 'no';
    if (ok) yes++; done++; if (bState === 'yes') byes++; bdone++;
    ins('g_urls', {
      host: s.host, url: u, src: k % 7 ? 1 : 3, state, verdict: ok ? 'PASS' : 'NEUTRAL', fetch: bad ? 'NOT_FOUND' : 'SUCCESSFUL', robots: 'ALLOWED', indexing: 'INDEXING_ALLOWED', canon: '',
      crawled_at: NOW - Math.round(rnd() * 20 + 1) * DAY, checked_at: NOW - Math.round(rnd() * 60) * 3600000, due_at: NOW + 3 * DAY, error: '',
      b_state: bState, b_crawled_at: bState === 'yes' ? NOW - 5 * DAY : 0, b_checked_at: NOW - DAY, b_due_at: NOW + 7 * DAY, b_submitted_at: bState === 'no' && k % 2 ? NOW - 22 * 3600000 : 0, b_error: '',
    });
  });
  ins('g_sitemaps', {
    host: s.host, list: JSON.stringify([{ path: `https://${s.host}/sitemap.xml`, type: 'sitemap', index: false, pending: false, submitted: NOW - 40 * DAY, downloaded: NOW - 2 * DAY, errors: 0, warnings: 0, urls: s.urls }]),
    urls: s.urls, error: '', at: NOW, q_day: day(0), q_n: 35, n_urls: s.urls, n_yes: yes, n_done: done, nb_yes: byes, nb_done: bdone,
    b_feeds: JSON.stringify([{ path: `https://${s.host}/sitemap.xml`, type: 'Sitemap', status: 'Success', crawled: NOW - 3 * DAY, submitted: NOW - 35 * DAY, urls: s.urls, size: 0 }]),
    b_error: '', b_quota: 100, b_quota_at: NOW, g_on: 1, b_on: 1, sc_pages: Math.round(s.urls * 0.7), sc_at: NOW,
  });

  // 站点详情页的 Google / Bing 数据（正常是现查后缓存一小时；这里缓存到很久以后）
  const to = day(1), totals = (a, b) => {
    const ses = sum(s.host, a, b, (r) => r.sessions), us = Math.round(sum(s.host, a, b, (r) => r.users) * 0.86);
    return { users: us, newUsers: Math.round(us * 0.71), sessions: ses, views: Math.round(ses * 2.4), keyEvents: s.noConv ? 0 : Math.round(ses * 0.05), engagement: 0.62, duration: 96 };
  };
  const cur = totals(1, 28), ses = cur.sessions;
  const ga = {
    totals: { cur, prev: totals(29, 56) },
    src: [['google / organic', 0.31], ['(direct) / (none)', 0.42], ['go.example.com / referral', 0.07], ['bing / organic', 0.05], ['t.me / referral', 0.04], ['chatgpt.com / referral', 0.03]]
      .map(([k, w]) => ({ k, v: [Math.round(ses * w), Math.round(ses * w * 0.85), s.noConv ? 0 : Math.round(ses * w * 0.05)] })),
    pages: PATHS.slice(0, 10).map((p, k) => ({ k: p, v: [Math.round(cur.views * [0.28, 0.12, 0.1, 0.09, 0.07, 0.06, 0.05, 0.04, 0.03, 0.03][k]), Math.round(cur.users * [0.4, 0.15, 0.13, 0.11, 0.09, 0.07, 0.06, 0.05, 0.04, 0.03][k])] })),
    countries: [['United States', 0.34], ['Japan', 0.11], ['Germany', 0.09], ['United Kingdom', 0.08], ['Singapore', 0.06], ['Hong Kong', 0.05], ['Canada', 0.05], ['Taiwan', 0.04]]
      .map(([k, w]) => ({ k, v: [Math.round(cur.users * w), Math.round(ses * w)] })),
    devices: [['desktop', 0.56], ['mobile', 0.41], ['tablet', 0.03]].map(([k, w]) => ({ k, v: [Math.round(cur.users * w), Math.round(ses * w)] })),
    channels: CH.map(([k, w]) => ({ k, v: [Math.round(ses * w), Math.round(cur.users * w), s.noConv ? 0 : Math.round(ses * w * 0.05)] })),
  };
  const row = (k, clicks, impressions, position) => ({ k, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });
  const qs = QUERIES.map((k, j) => {
    const imp = Math.round(s.imp * 28 * [0.18, 0.12, 0.1, 0.08, 0.07, 0.06, 0.05, 0.05, 0.04, 0.04, 0.03, 0.03, 0.03, 0.02, 0.02, 0.02, 0.02, 0.01][j] / 3);
    const pos = +(Math.max(1.2, s.pos * [0.35, 0.6, 0.55, 0.9, 1.1, 0.5, 1.3, 1.6, 0.8, 1.2, 1.5, 0.7, 2.1, 1.0, 1.8, 0.65, 1.4, 2.4][j])).toFixed(1);
    const ctr = j === 4 || j === 9 ? 0.004 : Math.min(0.3, 0.32 / pos);
    const r = row(k, Math.round(imp * ctr), imp, pos);
    return { ...r, prevClicks: Math.round(r.clicks * (0.7 + rnd() * 0.5)), prevPosition: +(pos * (0.85 + rnd() * 0.3)).toFixed(1) };
  });
  const sc = {
    hasPrev: true, queries: qs.sort((a, b) => b.clicks - a.clicks),
    declining: qs.filter((x) => x.clicks - x.prevClicks <= -3).map((x) => ({ ...x, gone: false })),
    pages: PATHS.slice(0, 12).map((p, j) => {
      const imp = Math.round(s.imp * 28 * [0.22, 0.14, 0.12, 0.1, 0.08, 0.07, 0.06, 0.05, 0.05, 0.04, 0.04, 0.03][j] / 2.5), pos = +(Math.max(1.4, s.pos * (0.5 + j * 0.12))).toFixed(1);
      return row(`https://${s.host}${p}`, Math.round(imp * (j === 2 ? 0.006 : Math.min(0.3, 0.3 / pos))), imp, pos);
    }),
    countries: [['usa', 0.36], ['jpn', 0.1], ['deu', 0.09], ['gbr', 0.08], ['ind', 0.07], ['sgp', 0.05]].map(([k, w]) => row(k, Math.round(s.clk * 28 * w), Math.round(s.imp * 28 * w), +(s.pos * (0.9 + rnd() * 0.2)).toFixed(1))),
    devices: [['DESKTOP', 0.6], ['MOBILE', 0.37], ['TABLET', 0.03]].map(([k, w]) => row(k, Math.round(s.clk * 28 * w), Math.round(s.imp * 28 * w), +(s.pos * (0.9 + rnd() * 0.2)).toFixed(1))),
  };
  const bq = qs.slice(0, 10).map((x) => ({ ...x, clicks: Math.round(x.clicks * 0.28), impressions: Math.round(x.impressions * 0.3), ctr: x.ctr, position: +(x.position * 0.9).toFixed(1) }));
  const bing = {
    hasPrev: true, position: +(s.pos * 0.9).toFixed(1), prevPosition: +(s.pos * 0.97).toFixed(1), queries: bq,
    pages: sc.pages.slice(0, 8).map((x) => ({ ...x, clicks: Math.round(x.clicks * 0.28), impressions: Math.round(x.impressions * 0.3) })),
    crawl: Array.from({ length: 28 }, (_, k) => ({ date: day(28 - k), crawled: noise(s.urls * 0.6), errors: k % 9 === 0 ? 1 : 0, inIndex: Math.round(s.urls * 0.6), c4xx: k % 9 === 0 ? 1 : 0, c5xx: 0, robots: 0 })),
    issues: [],
  };
  const cache = (k, v) => ins('g_cache', { k, v: JSON.stringify(v), at: 9e15 });
  for (const d of [7, 14, 28]) {
    cache(`ga4b|${prop}|${d}|${to}`, ga);
    cache(`gsc2|sc-domain:${s.host}|${d}|${to}`, sc);
    cache(`bing|https://${s.host}/|${d}|${to}`, bing);
  }
});

// ---------------------------------------------------------------- 账号和配置（加密的值都是假的，演示环境不会真的去请求）
ins('g_accounts', { id: ACCT, email: 'demo@example.com', auth: await seal(SECRET, { refresh: 'demo', scope: 'https://www.googleapis.com/auth/webmasters https://www.googleapis.com/auth/analytics.readonly' }),
  connected_at: NOW - 120 * DAY, error: '', found: JSON.stringify(found), found_at: NOW });
setting('int_google', await seal(SECRET, { clientId: '000000000000-demo.apps.googleusercontent.com', clientSecret: 'demo-client-secret' }));
setting('int_bing', await seal(SECRET, { key: '0'.repeat(32) }));
setting('int_opr', await seal(SECRET, { key: 'opr_live_' + '0'.repeat(32) }));
setting('bing_found', { sites: SITES.map((s) => ({ url: `https://${s.host}/`, host: s.host, verified: true })), at: NOW });
setting('bl_cfg', { bing: 1, opr: 1 });
setting('opr_usage', { limit: 30000, remaining: 29516, resets: NOW + 13 * DAY, tier: 'free', asOf: day(17), at: NOW });
setting('g_backfill', '486');
setting('cron_status', { at: NOW - 20 * 60000, ms: 41870, steps: Object.fromEntries(['schema', 'aggregate', 'backfill', 'prune', 'cleanup', 'google', 'bing', 'links', 'health', 'update', 'notify', 'usage', 'gindex'].map((k) => [k, { ok: true, ms: 120 }])) });

// ---------------------------------------------------------------- 短链和访问记录
const LINKS = [
  { slug: 'spring', title: '春季促销活动', url: 'https://shop.example.com/spring', w: 30, utm: 1, tags: ['活动'], rules: [
    { countries: 'HK,MO,TW', url: 'https://shop.example.com/zh-hant/spring', note: '港澳台繁体页' },
    { countries: '', devices: 'ios', url: 'https://apps.apple.com/app/id0000000000', note: 'iPhone 去 App Store' }] },
  { slug: 'app', title: '下载 App', url: 'tg://resolve?domain=example', app_web: 'https://t.me/example', w: 16, tags: ['App'] },
  { slug: 'vip', title: '会员计划', url: 'https://blog.example.com/vip', w: 14, utm: 1 },
  { slug: 'docs', title: '开发者文档', url: 'https://docs.example.com/', w: 10 },
  { slug: 'launch', title: '产品发布会', url: 'https://news.example.com/launch-2026', w: 9, down: true },
  { slug: 'deal', title: '限时优惠', url: 'https://deals.example.com/black-friday', w: 9, tags: ['活动'], expires: NOW + 10 * DAY },
  { slug: 'forum', title: '社区', url: 'https://forum.example.com/', w: 6 },
  { slug: 'start', title: '新手指南', url: 'https://guide.example.com/start', w: 6 },
];
const COUNTRY = [['US', 30, ['New York', 'San Francisco', 'Seattle', 'Austin']], ['CN', 12, ['Shanghai', 'Beijing', 'Shenzhen']], ['HK', 7, ['Hong Kong']], ['JP', 8, ['Tokyo', 'Osaka']],
  ['SG', 6, ['Singapore']], ['GB', 6, ['London', 'Manchester']], ['DE', 5, ['Berlin', 'Munich']], ['TW', 5, ['Taipei']], ['KR', 4, ['Seoul']], ['CA', 4, ['Toronto', 'Vancouver']],
  ['AU', 3, ['Sydney']], ['FR', 3, ['Paris']], ['IN', 3, ['Bengaluru', 'Mumbai']], ['BR', 2, ['São Paulo']]];
const SRC = [['(direct)', 30], ['blog.example.com', 18], ['google', 14], ['telegram', 10], ['twitter', 8], ['newsletter', 7], ['shop.example.com', 6], ['docs.example.com', 4], ['bing', 3]];
const BOTS = [['Googlebot', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'], ['bingbot', 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)'],
  ['TelegramBot', 'TelegramBot (like TwitterBot)'], ['facebookexternalhit', 'facebookexternalhit/1.1']];
let lid = 0, tid = 0;
for (const L of LINKS) {
  lid++;
  // 短链这一行要先写（规则、访问记录引用它），访问计数等访问记录生成完再补
  const mark = out.length;
  out.push('');
  const rules = [];
  for (const r of L.rules || []) {
    tid++;
    rules.push({ id: tid, ...r });
    ins('link_targets', { id: tid, link_id: lid, countries: r.countries, devices: r.devices || '', url: r.url, note: r.note || '', fallback: 0, fallbacks: 0, ab_of: -1, weight: 0, created_at: NOW - 60 * DAY, updated_at: NOW - 60 * DAY });
  }
  let abId = 0;
  if (L.slug === 'spring') {
    // 默认地址做 A/B：原版 60%，新版 40%
    abId = ++tid;
    ins('link_targets', { id: tid, link_id: lid, countries: '', devices: '', url: 'https://shop.example.com/spring-b', note: '新版落地页', fallback: 0, fallbacks: 0, ab_of: 0, weight: 40, created_at: NOW - 20 * DAY, updated_at: NOW - 20 * DAY });
  }
  for (const t of L.tags || []) ins('link_tags', { link_id: lid, tag: t });
  let total = 0, human = 0, last = 0;
  const n = L.w * 170;
  for (let k = 0; k < n; k++) {
    const age = Math.pow(rnd(), 1.2) * 60 * DAY;   // 最近 60 天，越近访问越多（和上一周期比约增长三成）
    const ts = Math.round(NOW - age);
    const [cc, , cities] = wpick(COUNTRY.map((c) => [c, c[1]]));
    const kind = wpick([['human', 88], ['bot', 8], ['suspect', 4]]);
    const dev = wpick([['mobile', 58], ['desktop', 38], ['tablet', 4]]);
    const os = dev === 'desktop' ? wpick([['Windows', 6], ['macOS', 4]]) : wpick([['iOS', 5], ['Android', 5]]);
    const src = wpick(SRC);
    const bot = kind === 'bot' ? pick(BOTS) : null;
    const browser = bot ? bot[0] : os === 'iOS' ? wpick([['Safari', 6], ['Chrome', 2], ['WeChat', cc === 'CN' ? 6 : 0.2]]) : wpick([['Chrome', 7], ['Edge', 1.5], ['Firefox', 1], ['Telegram', 1]]);
    const ruleHit = rules.find((r) => (r.countries && r.countries.split(',').includes(cc)) || (r.devices && r.devices === 'ios' && os === 'iOS'));
    // 访客：从一个访客池里抽（一部分人会多次访问）；地址都在文档专用的保留网段里（203.0.113.0/24、2001:db8::/32）
    const v = Math.floor(Math.pow(rnd(), 1.6) * 9000);
    const ip = v < 240 ? `203.0.113.${v + 1}` : `2001:db8:${(v >> 8).toString(16)}:${(v & 255).toString(16)}::1`;
    const ref = src.includes('.') ? `https://${src}/` : src === 'google' ? 'https://www.google.com/' : src === 'twitter' ? 'https://t.co/' : '';
    ins('clicks', {
      link_id: lid, ts, source: src, referer: ref, referer_host: ref ? new URL(ref).hostname : '', utm_source: ['telegram', 'newsletter', 'twitter'].includes(src) ? src : '', utm_medium: '', utm_campaign: '',
      ip, country: cc, region: '', city: pick(cities), asn_org: pick(['Example ISP', 'Demo Telecom', 'Sample Broadband']), ua: bot ? bot[1] : `Mozilla/5.0 (${os}) ${browser}`,
      browser, os: bot ? '' : os, device: bot ? '' : dev, is_bot: kind === 'human' ? 0 : 1, lang: cc === 'CN' || cc === 'HK' || cc === 'TW' ? 'zh-CN' : cc === 'JP' ? 'ja' : 'en-US',
      rule_id: ruleHit ? ruleHit.id : abId && rnd() < 0.4 ? abId : 0, kind, reason: kind === 'bot' ? '自报爬虫' : kind === 'suspect' ? '没有语言信息' : '', asn: 64500 + Math.floor(rnd() * 20), tls: 'TLSv1.3', http: 'HTTP/2', proxy: 0,
    });
    total++; if (kind === 'human') human++; last = Math.max(last, ts);
  }
  const before = out.length;
  ins('links', {
    id: lid, slug: L.slug, target_url: L.url, title: L.title, note: '', enabled: 1, pass_query: 0, utm: L.utm || 0, ab_weight: L.slug === 'spring' ? 60 : 0, expires_at: L.expires || null,
    clicks: total, human, flood: 0, app_web: L.app_web || '', last_click: last, created_at: NOW - (90 + lid * 7) * DAY, updated_at: NOW - lid * DAY,
  });
  out[mark] = out.splice(before, 1)[0];
  // 目标页检查：一个打不开，其余正常（都刚检查过）
  for (const u of [L.url, ...rules.map((r) => r.url)]) {
    if (!/^https?:/.test(u)) continue;
    ins('url_health', { url: u, state: L.down ? 'down' : 'ok', status: L.down ? 404 : 200, error: '', ms: L.down ? 0 : 140 + Math.round(rnd() * 160), fails: L.down ? 2 : 0, checked_at: NOW - 15 * 60000, since: NOW - (L.down ? 1 : 12) * DAY });
  }
}

// ---------------------------------------------------------------- 登录：直接签发一个会话令牌（和后台登录时一样的格式）
const sid = 'demo' + 'a1b2c3d4e5f6a7b8c9d0';
const exp = NOW + 7 * DAY;
ins('sessions', { id: sid, created_at: NOW, seen_at: NOW, exp, ip: '203.0.113.10', country: 'US', city: 'San Francisco', ua: 'Mozilla/5.0 (Macintosh) Chrome' });
const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const sig = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${exp}|${sid}|env`)))].map((b) => b.toString(16).padStart(2, '0')).join('');
mkdirSync(new URL('../.wrangler', import.meta.url), { recursive: true });
writeFileSync(new URL('../.wrangler/demo-token.txt', import.meta.url), `${exp}.${sid}.${sig}\n`);

console.log(out.join('\n'));
