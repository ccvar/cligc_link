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
