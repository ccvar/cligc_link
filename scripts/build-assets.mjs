// 生成静态首页到 public/：Cloudflare 直接返回静态文件，不经过 Worker，不占 Workers 的请求额度（被刷也不影响短链）。
// wrangler deploy / wrangler dev 时会自动先运行（wrangler.toml 的 [build]），不用手动执行；public/ 不提交到仓库。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { installI18n } from '../src/i18n/client.js';
import { ROBOTS_TXT } from '../src/lib.js';

const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
const out = (p) => new URL(`../public/${p}`, import.meta.url);
mkdirSync(out('i18n/'), { recursive: true });

// 版权年份：静态文件里没法每次替换，改在浏览器里算
writeFileSync(out('index.html'), src('home.html').replaceAll('__YEAR__', '<script>document.write(new Date().getFullYear())</script>'));
// 英文首页的翻译脚本（和 Worker 里 /i18n/home.en.js 生成的一样）
writeFileSync(out('i18n/home.en.js'), `var __name = (f) => f;\n(${installI18n.toString()})(${src('i18n/home.en.json')});`);
writeFileSync(out('robots.txt'), ROBOTS_TXT);
console.log('✓ 已生成静态首页（public/）');
