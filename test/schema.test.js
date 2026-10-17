// 建表脚本：按 migrate() 同样的方式切分 schema.sql，在全新的空数据库上逐条执行，确认不会因为语句顺序出错
// （D1 的 batch 是一个事务，任何一条失败整批回滚，全新部署就一张表都建不成）
// 需要 Node 22.13+ 自带的 node:sqlite；更老的 Node 上跳过这个测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sqlite = await import('node:sqlite').catch(() => null);
const SQL = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

test('schema.sql 能在全新数据库上完整执行（和 migrate() 的切分方式一致）', { skip: !sqlite && '需要 Node 22.13+（node:sqlite）' }, () => {
  const statements = SQL.replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean);
  const db = new sqlite.DatabaseSync(':memory:');
  for (const s of statements) assert.doesNotThrow(() => db.exec(s), `执行失败：${s.slice(0, 80)}`);
  // 再执行一遍：老部署每次升级都会重跑，必须全是 IF NOT EXISTS
  for (const s of statements) assert.doesNotThrow(() => db.exec(s), `重复执行失败：${s.slice(0, 80)}`);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  for (const t of ['links', 'clicks', 'link_targets', 'settings', 'g_sites', 'g_cache', 'g_urls', 'g_sitemaps', 'fb_seen']) assert.ok(tables.includes(t), `缺少表 ${t}`);
});
