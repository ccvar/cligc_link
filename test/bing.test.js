// Bing Webmaster：.NET 日期解析
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bingTime, bingDate } from '../src/bing.js';

test('bingTime / bingDate 解析 .NET 日期', () => {
  assert.equal(bingTime('/Date(1399014000000-0700)/'), 1399014000000);
  // 带偏移时按当地日期：太平洋时间 5 月 2 日 0 点
  assert.equal(bingDate('/Date(1399014000000-0700)/'), '2014-05-02');
  assert.equal(bingDate('/Date(1700000000000)/'), '2023-11-14');
  assert.equal(bingTime('/Date(-62135596800000)/'), 0);
  assert.equal(bingTime(null), 0);
  assert.equal(bingDate(''), '');
});
