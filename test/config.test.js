// 升级时保留 wrangler.toml 里的个人配置
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractConfig, applyConfig } from '../scripts/config.mjs';

const tpl = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');

test('模板本身：取出的是占位值', () => {
  const c = extractConfig(tpl);
  assert.equal(c.name, 'cligc-link');
  assert.equal(c.databaseId, 'REPLACE_WITH_YOUR_D1_ID');
  assert.equal(c.routes, undefined);
  assert.equal(c.sendEmail, undefined);
  assert.equal(c.vars.HOME_URL, '""');
});

test('用户改过的配置能完整带到新模板里', () => {
  const mine = tpl
    .replace('name = "cligc-link"', 'name = "my-links"')
    .replace('# routes = [\n#   { pattern = "go.example.com", custom_domain = true },\n# ]', '# routes = [\n#   { pattern = "go.example.com", custom_domain = true },\n# ]\nroutes = [\n  { pattern = "go.mine.com", custom_domain = true },\n]')
    .replace('database_id = "REPLACE_WITH_YOUR_D1_ID"', 'database_id = "abc-123"')
    .replace('HOME_URL = ""', 'HOME_URL = "https://mine.com"')
    .replace('# [[send_email]]\n# name = "EMAIL"', '[[send_email]]\nname = "EMAIL"');
  const c = extractConfig(mine);
  assert.equal(c.name, 'my-links');
  assert.match(c.routes, /go\.mine\.com/);
  assert.equal(c.databaseId, 'abc-123');
  assert.equal(c.vars.HOME_URL, '"https://mine.com"');
  assert.equal(c.sendEmail, 'EMAIL');
  // 新模板（多了一个变量、注释也变了）
  const next = tpl.replace('TURNSTILE_SITEKEY = ""', 'TURNSTILE_SITEKEY = ""\n# 新功能\nNEW_FLAG = "1"');
  const out = applyConfig(next, c);
  const c2 = extractConfig(out);
  assert.equal(c2.name, 'my-links');
  assert.match(c2.routes, /go\.mine\.com/);
  assert.equal(c2.databaseId, 'abc-123');
  assert.equal(c2.vars.HOME_URL, '"https://mine.com"');
  assert.equal(c2.vars.NEW_FLAG, '"1"');
  assert.equal(c2.sendEmail, 'EMAIL');
  assert.match(out, /# 新功能/);
  // 再套一次结果不变（不会重复插入 routes / send_email）
  assert.equal(applyConfig(out, c), out);
});

test('单行 routes', () => {
  const c = extractConfig(tpl.replace('compatibility_date = "2026-07-01"', 'compatibility_date = "2026-07-01"\nroutes = [{ pattern = "a.com", custom_domain = true }]'));
  assert.equal(c.routes, 'routes = [{ pattern = "a.com", custom_domain = true }]');
});
