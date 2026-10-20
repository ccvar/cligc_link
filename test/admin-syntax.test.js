// 后台页面（src/admin.html）里的脚本能正常解析：模板字符串、引号写错时整个后台会卡在“正在加载”
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('admin.html 的脚本没有语法错误', () => {
  const html = readFileSync(new URL('../src/admin.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length, '找到脚本');
  for (const code of scripts) assert.doesNotThrow(() => new vm.Script(code, { filename: 'admin.html' }));
});
