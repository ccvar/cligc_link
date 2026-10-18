// 站点地图刷新在真实 SQLite 上的行为：站点地图里出现新网址时自动重新提交（用 node:sqlite 模拟 D1，fetch 换成假的 Bing 接口和站点地图）
// 需要 Node 22.13+ 自带的 node:sqlite；更老的 Node 上跳过
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { refreshSite, bingSubmit } from '../src/gindex.js';

const sqlite = await import('node:sqlite').catch(() => null);
const SQL = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const skip = !sqlite && '需要 Node 22.13+（node:sqlite）';

function fakeEnv() {
  const db = new sqlite.DatabaseSync(':memory:');
  for (const s of SQL.replace(/--[^\n]*/g, '').split(';').map((x) => x.trim()).filter(Boolean)) db.exec(s);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async first(col) { const r = db.prepare(sql).get(...args); return r ? (col ? r[col] : { ...r }) : null; },
    async all() { return { results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }; },
    async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  const DB = {
    prepare: (sql) => stmt(sql),
    async batch(list) {
      db.exec('BEGIN');
      try { const out = []; for (const s of list) out.push(await s.run()); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
  return { db, env: { DB } };
}
const setting = (db, k, v) => db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));

test('站点地图里出现新网址时，定时任务自动把站点地图重新提交给 Bing', { skip }, async () => {
  const { db, env } = fakeEnv();
  setting(db, 'bing_auto', 0);   // 不逐个提交网址，只看站点地图
  const SM = 'https://a.com/sitemap.xml';
  let pages = ['https://a.com/', 'https://a.com/x'];
  const submitted = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/GetFeeds')) return new Response(JSON.stringify({ d: [{ Url: SM, Status: 'Success', UrlCount: pages.length }] }));
    if (u.includes('/SubmitFeed')) { submitted.push(JSON.parse(init.body).feedUrl); return new Response(JSON.stringify({ d: null })); }
    if (u === SM) return new Response(`<urlset>${pages.map((p) => `<url><loc>${p}</loc></url>`).join('')}</urlset>`);
    return new Response('', { status: 404 });
  };
  const s = { host: 'a.com', bing_site: 'https://a.com/', gsc_site: '', gsc_acct: '' };
  const feed = () => JSON.parse(db.prepare('SELECT b_feeds FROM g_sitemaps WHERE host = ?').get('a.com').b_feeds)[0];
  try {
    await refreshSite(env, 'x', s, 'KEY', { auto: true });
    assert.deepEqual(submitted, [], '第一次读取不算有变化');
    await refreshSite(env, 'x', s, 'KEY', { auto: true });
    assert.deepEqual(submitted, [], '没有新网址不提交');
    pages = [...pages, 'https://a.com/new'];
    await refreshSite(env, 'x', s, 'KEY', { auto: true });
    assert.deepEqual(submitted, [SM], '有新网址时重新提交');
    assert.ok(feed().submitted > Date.now() - 5000, '记下提交时间');
    pages = [...pages, 'https://a.com/new2'];
    await refreshSite(env, 'x', s, 'KEY');
    assert.equal(submitted.length, 1, '手动刷新（不是定时任务）不自动提交');
    pages = [...pages, 'https://a.com/new3'];
    setting(db, 'sm_auto_b', 0);
    await refreshSite(env, 'x', s, 'KEY', { auto: true });
    assert.equal(submitted.length, 1, '关掉开关后不提交');
    pages = pages.slice(0, 2);
    setting(db, 'sm_auto_b', 1);
    await refreshSite(env, 'x', s, 'KEY', { auto: true });
    assert.equal(submitted.length, 1, '只删了网址不提交');
  } finally { globalThis.fetch = realFetch; }
});

test('网页的 lastmod 变新：提交给 Bing、重新提交站点地图；一大半同时变时不逐个提交', { skip }, async () => {
  const { db, env } = fakeEnv();
  setting(db, 'bing_auto', 0);
  const SM = 'https://a.com/sitemap.xml', D = (d) => `2026-05-${String(d).padStart(2, '0')}`;
  const pages = Array.from({ length: 30 }, (_, i) => ({ u: `https://a.com/p${i}`, m: D(1) }));
  const feeds = [], urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/GetFeeds')) return new Response(JSON.stringify({ d: [{ Url: SM }] }));
    if (u.includes('/SubmitFeed')) { feeds.push(1); return new Response(JSON.stringify({ d: null })); }
    if (u.includes('/GetUrlSubmissionQuota')) return new Response(JSON.stringify({ d: { DailyQuota: 100, MonthlyQuota: 1000 } }));
    if (u.includes('/SubmitUrlBatch')) { urls.push(...JSON.parse(init.body).urlList); return new Response(JSON.stringify({ d: null })); }
    if (u === SM) return new Response(`<urlset>${pages.map((p) => `<url><loc>${p.u}</loc><lastmod>${p.m}</lastmod></url>`).join('')}</urlset>`);
    return new Response('', { status: 404 });
  };
  const s = { host: 'a.com', bing_site: 'https://a.com/', gsc_site: '', gsc_acct: '' };
  const row = (u) => db.prepare('SELECT lastmod, upd_at, b_submitted_at FROM g_urls WHERE url = ?').get(u);
  try {
    await refreshSite(env, 'x', s, 'KEY', { auto: true });
    assert.equal(row(pages[0].u).lastmod, Date.UTC(2026, 4, 1), '新网址记下 lastmod');
    // 所有网页都已收录、提交过
    db.prepare("UPDATE g_urls SET b_state = 'yes', b_submitted_at = 1").run();
    await refreshSite(env, 'x', s, 'KEY', { auto: true });
    assert.equal(feeds.length, 0, 'lastmod 没变不提交');
    await bingSubmit(env, 'KEY', s);
    assert.deepEqual(urls, [], '已收录、没更新的不提交给 Bing');

    pages[3].m = D(9);
    const r = await refreshSite(env, 'x', s, 'KEY', { auto: true });
    assert.equal(r.updated, 1);
    assert.equal(feeds.length, 1, '有网页更新时重新提交站点地图');
    assert.ok(row(pages[3].u).upd_at > 0);
    await bingSubmit(env, 'KEY', s);
    assert.deepEqual(urls, [pages[3].u], '有更新的网页（已收录）也提交给 Bing');
    await bingSubmit(env, 'KEY', s);
    assert.equal(urls.length, 1, '提交过之后不再重复提交');

    // 每次构建全部网页的 lastmod 都变成当天：看作不可信，只重新提交站点地图
    for (const p of pages) p.m = D(20);
    const r2 = await refreshSite(env, 'x', s, 'KEY', { auto: true });
    assert.equal(r2.updated, 0);
    assert.equal(feeds.length, 2, '站点地图照样重新提交');
    assert.equal(row(pages[0].u).lastmod, Date.UTC(2026, 4, 20), '新时间照样记下');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM g_urls WHERE upd_at > b_submitted_at').get().n, 0, '不逐个提交给 Bing');
  } finally { globalThis.fetch = realFetch; }
});
