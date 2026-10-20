// 站点地图批量提交（src/sitemaps.js）：列出两边各缺哪些、补交、两边都没有时去网站上找、定时任务自动补交（node:sqlite 模拟 D1，假的 Google / Bing 接口）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seal } from '../src/google.js';
import * as sm from '../src/sitemaps.js';

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
  db.prepare("INSERT INTO g_accounts (id, email, auth, connected_at, error, found) VALUES (?, 'me@x.com', ?, 1, '', '{}')").run(uid, await seal(SECRET, { refresh: 'r1', scope: 'https://www.googleapis.com/auth/webmasters' }));
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('int_bing', ?, 1)").run(await seal(SECRET, { key: 'bk' }));
  // a.com：Google 有站点地图，Bing 没有；b.com：只关联了 Google，什么都没有；c.com：两边都提交了
  db.prepare("INSERT INTO g_sites (host, gsc_site, gsc_acct, bing_site, updated_at) VALUES ('a.com', 'sc-domain:a.com', ?, 'https://a.com/', 1), ('b.com', 'sc-domain:b.com', ?, '', 1), ('c.com', 'sc-domain:c.com', ?, 'https://c.com/', 1)").run(uid, uid, uid);
  db.prepare("INSERT INTO g_sitemaps (host, list, b_feeds, at) VALUES ('a.com', ?, '[]', 1), ('c.com', ?, ?, 1)").run(
    JSON.stringify([{ path: 'https://a.com/sitemap.xml' }]), JSON.stringify([{ path: 'https://c.com/sm.xml' }]), JSON.stringify([{ path: 'https://c.com/sm.xml' }]));
  return { db, env };
}

function mock() {
  const real = globalThis.fetch;
  const st = { g: [], b: [] };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }));
    if (u.includes('/sitemaps/') && init.method === 'PUT') { st.g.push(decodeURIComponent(u.split('/sitemaps/')[1])); return new Response(null, { status: 204 }); }
    if (u.includes('/SubmitFeed')) { st.b.push(JSON.parse(init.body).feedUrl); return new Response(JSON.stringify({ d: null })); }
    if (u === 'https://b.com/') return new Response('ok');
    if (u === 'https://b.com/robots.txt') return new Response('Sitemap: https://b.com/sitemap-index.xml\n');
    return new Response('', { status: 404 });
  };
  return { st, restore: () => { globalThis.fetch = real; } };
}

test('列出两边各缺哪些，补交缺的；两边都没有时去 robots.txt 找', { skip }, async () => {
  const { db, env } = await setup();
  const m = mock();
  try {
    const by = new Map((await sm.smList(env)).items.map((x) => [x.host, x]));
    assert.deepEqual(by.get('a.com').b.missing, ['https://a.com/sitemap.xml'], 'Google 有、Bing 没有');
    assert.deepEqual(by.get('a.com').g.missing, []);
    assert.deepEqual(by.get('b.com').known, [], 'b.com 还不知道站点地图');
    assert.equal(by.get('b.com').b.on, false);
    assert.deepEqual([by.get('c.com').g.missing, by.get('c.com').b.missing], [[], []], 'c.com 两边都提交了');
    const a = await sm.smSubmit(env, SECRET, 'a.com');
    assert.deepEqual(a.b.done, ['https://a.com/sitemap.xml']); assert.deepEqual(m.st.b, ['https://a.com/sitemap.xml']);
    assert.deepEqual(a.state.b.missing, [], '记下了，不用等下次刷新');
    const b = await sm.smSubmit(env, SECRET, 'b.com');
    assert.deepEqual(b.g.done, ['https://b.com/sitemap-index.xml'], '从 robots.txt 找到并提交给 Google');
    assert.equal(JSON.parse(db.prepare("SELECT list FROM g_sitemaps WHERE host = 'b.com'").get().list)[0].path, 'https://b.com/sitemap-index.xml');
  } finally { m.restore(); }
});

test('定时任务自动补交：跟着开关走，每个站点一天最多试一次', { skip }, async () => {
  const { db, env } = await setup();
  const m = mock();
  try {
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('sm_auto_b', '0', 1)").run();
    const off = await sm.smAutoFill(env, SECRET);
    assert.equal(m.st.b.length, 0, 'Bing 的自动提交关了就不补交');
    assert.ok(off.skipped || off.done === 0 || off.sites === 0);
    db.prepare("UPDATE settings SET value = '1' WHERE key = 'sm_auto_b'").run();
    const r = await sm.smAutoFill(env, SECRET);
    assert.equal(r.bing, 1); assert.deepEqual(m.st.b, ['https://a.com/sitemap.xml']);
    db.prepare("UPDATE g_sitemaps SET b_feeds = '[]' WHERE host = 'a.com'").run();
    await sm.smAutoFill(env, SECRET);
    assert.equal(m.st.b.length, 1, '一天之内不再试');
  } finally { m.restore(); }
});
