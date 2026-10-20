// 热门搜索词（src/queries.js）：多个站点的 Google / Bing 搜索词合并、排序、缓存、分批加载（node:sqlite 模拟 D1，假的 Google / Bing 接口）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seal } from '../src/google.js';
import { hotQueries } from '../src/queries.js';

const sqlite = await import('node:sqlite').catch(() => null);
const SQL = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const skip = !sqlite && '需要 Node 22.13+（node:sqlite）';
const SECRET = 'test-secret';

async function setup(nSites = 2) {
  const db = new sqlite.DatabaseSync(':memory:');
  for (const s of SQL.replace(/--[^\n]*/g, '').split(';').map((x) => x.trim()).filter(Boolean)) db.exec(s);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async first(col) { const r = db.prepare(sql).get(...args); return r ? (col ? r[col] : { ...r }) : null; },
    async all() { return { results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }; },
    async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  const env = { DB: { prepare: (sql) => stmt(sql), async batch(list) { for (const s of list) await s.run(); return []; } },
    GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'secret-secret' };
  const uid = `u${Math.random().toString(36).slice(2)}`;
  db.prepare("INSERT INTO g_accounts (id, email, auth, connected_at, error, found) VALUES (?, 'me@x.com', ?, 1, '', '{}')").run(uid, await seal(SECRET, { refresh: 'r1', scope: 'x' }));
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('int_bing', ?, 1)").run(await seal(SECRET, { key: 'bk' }));
  for (let i = 0; i < nSites; i++) {
    const h = i === 0 ? 'a.com' : i === 1 ? 'b.com' : `s${i}.com`;
    db.prepare("INSERT INTO g_sites (host, gsc_site, gsc_acct, bing_site, updated_at) VALUES (?, ?, ?, ?, 1)").run(h, `sc-domain:${h}`, uid, i === 0 ? `https://${h}/` : '');
  }
  return { db, env };
}

function mock(handler) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }));
    calls.push(u);
    return new Response(JSON.stringify(handler(u, init.body ? JSON.parse(init.body) : null)));
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const day = (n) => `/Date(${Date.now() - n * 86400000})/`;

test('合并 Google 和 Bing 的搜索词，按热度排序，第二次读缓存', { skip }, async () => {
  const { env } = await setup();
  const m = mock((u) => {
    if (u.includes('sc-domain%3Aa.com')) return { rows: [{ keys: ['Foo Bar'], clicks: 3, impressions: 100, position: 4 }, { keys: ['only a'], clicks: 0, impressions: 5, position: 20 }] };
    if (u.includes('sc-domain%3Ab.com')) return { rows: [{ keys: ['foo  bar'], clicks: 1, impressions: 50, position: 10 }, { keys: ['big'], clicks: 9, impressions: 120, position: 2 }] };
    if (u.includes('GetQueryStats')) return { d: [{ Query: 'foo bar', Date: day(5), Clicks: 2, Impressions: 30, AvgImpressionPosition: 3 }, { Query: 'bing only', Date: day(5), Clicks: 0, Impressions: 8, AvgImpressionPosition: 6 }] };
    return {};
  });
  try {
    const r = await hotQueries(env, SECRET, [], 28);
    assert.equal(r.g.sites, 2); assert.equal(r.b.sites, 1); assert.equal(r.pending, 0); assert.deepEqual(r.errors, []);
    assert.deepEqual(r.items.map((x) => x.q), ['Foo Bar', 'big', 'bing only', 'only a'], '按 Google + Bing 展示合计排序');
    const foo = r.items[0];
    assert.equal(foo.q, 'Foo Bar', '同一个词不分大小写和空白合在一起，热度最高');
    assert.deepEqual(foo.g, { c: 4, i: 150, p: 6 }, 'Google 两个站点相加，排名按展示加权');
    assert.deepEqual(foo.b, { c: 2, i: 30, p: 3 });
    assert.equal(foo.n, 2); assert.deepEqual(foo.hosts[0], ['a.com', 100, 30]);
    assert.equal(r.items[1].q, 'big');
    assert.equal(r.items.find((x) => x.q === 'bing only').g, null);
    const n = m.calls.length;
    await hotQueries(env, SECRET, [], 28);
    assert.equal(m.calls.length, n, '一小时内读缓存');
    const only = await hotQueries(env, SECRET, ['b.com'], 28);
    assert.deepEqual(only.items.map((x) => x.q), ['big', 'foo  bar'], '只看筛选的站点');
  } finally { m.restore(); }
});

test('站点太多时分批查，出错的站点单独列出', { skip }, async () => {
  const { env } = await setup(70);
  const m = mock((u) => {
    if (u.includes('s5.com')) throw new Error('boom');
    if (u.includes('searchAnalytics')) return { rows: [{ keys: ['q'], clicks: 1, impressions: 2, position: 1 }] };
    if (u.includes('GetQueryStats')) return { d: [] };
    return {};
  });
  try {
    const r = await hotQueries(env, SECRET, [], 28);
    assert.equal(r.pending, 71 - 60, '一次最多查 60 个');
    assert.equal(r.pendingSites, 11, '还没查的涉及几个站点');
    assert.equal(r.progress.all, 71); assert.equal(r.progress.done, 59, '查过的（一个读取失败）');
    assert.equal(r.errors.length, 1); assert.equal(r.errors[0].host, 's5.com');
    const r2 = await hotQueries(env, SECRET, [], 28);
    assert.equal(r2.pending, 0, '第二次接着查剩下的');
    assert.equal(r2.g.loaded, 69);
    assert.equal(r2.items[0].n, 69);
  } finally { m.restore(); }
});

test('地区：只查 Google 的国家 / 地区，代码统一大写，和搜索词分开缓存', { skip }, async () => {
  const { env } = await setup();
  const m = mock((u, body) => {
    if (u.includes('searchAnalytics')) {
      assert.deepEqual(body.dimensions, ['country']);
      return u.includes('a.com') ? { rows: [{ keys: ['usa'], clicks: 5, impressions: 100, position: 3 }, { keys: ['chn'], clicks: 1, impressions: 40, position: 8 }] }
        : { rows: [{ keys: ['usa'], clicks: 1, impressions: 50, position: 5 }] };
    }
    if (u.includes('GetQueryStats')) throw new Error('地区不该查 Bing');
    return {};
  });
  try {
    const r = await hotQueries(env, SECRET, [], 28, 'country');
    assert.equal(r.b.sites, 0, '地区没有 Bing');
    assert.deepEqual(r.items.map((x) => x.q), ['USA', 'CHN']);
    assert.deepEqual(r.items[0].g, { c: 6, i: 150, p: 3.7 });
    assert.equal(r.items[0].n, 2);
    assert.ok(!m.calls.some((u) => u.includes('GetQueryStats')));
  } finally { m.restore(); }
});

test('缓存 24 小时；超过 24 小时或早于手动刷新的先拿旧数据显示，同时重查；定时任务提前查好', { skip }, async () => {
  const { db, env } = await setup();
  let n = 0;
  const m = mock((u) => {
    n++;
    if (u.includes('searchAnalytics')) return { rows: [{ keys: [`v${n}`], clicks: 1, impressions: 10, position: 1 }] };
    if (u.includes('GetQueryStats')) return { d: [] };
    return {};
  });
  try {
    const { warmQueries } = await import('../src/queries.js');
    const w = await warmQueries(env, SECRET, { limit: 100 });
    assert.equal(w.done, 5, '两个站点：Google 搜索词 ×2、Bing ×1、Google 地区 ×2');
    const calls = m.calls.length;
    const r1 = await hotQueries(env, SECRET, [], 28);
    assert.equal(m.calls.length, calls, '提前查好了，打开时不用再查');
    assert.ok(r1.updated.min > 0);
    // 23 小时前的照样用；25 小时前的要重查，但这次先显示旧数据
    db.prepare("UPDATE g_cache SET at = ? WHERE k LIKE 'hq-g|%'").run(Date.now() - 23 * 3600000);
    await hotQueries(env, SECRET, [], 28);
    assert.equal(m.calls.length, calls, '24 小时内不重查');
    db.prepare("UPDATE g_cache SET at = ? WHERE k LIKE 'hq-g|%'").run(Date.now() - 25 * 3600000);
    const r2 = await hotQueries(env, SECRET, [], 28);
    assert.equal(m.calls.length, calls + 2, '过期的两个重查');
    assert.ok(r2.updated.min > Date.now() - 60000, '重查后更新时间是现在');
    // 手动刷新：早于这个时间的都重查
    const before = m.calls.length;
    await hotQueries(env, SECRET, [], 28, 'query', { fresh: Date.now() + 1 });
    assert.equal(m.calls.length, before + 3, 'Google ×2 + Bing ×1 都重查');
  } finally { m.restore(); }
});
