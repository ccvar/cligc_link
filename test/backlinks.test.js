// 外链与权重（src/backlinks.js）：在真实 SQLite 上跑同步逻辑，外部接口（Bing / Open PageRank）用假的 fetch 代替
// 需要 Node 22.13+ 自带的 node:sqlite；更老的 Node 上跳过
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seal } from '../src/google.js';
import { BL_RESET } from '../src/bing.js';
import { oprRow, syncOpr, syncBingLinks, blFlags, setEnabled, urlLinks, deleteOprConfig, status, BL_PAGES } from '../src/backlinks.js';

const sqlite = await import('node:sqlite').catch(() => null);
const SQL = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const skip = !sqlite && '需要 Node 22.13+（node:sqlite）';
const SECRET = 'test-secret';

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
const getSetting = (db, k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null;
const site = (db, host, bing = '') => db.prepare('INSERT INTO g_sites (host, bing_site) VALUES (?, ?)').run(host, bing);
const row = (db, host) => ({ ...db.prepare('SELECT * FROM g_sites WHERE host = ?').get(host) });

// 假的 fetch：按网址分给 handler，记录每次请求
function mockFetch(handler) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: u, init });
    const r = await handler(u, init);
    return new Response(JSON.stringify(r.body ?? null), { status: r.status || 200, headers: { 'content-type': 'application/json', ...(r.headers || {}) } });
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test('Open PageRank：解析单个域名（分数保留两位小数、历史只留最近 13 个月；没收录记为 -1）', () => {
  const hist = Array.from({ length: 17 }, (_, i) => ({ date: `2025-${String((i % 12) + 1).padStart(2, '0')}-01`, open_page_rank: 0.1 + i / 1000, estimated: false }));
  const o = oprRow({ domain: 'a.com', found: true, open_page_rank: 3.14159, rank: 123, referring_domains: 45, history: hist });
  assert.equal(o.opr, 3.14);
  assert.equal(o.rank, 123);
  assert.equal(o.ref, 45);
  assert.equal(o.hist.length, 13);
  assert.deepEqual(o.hist[0], ['2025-05', 0.1]);
  assert.deepEqual(oprRow({ domain: 'b.com', found: false, open_page_rank: null }), { opr: -1, rank: 0, ref: 0, hist: [] });
  assert.deepEqual(oprRow(undefined), { opr: -1, rank: 0, ref: 0, hist: [] });
});

test('Open PageRank：只查开了开关、到期的域名；每个请求最多 100 个；用量从响应头记下', { skip }, async () => {
  const { db, env } = fakeEnv();
  const hosts = Array.from({ length: 130 }, (_, i) => `s${i}.com`);
  for (const h of hosts) site(db, h);
  site(db, 'ga4-123');   // 没有域名的站点不查
  setting(db, 'int_opr', await seal(SECRET, { key: 'opr_live_0123456789abcdef0123' }));
  const m = mockFetch((u, init) => {
    const body = JSON.parse(init.body);
    return {
      headers: { 'x-domains-limit': '30000', 'x-domains-remaining': '29000', 'x-domains-reset': '1793491200' },
      body: { as_of: '2026-09-01', results: body.domains.filter((d) => d !== 's1.com').map((d, i) => ({ domain: d, found: d !== 's2.com', open_page_rank: d === 's2.com' ? null : 1 + i / 100, rank: 1000 + i, referring_domains: i, history: [{ date: '2026-08-01', open_page_rank: 0.5 }, { date: '2026-09-01', open_page_rank: 1 }] })) },
    };
  });
  try {
    // 没开开关：不发请求
    assert.deepEqual(await syncOpr(env, SECRET), { skipped: true });
    assert.equal(m.calls.length, 0);
    setting(db, 'bl_cfg', JSON.stringify({ opr: 1 }));
    const r = await syncOpr(env, SECRET, { maxReq: 1 });
    assert.equal(r.done, 100);
    assert.equal(r.left, 30);
    assert.equal(m.calls.length, 1);
    assert.equal(m.calls[0].init.headers.authorization, 'Bearer opr_live_0123456789abcdef0123');
    assert.equal(JSON.parse(m.calls[0].init.body).domains.length, 100);
    assert.ok(!JSON.parse(m.calls[0].init.body).domains.includes('ga4-123'));
    const r2 = await syncOpr(env, SECRET, { maxReq: 2 });
    assert.equal(r2.done, 30);
    assert.equal(r2.left, 0);
    // 查过的不再查
    assert.equal((await syncOpr(env, SECRET)).done, 0);
    assert.equal(m.calls.length, 2);
    assert.equal(row(db, 's0.com').opr, 1);
    assert.equal(row(db, 's1.com').opr, -1, '结果里没有的域名记为没有数据');
    assert.ok(row(db, 's1.com').opr_at > 0);
    assert.equal(row(db, 's2.com').opr, -1, '没收录的域名');
    assert.deepEqual(JSON.parse(row(db, 's0.com').opr_hist), [['2026-08', 0.5], ['2026-09', 1]]);
    assert.equal(row(db, 'ga4-123').opr_at, 0);
    const u = JSON.parse(getSetting(db, 'opr_usage'));
    assert.equal(u.remaining, 29000);
    assert.equal(u.asOf, '2026-09-01');
    assert.ok(getSetting(db, 'g_ver'), '更新数据版本（站点列表缓存）');
  } finally { m.restore(); }
});

test('Open PageRank：Key 无效时记下错误、不改已有数据；删除 Key 清掉分数并关闭', { skip }, async () => {
  const { db, env } = fakeEnv();
  site(db, 'a.com');
  db.prepare("UPDATE g_sites SET opr = 2.5, opr_at = 1 WHERE host = 'a.com'").run();
  setting(db, 'int_opr', await seal(SECRET, { key: 'opr_live_0123456789abcdef0123' }));
  setting(db, 'bl_cfg', JSON.stringify({ opr: 1 }));
  const m = mockFetch(() => ({ status: 401, body: { error: { type: 'authentication_error', message: 'Invalid OPR API key.' } } }));
  try {
    const r = await syncOpr(env, SECRET);
    assert.equal(r.done, 0);
    assert.equal(r.error, 'API Key 无效');
    assert.equal(JSON.parse(getSetting(db, 'opr_error')).msg, 'API Key 无效');
    assert.equal(row(db, 'a.com').opr, 2.5);
    assert.equal((await status(env, SECRET)).opr.error.msg, 'API Key 无效');
  } finally { m.restore(); }
  await deleteOprConfig(env);
  assert.equal(getSetting(db, 'int_opr'), null);
  assert.equal(getSetting(db, 'opr_error'), null);
  assert.equal(row(db, 'a.com').opr, -1);
  assert.equal(row(db, 'a.com').opr_at, 0);
  assert.deepEqual(await blFlags(env), { bing: false, opr: false });
});

test('Open PageRank：子域名的分数在根域名那一项的 hosts[] 里；同名时用域名本身那一项；没出错时清掉旧错误', { skip }, async () => {
  const { db, env } = fakeEnv();
  for (const h of ['docs.example.com', 'example.com', 'x.pages.dev']) site(db, h);
  setting(db, 'int_opr', await seal(SECRET, { key: 'opr_live_0123456789abcdef0123' }));
  setting(db, 'bl_cfg', JSON.stringify({ opr: 1 }));
  setting(db, 'opr_error', JSON.stringify({ msg: '请求太频繁，稍后再试', at: 1 }));
  const m = mockFetch(() => ({ body: { as_of: '2026-09-01', results: [
    { domain: 'example.com', found: true, open_page_rank: 9.54, rank: 21, referring_domains: 300214,
      hosts: [{ host: 'docs.example.com', found: true, open_page_rank: 9.43, rank: 1066, referring_hosts: 15349 }, { host: 'example.com', found: true, open_page_rank: 1, rank: 1, referring_hosts: 1 }] },
    { domain: 'x.pages.dev', found: false, open_page_rank: null, rank: null, referring_domains: null, hosts: [{ host: 'x.pages.dev', found: false, open_page_rank: null }] },
  ] } }));
  try {
    assert.equal((await syncOpr(env, SECRET)).done, 3);
    assert.deepEqual([row(db, 'docs.example.com').opr, row(db, 'docs.example.com').opr_rank, row(db, 'docs.example.com').opr_ref], [9.43, 1066, 15349]);
    assert.deepEqual([row(db, 'example.com').opr, row(db, 'example.com').opr_ref], [9.54, 300214]);
    assert.equal(row(db, 'x.pages.dev').opr, -1);
    assert.equal(getSetting(db, 'opr_error'), null);
    // 之后没有到期的域名、也没出错：旧错误同样清掉
    setting(db, 'opr_error', JSON.stringify({ msg: 'x', at: 1 }));
    assert.equal((await syncOpr(env, SECRET)).done, 0);
    assert.equal(getSetting(db, 'opr_error'), null);
  } finally { m.restore(); }
});

test('Bing 外链：一个站点翻到一半超时不保存（下次排在最前面重新查），也不动上一次的数字', { skip }, async () => {
  const { db, env } = fakeEnv();
  site(db, 'a.com', 'https://a.com/');
  site(db, 'b.com', 'https://b.com/');
  db.prepare("UPDATE g_sites SET bl_total = 300, bl_at = 1 WHERE host = 'a.com'").run();
  db.prepare("UPDATE g_sites SET bl_at = 2 WHERE host = 'b.com'").run();
  setting(db, 'int_bing', await seal(SECRET, { key: '0123456789abcdef0123456789abcdef' }));
  setting(db, 'bl_cfg', JSON.stringify({ bing: 1 }));
  let now = Date.now();
  const realNow = Date.now;
  const m = mockFetch(() => { now += 30000; return { body: { d: { Links: [{ Url: 'https://a.com/', Count: 100 }], TotalPages: 3 } } }; });
  Date.now = () => now;
  try {
    const r = await syncBingLinks(env, SECRET, { deadline: now + 10000 });
    assert.equal(r.done, 0);
    assert.equal(m.calls.length, 1, '超时后不再往下查');
    const a = row(db, 'a.com');
    assert.deepEqual([a.bl_total, a.bl_prev, a.bl_at], [300, -1, 1]);
    assert.equal(row(db, 'b.com').bl_at, 2);
  } finally { m.restore(); Date.now = realNow; }
});

test('Bing 外链：最多翻 BL_PAGES 页、合并同一网址、按外链数排序；bl_prev 记上一次的总数', { skip }, async () => {
  const { db, env } = fakeEnv();
  site(db, 'a.com', 'https://a.com/');
  site(db, 'b.com', 'https://b.com/');
  site(db, 'c.com');   // 没关联 Bing 的不查
  setting(db, 'int_bing', await seal(SECRET, { key: '0123456789abcdef0123456789abcdef' }));
  setting(db, 'bl_cfg', JSON.stringify({ bing: 1 }));
  db.prepare("UPDATE g_sites SET bl_total = 3 WHERE host = 'a.com'").run();
  const m = mockFetch((u) => {
    assert.equal(u.pathname.split('/').pop(), 'GetLinkCounts');
    const p = Number(u.searchParams.get('page'));
    if (u.searchParams.get('siteUrl') === 'https://b.com/') return { body: { d: { Links: [], TotalPages: 0 } } };
    return { body: { d: { Links: [{ Url: 'https://a.com/', Count: 2 }, { Url: `https://a.com/p${p}`, Count: p + 1 }, { Url: 'https://a.com/zero', Count: 0 }], TotalPages: 7 } } };
  });
  try {
    const r = await syncBingLinks(env, SECRET);
    assert.deepEqual(r, { done: 2, left: 0 });
    const a = row(db, 'a.com');
    assert.equal(m.calls.filter((c) => c.url.searchParams.get('siteUrl') === 'https://a.com/').length, BL_PAGES);
    assert.equal(a.bl_total, 2 * BL_PAGES + (1 + 2 + 3 + 4 + 5));
    assert.equal(a.bl_pages, 1 + BL_PAGES, '0 个外链的网址不算');
    assert.equal(a.bl_more, 1, '还有没查的页');
    assert.equal(a.bl_prev, 3);
    const top = JSON.parse(a.bl_top);
    assert.deepEqual(top[0], ['https://a.com/', 10]);
    assert.deepEqual(top[1], ['https://a.com/p4', 5]);
    const b = row(db, 'b.com');
    assert.equal(b.bl_total, 0);
    assert.equal(b.bl_prev, -1, '第一次查，没有上一次');
    assert.equal(b.bl_top, '');
    assert.equal(row(db, 'c.com').bl_at, 0);
    // 一周内不再查
    assert.deepEqual(await syncBingLinks(env, SECRET), { done: 0, left: 0 });
    // 关掉开关：标记不显示，也不再查
    await setEnabled(env, SECRET, { bing: false });
    assert.deepEqual(await blFlags(env), { bing: false, opr: false });
    assert.deepEqual(await syncBingLinks(env, SECRET, { cutoff: Date.now() + 1 }), { skipped: true });
  } finally { m.restore(); }
});

test('Bing 外链：限流就停下（下次接着查）；其他错误记下原因、保留已有数字、一天后再试', { skip }, async () => {
  const { db, env } = fakeEnv();
  site(db, 'a.com', 'https://a.com/');
  site(db, 'b.com', 'https://b.com/');
  site(db, 'c.com', 'https://c.com/');
  db.prepare("UPDATE g_sites SET bl_total = 8, bl_at = 1 WHERE host = 'a.com'").run();
  db.prepare("UPDATE g_sites SET bl_at = 2 WHERE host = 'b.com'").run();
  db.prepare("UPDATE g_sites SET bl_at = 3 WHERE host = 'c.com'").run();
  setting(db, 'int_bing', await seal(SECRET, { key: '0123456789abcdef0123456789abcdef' }));
  setting(db, 'bl_cfg', JSON.stringify({ bing: 1 }));
  const st = globalThis.setTimeout;
  globalThis.setTimeout = (f) => st(f, 0);   // 限流时的重试等待不用真等
  const m = mockFetch((u) => {
    const s = u.searchParams.get('siteUrl');
    if (s === 'https://a.com/') return { status: 400, body: { ErrorCode: 14, Message: 'NotAuthorized' } };
    if (s === 'https://b.com/') return { status: 429, body: null };
    return { body: { d: { Links: [], TotalPages: 0 } } };
  });
  try {
    const r = await syncBingLinks(env, SECRET);
    assert.equal(r.done, 0);
    assert.equal(r.throttled, true);
    const a = row(db, 'a.com');
    assert.match(a.bl_error, /没有权限/);
    assert.equal(a.bl_total, 8, '已有的数字保留');
    assert.ok(a.bl_at > 0 && a.bl_at < Date.now() - 5 * 86400000, '一天后再试');
    assert.equal(row(db, 'b.com').bl_at, 2, '限流的站点不动');
    assert.equal(row(db, 'c.com').bl_at, 3, '限流后不再往下查');
  } finally { m.restore(); globalThis.setTimeout = st; }
});

test('Bing 外链明细：只查这个站点自己的网址，结果缓存', { skip }, async () => {
  const { db, env } = fakeEnv();
  site(db, 'a.com', 'https://a.com/');
  setting(db, 'int_bing', await seal(SECRET, { key: '0123456789abcdef0123456789abcdef' }));
  const m = mockFetch((u) => {
    assert.equal(u.pathname.split('/').pop(), 'GetUrlLinks');
    assert.equal(u.searchParams.get('link'), 'https://a.com/x');
    return { body: { d: { Details: [{ Url: 'https://ref.com/post', AnchorText: ' a site ' }, { Url: '' }], TotalPages: 3 } } };
  });
  try {
    assert.match((await urlLinks(env, SECRET, 'a.com', 'https://a.com/x')).error, /没有开启/);
    setting(db, 'bl_cfg', JSON.stringify({ bing: 1 }));
    assert.match((await urlLinks(env, SECRET, 'a.com', 'https://evil.com/x')).error, /不属于/);
    assert.match((await urlLinks(env, SECRET, 'b.com', 'https://b.com/x')).error, /没有关联/);
    const r = await urlLinks(env, SECRET, 'a.com', 'https://a.com/x');
    assert.deepEqual(r, { page: 0, pages: 3, items: [{ u: 'https://ref.com/post', a: 'a site' }] });
    await urlLinks(env, SECRET, 'a.com', 'https://a.com/x');
    assert.equal(m.calls.length, 1, '第二次读缓存');
  } finally { m.restore(); }
});

test('Bing 换 Key / 删除 Key / 站点换了 Bing 资源时清空外链数据的语句可以执行', { skip }, async () => {
  const { db } = fakeEnv();
  site(db, 'a.com', 'https://a.com/');
  db.prepare("UPDATE g_sites SET bl_total = 5, bl_prev = 4, bl_top = '[]', bl_at = 9 WHERE host = 'a.com'").run();
  db.prepare(`UPDATE g_sites SET ${BL_RESET} WHERE bl_at > 0`).run();
  const a = row(db, 'a.com');
  assert.equal(a.bl_total, -1);
  assert.equal(a.bl_prev, -1);
  assert.equal(a.bl_at, 0);
  assert.equal(a.bl_top, '');
});
