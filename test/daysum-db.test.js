// 访问记录面板的按天汇总（src/agg.js daySummary）：已汇总的读 agg_d / agg_uv，没汇总的读原始明细；时区对不上不返回（node:sqlite 模拟 D1）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { daySummary, aggregate, dayKey } from '../src/agg.js';

const sqlite = await import('node:sqlite').catch(() => null);
const SQL = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const skip = !sqlite && '需要 Node 22.13+（node:sqlite）';

function setup() {
  const db = new sqlite.DatabaseSync(':memory:');
  for (const s of SQL.replace(/--[^\n]*/g, '').split(';').map((x) => x.trim()).filter(Boolean)) db.exec(s);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async first(col) { const r = db.prepare(sql).get(...args); return r ? (col ? r[col] : { ...r }) : null; },
    async all() { return { results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }; },
    async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return { db, env: { DB: { prepare: (sql) => stmt(sql), async batch(list) { for (const s of list) await s.run(); return []; } } } };
}

test('按天汇总：访问、访客、最多的短链和地区；汇总过的和最近的明细加在一起', { skip }, async () => {
  const { db, env } = setup();
  const tz = 480, now = Date.now();
  db.prepare("INSERT INTO links (id, slug, target_url, created_at, updated_at) VALUES (1, 'dbn', 'https://a.com', 1, 1), (2, 'dok', 'https://b.com', 1, 1)").run();
  const ins = db.prepare('INSERT INTO clicks (link_id, ts, is_bot, ip, source, country, device, os, browser) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  // 两小时前：会被汇总；刚才：还没汇总（明细尾巴）
  const t1 = Math.floor(now / 3600000) * 3600000 - 2 * 3600000 + 60000, t2 = now - 1000;
  for (let i = 0; i < 5; i++) ins.run(1, t1 + i, 0, `1.1.1.${i}`, 'x', 'CN', 'desktop', 'Windows', 'Chrome');
  ins.run(2, t1 + 10, 0, '1.1.1.0', 'x', 'US', 'desktop', 'Windows', 'Chrome');
  ins.run(2, t1 + 11, 1, '9.9.9.9', 'x', 'US', 'desktop', 'Windows', 'Bot');
  await aggregate(env, tz);
  ins.run(1, t2, 0, '2.2.2.2', 'x', 'CN', 'mobile', 'iOS', 'Safari');
  const d1 = dayKey(t1, tz), d2 = dayKey(t2, tz);
  const r = await daySummary(env, { days: [...new Set([d1, d2])], tz, bots: false });
  const sum = (k) => [...new Set([d1, d2])].reduce((a, d) => a + (r.days[d]?.[k] || 0), 0);
  assert.equal(sum('n'), 7, '5 + 1 汇总过的真人 + 1 条明细尾巴');
  assert.equal(r.days[d2].topLink.slug, 'dbn');
  assert.equal(r.days[d2].topCountry.k, 'CN');
  assert.ok(sum('uv') >= 6 && sum('uv') <= 8, `独立访客约 7：${sum('uv')}`);
  const withBots = await daySummary(env, { days: [d1], tz, bots: true });
  assert.equal(withBots.days[d1].machine, 1);
  // 浏览器时区和汇总时区不一样：按浏览器的日期从明细里算
  const raw = await daySummary(env, { days: [dayKey(t1, 0), dayKey(t2, 0)], tz: 0, bots: false });
  assert.equal(Object.values(raw.days).reduce((a, x) => a + x.n, 0), 7, '从明细算，数字一样');
  assert.equal(raw.days[dayKey(t2, 0)].topLink.slug, 'dbn');
});
