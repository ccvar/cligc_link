// HyperLogLog（独立访客估算）测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hllNew, hllAdd, hllCount, hllMerge, hllParse, hllPack, dayKey } from '../src/agg.js';

const fill = (n, prefix = 'ip') => { const r = hllNew(); for (let i = 0; i < n; i++) hllAdd(r, `${prefix}${i}`); return r; };

// 512 个寄存器的标准误差约 1.04/√512 ≈ 4.6%；按约 2 倍标准误差判断
test('HyperLogLog：估算误差在 10% 以内', () => {
  for (const n of [10, 100, 1000, 20000]) {
    const est = hllCount(fill(n));
    assert.ok(Math.abs(est - n) / n < 0.1 || Math.abs(est - n) <= 1, `${n} → ${est}`);
  }
});

test('HyperLogLog：同一个 IP 重复加入不改变结果（重复回填不会多算）', () => {
  const a = fill(500), b = fill(500);
  for (let i = 0; i < 500; i++) hllAdd(b, `ip${i}`);
  assert.deepEqual([...a], [...b]);
});

test('HyperLogLog：合并后是并集的估算', () => {
  const a = fill(1000, 'a'), b = fill(1000, 'b'), c = fill(1000, 'a');
  const ab = hllCount(hllMerge(hllNew().map((_, i) => a[i]), b));
  assert.ok(Math.abs(ab - 2000) / 2000 < 0.1, `两组不相同的 → ${ab}`);
  const ac = hllCount(hllMerge(hllNew().map((_, i) => a[i]), c));
  assert.ok(Math.abs(ac - 1000) / 1000 < 0.1, `两组相同的 → ${ac}`);
});

test('HyperLogLog：稀疏格式和完整格式都能还原', () => {
  for (const n of [0, 3, 50, 5000]) {
    const r = fill(n), packed = hllPack(r);
    if (n <= 50) assert.ok(packed.startsWith('s'), `${n} 个访客用稀疏格式`);
    assert.deepEqual([...hllParse(packed)], [...r]);
  }
});

test('按时区的日期', () => {
  assert.equal(dayKey(Date.UTC(2026, 9, 15, 17), 480), '2026-10-16');
  assert.equal(dayKey(Date.UTC(2026, 9, 15, 15), 480), '2026-10-15');
});
