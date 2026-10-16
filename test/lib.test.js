// 纯逻辑测试：node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyVisit, parseUA, tally, uniq, hourKey, dateKey, buckets, usageForecast } from '../src/lib.js';

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const human = { ua: CHROME, hasLang: true, lang: 'zh-CN', country: 'CN', asnOrg: 'China Telecom', asn: 4134, recent: 1, tls: 'TLSv1.3', http: 'HTTP/2' };

test('访客识别：正常浏览器是真人', () => {
  assert.equal(classifyVisit(human).kind, 'human');
});

test('访客识别：已知爬虫的 UA 是爬虫', () => {
  for (const ua of ['Googlebot/2.1 (+http://www.google.com/bot.html)', 'Mozilla/5.0 (compatible; bingbot/2.0)', 'curl/8.4.0', 'python-requests/2.31']) {
    assert.equal(classifyVisit({ ...human, ua, hasLang: false }).kind, 'bot', ua);
  }
});

test('访客识别：机房 IP、缺少浏览器特征时是可疑', () => {
  const v = classifyVisit({ ...human, asnOrg: 'Tencent Building, Kejizhongyi Avenue', asn: 132203, hasLang: false, http: 'HTTP/1.1', tls: 'TLSv1.2' });
  assert.notEqual(v.kind, 'human');
});

test('访客识别：机房 IP 但浏览器特征完整，算真人并标记代理', () => {
  const v = classifyVisit({ ...human, asnOrg: 'DigitalOcean, LLC', asn: 14061, country: 'US' });
  assert.equal(v.kind, 'human');
  assert.equal(v.proxy, 1);
});

test('访客识别：60 秒内同一 IP 反复访问是可疑信号', () => {
  assert.notEqual(classifyVisit({ ...human, recent: 30 }).kind, 'human');
});

test('UA 解析：微信、iOS、手机', () => {
  const r = parseUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0');
  assert.deepEqual([r.browser, r.os, r.device, r.bot], ['WeChat', 'iOS', 'Mobile', false]);
});

test('24 小时统计工具：计数、去重、时间桶（与 SQL strftime 一致）', () => {
  const rows = [{ ts: 0, ip: 'a' }, { ts: 1000, ip: 'a' }, { ts: 3600000, ip: 'b' }];
  assert.deepEqual(tally(rows, (r) => r.ip), [{ k: 'a', n: 2 }, { k: 'b', n: 1 }]);
  assert.equal(uniq(rows), 2);
  assert.equal(hourKey(0, 480), '1970-01-01 08:00');
  assert.equal(dateKey(Date.UTC(2026, 0, 1, 20), 480), '2026-01-02');   // 东八区已经是第二天
  assert.deepEqual(buckets(rows, (ts) => hourKey(ts, 0)), [{ k: '1970-01-01 00:00', n: 2, u: 1 }, { k: '1970-01-01 01:00', n: 1, u: 1 }]);
  assert.equal(tally(rows, (r) => r.ip, 1).length, 1);
});

test('用量预测：付费版按最近 7 天日均推算到月底', () => {
  const now = Date.UTC(2026, 9, 16, 12);
  const days = Array.from({ length: 16 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, rowsRead: 1e9, rowsWritten: 1e6, requests: 1e5 }));
  const u = { plan: 'paid', today: '2026-10-16', days, month: { rowsRead: 15.5e9, rowsWritten: 15.5e6, requests: 15.5e5 } };
  const f = usageForecast(u, now);
  const read = f.items.find((x) => x.k === 'rowsRead');
  assert.equal(f.paid, true);
  assert.equal(Math.round(read.proj / 1e9), 31);                       // 每天 10 亿 × 31 天
  assert.ok(read.projRatio > 1 && read.runOut, '预计超出时给出用完日期');
  assert.equal(new Date(read.runOut).toISOString().slice(0, 10), '2026-10-26');
  const write = f.items.find((x) => x.k === 'rowsWritten');
  assert.equal(write.runOut, null);                                    // 不会用完时没有日期
});

test('用量预测：免费版按今天已过时间推算到今天结束', () => {
  const now = Date.UTC(2026, 9, 16, 6);                                // 今天过去 1/4
  const u = { plan: 'free', today: '2026-10-16', days: [{ date: '2026-10-16', rowsRead: 1e6, rowsWritten: 1e4, requests: 1e4 }] };
  const f = usageForecast(u, now);
  assert.equal(f.paid, false);
  assert.equal(f.items.find((x) => x.k === 'rowsRead').proj, 4e6);
});
