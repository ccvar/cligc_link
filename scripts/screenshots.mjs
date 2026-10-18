// README 截图：用本机的 Chrome（无头模式，DevTools 协议）打开演示环境，按中英文各截一组 2 倍清晰度的 PNG，存到 docs/screenshots/。
// 先按 scripts/demo-data.mjs 里的说明启动演示环境、导入演示数据，然后：
//   node scripts/screenshots.mjs [http://127.0.0.1:8790]
// 之后用 cwebp 转成 WebP（见文件末尾的提示）。只用 Node 自带的 fetch / WebSocket，不需要装别的包。

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8790';
const TOKEN = readFileSync(new URL('../.wrangler/demo-token.txt', import.meta.url), 'utf8').trim();
const OUT = new URL('../docs/screenshots/', import.meta.url);
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = 1440;
mkdirSync(OUT, { recursive: true });

const profile = join(tmpdir(), `cligc-shots-${Date.now()}`);
// 端口填 0 让 Chrome 自己挑一个空闲端口，再从它的配置目录里读出来：保证连上的是这里启动的 Chrome，不会连到别的程序开着的调试端口
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--hide-scrollbars', '--no-first-run', '--no-default-browser-check'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws, id = 0, nav = 0;
const pending = new Map(), waiters = [];
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const once = (method, ms = 20000) => Promise.race([new Promise((res) => waiters.push({ method, res })), sleep(ms).then(() => { throw new Error(`等不到 ${method}`); })]);
const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const go = async (hash) => {
  const loaded = once('Page.loadEventFired');
  // 每次带个不同的查询参数，保证是一次完整的页面加载（只改 # 后面的部分不会触发 load 事件）
  await send('Page.navigate', { url: `${BASE}/admin?shot=${++nav}${hash}` });
  await loaded;
  await sleep(2500);
};
// 等某个元素出现
const until = (sel, ms = 15000) => js(`for (let i = 0; i < ${ms / 200}; i++) { if (document.querySelector(${JSON.stringify(sel)})) return true; await new Promise((r) => setTimeout(r, 200)); } throw new Error('等不到 ' + ${JSON.stringify(sel)});`);
// 页面上的本地地址（127.0.0.1:8790）换成示例短链域名，二维码也重新生成
// 英文截图里，演示数据本身的中文名称（短链标题、分组、规则备注）换成英文
const EN_NAMES = { 春季促销活动: 'Spring sale', '下载 App': 'Get the app', 会员计划: 'Membership', 开发者文档: 'Developer docs', 产品发布会: 'Launch event',
  限时优惠: 'Limited-time deal', 社区: 'Community', 新手指南: 'Starter guide', 活动: 'Campaign', 电商: 'Shop', 内容: 'Content', 港澳台繁体页: 'Traditional Chinese page',
  'iPhone 去 App Store': 'iPhone to App Store', 新版落地页: 'New landing page' };
const masq = () => js(`
  const H = location.host, R = 'go.example.com', N = document.documentElement.lang === 'en' ? ${JSON.stringify(EN_NAMES)} : {};
  const walk = (n) => { for (const c of n.childNodes) {
    if (c.nodeType === 3) { if (c.data.includes(H)) c.data = c.data.split(H).join(R); const t = c.data.trim(); if (N[t]) c.data = c.data.replace(t, N[t]); }
    else if (c.nodeType === 1) walk(c);
  } };
  walk(document.body);
  document.querySelectorAll('input').forEach((i) => { if (i.value.includes(H)) i.value = i.value.split(H).join(R); });
  const imgs = [...document.querySelectorAll('img[src*="/api/qr"]')];
  await Promise.all(imgs.map((i) => new Promise((ok) => {
    const u = new URL(i.src), t = u.searchParams.get('text');
    if (!t || !t.includes(H)) return ok();
    u.searchParams.set('text', t.split(H).join(R).replace(/^http:/, 'https:'));
    i.onload = i.onerror = ok; i.src = u.pathname + u.search;
  })));`);
const shot = async (name, { y = 0, h = 900 } = {}) => {
  await masq();
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y, width: W, height: h, scale: 1 } });
  writeFileSync(new URL(`${name}.png`, OUT), Buffer.from(r.data, 'base64'));
  console.log('✓', name);
};

try {
  let PORT = 0;
  for (let i = 0; i < 100 && !PORT; i++) { try { PORT = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(100); } }
  if (!PORT) throw new Error('Chrome 没有启动');
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return; }
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].method === m.method) { waiters[i].res(m.params); waiters.splice(i, 1); }
  };
  await send('Page.enable');
  await send('Network.enable');
  await send('Network.setCookie', { name: 'sl_session', value: TOKEN, domain: '127.0.0.1', path: '/' });
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: 900, deviceScaleFactor: 2, mobile: false });
  // 跳过入场动画和数字滚动
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: 'light' }] });

  for (const lang of ['zh', 'en']) {
    await go('#/');
    await js(`localStorage.setItem('sl:lang', '"${lang}"'); localStorage.setItem('sl:setup:hide', 'true'); localStorage.setItem('sl:days', '28'); localStorage.setItem('sl:g:days', '28');
      localStorage.setItem('sl:g:sort', '"sessions"'); localStorage.setItem('sl:g:dir', '""'); localStorage.setItem('sl:g:se', '"google"');`);

    // 站点列表
    await go('#/sites');
    await until('.tbl.gl tbody tr');
    await shot(`sites-${lang}`, { h: 1000 });

    // 概览
    await go('#/');
    await until('#page .kpi, #page .kstrip, #page canvas, #page svg');
    await shot(`overview-${lang}`, { h: 1000 });

    // 短链详情（/spring：地区和设备规则、A/B、二维码）
    const linkId = await js(`const r = await fetch('/api/links?lite=1').then((r) => r.json()); return (r.items || r.links || r).find((x) => x.slug === 'spring').id;`);
    await go(`#/link/${linkId}`);
    await until('.hero');
    await shot(`link-${lang}`, { h: 1000 });

    // 跳转规则面板：按地区 / 设备分流、A/B 测试
    await js(`const b = [...document.querySelectorAll('.hero button')].find((x) => /跳转规则|Redirect rules|Rules/i.test(x.textContent)); b.click();`);
    await until('#radd');
    await sleep(800);
    await shot(`rules-${lang}`, { h: 620 });

    // 站点详情：展开优化建议
    await go('#/site/blog.example.com');
    await until('#g-adv:not([hidden]) .adv-hd');
    await js(`document.querySelector('#g-adv .adv-hd').click();`);
    await sleep(600);
    const advBottom = await js(`const r = document.querySelector('#g-adv').getBoundingClientRect(); return Math.round(r.bottom + scrollY);`);
    await shot(`site-${lang}`, { y: 0, h: advBottom + 36 });
  }
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}
console.log('\n转成 WebP：for f in docs/screenshots/*.png; do cwebp -quiet -q 82 "$f" -o "${f%.png}.webp" && rm "$f"; done');
