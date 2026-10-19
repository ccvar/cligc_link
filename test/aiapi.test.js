// AI 接口：令牌、权限、删除类操作待确认（node:sqlite 模拟 D1）；事件规则的参数校验
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createToken, listTokens, revokeToken, handleAi, decideOp, listOps, tokenHash } from '../src/aiapi.js';
import { ruleBody, gtagSnippet } from '../src/ga4admin.js';

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
  const DB = { prepare: (sql) => stmt(sql), async batch(list) { const out = []; for (const s of list) out.push(await s.run()); return out; } };
  return { db, env: { DB } };
}
const call = (env, method, path, token, body) => handleAi(new Request(`https://x.test${path}`, {
  method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
}), env, new URL(`https://x.test${path}`), { secret: 's', sitesForAi: async () => [{ host: 'a.com' }] });

test('ruleBody：校验事件名和匹配方式，生成 GA4 的事件创建规则', () => {
  assert.deepEqual(ruleBody({ event: 'purchase', value: '/thank-you' }), {
    destinationEvent: 'purchase', sourceCopyParameters: true,
    eventConditions: [{ field: 'event_name', comparisonType: 'EQUALS', value: 'page_view' }, { field: 'page_location', comparisonType: 'CONTAINS', value: '/thank-you' }],
  });
  assert.throws(() => ruleBody({ event: '9bad' }), /字母开头/);
  assert.throws(() => ruleBody({ event: 'page_view' }), /不能和来源事件一样/);
  assert.throws(() => ruleBody({ event: 'x', match: 'LIKE' }), /匹配方式/);
  assert.equal(ruleBody({ event: 'x', match: 'starts_with', value: 'a' }).eventConditions[1].comparisonType, 'STARTS_WITH');
  assert.match(gtagSnippet('G-ABC'), /gtag\('config', 'G-ABC'\)/);
});

test('AI 令牌：只存哈希，权限、过期、吊销都生效', { skip }, async () => {
  const { db, env } = fakeEnv();
  const t = await createToken(env, { hours: 1, perms: ['events'] });
  assert.match(t.token, /^cl_tk_/);
  assert.deepEqual(t.perms, ['read', 'events'], '读取权限总是带上');
  assert.equal(db.prepare('SELECT hash FROM ai_tokens').get().hash, await tokenHash(t.token));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_tokens WHERE hash LIKE ?').get('%' + t.token + '%').n, 0, '不存明文');

  assert.equal((await call(env, 'GET', '/api/ai')).status, 200, '接口说明不用令牌');
  assert.equal((await call(env, 'GET', '/api/ai/sites')).status, 401);
  assert.equal((await call(env, 'GET', '/api/ai/sites', 'cl_tk_wrongwrongwrongwrongwrong')).status, 401);
  const r = await call(env, 'GET', '/api/ai/sites', t.token);
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).sites, [{ host: 'a.com' }]);
  assert.equal((await call(env, 'POST', '/api/ai/ga4/properties', t.token, { url: 'https://n.com' })).status, 403, '没有新建权限');

  db.prepare('UPDATE ai_tokens SET expires_at = 1').run();
  assert.equal((await call(env, 'GET', '/api/ai/me', t.token)).status, 401, '过期');
  db.prepare('UPDATE ai_tokens SET expires_at = ?').run(Date.now() + 3600000);
  await revokeToken(env, t.id);
  assert.equal((await call(env, 'GET', '/api/ai/me', t.token)).status, 401, '吊销');
  assert.equal((await listTokens(env))[0].revoked, true);
});

test('AI 删除类操作：没有 delete 权限时先待确认，后台拒绝后不执行', { skip }, async () => {
  const { env } = fakeEnv();
  const t = await createToken(env, { hours: 24, perms: ['read', 'events'] });
  const r = await call(env, 'DELETE', '/api/ai/sites/a.com/event-rules/123', t.token);
  assert.equal(r.status, 202);
  const { op, status } = await r.json();
  assert.equal(status, 'pending');
  const k = await call(env, 'POST', '/api/ai/sites/a.com/key-events', t.token, { event: 'purchase', on: false });
  assert.equal(k.status, 202, '取消关键事件也算删除类');
  assert.equal((await listOps(env, { pending: true })).length, 2);
  assert.deepEqual(await decideOp(env, 's', op, false, 'https://x.test'), { ok: true, status: 'rejected' });
  assert.equal((await decideOp(env, 's', op, true, 'https://x.test')).error, '这条操作已经处理过了');
  const o = await (await call(env, 'GET', `/api/ai/ops/${op}`, t.token)).json();
  assert.equal(o.status, 'rejected');
  await revokeToken(env, t.id);
  assert.equal((await listOps(env, { pending: true })).length, 0, '吊销令牌时待确认的操作一起作废');
});
