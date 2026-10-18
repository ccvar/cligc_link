// 站点优化建议的规则（src/advice.js 的 siteRules）：门槛以内不提醒，超过才提醒
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteRules } from '../src/advice.js';

const DAY = 86400000;
const ymd = (t) => new Date(t).toISOString().slice(0, 10);
// n 天前的一行 g_daily
const day = (n, v) => ({ date: ymd(Date.now() - n * DAY), ...v });
const rules = (list) => list.map((a) => a.rule).sort();
const GA = { ga4_property: '1', synced_at: Date.now(), error: '' };

test('GA4 停止上报：前两周有访问、最近 3 天（跳过昨天）没有；同步出错或数据太少时不提醒', () => {
  const rows = Array.from({ length: 14 }, (_, i) => day(5 + i, { sessions: 10 }));
  assert.deepEqual(rules(siteRules(GA, rows, null, null)), ['ga_stopped']);
  assert.equal(siteRules(GA, [...rows, day(3, { sessions: 1 })], null, null).length, 0, '最近 3 天有访问');
  assert.equal(siteRules({ ...GA, error: '无权限' }, rows, null, null).length, 0, '同步出错时是同步的问题，不是代码掉了');
  assert.equal(siteRules(GA, rows.slice(0, 4), null, null).length, 0, '之前访问太少');
  assert.equal(siteRules(GA, [...rows, day(1, { sessions: 0 })], null, null)[0].rule, 'ga_stopped', '昨天的数据不算（GA4 有延迟）');
});

test('搜索点击下滑：最近 7 天比前 7 天少 30% 以上，之前太少不算；少一半以上为“重要”', () => {
  const s = { gsc_site: 'sc-domain:a.com' };
  const mk = (cur, prev) => [...Array.from({ length: 7 }, (_, i) => day(3 + i, { clicks: cur / 7 })), ...Array.from({ length: 7 }, (_, i) => day(10 + i, { clicks: prev / 7 }))];
  const a = siteRules(s, mk(35, 70), null, null).find((x) => x.rule === 'traffic_drop');
  assert.equal(a.level, 'high');
  assert.equal(a.n.pct, 50);
  assert.equal(siteRules(s, mk(42, 70), null, null).find((x) => x.rule === 'traffic_drop').level, 'mid', '少 40%');
  assert.equal(siteRules(s, mk(60, 70), null, null).some((x) => x.rule === 'traffic_drop'), false, '只少 14%');
  assert.equal(siteRules(s, mk(5, 20), null, null).some((x) => x.rule === 'traffic_drop'), false, '之前太少');
  // Bing 的点击也算进去
  const withBing = [...mk(35, 70).map((r) => ({ ...r, b_clicks: r.date >= ymd(Date.now() - 9 * DAY) ? 5 : 0 }))];
  assert.equal(siteRules(s, withBing, null, null).some((x) => x.rule === 'traffic_drop'), false);
});

test('整站点击率偏低：曝光够多、点击率不到该排名常见值的一半', () => {
  const s = { gsc_site: 'sc-domain:a.com' };
  const rows = Array.from({ length: 28 }, (_, i) => day(3 + i, { impressions: 100, clicks: 1, position: 3 }));   // 1% vs 常见 10%
  const a = siteRules(s, rows, null, null).find((x) => x.rule === 'site_ctr');
  assert.ok(a && a.n.lost > 200);
  assert.equal(siteRules(s, rows.map((r) => ({ ...r, clicks: 8 })), null, null).some((x) => x.rule === 'site_ctr'), false);
  assert.equal(siteRules(s, rows.slice(0, 10), null, null).some((x) => x.rule === 'site_ctr'), false, '曝光不到 2000');
});

test('收录：收录率低带主要原因；有问题的网址；站点地图失败或没有；Bing 收录少', () => {
  const s = { gsc_site: 'sc-domain:a.com', bing_site: 'https://a.com/' };
  const m = { n_done: 40, n_yes: 6, n_urls: 100, nb_done: 30, nb_yes: 2, at: 1, list: '[]', error: '' };
  const idx = { problems: 3, reasons: [{ state: 'Discovered - currently not indexed', n: 30 }] };
  const out = siteRules(s, [], m, idx);
  assert.deepEqual(rules(out), ['low_index', 'sitemap_error', 'url_problems']);
  assert.equal(out.find((x) => x.rule === 'low_index').level, 'high');
  assert.equal(out.find((x) => x.rule === 'sitemap_error').n.none, 1);
  // Google 收录正常时 Bing 少才提醒
  const ok = { ...m, n_yes: 30, list: '[{"path":"https://a.com/sitemap.xml"}]' };
  assert.deepEqual(rules(siteRules(s, [], ok, { problems: 0, reasons: [] })), ['bing_low']);
  assert.equal(siteRules(s, [], { ...ok, error: '读取站点地图失败：超时' }, null).find((x) => x.rule === 'sitemap_error').n.error, '读取站点地图失败：超时');
  // 检查的网址太少不算
  assert.equal(siteRules(s, [], { ...m, n_done: 10, nb_done: 10, list: '[{}]' }, null).length, 0);
});

test('有流量没转化：近 28 天会话够多、关键事件为 0', () => {
  const rows = Array.from({ length: 28 }, (_, i) => day(2 + i, { sessions: 20, key_events: 0 }));
  const s = { ...GA };
  assert.ok(siteRules(s, rows, null, null).some((x) => x.rule === 'no_conversion'));
  assert.equal(siteRules(s, rows.map((r, i) => ({ ...r, key_events: i ? 0 : 1 })), null, null).some((x) => x.rule === 'no_conversion'), false);
  assert.equal(siteRules(s, rows.slice(0, 10), null, null).some((x) => x.rule === 'no_conversion'), false, '会话不到 300');
});
