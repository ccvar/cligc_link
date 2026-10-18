// 站点地图解析、网址归属、索引状态判断
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSitemap, inProperty, isIndexed, hasProblem } from '../src/gindex.js';

test('parseSitemap 读取网址和索引文件', () => {
  const a = parseSitemap('<?xml version="1.0"?><urlset><url><loc> https://a.com/ </loc></url><url><loc><![CDATA[https://a.com/x?a=1&b=2]]></loc></url><url><loc>https://a.com/y?a=1&amp;b=2</loc></url></urlset>');
  assert.equal(a.index, false);
  assert.deepEqual(a.locs, ['https://a.com/', 'https://a.com/x?a=1&b=2', 'https://a.com/y?a=1&b=2']);
  const b = parseSitemap('<sitemapindex xmlns="x"><sitemap><loc>https://a.com/s1.xml</loc></sitemap></sitemapindex>');
  assert.equal(b.index, true);
  assert.deepEqual(b.locs, ['https://a.com/s1.xml']);
});

test('inProperty 区分网域资源和网址前缀资源', () => {
  assert.equal(inProperty('https://a.com/x', 'sc-domain:a.com'), true);
  assert.equal(inProperty('http://www.a.com/x', 'sc-domain:a.com'), true);
  assert.equal(inProperty('https://xa.com/x', 'sc-domain:a.com'), false);
  assert.equal(inProperty('https://www.a.com/x', 'https://www.a.com/'), true);
  assert.equal(inProperty('https://a.com/x', 'https://www.a.com/'), false);
  assert.equal(inProperty('ftp://a.com/x', 'sc-domain:a.com'), false);
  assert.equal(inProperty('not a url', 'sc-domain:a.com'), false);
});

test('isIndexed / hasProblem', () => {
  assert.equal(isIndexed({ verdict: 'PASS', state: 'Submitted and indexed' }), true);
  assert.equal(isIndexed({ verdict: 'NEUTRAL', state: 'Indexed, not submitted in sitemap' }), true);
  assert.equal(isIndexed({ verdict: 'NEUTRAL', state: 'Crawled - currently not indexed' }), false);
  assert.equal(isIndexed({ verdict: 'NEUTRAL', state: 'Discovered - currently not indexed' }), false);
  assert.equal(hasProblem({ fetch: 'SERVER_ERROR' }), true);
  assert.equal(hasProblem({ fetch: 'SUCCESSFUL', robots: 'DISALLOWED' }), true);
  assert.equal(hasProblem({ fetch: 'SUCCESSFUL', robots: 'ALLOWED', indexing: 'BLOCKED_BY_META_TAG' }), true);
  assert.equal(hasProblem({ fetch: 'SUCCESSFUL', robots: 'ALLOWED', indexing: 'INDEXING_ALLOWED' }), false);
});

test('parseSitemap 读取 lastmod（没写、写错、未来时间都不算）', () => {
  const a = parseSitemap(`<urlset><url><loc>https://a.com/</loc><lastmod>2026-05-01</lastmod></url>
    <url><loc>https://a.com/x</loc><lastmod>2026-05-02T10:00:00+08:00</lastmod><priority>1</priority></url>
    <url><loc>https://a.com/y</loc></url><url><loc>https://a.com/z</loc><lastmod>bad</lastmod></url>
    <url><loc>https://a.com/f</loc><lastmod>2999-01-01</lastmod></url></urlset>`);
  assert.deepEqual(a.locs, ['https://a.com/', 'https://a.com/x', 'https://a.com/y', 'https://a.com/z', 'https://a.com/f']);
  assert.deepEqual([...a.mods], [['https://a.com/', Date.UTC(2026, 4, 1)], ['https://a.com/x', Date.UTC(2026, 4, 2, 2)]]);
});

test('contentOf：lastmod 可信时用它，不可信时用观察到的变化，再不行给出站点地图日期', async () => {
  const { contentOf, modTrusted } = await import('../src/content.js');
  const ymd = (t) => new Date(t).toISOString().slice(0, 10);
  assert.equal(contentOf(null), null);
  assert.equal(contentOf({ c_since: 0 }), null, '还没开始观察');
  assert.deepEqual(contentOf({ c_since: 1, c_mod: 100, c_trust: 1, c_seen: 50, c_new30: 2, c_upd30: 3 }), { at: 100, src: 'mod', new30: 2, upd30: 3, since: 1 });
  assert.equal(contentOf({ c_since: 1, c_mod: 100, c_trust: 1, c_seen: 200 }).src, 'seen', '有没写 lastmod 的新网址');
  assert.deepEqual(contentOf({ c_since: 1, c_mod: 100, c_trust: 0, c_seen: 50, c_upd30: -1 }), { at: 50, src: 'seen', new30: 0, upd30: null, since: 1 });
  assert.equal(contentOf({ c_since: 1, c_mod: 100, c_trust: 0, c_seen: 0 }).src, 'build');
  assert.equal(contentOf({ c_since: 1, c_mod: 0, c_seen: 0 }).at, null);
  const D = (d) => Date.UTC(2026, 4, d);
  assert.equal(modTrusted([D(1), D(1), D(2)], ymd), true, '太少不判断');
  assert.equal(modTrusted(Array.from({ length: 20 }, (_, i) => D(1 + (i % 10))), ymd), true);
  assert.equal(modTrusted([...Array(12).fill(D(9)), ...Array.from({ length: 8 }, (_, i) => D(1 + i))], ymd), false, '一大半是同一天');
});
