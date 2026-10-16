// 站点匹配、AI 报告的规则测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteHost, matchHost, sourceSite, expectedCtr, reportMarkdown } from '../src/google.js';

test('站点主域名：去掉协议、端口、www.，支持 GSC 网域资源', () => {
  assert.equal(siteHost('https://www.Example.com:8443/a?b=1'), 'example.com');
  assert.equal(siteHost('sc-domain:Gaterar.com'), 'gaterar.com');
  assert.equal(siteHost('not a url'), '');
});

test('跳转地址匹配站点：相同域名或子域名', () => {
  const hosts = new Set(['example.com', 'shop.example.com', 'gaterar.com']);
  assert.equal(matchHost('example.com', hosts), 'example.com');
  assert.equal(matchHost('app.example.com', hosts), 'example.com');
  assert.equal(matchHost('a.shop.example.com', hosts), 'shop.example.com');   // 优先更具体的
  assert.equal(matchHost('other.com', hosts), null);
});

test('访问来源匹配站点：域名（忽略 www.）或唯一的站点主名称', () => {
  const hosts = new Set(['gaterar.com', 'gateraw.com', 'blockvar.com', 'blockvar.io']);
  const labels = new Map();
  for (const h of hosts) { const l = h.split('.')[0]; labels.set(l, [...(labels.get(l) || []), h]); }
  assert.equal(sourceSite('www.gaterar.com', hosts, labels), 'gaterar.com');
  assert.equal(sourceSite('GATERAR', hosts, labels), 'gaterar.com');
  assert.equal(sourceSite('blockvar', hosts, labels), null);      // 两个站点同名，不猜
  assert.equal(sourceSite('(direct)', hosts, labels), null);
  assert.equal(sourceSite('zhihu', hosts, labels), null);
});

test('各排名的常见点击率随排名下降', () => {
  assert.ok(expectedCtr(1) > expectedCtr(3) && expectedCtr(3) > expectedCtr(8) && expectedCtr(8) > expectedCtr(15) && expectedCtr(15) > expectedCtr(40));
});

test('AI 报告：Markdown 包含概览、机会和短链，空数据不报错', () => {
  const site = {
    host: 'example.com', ga4: { name: 'Example' }, searchConsole: true, errors: [],
    cur: { ga: { sessions: 100, views: 200, keyEvents: 3, engagement: 0.5 }, gsc: { clicks: 20, impressions: 1000, ctr: 0.02, position: 6.2 } },
    prev: { ga: { sessions: 80, views: 150, keyEvents: 1, engagement: 0.4 }, gsc: { clicks: 25, impressions: 900, ctr: 0.028, position: 5.8 } },
    users: 90, prevUsers: 70, trend: [{ period: '2026-10-01', sessions: 10, users: 9, clicks: 2, impressions: 100, position: 6 }],
    search: {
      topQueries: [{ k: 'example query', clicks: 10, impressions: 500, ctr: 2, position: 6.1 }], topPages: [], countries: [], devices: [],
      opportunities: { strikingDistance: [{ k: 'example query', clicks: 10, impressions: 500, ctr: 2, position: 6.1 }], lowCtr: [], decliningQueries: [], decliningPages: [], newQueries: [] },
    },
    linksFrom: [{ slug: 'vip', title: '会员', humanClicks: 30, visitors: 25, allClicks: 33, prevHumanClicks: 20, sources: ['example.com'] }], linksFromVisitors: 25, links: [],
  };
  const md = reportMarkdown({ generatedAt: '2026-10-16T00:00:00Z', days: 28, range: { from: '2026-09-18', to: '2026-10-15' }, prevRange: { from: '2026-08-21', to: '2026-09-17' }, sections: ['search', 'traffic', 'links'], sites: [site] });
  assert.match(md, /# 站点 SEO 与流量数据报告/);
  assert.match(md, /排名 4–20/);
  assert.match(md, /example query/);
  assert.match(md, /\/vip/);
  assert.match(md, /点出率/);
  const empty = reportMarkdown({ generatedAt: 'x', days: 28, range: { from: 'a', to: 'b' }, prevRange: null, sections: ['links'], sites: [] });
  assert.match(empty, /站点数：0/);
});
