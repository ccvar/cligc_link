// 汇总、明细清理在真实 SQLite 上的行为（用 node:sqlite 模拟 D1 的 prepare / bind / first / all / run / batch）
// 需要 Node 22.13+ 自带的 node:sqlite；更老的 Node 上跳过
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aggregate, aggQuery, pruneClicks, PRUNE_PER_RUN, dayKey, HOUR, DAY } from '../src/agg.js';

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
function addLinks(db, ids) {
  for (const id of ids) db.prepare('INSERT INTO links (id, slug, created_at, updated_at) VALUES (?, ?, 0, 0)').run(id, `s${id}`);
}
function addClicks(db, rows) {
  const st = db.prepare('INSERT INTO clicks (link_id, ts, ip, country, source, is_bot, kind) VALUES (?, ?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  for (const r of rows) st.run(r.link_id, r.ts, r.ip, r.country || '', r.source || '', r.is_bot || 0, r.is_bot ? 'bot' : 'human');
  db.exec('COMMIT');
}
const count = (db, where = '1') => db.prepare(`SELECT COUNT(*) AS n FROM clicks WHERE ${where}`).get().n;
const setting = (db, k, v) => db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));

test('数据保留：每次整点任务最多删 PRUNE_PER_RUN 条，积压的分几次删完', { skip }, async () => {
  const { db, env } = fakeEnv();
  addLinks(db, [1]);
  const old = Date.now() - 100 * DAY;
  addClicks(db, Array.from({ length: 1200 }, (_, i) => ({ link_id: 1, ts: old + i, ip: `ip${i}` })));
  addClicks(db, [{ link_id: 1, ts: Date.now() - DAY, ip: 'new' }]);
  setting(db, 'retention_days', 60);
  setting(db, 'agg_mark', Math.floor(Date.now() / HOUR) * HOUR);
  assert.equal(await pruneClicks(env), PRUNE_PER_RUN);
  assert.equal(await pruneClicks(env), PRUNE_PER_RUN);
  assert.equal(await pruneClicks(env), 200);
  assert.equal(await pruneClicks(env), 0);
  assert.equal(count(db), 1, '保留期内的不删');
});

test('数据保留：付费版每次多删一些（分批，每批最多 2000 条），访问多的站点也追得上', { skip }, async () => {
  const { db, env } = fakeEnv();
  addLinks(db, [1]);
  const old = Date.now() - 100 * DAY;
  addClicks(db, Array.from({ length: 4500 }, (_, i) => ({ link_id: 1, ts: old + i, ip: `ip${i}` })));
  setting(db, 'retention_days', 60);
  setting(db, 'agg_mark', Math.floor(Date.now() / HOUR) * HOUR);
  setting(db, 'cf_plan', 'paid');
  assert.equal(await pruneClicks(env), 4500);
  assert.equal(count(db), 0);
  // 自动识别：用量缓存里识别为付费版时同样多删；识别不出来按免费版
  addClicks(db, Array.from({ length: 900 }, (_, i) => ({ link_id: 1, ts: old + i, ip: `b${i}` })));
  setting(db, 'cf_plan', 'auto');
  setting(db, 'usage_cache', JSON.stringify({ detected: null }));
  assert.equal(await pruneClicks(env), PRUNE_PER_RUN);
  setting(db, 'usage_cache', JSON.stringify({ detected: 'paid' }));
  assert.equal(await pruneClicks(env), 400);
});

test('汇总：单条短链按日期 / 小时列表精确查找，结果和明细一致；概览照旧', { skip }, async () => {
  const { db, env } = fakeEnv();
  addLinks(db, [1, 2, 3]);
  const now = Date.now(), rows = [];
  // 10 天的访问：3 条短链，部分是机器访问；最近一小时也有（读原始明细的尾巴）
  for (let d = 0; d < 10; d++) for (const lid of [1, 2, 3]) for (let i = 0; i < 3 + lid + d; i++) {
    rows.push({ link_id: lid, ts: now - d * DAY - i * 60000 - (d ? 0 : 1000), ip: `${lid}-${d}-${i % 4}`, country: ['US', 'CN', 'JP'][i % 3], is_bot: i % 5 === 4 ? 1 : 0 });
  }
  addClicks(db, rows);
  await aggregate(env, 0);

  const q = await aggQuery(env, { days: 7, tz: 0, bots: false, linkId: 2 });
  const mine = rows.filter((r) => r.link_id === 2 && !r.is_bot && r.ts >= q.start && r.ts < q.now);
  const byCountry = {};
  for (const r of mine) byCountry[r.country] = (byCountry[r.country] || 0) + 1;
  const top = await q.top('country');
  assert.deepEqual(Object.fromEntries(top.map((x) => [x.k, x.n])), byCountry);
  const total = await q.total(q.firstDay, q.today, q.start, q.now);
  assert.equal(total.total, mine.length);
  const daily = await q.daily(q.firstDay, q.today, q.start, q.now);
  const byDay = {};
  for (const r of mine) byDay[dayKey(r.ts, 0)] = (byDay[dayKey(r.ts, 0)] || 0) + 1;
  assert.deepEqual(Object.fromEntries(daily.map((x) => [x.k, x.n])), byDay);
  const hours = await q.hours(q.start, q.now);
  assert.equal(hours.reduce((a, b) => a + b.n, 0), mine.length);
  // 概览（全部短链，含机器访问）
  const all = await aggQuery(env, { days: 7, tz: 0, bots: true, linkId: 0 });
  const t = await all.total(all.firstDay, all.today, all.start, all.now);
  assert.equal(t.total, rows.filter((r) => r.ts >= all.start && r.ts < all.now).length);
  assert.equal((await all.hours(all.start, all.now)).reduce((a, b) => a + b.n, 0), t.total);
});
