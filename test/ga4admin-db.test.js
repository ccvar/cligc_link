// GA4 管理（src/ga4admin.js）：用假的 Google 接口跑一遍新建媒体资源、读取事件、关键事件、事件规则（node:sqlite 模拟 D1）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seal } from '../src/google.js';
import * as ga from '../src/ga4admin.js';

const sqlite = await import('node:sqlite').catch(() => null);
const SQL = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const skip = !sqlite && '需要 Node 22.13+（node:sqlite）';
const SECRET = 'test-secret';
const EDIT = 'openid email https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/analytics.edit https://www.googleapis.com/auth/webmasters';

async function setup({ scope = EDIT } = {}) {
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
  const uid = `u${Math.random().toString(36).slice(2)}`;   // 每个测试不同的账号 ID，避开访问令牌缓存
  db.prepare("INSERT INTO g_accounts (id, email, auth, connected_at, error, found) VALUES (?, 'me@x.com', ?, 1, '', ?)")
    .run(uid, await seal(SECRET, { refresh: 'r1', scope }), JSON.stringify({ props: [{ id: '111', name: 'A', account: 'Main', host: 'a.com' }], gsc: [], errors: [] }));
  db.prepare("INSERT INTO g_sites (host, ga4_property, ga4_name, ga4_acct, updated_at) VALUES ('a.com', '111', 'A', ?, 1)").run(uid);
  return { db, env, uid };
}

// 假的 Google 接口：记下每个请求，按地址返回
function mockGoogle(handler) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url), method = init.method || 'GET', body = init.body && typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : null;
    if (u.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }));
    calls.push({ method, url: u, body });
    const r = handler(method, u, body);
    return new Response(JSON.stringify(r?.body ?? r ?? {}), { status: r?.status || 200 });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test('新建媒体资源：建资源和网站数据流，返回衡量 ID 和代码，站点加进列表', { skip }, async () => {
  const { db, env, uid } = await setup();
  const g = mockGoogle((m, u) => {
    if (u.includes('/accountSummaries')) return { accountSummaries: [{ account: 'accounts/9', displayName: 'Main', propertySummaries: [] }] };
    if (m === 'POST' && u.endsWith('/v1beta/properties')) return { name: 'properties/222', displayName: 'new.com' };
    if (m === 'POST' && u.endsWith('/properties/222/dataStreams')) return { name: 'properties/222/dataStreams/5', webStreamData: { measurementId: 'G-NEW123' } };
  });
  try {
    const r = await ga.createProperty(env, SECRET, { acct: uid, account: 'accounts/9', url: 'new.com/path', timeZone: 'Asia/Shanghai', currency: 'CNY' });
    assert.equal(r.measurementId, 'G-NEW123');
    assert.match(r.snippet, /G-NEW123/);
    const p = g.calls.find((c) => c.url.endsWith('/v1beta/properties'));
    assert.deepEqual(p.body, { parent: 'accounts/9', displayName: 'new.com', timeZone: 'Asia/Shanghai', currencyCode: 'CNY' });
    assert.equal(g.calls.find((c) => c.url.endsWith('/dataStreams')).body.webStreamData.defaultUri, 'https://new.com');
    assert.equal(db.prepare("SELECT ga4_property FROM g_sites WHERE host = 'new.com'").get()?.ga4_property, '222', '新站点进了列表');
    await assert.rejects(ga.createProperty(env, SECRET, { acct: uid, account: 'accounts/9', url: 'https://a.com' }), /已经有 GA4 媒体资源/);
    await assert.rejects(ga.createProperty(env, SECRET, { acct: uid, account: 'bad', url: 'https://b.com' }), /GA4 账号/);
  } finally { g.restore(); }
});

test('没有 GA4 编辑权限：写操作提示重新授权，不调用 Google', { skip }, async () => {
  const { env } = await setup({ scope: 'openid email https://www.googleapis.com/auth/analytics.readonly' });
  const g = mockGoogle(() => ({}));
  try {
    await assert.rejects(ga.setKeyEvent(env, SECRET, 'a.com', 'purchase', true), (e) => e.reauth === true);
    assert.equal(g.calls.length, 0);
  } finally { g.restore(); }
});

test('事件：列表合并收到的事件、关键事件、规则；设置关键事件；新建 / 删除规则', { skip }, async () => {
  const { env } = await setup();
  const keys = [{ name: 'properties/111/keyEvents/1', eventName: 'purchase', deletable: false }];
  const g = mockGoogle((m, u, b) => {
    if (u.includes(':runReport')) return { rows: [{ dimensionValues: [{ value: 'page_view' }], metricValues: [{ value: '120' }] }, { dimensionValues: [{ value: 'purchase' }], metricValues: [{ value: '3' }] }] };
    if (u.includes('/keyEvents') && m === 'GET') return { keyEvents: keys };
    if (u.includes('/keyEvents') && m === 'POST') { keys.push({ name: 'properties/111/keyEvents/2', eventName: b.eventName }); return keys.at(-1); }
    if (u.includes('/keyEvents/2') && m === 'DELETE') return {};
    if (u.endsWith('/properties/111/dataStreams')) return { dataStreams: [{ name: 'properties/111/dataStreams/7', type: 'WEB_DATA_STREAM', webStreamData: { measurementId: 'G-A' } }] };
    if (u.includes('/eventCreateRules') && m === 'GET') return { eventCreateRules: [{ name: 'properties/111/dataStreams/7/eventCreateRules/88', destinationEvent: 'sign_up',
      eventConditions: [{ field: 'event_name', comparisonType: 'EQUALS', value: 'page_view' }, { field: 'page_location', comparisonType: 'CONTAINS', value: '/welcome' }] }] };
    if (u.includes('/eventCreateRules') && m === 'POST') return { name: 'properties/111/dataStreams/7/eventCreateRules/99', ...b };
    if (u.includes('/eventCreateRules/88') && m === 'DELETE') return {};
  });
  try {
    const d = await ga.listEvents(env, SECRET, 'a.com');
    assert.equal(d.measurementId, 'G-A');
    assert.deepEqual(d.events.map((e) => [e.name, e.count, e.key, e.type]), [['page_view', 120, false, 'auto'], ['purchase', 3, true, 'recommended'], ['sign_up', 0, false, 'recommended']]);
    assert.equal(ga.eventType('scroll'), 'enhanced');
    assert.equal(ga.eventType('exchange_signup_click'), 'custom');
    assert.equal(d.events[2].rules[0].id, '88');
    await assert.rejects(ga.setKeyEvent(env, SECRET, 'a.com', 'purchase', false), /不能取消/);
    await ga.setKeyEvent(env, SECRET, 'a.com', 'sign_up', true);
    assert.equal(g.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/keyEvents')).length, 1);
    await ga.setKeyEvent(env, SECRET, 'a.com', 'sign_up', true);
    assert.equal(g.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/keyEvents')).length, 1, '已经是关键事件时不重复创建');
    await ga.setKeyEvent(env, SECRET, 'a.com', 'sign_up', false);
    assert.ok(g.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/v1beta/properties/111/keyEvents/2')));
    const r = await ga.createEventRule(env, SECRET, 'a.com', { event: 'purchase_done', value: '/thanks', key: false });
    assert.equal(r.rule.id, '99');
    assert.ok(g.calls.some((c) => c.method === 'POST' && c.url.endsWith('/v1alpha/properties/111/dataStreams/7/eventCreateRules')));
    await ga.deleteEventRule(env, SECRET, 'a.com', '88');
    assert.ok(g.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/v1alpha/properties/111/dataStreams/7/eventCreateRules/88')));
    await assert.rejects(ga.deleteEventRule(env, SECRET, 'a.com', '../x'), /规则 ID/);
  } finally { g.restore(); }
});

test('新建媒体资源没有权限：换另一个能访问这个 GA4 账号、有编辑权限的 Google 账号；都不行时说清楚缺什么', { skip }, async () => {
  const { db, env, uid } = await setup();
  const uid2 = `v${Math.random().toString(36).slice(2)}`;
  db.prepare("INSERT INTO g_accounts (id, email, auth, connected_at, error, found) VALUES (?, 'boss@x.com', ?, 2, '', '{}')").run(uid2, await seal(SECRET, { refresh: 'r2', scope: EDIT }));
  let tokenN = 0, allow = true;
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    // 两个 Google 账号拿到不同的访问令牌，好分辨是谁在请求
    if (u.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: String(init.body).includes('r2') ? 'boss' : `me${tokenN++}`, expires_in: 3600 }));
    const who = init.headers?.authorization?.includes('boss') ? 'boss' : 'me';
    calls.push(`${who} ${init.method || 'GET'} ${u}`);
    if (u.includes('/accountSummaries')) return new Response(JSON.stringify({ accountSummaries: [{ account: 'accounts/9', displayName: 'blockvar', propertySummaries: [] }] }));
    if (u.endsWith('/v1beta/properties') && (who === 'me' || !allow)) return new Response(JSON.stringify({ error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } }), { status: 403 });
    if (u.endsWith('/v1beta/properties')) return new Response(JSON.stringify({ name: 'properties/777', displayName: 'new.com' }));
    if (u.endsWith('/properties/777/dataStreams')) return new Response(JSON.stringify({ name: 'properties/777/dataStreams/1', webStreamData: { measurementId: 'G-OK' } }));
    return new Response('{}');
  };
  try {
    const r = await ga.createProperty(env, SECRET, { acct: uid, account: 'accounts/9', url: 'new.com' });
    assert.equal(r.measurementId, 'G-OK', '换成 boss@x.com 建好了');
    assert.ok(calls.some((c) => c.startsWith('boss POST') && c.endsWith('/v1beta/properties')));
    allow = false;
    db.prepare("DELETE FROM g_sites WHERE host = 'new2.com'").run();
    await assert.rejects(ga.createProperty(env, SECRET, { acct: uid, account: 'accounts/9', url: 'new2.com' }), /me@x\.com 在 GA4 账号“blockvar”里没有新建媒体资源的权限/);
  } finally { globalThis.fetch = real; }
});
