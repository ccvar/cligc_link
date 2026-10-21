// GA4 同步（src/google.js syncBatch / syncSite）：区间用户数一天只查一次；配额用完时这一批剩下的 GA4 站点先不同步、一小时后再试；
// 站点同步出错时详情页照常打开（node:sqlite 模拟 D1，假的 Google 接口）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seal, syncBatch, siteDetail } from '../src/google.js';

const sqlite = await import('node:sqlite').catch(() => null);
const SQL = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const skip = !sqlite && '需要 Node 22.13+（node:sqlite）';
const SECRET = 'test-secret';

async function setup() {
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
  db.prepare("INSERT INTO g_accounts (id, email, auth, connected_at, error, found, found_at) VALUES (?, 'me@x.com', ?, 1, '', '{}', ?)").run(uid, await seal(SECRET, { refresh: 'r1', scope: 'x' }), Date.now());
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('g_backfill', '486', 1)").run();
  for (const [h, p] of [['a.com', '1'], ['b.com', '2'], ['c.com', '3']]) db.prepare("INSERT INTO g_sites (host, ga4_property, ga4_acct, ch_at, synced_at, updated_at) VALUES (?, ?, ?, 1, 1, 1)").run(h, p, uid);
  return { db, env };
}
function mock(handler) {
  const real = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }));
    calls.push({ u, body: init.body ? JSON.parse(init.body) : null });
    return handler(u, init.body ? JSON.parse(init.body) : null);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const ok = () => new Response(JSON.stringify({ rows: [] }));

test('区间用户数一天只查一次；配额用完时剩下的 GA4 站点这一批先不同步，一小时后再试', { skip }, async () => {
  const { db, env } = await setup();
  let quota = false;
  const m = mock((u) => (quota && u.includes('/properties/2:') ? new Response(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }), { status: 429 }) : ok()));
  try {
    await syncBatch(env, SECRET, { limit: 10, cutoff: Date.now() });
    const users1 = m.calls.filter((c) => c.body?.dateRanges?.length === 4).length;
    assert.equal(users1, 9, '每个站点 3 个区间用户数请求');
    db.prepare('UPDATE g_sites SET synced_at = 1').run();
    m.calls.length = 0;
    await syncBatch(env, SECRET, { limit: 10, cutoff: Date.now() });
    assert.equal(m.calls.filter((c) => c.body?.dateRanges?.length === 4).length, 0, '20 小时内不再查区间用户数');
    // 第二个站点配额用完
    db.prepare('UPDATE g_sites SET synced_at = 1').run();
    quota = true; m.calls.length = 0;
    const r = await syncBatch(env, SECRET, { limit: 10, cutoff: Date.now() });
    assert.equal(r.quota, true);
    const b = db.prepare("SELECT synced_at, error FROM g_sites WHERE host = 'b.com'").get();
    assert.match(b.error, /配额已用完：RESOURCE_EXHAUSTED/, '错误里带上 Google 的状态');
    assert.ok(b.synced_at < Date.now() - 4.9 * 3600000 && b.synced_at > Date.now() - 5.1 * 3600000, '记成 5 小时前同步，一小时后再试');
    assert.equal(m.calls.filter((c) => c.u.includes('/properties/2:')).length, 1, '配额用完后这个站点不再发别的 GA4 请求');
    assert.equal(db.prepare("SELECT synced_at FROM g_sites WHERE host = 'c.com'").get().synced_at, 1, '后面的 GA4 站点这一批先不同步');
    // 同步出过错的站点，详情页照常返回（不是“站点不存在”）
    quota = false;
    const d = await siteDetail(env, SECRET, 'b.com', 28);
    assert.ok(!d.notFound); assert.match(d.error, /配额/);
    assert.equal((await siteDetail(env, SECRET, 'nope.com', 28)).notFound, true);
  } finally { m.restore(); }
});
