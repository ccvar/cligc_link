import ADMIN_HTML from './admin.html';
import HOME_HTML from './home.html';
import SCHEMA_SQL from '../schema.sql';
import ADMIN_EN from './i18n/admin.en.json';
import HOME_EN from './i18n/home.en.json';
import { installI18n } from './i18n/client.js';
import { renderSVG } from 'uqr';
import { EmailMessage } from 'cloudflare:email';
import * as google from './google.js';
import * as gindex from './gindex.js';
import * as bing from './bing.js';
import { classifyVisit, parseUA, deviceKey, pickRule, pickArm, ARM_NAMES, DEVICES, RAW_COLS, tally, uniq, hourKey, dateKey, buckets, CF_LIMITS, CF_NAMES, usageForecast } from './lib.js';
import { aggregate, aggQuery, aggState, rebuildAgg, dropLinkAgg, pruneClicks, backfillSourceUv, hllNew, hllMerge, hllAdd, hllCount, dayKey, HOUR, DAY } from './agg.js';

// 后台页面的 ETag（按内容算 FNV-1a 哈希，同一个实例里只算一次）
// 英文界面：词典 + 翻译脚本，按需加载（中文界面不下载）
const I18N_JS = {};
function i18nScript(name) {
  if (!I18N_JS[name]) {
    const dict = name === 'home' ? HOME_EN : ADMIN_EN;
    // 打包工具会给函数包上 __name(...)，浏览器里没有这个函数，补一个空实现
    const body = `var __name = (f) => f;\n(${installI18n.toString()})(${JSON.stringify(dict)});`;
    let h = 0x811c9dc5;
    for (let i = 0; i < body.length; i++) { h ^= body.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    I18N_JS[name] = { body, etag: `"i${(h >>> 0).toString(36)}${body.length.toString(36)}"` };
  }
  return I18N_JS[name];
}
function i18nResponse(request, name) {
  const { body, etag } = i18nScript(name);
  const headers = { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', etag };
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  return new Response(body, { headers });
}
let adminTag = null;
function adminEtag(html) {
  if (adminTag && adminTag.len === html.length) return adminTag.v;
  let h = 0x811c9dc5;
  for (let i = 0; i < html.length; i++) { h ^= html.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  adminTag = { len: html.length, v: `"a${(h >>> 0).toString(36)}${html.length.toString(36)}"` };
  return adminTag.v;
}

const RESERVED = new Set(['admin', 'api', 'favicon.ico', 'robots.txt', '_fb']);
// 回退检测：访客浏览器内探测地区地址的超时时间
const PROBE_TIMEOUT = 2500;
const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_TTL = 7 * 24 * 3600 * 1000;
// 未设置任何密码时使用的默认密码；用它登录后必须先修改密码才能使用后台
const DEFAULT_PASSWORD = 'admin';
const MIN_PASSWORD_LENGTH = 8;
// 两步验证：连续输错 MFA_MAX_FAILS 次后锁定 MFA_LOCK_MS
const MFA_MAX_FAILS = 5;
const MFA_LOCK_MS = 15 * 60 * 1000;
const MFA_TICKET_MS = 5 * 60 * 1000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // 首页和 robots.txt 不需要数据库，其余请求先确保表已创建
      if (path === '/i18n/home.en.js') return i18nResponse(request, 'home');
      if (path === '/admin/i18n.en.js') return i18nResponse(request, 'admin');
      if (path !== '/' && path !== '' && path !== '/robots.txt') await ensureSchema(env);
      if (path === '/admin' || path === '/admin/' || path.startsWith('/api/')) {
        if (env.ADMIN_HOST && url.hostname !== env.ADMIN_HOST) return notFound();
        // Google 授权回调：会话 Cookie 是 SameSite=Strict，从 Google 跳回时浏览器不会带上，
        // 所以不走登录校验，改由签名的 state（只有已登录的后台才能生成，10 分钟有效）保护
        if (path === '/api/google/callback') return await googleCallback(env, url);
        if (path.startsWith('/api/')) return await handleApi(request, env, url);
        // 后台页面按内容生成 ETag：浏览器每次都来确认，没变就返回 304，不用重新下载整个页面
        const html = ADMIN_HTML.replace('__TURNSTILE_SITEKEY__', env.TURNSTILE_SITEKEY || '');
        const etag = adminEtag(html);
        if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag, 'cache-control': 'no-cache' } });
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', etag } });
      }
      if (path === '/_fb' && request.method === 'POST') return await recordFallback(request, env);
      if (path === '/t.js') return await trackerScript(env, url);
      if (path.startsWith('/r/')) return await shareView(request, env, ctx, url);
      if (path === '/robots.txt') {
        // 短链不需要被收录；/r/ 是给 AI 读的分析报告，要允许 AI 工具抓取（报告本身带 noindex，不会被搜索引擎收录）
        return new Response('User-agent: *\nAllow: /r/\nDisallow: /\n', { headers: { 'content-type': 'text/plain' } });
      }
      if (path === '/' || path === '') {
        if (env.HOME_URL) return Response.redirect(env.HOME_URL, 302);
        return new Response(HOME_HTML.replaceAll('__YEAR__', String(new Date().getUTCFullYear())), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' },
        });
      }
      return await handleRedirect(request, env, ctx, url);
    } catch (err) {
      console.error(err);
      return json({ error: 'internal error' }, 500);
    }
  },

  // 定时任务（wrangler.toml 中每小时整点触发）：到了设定时间发送日报 / 周报 / 月报
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env, event.scheduledTime));
  },
};

// ---------------------------------------------------------------- 系统状态（后台“设置 → 系统状态”）
async function systemStatus(env) {
  const get = async (k) => (await getSetting(env, k))?.value ?? null;
  const parse = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
  const [cron, mark, suv, nstat, n, accts, sites, cf] = await Promise.all([
    get('cron_status').then(parse), get('agg_mark'), get('suv_mark'), get('notify_status').then(parse), getNotify(env),
    env.DB.prepare('SELECT email, error, found_at FROM g_accounts').all().then((r) => r.results).catch(() => []),
    env.DB.prepare('SELECT COUNT(*) AS n, MAX(synced_at) AS last, SUM(synced_at = 0) AS pending, SUM(error != \'\') AS errors FROM g_sites').first().catch(() => null),
    cfCreds(env),
  ]);
  const health = await env.DB.prepare(
    `SELECT COUNT(*) AS n, SUM(state = 'down') AS down, MAX(checked_at) AS last FROM url_health WHERE url IN (
       SELECT target_url FROM links WHERE enabled = 1 AND target_url != ''
       UNION SELECT t.url FROM link_targets t JOIN links l ON l.id = t.link_id WHERE l.enabled = 1)`
  ).first().catch(() => null);
  return {
    now: Date.now(), cron, aggMark: Number(mark) || null, backfillDone: suv === 'done',
    google: { accounts: accts.length, accountErrors: accts.filter((a) => a.error).map((a) => ({ email: a.email, error: a.error })), sites: sites?.n || 0, lastSync: sites?.last || null, pending: sites?.pending || 0, siteErrors: sites?.errors || 0 },
    notify: { channels: [n.tg.enabled && 'Telegram', n.email.enabled && '邮件'].filter(Boolean), last: nstat },
    usage: { configured: !!cf, alert: !!n.usage.enabled },
    health: health ? { urls: health.n || 0, down: health.down || 0, last: health.last || null } : null,
  };
}

// ---------------------------------------------------------------- 定时任务
// 每一步单独计时、单独捕获错误（一步失败不影响后面的步骤），结果记在 settings.cron_status，后台“系统状态”里显示
async function runCron(env, at = Date.now()) {
  const t0 = Date.now(), steps = {};
  const step = async (name, fn) => {
    const s0 = Date.now();
    try { const info = await fn(); steps[name] = { ok: true, ms: Date.now() - s0, ...(info && typeof info === 'object' ? { info } : {}) }; }
    catch (e) { console.error(`cron ${name} failed`, e); steps[name] = { ok: false, ms: Date.now() - s0, error: String(e?.message || e).slice(0, 300) }; }
  };
  await step('schema', () => ensureSchema(env));
  await step('aggregate', async () => { const st = await aggregate(env); return { mark: st?.mark || null }; });
  // 按来源的独立访客：一次性回填旧数据（先于清理明细，每次最多 5 批）
  await step('backfill', async () => { let r = { done: true }; for (let i = 0; i < 5; i++) { r = await backfillSourceUv(env); if (r.done) break; } return { done: !!r.done }; });
  await step('prune', async () => ({ deleted: await pruneClicks(env) }));
  await step('cleanup', async () => {
    await env.DB.prepare('DELETE FROM login_guard WHERE at < ? AND until < ?').bind(Date.now() - 7 * DAY, Date.now()).run();
    // Google 接口缓存和 AI 报告缓存：只用 1 小时，两天前的清掉
    await env.DB.prepare('DELETE FROM g_cache WHERE at < ?').bind(Date.now() - 2 * DAY).run();
    // 过期的登录设备、一年前的修改记录
    await env.DB.prepare('DELETE FROM sessions WHERE exp < ?').bind(Date.now()).run();
    await env.DB.prepare('DELETE FROM link_log WHERE at < ?').bind(Date.now() - 365 * DAY).run();
  });
  await step('google', async () => {
    const gsec = await sessionSecret(env);
    if (!(await google.googleConfigured(env, gsec))) return { skipped: true };
    return await google.syncBatch(env, gsec, { limit: 10 });
  });
  // Bing Webmaster：每日点击 / 展示、索引网页数
  await step('bing', async () => bing.syncBatch(env, await sessionSecret(env)));
  // 站点地图 + 网页索引检查（Google 和 Bing，每次最多约 100 秒）
  await step('gindex', async () => {
    const gsec = await sessionSecret(env);
    if (!(await google.googleConfigured(env, gsec)) && !(await bing.bingCreds(env, gsec))) return { skipped: true };
    return await gindex.cronBatch(env, gsec);
  });
  await step('health', () => runHealthChecks(env));
  await step('notify', () => runNotifications(env, at));
  await step('usage', () => runUsageAlert(env));
  await setSetting(env, 'cron_status', JSON.stringify({ at: t0, ms: Date.now() - t0, steps })).catch(() => {});
}

// ---------------------------------------------------------------- 首次运行自动建表

// 每个 Worker 实例只执行一次；表已存在时 CREATE ... IF NOT EXISTS 不会有影响
let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = migrate(env).catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

async function migrate(env) {
  const statements = SCHEMA_SQL
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
  // 老版本数据库补列
  const cols = (await env.DB.prepare('PRAGMA table_info(clicks)').all()).results.map((c) => c.name);
  if (!cols.includes('rule_id')) {
    await env.DB.prepare('ALTER TABLE clicks ADD COLUMN rule_id INTEGER NOT NULL DEFAULT 0').run();
  }
  const tcols = (await env.DB.prepare('PRAGMA table_info(link_targets)').all()).results.map((c) => c.name);
  if (!tcols.includes('fallback')) {
    await env.DB.prepare('ALTER TABLE link_targets ADD COLUMN fallback INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!tcols.includes('devices')) {
    await env.DB.prepare("ALTER TABLE link_targets ADD COLUMN devices TEXT NOT NULL DEFAULT ''").run();
  }
  if (!tcols.includes('fallbacks')) {
    await env.DB.prepare('ALTER TABLE link_targets ADD COLUMN fallbacks INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!tcols.includes('ab_of')) await env.DB.prepare('ALTER TABLE link_targets ADD COLUMN ab_of INTEGER NOT NULL DEFAULT -1').run();
  if (!tcols.includes('weight')) await env.DB.prepare('ALTER TABLE link_targets ADD COLUMN weight INTEGER NOT NULL DEFAULT 0').run();
  const lcols = (await env.DB.prepare('PRAGMA table_info(links)').all()).results.map((c) => c.name);
  if (!lcols.includes('utm')) await env.DB.prepare('ALTER TABLE links ADD COLUMN utm INTEGER NOT NULL DEFAULT 0').run();
  if (!lcols.includes('ab_weight')) await env.DB.prepare('ALTER TABLE links ADD COLUMN ab_weight INTEGER NOT NULL DEFAULT 0').run();
  const gcols = (await env.DB.prepare('PRAGMA table_info(g_sites)').all()).results.map((c) => c.name);
  for (const c of ['ga4_acct', 'gsc_acct']) {
    if (!gcols.includes(c)) await env.DB.prepare(`ALTER TABLE g_sites ADD COLUMN ${c} TEXT NOT NULL DEFAULT ''`).run();
  }
  if (!gcols.includes('ch_at')) await env.DB.prepare('ALTER TABLE g_sites ADD COLUMN ch_at INTEGER NOT NULL DEFAULT 0').run();
  for (const [c, def] of [['bing_site', "TEXT NOT NULL DEFAULT ''"], ['b_synced_at', 'INTEGER NOT NULL DEFAULT 0'], ['b_error', "TEXT NOT NULL DEFAULT ''"], ['b_in_index', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!gcols.includes(c)) await env.DB.prepare(`ALTER TABLE g_sites ADD COLUMN ${c} ${def}`).run();
  }
  const dcols = (await env.DB.prepare('PRAGMA table_info(g_daily)').all()).results.map((c) => c.name);
  if (!dcols.includes('channels')) await env.DB.prepare('ALTER TABLE g_daily ADD COLUMN channels TEXT').run();
  for (const c of ['b_clicks', 'b_impressions']) if (!dcols.includes(c)) await env.DB.prepare(`ALTER TABLE g_daily ADD COLUMN ${c} INTEGER`).run();
  for (const [c, def] of [['kind', "TEXT NOT NULL DEFAULT ''"], ['reason', "TEXT NOT NULL DEFAULT ''"],
    ['asn', 'INTEGER NOT NULL DEFAULT 0'], ['tls', "TEXT NOT NULL DEFAULT ''"], ['http', "TEXT NOT NULL DEFAULT ''"],
    ['proxy', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!cols.includes(c)) await env.DB.prepare(`ALTER TABLE clicks ADD COLUMN ${c} ${def}`).run();
  }
  // 判定规则更新时提高版本号，旧记录重新检查一次；平时不扫描整张表
  if ((await getSetting(env, 'kind_backfilled'))?.value !== KIND_VER) await backfillKinds(env);
}

// 按已有的 IP、运营商、User-Agent、语言补算旧访问记录的访客类型（每次最多处理 2 万条，下次启动继续）
const KIND_VER = '4';
async function backfillKinds(env) {
  // 爬虫只由 User-Agent 决定，不受规则调整影响，不再重算
  const rows = (await env.DB.prepare(
    "SELECT id, link_id, ts, ip, ua, asn, asn_org, lang, country, tls, http FROM clicks WHERE kind IN ('', 'human', 'suspect') ORDER BY ts LIMIT 20000"
  ).all()).results;
  // 同一 IP 访问同一短链：统计 60 秒内的次数
  const recent = new Map(), hist = new Map();
  for (const r of rows) {
    const key = r.ip + '|' + r.link_id;
    const list = (hist.get(key) || []).filter((t) => r.ts - t < 60000);
    list.push(r.ts); hist.set(key, list); recent.set(r.id, list.length);
  }
  const groups = new Map();
  for (const r of rows) {
    const v = classifyVisit({
      ua: r.ua, hasLang: !!r.lang, lang: r.lang, country: r.country, asnOrg: r.asn_org, asn: r.asn,
      recent: recent.get(r.id), tls: r.tls, http: r.http,
    });
    const k = v.kind + '\u0000' + v.reason + '\u0000' + v.proxy;
    if (!groups.has(k)) groups.set(k, { ...v, ids: [] });
    groups.get(k).ids.push(r.id);
  }
  const stmts = [];
  for (const g of groups.values()) {
    for (let i = 0; i < g.ids.length; i += 90) {
      const ids = g.ids.slice(i, i + 90);
      stmts.push(env.DB.prepare(`UPDATE clicks SET kind = ?, reason = ?, is_bot = ?, proxy = ? WHERE id IN (${ids.map(() => '?').join(',')})`)
        .bind(g.kind, g.reason, g.kind === 'human' ? 0 : 1, g.proxy, ...ids));
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  if (rows.length < 20000) await setSetting(env, 'kind_backfilled', KIND_VER);
  if (rows.length) await rebuildAgg(env);
}

// ---------------------------------------------------------------- 跳转

async function handleRedirect(request, env, ctx, url) {
  const slug = decodeURIComponent(url.pathname.slice(1)).replace(/\/$/, '');
  if (!SLUG_RE.test(slug)) return notFound();

  const link = await env.DB.prepare(
    'SELECT id, slug, target_url, enabled, pass_query, utm, expires_at, ab_weight FROM links WHERE slug = ?'
  ).bind(slug).first();
  if (!link || !link.enabled) return notFound();
  if (link.expires_at && link.expires_at < Date.now()) return new Response('Link expired', { status: 410 });

  // 按访问者所在国家 / 地区和设备匹配跳转规则（两者都指定的优先），未命中则用默认地址
  const country = request.cf?.country || '';
  const device = deviceKey(parseUA(request.headers.get('user-agent') || ''));
  const all = (await env.DB.prepare('SELECT id, url, fallback, countries, devices, ab_of, weight FROM link_targets WHERE link_id = ?').bind(link.id).all()).results
    .map((r) => ({ ...r, countries: r.countries.split(',').filter(Boolean), devices: (r.devices || '').split(',').filter(Boolean) }));
  const rules = all.filter((r) => r.ab_of < 0);
  const rule = rules.length ? pickRule(rules, country, device) : null;
  // A/B 分流：命中的去向（规则或默认地址）有分流地址时，按比例选一个；同一访客总是去同一个
  const arms = all.filter((r) => r.ab_of === (rule ? rule.id : 0)).sort((a, b) => a.id - b.id);
  let arm = null, armIdx = -1;
  if (arms.length && (rule || link.target_url)) {
    const ip = request.headers.get('cf-connecting-ip') || '';
    armIdx = pickArm([rule ? rule.weight : link.ab_weight, ...arms.map((a) => a.weight)], ip ? `${ip}|${link.id}|${rule ? rule.id : 0}` : Math.random());
    arm = armIdx > 0 ? arms[armIdx - 1] : null;
  }
  const ruleId = arm ? arm.id : rule ? rule.id : 0;
  const raw = arm ? arm.url : rule ? rule.url : link.target_url;
  if (!raw) return notConfigured();

  const withQuery = (u) => {
    if (!link.pass_query && !link.utm) return u;
    const t = new URL(u);
    if (link.pass_query) {
      for (const [k, v] of url.searchParams) {
        if (k !== 'src') t.searchParams.set(k, v);
      }
    }
    // 转化追踪：目标地址（含透传后）没有任何 utm 参数时才加，不覆盖已有的
    if (link.utm && ![...t.searchParams.keys()].some((k) => k.startsWith('utm_'))) {
      t.searchParams.set('utm_source', 'cligc');
      t.searchParams.set('utm_medium', 'shortlink');
      t.searchParams.set('utm_campaign', link.slug);
      // 参与 A/B 分流时标出是哪个版本，在 GA4 里按 utm_content 对比转化
      if (armIdx >= 0) t.searchParams.set('utm_content', `ab-${ARM_NAMES[armIdx].toLowerCase()}`);
    }
    return t.toString();
  };
  const target = withQuery(raw);

  if (request.method === 'GET') {
    ctx.waitUntil(logClick(request, env, link.id, url, ruleId).catch((e) => console.error('log failed', e)));
  }

  // 规则开启了“打不开时回退”：先在访客浏览器里探测地区地址，连不上再改去默认地址。
  // 爬虫 / 链接预览不执行脚本，直接跳转；http 地址在 https 页面里无法探测，也直接跳转。
  if (rule && rule.fallback && link.target_url && request.method === 'GET'
    && target.startsWith('https:') && !parseUA(request.headers.get('user-agent') || '').bot) {
    const exp = Date.now() + 10 * 60 * 1000;
    const sig = await hmac(await sessionSecret(env), `fb|${rule.id}|${exp}`);
    return probePage(target, withQuery(link.target_url), { r: rule.id, e: exp, s: sig });
  }

  return new Response(null, {
    status: 302,
    headers: { location: target, 'cache-control': 'no-store, private' },
  });
}

// 过渡页：探测目标站点能否在访客网络中打开（任何 HTTP 响应都算能打开），失败则回退
function probePage(target, backup, beacon) {
  const js = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>正在跳转…</title>
<noscript><meta http-equiv="refresh" content="0;url=${target.replace(/"/g, '&quot;')}"></noscript>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f9;color:#868e9e;font:14px -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
@media (prefers-color-scheme:dark){body{background:#08090c;color:#757d8c}}
.s{display:flex;align-items:center;gap:10px;opacity:0;transition:opacity .4s}.s.on{opacity:1}
.d{width:14px;height:14px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:r .8s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}
</style></head><body><div class="s" id="s"><i class="d"></i>正在跳转…</div>
<script>
(function () {
  var t = ${js(target)}, b = ${js(backup)}, fb = ${js(beacon)}, done = false;
  setTimeout(function () { document.getElementById('s').className = 's on'; }, 500);
  function go(u) { if (done) return; done = true; location.replace(u); }
  function fail() {
    if (done) return;
    try { navigator.sendBeacon('/_fb', JSON.stringify(fb)); } catch (e) {}
    go(b);
  }
  var timer = setTimeout(fail, ${PROBE_TIMEOUT});
  try {
    fetch(new URL('/favicon.ico', t).href, { mode: 'no-cors', cache: 'no-store', credentials: 'omit' })
      .then(function () { clearTimeout(timer); go(t); }, function () { clearTimeout(timer); fail(); });
  } catch (e) { clearTimeout(timer); go(t); }
})();
</script></body></html>`;
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, private', 'referrer-policy': 'no-referrer-when-downgrade' },
  });
}

// 记录一次回退（由过渡页通过 sendBeacon 上报，带有效期签名）
async function recordFallback(request, env) {
  const body = await request.text().then((t) => JSON.parse(t)).catch(() => ({}));
  const r = Number(body.r), e = Number(body.e);
  if (!r || !e || e < Date.now() || typeof body.s !== 'string') return new Response(null, { status: 204 });
  const secret = await sessionSecret(env);
  if (await safeEqual(body.s, await hmac(secret, `fb|${r}|${e}`), secret)) {
    await env.DB.prepare('UPDATE link_targets SET fallbacks = fallbacks + 1 WHERE id = ?').bind(r).run();
  }
  return new Response(null, { status: 204 });
}

async function logClick(request, env, linkId, url, ruleId) {
  const h = request.headers;
  const cf = request.cf || {};
  const referer = h.get('referer') || '';
  let refererHost = '';
  try { refererHost = referer ? new URL(referer).hostname : ''; } catch {}

  const qs = url.searchParams;
  const utmSource = qs.get('utm_source') || '';
  const source = qs.get('src') || utmSource || refererHost || '(direct)';
  const ua = h.get('user-agent') || '';
  const parsed = parseUA(ua);
  const now = Date.now();
  const ip = h.get('cf-connecting-ip') || '';
  const recent = 1 + (await env.DB.prepare('SELECT COUNT(*) AS n FROM clicks WHERE link_id = ? AND ts > ? AND ip = ?')
    .bind(linkId, now - 60000, ip).first('n'));
  const visit = classifyVisit({
    ua, hasLang: h.has('accept-language'), lang: h.get('accept-language') || '', country: cf.country || '',
    asnOrg: cf.asOrganization || '', asn: Number(cf.asn) || 0, recent,
    secFetch: h.has('sec-fetch-mode'), tls: cf.tlsVersion || '', http: cf.httpProtocol || '',
  });

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO clicks (link_id, ts, source, referer, referer_host, utm_source, utm_medium, utm_campaign,
         ip, country, region, city, asn_org, ua, browser, os, device, is_bot, lang, rule_id, kind, reason, asn, tls, http, proxy)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      linkId, now, cut(source, 200), cut(referer, 1000), cut(refererHost, 200),
      cut(utmSource, 200), cut(qs.get('utm_medium') || '', 200), cut(qs.get('utm_campaign') || '', 200),
      ip, cf.country || '', cf.region || '', cf.city || '',
      cut(cf.asOrganization || '', 200), cut(ua, 500),
      parsed.browser, parsed.os, parsed.device, visit.kind === 'human' ? 0 : 1,
      cut((h.get('accept-language') || '').split(',')[0], 32),
      ruleId, visit.kind, cut(visit.reason, 300), Number(cf.asn) || 0, cut(cf.tlsVersion || '', 16), cut(cf.httpProtocol || '', 16), visit.proxy
    ),
    env.DB.prepare('UPDATE links SET clicks = clicks + 1, last_click = ? WHERE id = ?').bind(now, linkId),
  ]);
}

// ---------------------------------------------------------------- 后台 API

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/login' && method === 'POST') return login(request, env);
  if (path === '/api/login/2fa' && method === 'POST') return loginSecondStep(request, env);
  if (path === '/api/logout' && method === 'POST') {
    const sid = sessionToken(request).split('.')[1];
    if (sid) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run();
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
  }

  const cred = await authedCredential(request, env);
  if (!cred) return json({ error: 'unauthorized' }, 401);
  const res = await authedApi(request, env, url, cred);
  if (!cred.renew) return res;
  const out = new Response(res.body, res);
  out.headers.append('set-cookie', cred.renew);
  return out;
}

async function authedApi(request, env, url, cred) {
  const path = url.pathname;
  const method = request.method;
  if (method !== 'GET' && !(request.headers.get('content-type') || '').includes('application/json')) {
    return json({ error: 'content-type must be application/json' }, 415);
  }

  const mustChange = cred.source === 'default';
  if (path === '/api/me') return json({ ok: true, mustChange });
  if (path === '/api/password' && method === 'POST') return changePassword(request, env, cred);
  if (path === '/api/notify' && method === 'GET') return json(await notifyForClient(env));
  if (path === '/api/notify' && method === 'PUT') return saveNotify(request, env, url);
  if (path === '/api/notify/test' && method === 'POST') return testNotify(request, env);
  if (path === '/api/notify/preview' && method === 'GET' && url.searchParams.get('kind') === 'seo') {
    const cfg = { ...(await getNotify(env)), base: url.origin };
    const dg = await google.seoDigest(env, await sessionSecret(env), cfg.seo.tag).catch(() => null);
    const html = dg ? buildSeoDigest(cfg, dg).html : '<p style="font-family:sans-serif;padding:24px">没有可用的站点数据（还没连接 Google，或这个分组里没有站点）。</p>';
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  }
  if (path === '/api/notify/preview' && method === 'GET') {
    const kind = KIND_NAME[url.searchParams.get('kind')] ? url.searchParams.get('kind') : 'daily';
    const report = await buildReport(env, { ...(await getNotify(env)), base: url.origin }, kind, Date.now());
    return new Response(report.html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  }
  if (path === '/api/tracking' && method === 'GET') return json(await trackingInfo(env, url));
  if (path === '/api/tracking' && method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    await setSetting(env, 'tracking', body.enabled ? '1' : '0');
    return json(await trackingInfo(env, url));
  }
  if (path === '/api/2fa' && method === 'GET') return json({ enabled: !!cred.totp, since: cred.totp?.at || null });
  if (path === '/api/sessions' && method === 'GET') return json(await listSessions(env, cred));
  if (path === '/api/sessions/others' && method === 'DELETE') {
    const r = await env.DB.prepare('DELETE FROM sessions WHERE id != ?').bind(cred.sid).run();
    return json({ ok: true, n: r.meta.changes || 0 });
  }
  if (path.startsWith('/api/sessions/') && method === 'DELETE') {
    const sid = path.slice('/api/sessions/'.length);
    if (sid === cred.sid) return json({ error: '不能在这里退出当前设备，请用“退出登录”' }, 400);
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run();
    return json({ ok: true });
  }
  if (path === '/api/status' && method === 'GET') return json(await systemStatus(env));
  // 概览页的“开始使用”清单：各项是否已完成（只读设置，不请求外部接口）
  if (path === '/api/setup' && method === 'GET') {
    const n = await getNotify(env);
    const secret = await sessionSecret(env);
    return json({
      link: !!(await env.DB.prepare('SELECT 1 FROM links LIMIT 1').first()),
      mfa: !!cred.totp,
      google: !!(await env.DB.prepare('SELECT 1 FROM g_accounts LIMIT 1').first()),
      googleClient: await google.googleConfigured(env, secret),
      notify: !!(n.tg.enabled || n.email.enabled),
      cloudflare: !!(await cfCreds(env)),
    });
  }
  if (path === '/api/2fa/setup' && method === 'POST') return totpSetup(request, env, cred);
  if (path === '/api/2fa/enable' && method === 'POST') return totpEnable(request, env, cred);
  if (path === '/api/2fa/disable' && method === 'POST') return totpDisable(request, env, cred);
  // 仍在使用默认密码时，除修改密码外的接口一律拒绝
  if (mustChange) return json({ error: '请先修改默认密码', mustChange: true }, 403);
  if (path === '/api/overview' && method === 'GET') return overview(env, url);
  if (path === '/api/retention' && method === 'GET') return json(await retentionInfo(env));
  if (path.startsWith('/api/google/')) return googleApi(request, env, url);
  if (path.startsWith('/api/bing/')) return bingApi(request, env, url);
  if (path === '/api/shares' && method === 'GET') return json(await listShares(env, url));
  if (path === '/api/shares' && method === 'POST') return createShare(request, env, url);
  if (path.startsWith('/api/shares/') && path.endsWith('/views') && method === 'GET') {
    const token = path.slice('/api/shares/'.length, -'/views'.length);
    const rows = (await env.DB.prepare('SELECT at, ip, country, ua, agent, status FROM share_views WHERE token = ? ORDER BY at DESC LIMIT 200').bind(token).all()).results;
    return json({ items: rows });
  }
  if (path.startsWith('/api/shares/') && path.endsWith('/warm') && method === 'POST') {
    // 预先生成报告（不计入打开次数），AI 第一次打开时直接读缓存
    const row = await env.DB.prepare('SELECT * FROM shares WHERE token = ?').bind(path.slice('/api/shares/'.length, -'/warm'.length)).first();
    if (!row) return json({ error: 'not found' }, 404);
    const t0 = Date.now();
    await shareReport(env, await sessionSecret(env), row, true);
    return json({ ok: true, ms: Date.now() - t0 });
  }
  if (path.startsWith('/api/shares/') && method === 'DELETE') {
    await env.DB.prepare("DELETE FROM g_cache WHERE k = ?").bind(`ai-report|${path.slice('/api/shares/'.length)}`).run();
    await env.DB.prepare('DELETE FROM share_views WHERE token = ?').bind(path.slice('/api/shares/'.length)).run();
    await env.DB.prepare('DELETE FROM shares WHERE token = ?').bind(path.slice('/api/shares/'.length)).run();
    return json({ ok: true });
  }
  if (path === '/api/usage' && method === 'GET') return json(await cfUsage(env, url.searchParams.get('force') === '1'));
  if (path === '/api/usage/config' && method === 'PUT') {
    const r = await saveCfConfig(env, await request.json().catch(() => ({})));
    return r.error ? json(r, 400) : json(await cfUsage(env, true));
  }
  if (path === '/api/usage/config' && method === 'DELETE') {
    await env.DB.prepare("DELETE FROM settings WHERE key IN ('int_cf', 'usage_cache')").run();
    await setSetting(env, 'env_import_cf', String(Date.now()));   // 删除后不再从环境变量导入
    return json({ configured: false });
  }
  if (path === '/api/usage/plan' && method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    if (!['auto', 'free', 'paid'].includes(body.plan)) return json({ error: '套餐只能是 auto、free 或 paid' }, 400);
    await setSetting(env, 'cf_plan', body.plan);
    return json(await cfUsage(env, false));
  }
  if (path === '/api/retention' && method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    const days = Number(body.days) || 0;
    if (![0, 60, 90, 180, 365].includes(days)) return json({ error: '保留天数只能是 60、90、180、365 或永久' }, 400);
    await setSetting(env, 'retention_days', String(days));
    await env.DB.prepare("DELETE FROM settings WHERE key = 'clicks_count'").run();
    return json(await retentionInfo(env));
  }
  if (path === '/api/recent' && method === 'GET') {
    const linkId = Math.max(0, parseInt(url.searchParams.get('link'), 10) || 0);
    return json({ items: await recentClicks(env, url.searchParams.get('bots') === '1', linkId) });
  }
  if (path === '/api/links' && method === 'GET') return listLinks(env, url);
  if (path === '/api/links/bulk' && method === 'POST') return bulkLinks(request, env);
  if (path === '/api/links' && method === 'POST') return createLink(request, env);
  if (path === '/api/links/replace' && method === 'POST') return bulkReplace(request, env);

  const t = path.match(/^\/api\/links\/(\d+)\/targets(?:\/(\d+))?$/);
  if (t) {
    const linkId = Number(t[1]);
    const tid = t[2] ? Number(t[2]) : null;
    if (!tid && method === 'POST') return saveTarget(request, env, linkId, null);
    if (tid && method === 'PUT') return saveTarget(request, env, linkId, tid);
    if (tid && method === 'DELETE') return deleteTarget(request, env, linkId, tid);
  }
  const sp = path.match(/^\/api\/links\/(\d+)\/split$/);
  if (sp && method === 'PUT') return saveSplit(request, env, Number(sp[1]));
  const lg = path.match(/^\/api\/links\/(\d+)\/log(?:\/(\d+)\/revert)?$/);
  if (lg && !lg[2] && method === 'GET') return json(await listLog(env, Number(lg[1]), url));
  if (lg && lg[2] && method === 'POST') return revertLog(request, env, Number(lg[1]), Number(lg[2]));

  // 立即检查这个短链的目标地址
  const hc = path.match(/^\/api\/links\/(\d+)\/check$/);
  if (hc && method === 'POST') {
    const id = Number(hc[1]);
    const l = await env.DB.prepare('SELECT target_url FROM links WHERE id = ?').bind(id).first();
    if (!l) return json({ error: 'not found' }, 404);
    const urls = [...new Set([l.target_url, ...(await loadAllTargets(env, id)).map((t) => t.url)].filter(Boolean))];
    const res = await Promise.all(urls.map((u) => probeUrl(u)));
    for (let i = 0; i < urls.length; i++) await saveHealth(env, urls[i], res[i]);
    return json({ results: urls.map((u, i) => ({ url: u, ...res[i] })), health: Object.fromEntries(await healthOf(env, urls)) });
  }
  const dup = path.match(/^\/api\/links\/(\d+)\/duplicate$/);
  if (dup && method === 'POST') return duplicateLink(request, env, Number(dup[1]));

  const m = path.match(/^\/api\/links\/(\d+)(?:\/(stats|clicks|export))?$/);
  if (m) {
    const id = Number(m[1]);
    const sub = m[2];
    if (!sub && method === 'GET') return getLink(env, id);
    if (!sub && method === 'PUT') return updateLink(request, env, id);
    if (!sub && method === 'DELETE') return deleteLink(env, id);
    if (sub === 'stats' && method === 'GET') return linkStats(env, id, url);
    if (sub === 'clicks' && method === 'GET') return linkClicks(env, id, url);
    if (sub === 'export' && method === 'GET') return exportClicks(env, id);
  }
  return json({ error: 'not found' }, 404);
}

// 登录防暴力破解：同一 IP 连续输错 LOGIN_MAX_FAILS 次密码锁定，锁定时长从 15 分钟起逐次加倍（最长 24 小时）
const LOGIN_MAX_FAILS = 5, LOGIN_LOCK_MS = 15 * 60000, LOGIN_LOCK_MAX = DAY;
const loginIp = (request) => request.headers.get('cf-connecting-ip') || 'unknown';
const lockText = (ms) => (ms >= 3600000 ? `${Math.ceil(ms / 3600000)} 小时` : `${Math.ceil(ms / 60000)} 分钟`);

async function loginGuard(env, ip) {
  const g = await env.DB.prepare('SELECT * FROM login_guard WHERE ip = ?').bind(ip).first();
  return g && g.until > Date.now() ? g.until - Date.now() : 0;
}

async function loginFailed(env, ip) {
  const now = Date.now();
  const g = (await env.DB.prepare('SELECT * FROM login_guard WHERE ip = ?').bind(ip).first()) || { n: 0, locks: 0, until: 0, at: 0 };
  // 一小时内没有再输错就重新计数；锁定次数一天后清零
  let n = now - g.at > 3600000 ? 1 : g.n + 1, locks = now - g.at > DAY ? 0 : g.locks, until = 0;
  if (n >= LOGIN_MAX_FAILS) {
    until = now + Math.min(LOGIN_LOCK_MAX, LOGIN_LOCK_MS * 2 ** locks);
    locks += 1; n = 0;
  }
  await env.DB.prepare(
    `INSERT INTO login_guard (ip, n, locks, until, at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET n = excluded.n, locks = excluded.locks, until = excluded.until, at = excluded.at`
  ).bind(ip, n, locks, until, now).run();
  return until ? { locked: until - now } : { left: LOGIN_MAX_FAILS - n };
}

async function login(request, env) {
  const body = await request.json().catch(() => ({}));
  const ip = loginIp(request);
  const locked = await loginGuard(env, ip);
  if (locked) return json({ error: `密码错误次数过多，请 ${lockText(locked)}后再试` }, 429);
  // 配置了 Turnstile 时，先过人机验证再核对密码，防止暴力破解
  if (env.TURNSTILE_SECRET && !(await verifyTurnstile(env, body.turnstile, request))) {
    return json({ error: '人机验证未通过，请重试', turnstile: true }, 403);
  }
  const secret = await sessionSecret(env);
  const cred = await credential(env);
  if (!(await cred.verify(String(body.password || ''), secret))) {
    await new Promise((r) => setTimeout(r, 800));
    const f = await loginFailed(env, ip);
    return json({ error: f.locked ? `密码错误次数过多，已锁定 ${lockText(f.locked)}` : `密码错误（还可尝试 ${f.left} 次）` }, f.locked ? 429 : 401);
  }
  await env.DB.prepare('DELETE FROM login_guard WHERE ip = ?').bind(ip).run();
  if (cred.totp) {
    const exp = Date.now() + MFA_TICKET_MS;
    return json({ need2fa: true, ticket: `${exp}.${await hmac(secret, `mfa|${exp}|${cred.stamp}`)}` });
  }
  return json({ ok: true, mustChange: cred.source === 'default' }, 200,
    { 'set-cookie': sessionCookie(await issueToken(env, request, secret, cred), SESSION_TTL / 1000) });
}

// 登录第二步：校验动态码
async function loginSecondStep(request, env) {
  const body = await request.json().catch(() => ({}));
  const secret = await sessionSecret(env);
  const cred = await credential(env);
  const [exp, sig] = String(body.ticket || '').split('.');
  if (!cred.totp || !exp || !sig || Number(exp) < Date.now()
    || !(await safeEqual(sig, await hmac(secret, `mfa|${exp}|${cred.stamp}`), secret))) {
    return json({ error: '登录已过期，请重新输入密码', restart: true }, 401);
  }
  const locked = await mfaLocked(env);
  if (locked) return json({ error: locked }, 429);
  if (!(await useTotpCode(env, cred.totp, String(body.code || '')))) {
    return json({ error: (await mfaFail(env)) || '动态码不正确' }, 401);
  }
  return json({ ok: true, mustChange: false }, 200,
    { 'set-cookie': sessionCookie(await issueToken(env, request, secret, cred), SESSION_TTL / 1000) });
}

// ---------------------------------------------------------------- 两步验证（TOTP，RFC 6238）

async function totpSetup(request, env, cred) {
  const body = await request.json().catch(() => ({}));
  if (cred.totp) return json({ error: '两步验证已开启' }, 400);
  if (!(await cred.verify(String(body.password || ''), await sessionSecret(env)))) {
    await new Promise((r) => setTimeout(r, 800));
    return json({ error: '密码不正确' }, 400);
  }
  const key = b32encode(crypto.getRandomValues(new Uint8Array(20)));
  await setSetting(env, 'totp_pending', key);
  const host = new URL(request.url).hostname;
  const uri = `otpauth://totp/${encodeURIComponent(`cligc link:${host}`)}?secret=${key}&issuer=${encodeURIComponent('cligc link')}&algorithm=SHA1&digits=6&period=30`;
  return json({ secret: key, uri, svg: renderSVG(uri, { border: 1 }) });
}

async function totpEnable(request, env, cred) {
  const body = await request.json().catch(() => ({}));
  if (cred.totp) return json({ error: '两步验证已开启' }, 400);
  const pending = await getSetting(env, 'totp_pending');
  if (!pending || Date.now() - pending.updated_at > 15 * 60 * 1000) return json({ error: '设置已过期，请重新开始' }, 400);
  const step = await checkTotp(pending.value, String(body.code || ''), -1);
  if (step === null) return json({ error: '动态码不正确，请确认手机时间准确后重试' }, 400);
  await setSetting(env, 'totp', JSON.stringify({ secret: pending.value, at: Date.now(), last: step }));
  await env.DB.prepare("DELETE FROM settings WHERE key = 'totp_pending'").run();
  // 开启后其他会话全部失效，当前浏览器换发新会话
  return json({ ok: true }, 200, { 'set-cookie': await keepOnlyThisSession(env, request, cred) });
}

async function totpDisable(request, env, cred) {
  const body = await request.json().catch(() => ({}));
  if (!cred.totp) return json({ error: '两步验证未开启' }, 400);
  if (!(await cred.verify(String(body.password || ''), await sessionSecret(env)))) {
    await new Promise((r) => setTimeout(r, 800));
    return json({ error: '密码不正确' }, 400);
  }
  const locked = await mfaLocked(env);
  if (locked) return json({ error: locked }, 429);
  if (!(await useTotpCode(env, cred.totp, String(body.code || '')))) {
    return json({ error: (await mfaFail(env)) || '动态码不正确' }, 400);
  }
  await env.DB.prepare("DELETE FROM settings WHERE key = 'totp'").run();
  return json({ ok: true }, 200, { 'set-cookie': await keepOnlyThisSession(env, request, cred) });
}

// 校验动态码并记录已用的时间片，同一个码不能重复使用
async function useTotpCode(env, totp, code) {
  const step = await checkTotp(totp.secret, code, totp.last ?? -1);
  if (step === null) return false;
  await env.DB.prepare(
    "UPDATE settings SET value = json_set(value, '$.last', ?) WHERE key = 'totp'"
  ).bind(step).run();
  await env.DB.prepare("DELETE FROM settings WHERE key = 'mfa_fail'").run();
  return true;
}

async function mfaLocked(env) {
  const row = await getSetting(env, 'mfa_fail');
  const f = row ? JSON.parse(row.value) : null;
  if (f && f.until > Date.now()) return `动态码错误次数过多，请 ${Math.ceil((f.until - Date.now()) / 60000)} 分钟后再试`;
  return null;
}

async function mfaFail(env) {
  const row = await getSetting(env, 'mfa_fail');
  const f = row ? JSON.parse(row.value) : { n: 0, until: 0 };
  f.n = (f.until && f.until < Date.now() ? 0 : f.n) + 1;
  if (f.n >= MFA_MAX_FAILS) { f.n = 0; f.until = Date.now() + MFA_LOCK_MS; }
  await setSetting(env, 'mfa_fail', JSON.stringify(f));
  await new Promise((r) => setTimeout(r, 600));
  return f.until > Date.now() ? `动态码错误次数过多，已锁定 ${MFA_LOCK_MS / 60000} 分钟` : `动态码不正确（还可尝试 ${MFA_MAX_FAILS - f.n} 次）`;
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(bytes) {
  let bits = 0, val = 0, out = '';
  for (const b of bytes) {
    val = ((val << 8) | b) & 0xffff; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32decode(str) {
  let bits = 0, val = 0;
  const out = [];
  for (const c of str.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    val = ((val << 5) | B32.indexOf(c)) & 0xffff; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

async function totpAt(key, step) {
  const k = await crypto.subtle.importKey('raw', b32decode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new DataView(new ArrayBuffer(8));
  msg.setUint32(0, Math.floor(step / 2 ** 32)); msg.setUint32(4, step >>> 0);
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', k, msg.buffer));
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}

// 允许前后各一个 30 秒时间片的误差；返回匹配的时间片，未匹配返回 null
async function checkTotp(key, code, lastStep, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return null;
  const cur = Math.floor(now / 30000);
  for (const st of [cur, cur - 1, cur + 1]) {
    if (st <= lastStep) continue;
    if ((await totpAt(key, st)) === code) return st;
  }
  return null;
}

async function changePassword(request, env, cred) {
  const body = await request.json().catch(() => ({}));
  const secret = await sessionSecret(env);
  const current = String(body.current || '');
  const next = String(body.next || '');
  if (!(await cred.verify(current, secret))) {
    await new Promise((r) => setTimeout(r, 800));
    return json({ error: '当前密码不正确' }, 400);
  }
  if (next.length < MIN_PASSWORD_LENGTH) return json({ error: `新密码至少 ${MIN_PASSWORD_LENGTH} 位` }, 400);
  if (next.length > 200) return json({ error: '新密码太长' }, 400);
  if (next === DEFAULT_PASSWORD || next === current) return json({ error: '新密码不能与当前密码或默认密码相同' }, 400);

  await setSetting(env, 'admin_password', JSON.stringify(await hashPassword(next)));
  // 密码变化后，旧会话全部失效；给当前浏览器换发新会话
  return json({ ok: true }, 200, { 'set-cookie': await keepOnlyThisSession(env, request, cred) });
}

/**
 * 当前生效的管理员密码，优先级：后台修改过的密码 > ADMIN_PASSWORD > 默认密码
 * stamp 参与会话签名：密码一变，旧会话自动失效
 */
async function credential(env) {
  const rows = (await env.DB.prepare("SELECT key, value, updated_at FROM settings WHERE key IN ('admin_password', 'totp')").all()).results;
  const row = rows.find((r) => r.key === 'admin_password');
  const totpRow = rows.find((r) => r.key === 'totp');
  const totp = totpRow ? JSON.parse(totpRow.value) : null;
  const mfa = totp ? `|mfa:${totp.at}` : '';
  if (row) {
    const stored = JSON.parse(row.value);
    return { source: 'custom', stamp: `custom:${row.updated_at}${mfa}`, totp, verify: (pw) => verifyPassword(pw, stored) };
  }
  if (env.ADMIN_PASSWORD) {
    return { source: 'env', stamp: `env${mfa}`, totp, verify: (pw, secret) => safeEqual(pw, env.ADMIN_PASSWORD, secret) };
  }
  return { source: 'default', stamp: `default${mfa}`, totp, verify: (pw, secret) => safeEqual(pw, DEFAULT_PASSWORD, secret) };
}

// 会话令牌：过期时间.会话 ID.签名。会话 ID 对应 sessions 表里的一台登录设备，删掉那一行该设备即退出
async function issueToken(env, request, secret, cred, sid = null) {
  const now = Date.now(), exp = now + SESSION_TTL;
  if (sid) {
    await env.DB.prepare('UPDATE sessions SET exp = ? WHERE id = ?').bind(exp, sid).run();
  } else {
    sid = toHex(crypto.getRandomValues(new Uint8Array(12)));
    const cf = request.cf || {};
    await env.DB.prepare('INSERT INTO sessions (id, created_at, seen_at, exp, ip, country, city, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(sid, now, now, exp, loginIp(request), cf.country || '', cut(cf.city || '', 80), cut(request.headers.get('user-agent') || '', 300)).run();
  }
  return `${exp}.${sid}.${await hmac(secret, `${exp}|${sid}|${cred.stamp}`)}`;
}

// 密码或两步验证变了：其他设备全部退出，当前设备换发新令牌（会话 ID 不变）
async function keepOnlyThisSession(env, request, cred) {
  await env.DB.prepare('DELETE FROM sessions WHERE id != ?').bind(cred.sid || '').run();
  return sessionCookie(await issueToken(env, request, await sessionSecret(env), await credential(env), cred.sid), SESSION_TTL / 1000);
}

const sessionToken = (request) => ((request.headers.get('cookie') || '').match(/(?:^|;\s*)sl_session=([^;]+)/) || [])[1] || '';

// 已登录则返回当前密码信息（带上会话 ID），否则返回 null
async function authedCredential(request, env) {
  const parts = sessionToken(request).split('.');
  const exp = parts[0];
  if (!exp || Number(exp) < Date.now() || parts.length < 2) return null;
  const secret = await sessionSecret(env);
  const cred = await credential(env);
  // 旧版令牌（没有会话 ID）：校验通过后补登记为一台设备，并换发新令牌
  if (parts.length === 2) {
    if (!(await safeEqual(parts[1], await hmac(secret, `${exp}|${cred.stamp}`), secret))) return null;
    const token = await issueToken(env, request, secret, cred);
    cred.sid = token.split('.')[1];
    cred.renew = sessionCookie(token, SESSION_TTL / 1000);
    return cred;
  }
  const [, sid, sig] = parts;
  if (!(await safeEqual(sig, await hmac(secret, `${exp}|${sid}|${cred.stamp}`), secret))) return null;
  const row = await env.DB.prepare('SELECT seen_at FROM sessions WHERE id = ?').bind(sid).first();
  if (!row) return null;
  // 最近使用时间最多 5 分钟写一次，省写入
  if (Date.now() - row.seen_at > 5 * 60000) {
    const cf = request.cf || {};
    await env.DB.prepare('UPDATE sessions SET seen_at = ?, ip = ?, country = ?, city = ? WHERE id = ?')
      .bind(Date.now(), loginIp(request), cf.country || '', cut(cf.city || '', 80), sid).run();
  }
  cred.sid = sid;
  return cred;
}

// 登录设备列表
async function listSessions(env, cred) {
  const rows = (await env.DB.prepare('SELECT id, created_at, seen_at, exp, ip, country, city, ua FROM sessions WHERE exp > ? ORDER BY seen_at DESC').bind(Date.now()).all()).results;
  return { items: rows.map((r) => ({ ...r, current: r.id === cred.sid, ...pick(parseUA(r.ua), ['browser', 'os', 'device']) })) };
}
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

// 会话签名密钥：优先用 SESSION_SECRET，未设置时首次运行自动生成并保存
let cachedSecret = null;
async function sessionSecret(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (cachedSecret) return cachedSecret;
  let row = await getSetting(env, 'session_secret');
  if (!row) {
    await env.DB.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
      .bind('session_secret', toHex(crypto.getRandomValues(new Uint8Array(32))), Date.now()).run();
    row = await getSetting(env, 'session_secret');
  }
  cachedSecret = row.value;
  return cachedSecret;
}

async function getSetting(env, key) {
  return env.DB.prepare('SELECT value, updated_at FROM settings WHERE key = ?').bind(key).first();
}

async function setSetting(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, value, Date.now()).run();
}

// ---------------------------------------------------------------- 来源追踪代码
// 放在推广页面上：识别访客从哪个搜索引擎 / 广告进来，给指向短链的链接加上 utm_source。
// 不改动链接上已有的 src 和 utm_source。

function trackerCode(host) {
  return `(function () {
  var HOST = ${JSON.stringify(host)}, KEY = 'cligc_utm';
  // 搜索引擎域名关键字 → 来源名
  var ENGINES = [['google', 'google'], ['bing', 'bing'], ['baidu', 'baidu'], ['sogou', 'sogou'], ['so.com', '360'], ['sm.cn', 'shenma'],
    ['yahoo', 'yahoo'], ['duckduckgo', 'duckduckgo'], ['yandex', 'yandex'], ['naver', 'naver'], ['ecosia', 'ecosia'], ['brave', 'brave']];
  var src = '';
  try {
    var q = new URLSearchParams(location.search);
    src = q.get('utm_source') || (q.get('gclid') ? 'google-ads' : q.get('msclkid') ? 'bing-ads' : '');
    if (!src && document.referrer) {
      var h = '.' + new URL(document.referrer).hostname + '.';
      for (var i = 0; i < ENGINES.length; i++) if (h.indexOf('.' + ENGINES[i][0] + '.') > -1) { src = ENGINES[i][1]; break; }
    }
    // 记住首次来源，访客在站内翻页后再点短链也不会丢
    if (src) sessionStorage.setItem(KEY, src); else src = sessionStorage.getItem(KEY) || '';
  } catch (e) {}
  if (!src) return;
  function tag(a) {
    try {
      var u = new URL(a.href);
      if (u.hostname !== HOST || u.searchParams.has('utm_source')) return;
      u.searchParams.set('utm_source', src);
      a.href = u.toString();
    } catch (e) {}
  }
  function all() { var l = document.querySelectorAll('a[href]'); for (var i = 0; i < l.length; i++) tag(l[i]); }
  // 页面加载后处理一遍；之后动态插入的链接在点击时处理
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', all); else all();
  ['mousedown', 'touchstart', 'click', 'auxclick'].forEach(function (t) {
    document.addEventListener(t, function (e) { var a = e.target.closest && e.target.closest('a[href]'); if (a) tag(a); }, true);
  });
})();`;
}

async function trackingEnabled(env) {
  return (await getSetting(env, 'tracking'))?.value === '1';
}

async function trackingInfo(env, url) {
  const host = url.hostname;
  return {
    enabled: await trackingEnabled(env),
    script: `<script src="${url.origin}/t.js" async></script>`,
    code: `<script>\n${trackerCode(host)}\n</script>`,
  };
}

async function trackerScript(env, url) {
  const on = await trackingEnabled(env);
  return new Response(on ? trackerCode(url.hostname) : '/* cligc link: 来源追踪未开启 */', {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': on ? 'public, max-age=3600' : 'public, max-age=300',
      'access-control-allow-origin': '*',
    },
  });
}

// PBKDF2-SHA256 加盐哈希（Workers 上限为 10 万次迭代）
const PBKDF2_ITERATIONS = 100000;
async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return toHex(new Uint8Array(bits));
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { alg: 'pbkdf2-sha256', iter: PBKDF2_ITERATIONS, salt: toHex(salt), hash: await pbkdf2(password, salt, PBKDF2_ITERATIONS) };
}

async function verifyPassword(password, stored) {
  const salt = new Uint8Array(stored.salt.match(/../g).map((h) => parseInt(h, 16)));
  const hash = await pbkdf2(password, salt, stored.iter);
  let diff = hash.length ^ stored.hash.length;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ stored.hash.charCodeAt(i);
  return diff === 0;
}

function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifyTurnstile(env, token, request) {
  if (!token || typeof token !== 'string' || token.length > 2048) return false;
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) form.append('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.error('turnstile verify failed', err);
    return false;
  }
}

function sessionCookie(value, maxAge) {
  return `sl_session=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 先做 HMAC 再比较，避免长度和时序泄露
async function safeEqual(a, b, secret) {
  const [x, y] = await Promise.all([hmac(secret, a), hmac(secret, b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------- 短链 CRUD

async function validateLinkInput(body, env, currentId) {
  const out = {};
  if (body.slug !== undefined) {
    const slug = String(body.slug).trim();
    if (!SLUG_RE.test(slug)) return { error: '短链后缀只能包含字母、数字、- 和 _，长度 1-64' };
    if (RESERVED.has(slug.toLowerCase())) return { error: `"${slug}" 是保留字` };
    const exists = await env.DB.prepare('SELECT id FROM links WHERE slug = ?').bind(slug).first();
    if (exists && exists.id !== currentId) return { error: `短链 "${slug}" 已存在` };
    out.slug = slug;
  }
  if (body.target_url !== undefined) {
    const raw = String(body.target_url ?? '').trim();
    if (raw) {
      const u = normalizeUrl(raw);
      if (!u) return { error: '默认目标地址必须是合法的 http / https 地址' };
      out.target_url = u;
    } else {
      out.target_url = '';
    }
  }
  if (body.title !== undefined) out.title = cut(String(body.title), 200);
  if (body.note !== undefined) out.note = cut(String(body.note), 2000);
  if (body.enabled !== undefined) out.enabled = body.enabled ? 1 : 0;
  if (body.pass_query !== undefined) out.pass_query = body.pass_query ? 1 : 0;
  if (body.utm !== undefined) out.utm = body.utm ? 1 : 0;
  if (body.expires_at !== undefined) {
    out.expires_at = body.expires_at ? Number(body.expires_at) : null;
    if (out.expires_at !== null && !Number.isFinite(out.expires_at)) return { error: '过期时间不合法' };
  }
  return { data: out };
}

async function createLink(request, env) {
  const body = await request.json().catch(() => ({}));
  // 后缀和默认推广地址至少填一个
  if (!String(body.slug || '').trim() && !String(body.target_url || '').trim()) {
    return json({ error: '请填写短链后缀或默认推广地址' }, 400);
  }
  if (!body.slug) body.slug = await uniqueSlug(env);
  const { error, data } = await validateLinkInput(body, env);
  if (error) return json({ error }, 400);

  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO links (slug, target_url, title, note, enabled, pass_query, utm, expires_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING *`
  ).bind(
    data.slug, data.target_url || '', data.title || '', data.note || '',
    data.enabled ?? 1, data.pass_query ?? 0, data.utm ?? 0, data.expires_at ?? null, now, now
  ).first();
  await addLog(env, request, row.id, 'create', { slug: row.slug, target_url: row.target_url });
  return json(row, 201);
}

// 复制短链：标题、推广地址、设置和地区规则都带过去，访问记录不复制
async function duplicateLink(request, env, id) {
  const src = await env.DB.prepare('SELECT * FROM links WHERE id = ?').bind(id).first();
  if (!src) return json({ error: '短链不存在' }, 404);
  const body = await request.json().catch(() => ({}));
  const slug = String(body.slug || '').trim() || await uniqueSlug(env);
  // 不传 title 时沿用原标题
  const input = { slug, title: body.title === undefined ? src.title : body.title };
  const { error, data } = await validateLinkInput(input, env);
  if (error) return json({ error }, 400);

  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO links (slug, target_url, title, note, enabled, pass_query, utm, expires_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING *`
  ).bind(data.slug, src.target_url, data.title, src.note, src.enabled, src.pass_query, src.utm || 0, src.expires_at, now, now).first();
  // 规则和 A/B 分流地址一起复制：先复制规则，再把分流地址挂到新规则上
  if (src.ab_weight) await env.DB.prepare('UPDATE links SET ab_weight = ? WHERE id = ?').bind(src.ab_weight, row.id).run();
  const old = (await env.DB.prepare('SELECT * FROM link_targets WHERE link_id = ? ORDER BY id').bind(id).all()).results;
  const ids = new Map([[0, 0]]);
  for (const t of [...old.filter((t) => t.ab_of < 0), ...old.filter((t) => t.ab_of >= 0)]) {
    if (t.ab_of >= 0 && !ids.has(t.ab_of)) continue;
    const r = await env.DB.prepare(
      `INSERT INTO link_targets (link_id, countries, devices, url, note, fallback, ab_of, weight, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    ).bind(row.id, t.countries, t.devices || '', t.url, t.note, t.fallback, t.ab_of < 0 ? -1 : ids.get(t.ab_of), t.weight || 0, now, now).first();
    if (t.ab_of < 0) ids.set(t.id, r.id);
  }
  await env.DB.prepare('INSERT OR IGNORE INTO link_tags (link_id, tag) SELECT ?, tag FROM link_tags WHERE link_id = ?').bind(row.id, id).run();
  await addLog(env, request, row.id, 'create', { slug: row.slug, target_url: row.target_url, from: src.slug });
  return json(row, 201);
}

// 批量替换目标地址：默认地址和地区规则的地址都会处理。dry = true 时只预览不修改
async function bulkReplace(request, env) {
  const body = await request.json().catch(() => ({}));
  const mode = body.mode === 'contains' ? 'contains' : 'exact';
  const find = String(body.find || '').trim();
  let to = String(body.replace || '').trim();
  if (!find) return json({ error: '请填写原始链接' }, 400);
  if (!to) return json({ error: '请填写替换后的链接' }, 400);
  if (mode === 'exact') {
    to = normalizeUrl(to);
    if (!to) return json({ error: '替换后的链接必须是合法的 http / https 地址' }, 400);
  }
  // 完全匹配时同时匹配用户输入和规范化后的写法（如 https://a.com 与 https://a.com/）
  const finds = mode === 'exact' ? [...new Set([find, normalizeUrl(find)].filter(Boolean))] : [find];
  const where = mode === 'exact' ? `IN (${finds.map(() => '?').join(',')})` : '';
  const [links, rules] = await Promise.all([
    (mode === 'exact'
      ? env.DB.prepare(`SELECT id, slug, title, target_url AS url FROM links WHERE target_url ${where} ORDER BY id`).bind(...finds)
      : env.DB.prepare('SELECT id, slug, title, target_url AS url FROM links WHERE instr(target_url, ?) > 0 ORDER BY id').bind(find)).all(),
    (mode === 'exact'
      ? env.DB.prepare(`SELECT t.id, t.link_id, t.countries, t.url, l.slug FROM link_targets t JOIN links l ON l.id = t.link_id WHERE t.url ${where} ORDER BY t.link_id, t.id`).bind(...finds)
      : env.DB.prepare('SELECT t.id, t.link_id, t.countries, t.url, l.slug FROM link_targets t JOIN links l ON l.id = t.link_id WHERE instr(t.url, ?) > 0 ORDER BY t.link_id, t.id').bind(find)).all(),
  ]);
  const next = (u) => (mode === 'exact' ? to : u.split(find).join(to));
  const items = [
    ...links.results.map((l) => ({ type: 'link', id: l.id, slug: l.slug, title: l.title, from: l.url, to: next(l.url) })),
    ...rules.results.map((t) => ({ type: 'rule', id: t.id, link_id: t.link_id, slug: t.slug, countries: t.countries.split(',').filter(Boolean), from: t.url, to: next(t.url) })),
  ];
  // 替换后的地址都必须合法
  const bad = items.find((x) => !normalizeUrl(x.to));
  const summary = {
    mode, find, replace: to, total: items.length,
    links: items.filter((x) => x.type === 'link').length,
    rules: items.filter((x) => x.type === 'rule').length,
    affected: new Set(items.map((x) => (x.type === 'link' ? x.id : x.link_id))).size,
    invalid: bad ? { slug: bad.slug, to: bad.to } : null,
  };
  if (body.dry !== false) return json({ ...summary, items: items.slice(0, 200) });
  if (!items.length) return json({ error: '没有找到要替换的地址' }, 400);
  if (bad) return json({ error: `替换后 /${bad.slug} 的地址不合法：${bad.to}` }, 400);

  const now = Date.now();
  const stmts = items.flatMap((x) => (x.type === 'link'
    ? [env.DB.prepare('UPDATE links SET target_url = ?, updated_at = ? WHERE id = ?').bind(normalizeUrl(x.to), now, x.id),
      logStmt(env, request, x.id, 'update', { changes: { target_url: [x.from, normalizeUrl(x.to)] }, via: 'replace' })]
    : [env.DB.prepare('UPDATE link_targets SET url = ?, updated_at = ? WHERE id = ?').bind(normalizeUrl(x.to), now, x.id),
      logStmt(env, request, x.link_id, 'rule.edit', { before: { id: x.id, url: x.from }, after: { id: x.id, url: normalizeUrl(x.to) }, via: 'replace' })]));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return json({ ...summary, done: true });
}

async function updateLink(request, env, id) {
  const body = await request.json().catch(() => ({}));
  const { error, data } = await validateLinkInput(body, env, id);
  if (error) return json({ error }, 400);
  if (!Object.keys(data).length) return json({ error: '没有要更新的字段' }, 400);
  const r = await applyLinkUpdate(env, request, id, data);
  return r.row ? json(r.row) : json({ error: 'not found' }, 404);
}

// 更新短链字段并记下改了什么（只记真正变化的字段）
async function applyLinkUpdate(env, request, id, data, extra = {}) {
  const before = await env.DB.prepare('SELECT * FROM links WHERE id = ?').bind(id).first();
  if (!before) return {};
  const cols = Object.keys(data);
  const row = await env.DB.prepare(
    `UPDATE links SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ? RETURNING *`
  ).bind(...cols.map((c) => data[c]), Date.now(), id).first();
  const changes = Object.fromEntries(cols.filter((c) => LOG_FIELDS.includes(c) && before[c] !== row[c]).map((c) => [c, [before[c], row[c]]]));
  let logId = null;
  if (Object.keys(changes).length) logId = await addLog(env, request, id, 'update', { changes, ...extra });
  return { row, logId };
}

async function deleteLink(env, id) {
  await dropLinkAgg(env, id);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM clicks WHERE link_id = ?').bind(id),
    env.DB.prepare('DELETE FROM link_targets WHERE link_id = ?').bind(id),
    env.DB.prepare('DELETE FROM link_tags WHERE link_id = ?').bind(id),
    env.DB.prepare('DELETE FROM link_log WHERE link_id = ?').bind(id),
    env.DB.prepare('DELETE FROM links WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
}

// 批量操作：启用 / 停用 / 删除 / 加分组 / 移出分组；分组改名、删除分组
async function bulkLinks(request, env) {
  const b = await request.json().catch(() => ({}));
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 500);
  const tag = cut(String(b.tag || '').trim(), 40);
  const now = Date.now();
  const inIds = ids.map(() => '?').join(',');
  if (b.action === 'renameTag' || b.action === 'dropTag') {
    if (!tag) return json({ error: '分组名不能为空' }, 400);
    const to = cut(String(b.to || '').trim(), 40);
    if (b.action === 'renameTag') {
      if (!to) return json({ error: '分组名不能为空' }, 400);
      await env.DB.batch([
        env.DB.prepare('INSERT OR IGNORE INTO link_tags (link_id, tag) SELECT link_id, ? FROM link_tags WHERE tag = ?').bind(to, tag),
        env.DB.prepare('DELETE FROM link_tags WHERE tag = ? AND tag != ?').bind(tag, to),
      ]);
    } else await env.DB.prepare('DELETE FROM link_tags WHERE tag = ?').bind(tag).run();
    return json({ ok: true, tags: await linkTagList(env) });
  }
  if (!ids.length) return json({ error: '没有选中短链' }, 400);
  if (b.action === 'enable' || b.action === 'disable') {
    const v = b.action === 'enable' ? 1 : 0;
    const changed = (await env.DB.prepare(`SELECT id FROM links WHERE enabled != ? AND id IN (${inIds})`).bind(v, ...ids).all()).results;
    await env.DB.batch([
      env.DB.prepare(`UPDATE links SET enabled = ?, updated_at = ? WHERE id IN (${inIds})`).bind(v, now, ...ids),
      ...changed.map((r) => logStmt(env, request, r.id, 'update', { changes: { enabled: [1 - v, v] }, via: 'bulk' })),
    ]);
  } else if (b.action === 'delete') {
    for (const id of ids) await deleteLink(env, id);
  } else if (b.action === 'tag' || b.action === 'untag') {
    if (!tag) return json({ error: '请填写分组名' }, 400);
    const st = ids.map((id) => (b.action === 'tag'
      ? env.DB.prepare('INSERT OR IGNORE INTO link_tags (link_id, tag) VALUES (?, ?)').bind(id, tag)
      : env.DB.prepare('DELETE FROM link_tags WHERE link_id = ? AND tag = ?').bind(id, tag)));
    for (let i = 0; i < st.length; i += 100) await env.DB.batch(st.slice(i, i + 100));
  } else return json({ error: '未知操作' }, 400);
  return json({ ok: true, n: ids.length, tags: await linkTagList(env) });
}
const linkTagList = async (env) => (await env.DB.prepare('SELECT tag, COUNT(*) AS n FROM link_tags GROUP BY tag ORDER BY tag').all()).results;

async function getLink(env, id) {
  const row = await env.DB.prepare('SELECT * FROM links WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'not found' }, 404);
  const all = await loadAllTargets(env, id);
  row.targets = all.filter((t) => t.ab_of < 0).map((t) => ({ ...t, arms: all.filter((a) => a.ab_of === t.id) }));
  row.arms = all.filter((a) => a.ab_of === 0);
  row.tags = (await env.DB.prepare('SELECT tag FROM link_tags WHERE link_id = ? ORDER BY tag').bind(id).all()).results.map((r) => r.tag);
  row.health = Object.fromEntries(await healthOf(env, [row.target_url, ...all.map((t) => t.url)].filter(Boolean)));
  return json(row);
}

// 全部去向（规则 + A/B 分流地址）
async function loadAllTargets(env, linkId) {
  const r = await env.DB.prepare('SELECT * FROM link_targets WHERE link_id = ? ORDER BY id').bind(linkId).all();
  return r.results.map((t) => ({ ...t, countries: t.countries.split(',').filter(Boolean), devices: (t.devices || '').split(',').filter(Boolean) }));
}
// 只有跳转规则（不含分流地址）
const loadTargets = async (env, linkId) => (await loadAllTargets(env, linkId)).filter((t) => t.ab_of < 0);

// ---------------------------------------------------------------- 地区跳转规则

async function saveTarget(request, env, linkId, tid) {
  const link = await env.DB.prepare('SELECT id FROM links WHERE id = ?').bind(linkId).first();
  if (!link) return json({ error: '短链不存在' }, 404);
  const body = await request.json().catch(() => ({}));
  const before = tid ? (await loadTargets(env, linkId)).find((t) => t.id === tid) : null;
  if (tid && !before) return json({ error: 'not found' }, 404);
  const r = await applyTarget(env, linkId, tid, body);
  if (r.error) return json(r, 400);
  if (!before) await addLog(env, request, linkId, 'rule.add', { after: ruleSnap(r.row) });
  else if (JSON.stringify(ruleSnap(before)) !== JSON.stringify(ruleSnap(r.row))) await addLog(env, request, linkId, 'rule.edit', { before: ruleSnap(before), after: ruleSnap(r.row) });
  return json(r.row, tid ? 200 : 201);
}

// 校验并保存一条跳转规则；返回 { row } 或 { error }
async function applyTarget(env, linkId, tid, body, forceId = null) {
  const url = normalizeUrl(String(body.url || '').trim());
  if (!url) return { error: '目标地址必须是合法的 http / https 地址' };
  const countries = [...new Set((Array.isArray(body.countries) ? body.countries : [])
    .map((c) => String(c).trim().toUpperCase()))];
  const devices = [...new Set((Array.isArray(body.devices) ? body.devices : []).map(String))].filter((d) => DEVICES.includes(d));
  if (!countries.length && !devices.length) return { error: '至少选择一个国家 / 地区或设备' };
  if (countries.some((c) => !/^[A-Z]{2}$/.test(c))) return { error: '国家代码不合法' };

  // 冲突只在同一类规则之间检查（只按国家 / 只按设备 / 两者都有）：不同类按优先级匹配，不冲突
  const kind = (t) => (t.countries.length && t.devices.length ? 'both' : t.devices.length ? 'device' : 'country');
  const me = { countries, devices };
  const others = (await loadTargets(env, linkId)).filter((t) => t.id !== tid && kind(t) === kind(me));
  // 同一类里：用到的维度都有交集才算重叠（只按国家的看国家，只按设备的看设备，两者都有的两个都看）
  const inter = (a, b) => a.some((x) => b.includes(x));
  const clash = others.find((t) => (!countries.length || inter(t.countries, countries)) && (!devices.length || inter(t.devices, devices)));
  if (clash) {
    const taken = countries.filter((c) => clash.countries.includes(c));
    const dTaken = devices.filter((d) => clash.devices.includes(d));
    const DN = { ios: 'iOS', android: 'Android', desktop: '电脑' };
    return { error: `和另一条规则重叠：${[...taken, ...dTaken.map((d) => DN[d])].join('、')}`, taken };
  }

  const now = Date.now();
  const note = cut(String(body.note || ''), 200);
  const fallback = body.fallback ? 1 : 0;
  const row = tid
    ? await env.DB.prepare(
      'UPDATE link_targets SET countries = ?, devices = ?, url = ?, note = ?, fallback = ?, updated_at = ? WHERE id = ? AND link_id = ? RETURNING *'
    ).bind(countries.join(','), devices.join(','), url, note, fallback, now, tid, linkId).first()
    : await env.DB.prepare(
      `INSERT INTO link_targets (${forceId ? 'id, ' : ''}link_id, countries, devices, url, note, fallback, weight, created_at, updated_at)
       VALUES (${forceId ? '?, ' : ''}?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
    ).bind(...(forceId ? [forceId] : []), linkId, countries.join(','), devices.join(','), url, note, fallback, Number(body.weight) || 0, now, now).first();
  if (!row) return { error: 'not found' };
  return { row: { ...row, countries, devices } };
}

async function deleteTarget(request, env, linkId, tid) {
  const all = await loadAllTargets(env, linkId);
  const t = all.find((x) => x.id === tid && x.ab_of < 0);
  if (!t) return json({ ok: true });
  const arms = all.filter((a) => a.ab_of === tid);
  await env.DB.prepare('DELETE FROM link_targets WHERE link_id = ? AND (id = ? OR ab_of = ?)').bind(linkId, tid, tid).run();
  await addLog(env, request, linkId, 'rule.del', { before: ruleSnap(t), arms: arms.map(armSnap), weight: t.weight });
  return json({ ok: true });
}

// ---------------------------------------------------------------- A/B 分流
// 一个去向（默认地址 parent = 0，或规则 parent = 规则 ID）按比例分到多个地址。
// 原地址是 A，分流地址按顺序是 B、C……；分流地址也存在 link_targets 里（ab_of = parent），命中统计沿用规则统计。
const MAX_ARMS = 4;
async function saveSplit(request, env, linkId) {
  const body = await request.json().catch(() => ({}));
  const r = await applySplit(env, linkId, body);
  if (r.error) return json(r, 400);
  if (JSON.stringify(r.before) !== JSON.stringify(r.after)) await addLog(env, request, linkId, 'split', { parent: r.parent, before: r.before, after: r.after });
  return json({ ok: true });
}

async function splitState(env, linkId, parent) {
  const all = await loadAllTargets(env, linkId);
  const weight = parent ? all.find((t) => t.id === parent)?.weight : (await env.DB.prepare('SELECT ab_weight FROM links WHERE id = ?').bind(linkId).first('ab_weight'));
  return { weight: Number(weight) || 0, arms: all.filter((a) => a.ab_of === parent).map(armSnap) };
}

// body: { parent, weight, arms: [{ id?, url, weight, note }] }；arms 为空表示取消分流
async function applySplit(env, linkId, body, keepIds = false) {
  const link = await env.DB.prepare('SELECT id, target_url FROM links WHERE id = ?').bind(linkId).first();
  if (!link) return { error: '短链不存在' };
  const parent = Math.max(0, parseInt(body.parent, 10) || 0);
  const all = await loadAllTargets(env, linkId);
  if (parent && !all.some((t) => t.id === parent && t.ab_of < 0)) return { error: '规则不存在' };
  if (!parent && !link.target_url) return { error: '请先设置默认地址' };
  const arms = (Array.isArray(body.arms) ? body.arms : []).slice(0, MAX_ARMS + 1);
  if (arms.length > MAX_ARMS) return { error: `最多再加 ${MAX_ARMS} 个分流地址` };
  const clean = [];
  for (const a of arms) {
    const url = normalizeUrl(String(a.url || '').trim());
    if (!url) return { error: '分流地址必须是合法的 http / https 地址' };
    const w = Math.round(Number(a.weight));
    if (!(w >= 1 && w <= 100)) return { error: '比例必须是 1–100' };
    clean.push({ id: Number(a.id) || null, url, weight: w, note: cut(String(a.note || ''), 200) });
  }
  const weight = clean.length ? Math.round(Number(body.weight)) : 0;
  if (clean.length && !(weight >= 1 && weight <= 100)) return { error: '比例必须是 1–100' };
  const before = await splitState(env, linkId, parent);
  const mine = new Set(all.filter((a) => a.ab_of === parent).map((a) => a.id));
  const now = Date.now();
  const stmts = [
    parent ? env.DB.prepare('UPDATE link_targets SET weight = ?, updated_at = ? WHERE id = ?').bind(weight, now, parent)
      : env.DB.prepare('UPDATE links SET ab_weight = ?, updated_at = ? WHERE id = ?').bind(weight, now, linkId),
  ];
  const keep = new Set(clean.filter((a) => a.id && mine.has(a.id)).map((a) => a.id));
  for (const id of mine) if (!keep.has(id)) stmts.push(env.DB.prepare('DELETE FROM link_targets WHERE id = ?').bind(id));
  for (const a of clean) {
    if (a.id && mine.has(a.id)) {
      stmts.push(env.DB.prepare('UPDATE link_targets SET url = ?, weight = ?, note = ?, updated_at = ? WHERE id = ?').bind(a.url, a.weight, a.note, now, a.id));
    } else {
      // 撤销时尽量用回原来的 ID，命中统计能接上
      const reuse = keepIds && a.id && !all.some((t) => t.id === a.id);
      stmts.push(env.DB.prepare(
        `INSERT INTO link_targets (${reuse ? 'id, ' : ''}link_id, countries, devices, url, note, fallback, ab_of, weight, created_at, updated_at)
         VALUES (${reuse ? '?, ' : ''}?, '', '', ?, ?, 0, ?, ?, ?, ?)`
      ).bind(...(reuse ? [a.id] : []), linkId, a.url, a.note, parent, a.weight, now, now));
    }
  }
  await env.DB.batch(stmts);
  return { parent, before, after: await splitState(env, linkId, parent) };
}

// ---------------------------------------------------------------- 修改记录
const LOG_FIELDS = ['slug', 'target_url', 'title', 'note', 'enabled', 'pass_query', 'utm', 'expires_at'];
const ruleSnap = (t) => ({ id: t.id, countries: t.countries, devices: t.devices, url: t.url, note: t.note, fallback: t.fallback });
const armSnap = (a) => ({ id: a.id, url: a.url, weight: a.weight, note: a.note });

function logStmt(env, request, linkId, action, data) {
  return env.DB.prepare('INSERT INTO link_log (link_id, at, action, data, ip, ua) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
    .bind(linkId, Date.now(), action, JSON.stringify(data), request ? loginIp(request) : '', request ? cut(request.headers.get('user-agent') || '', 300) : '');
}
async function addLog(env, request, linkId, action, data) {
  return (await logStmt(env, request, linkId, action, data).first())?.id ?? null;
}

async function listLog(env, linkId, url) {
  const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
  const rows = (await env.DB.prepare('SELECT * FROM link_log WHERE link_id = ? AND id < ? ORDER BY id DESC LIMIT 31').bind(linkId, before).all()).results;
  return {
    items: rows.slice(0, 30).map((r) => ({ ...r, data: JSON.parse(r.data || '{}'), ...pick(parseUA(r.ua), ['browser', 'os']), ua: undefined })),
    more: rows.length > 30,
  };
}

// 撤销一条修改：只撤销之后没有再被改过的部分；撤销本身也记一条
async function revertLog(request, env, linkId, logId) {
  const e = await env.DB.prepare('SELECT * FROM link_log WHERE id = ? AND link_id = ?').bind(logId, linkId).first();
  if (!e) return json({ error: '记录不存在' }, 404);
  if (e.reverted) return json({ error: '这条修改已经撤销过了' }, 400);
  const d = JSON.parse(e.data || '{}');
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const conflict = () => json({ error: '之后又被修改过，不能直接撤销。可以手动改回去。' }, 409);
  let newId = null;
  if (e.action === 'update') {
    const cur = await env.DB.prepare('SELECT * FROM links WHERE id = ?').bind(linkId).first();
    if (!cur) return json({ error: '短链不存在' }, 404);
    const back = Object.fromEntries(Object.entries(d.changes || {}).filter(([f, [, nv]]) => same(cur[f], nv)).map(([f, [ov]]) => [f, ov]));
    if (!Object.keys(back).length) return conflict();
    if (back.slug !== undefined) {
      const { error } = await validateLinkInput({ slug: back.slug }, env, linkId);
      if (error) return json({ error }, 400);
    }
    newId = (await applyLinkUpdate(env, request, linkId, back, { revertOf: e.id })).logId;
  } else if (e.action === 'rule.edit') {
    const cur = (await loadTargets(env, linkId)).find((t) => t.id === d.before.id);
    if (!cur) return json({ error: '这条规则已经删除了' }, 409);
    const fields = Object.keys(d.before).filter((f) => f !== 'id');
    if (!fields.every((f) => same(cur[f], d.after[f]))) return conflict();
    const r = await applyTarget(env, linkId, cur.id, { ...cur, ...d.before });
    if (r.error) return json(r, 400);
    newId = await addLog(env, request, linkId, 'rule.edit', { before: ruleSnap(cur), after: ruleSnap(r.row), revertOf: e.id });
  } else if (e.action === 'rule.add') {
    const cur = (await loadTargets(env, linkId)).find((t) => t.id === d.after.id);
    if (!cur) return json({ error: '这条规则已经删除了' }, 409);
    if (!same(ruleSnap(cur), d.after)) return conflict();
    const arms = (await loadAllTargets(env, linkId)).filter((a) => a.ab_of === cur.id);
    await env.DB.prepare('DELETE FROM link_targets WHERE link_id = ? AND (id = ? OR ab_of = ?)').bind(linkId, cur.id, cur.id).run();
    newId = await addLog(env, request, linkId, 'rule.del', { before: ruleSnap(cur), arms: arms.map(armSnap), weight: cur.weight, revertOf: e.id });
  } else if (e.action === 'rule.del') {
    // 用原来的规则 ID 恢复，之前的命中统计能接上
    const taken = await env.DB.prepare('SELECT 1 FROM link_targets WHERE id = ?').bind(d.before.id).first();
    const r = await applyTarget(env, linkId, null, d.before, taken ? null : d.before.id);
    if (r.error) return json(r, 400);
    if (d.arms?.length) await applySplit(env, linkId, { parent: r.row.id, weight: d.weight || 50, arms: d.arms }, true);
    newId = await addLog(env, request, linkId, 'rule.add', { after: ruleSnap(r.row), revertOf: e.id });
  } else if (e.action === 'split') {
    const cur = await splitState(env, linkId, d.parent);
    if (!same(cur, d.after)) return conflict();
    const r = await applySplit(env, linkId, { parent: d.parent, weight: d.before.weight, arms: d.before.arms }, true);
    if (r.error) return json(r, 400);
    newId = await addLog(env, request, linkId, 'split', { parent: d.parent, before: r.before, after: r.after, revertOf: e.id });
  } else return json({ error: '这类记录不能撤销' }, 400);
  await env.DB.prepare('UPDATE link_log SET reverted = ? WHERE id = ?').bind(newId || -1, e.id).run();
  return json({ ok: true });
}

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    return ['http:', 'https:'].includes(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

const SORTS = {
  created: 'id DESC',
  clicks: 'clicks DESC, id DESC',
  last_click: 'last_click IS NULL, last_click DESC, id DESC',
};

async function listLinks(env, url) {
  const q = (url.searchParams.get('q') || '').trim();
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const size = Math.min(100, Math.max(1, Number(url.searchParams.get('size')) || 20));
  const order = SORTS[url.searchParams.get('sort')] || SORTS.created;
  const tz = Math.max(-840, Math.min(840, Number(url.searchParams.get('tz')) || 0));
  // 搜索 + 按分组筛选（tag=+none 为未分组）
  const tag = (url.searchParams.get('tag') || '').trim();
  const conds = [], params = [];
  if (q) { params.push(`%${q}%`); conds.push(`(slug LIKE ?${params.length} OR target_url LIKE ?${params.length} OR title LIKE ?${params.length} OR note LIKE ?${params.length})`); }
  if (tag === '+none') conds.push('id NOT IN (SELECT link_id FROM link_tags)');
  else if (tag) { params.push(tag); conds.push(`id IN (SELECT link_id FROM link_tags WHERE tag = ?${params.length})`); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const [total, rows] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM links ${where}`).bind(...params).first('n'),
    env.DB.prepare(`SELECT *, (SELECT COUNT(*) FROM link_targets t WHERE t.link_id = links.id AND t.ab_of < 0) AS rules,
      (SELECT COUNT(*) FROM link_targets t WHERE t.link_id = links.id AND t.ab_of >= 0) AS arms
      FROM links ${where} ORDER BY ${order} LIMIT ${size} OFFSET ${(page - 1) * size}`)
      .bind(...params).all(),
  ]);
  const items = rows.results;

  // 每个短链最近 14 天的每日访问（用于列表里的迷你趋势图）
  if (items.length) {
    const ids = items.map((l) => l.id);
    const st = await aggregate(env, tz).catch(() => aggState(env));
    const since = Date.now() - 15 * DAY, atz = st.tz ?? tz;
    const [agg, tail] = await Promise.all([
      env.DB.prepare(
        `SELECT link_id, day AS k, SUM(n) AS n FROM agg_d WHERE dim = '' AND day >= ? AND machine = 0
         AND link_id IN (${ids.map(() => '?').join(',')}) GROUP BY link_id, day`
      ).bind(dayKey(since, atz), ...ids).all(),
      env.DB.prepare(
        `SELECT link_id, ts FROM clicks WHERE ts >= ? AND is_bot = 0 AND link_id IN (${ids.map(() => '?').join(',')})`
      ).bind(Math.max(st.mark, since), ...ids).all(),
    ]);
    const byId = new Map();
    const add = (lid, k, n) => {
      if (!byId.has(lid)) byId.set(lid, new Map());
      byId.get(lid).set(k, (byId.get(lid).get(k) || 0) + n);
    };
    for (const r of agg.results) add(r.link_id, r.k, r.n);
    for (const r of tail.results) add(r.link_id, dayKey(r.ts, tz), 1);
    for (const l of items) l.spark = [...(byId.get(l.id) || [])].map(([k, n]) => ({ k, n }));

    // 地区规则摘要（列表里鼠标悬停显示）
    const rules = await env.DB.prepare(
      `SELECT link_id, countries, devices, url, ab_of FROM link_targets WHERE link_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`
    ).bind(...ids).all();
    for (const l of items) {
      l.ruleList = rules.results.filter((r) => r.link_id === l.id)
        .map((r) => ({ countries: r.countries.split(',').filter(Boolean), devices: (r.devices || '').split(',').filter(Boolean), url: r.url, ab: r.ab_of >= 0 }));
    }
    const tg = (await env.DB.prepare(`SELECT link_id, tag FROM link_tags WHERE link_id IN (${ids.map(() => '?').join(',')}) ORDER BY tag`).bind(...ids).all()).results;
    for (const l of items) l.tags = tg.filter((t) => t.link_id === l.id).map((t) => t.tag);
    // 目标页检查：列出打不开的地址
    const hm = await healthOf(env, [...new Set(items.flatMap((l) => [l.target_url, ...l.ruleList.map((r) => r.url)]).filter(Boolean))]);
    for (const l of items) {
      const urls = [l.target_url, ...l.ruleList.map((r) => r.url)].filter(Boolean);
      l.down = urls.filter((u) => hm.get(u)?.state === 'down').map((u) => ({ url: u, error: hm.get(u).error, since: hm.get(u).since }));
    }
  }
  return json({ total, page, size, items, tags: await linkTagList(env) });
}

async function uniqueSlug(env) {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let len = 5; ; len++) {
    for (let i = 0; i < 5; i++) {
      const bytes = crypto.getRandomValues(new Uint8Array(len));
      const slug = [...bytes].map((b) => chars[b % chars.length]).join('');
      const exists = await env.DB.prepare('SELECT 1 FROM links WHERE slug = ?').bind(slug).first();
      if (!exists) return slug;
    }
  }
}

// ---------------------------------------------------------------- 统计

function rangeParams(url) {
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
  const tz = Math.max(-840, Math.min(840, Number(url.searchParams.get('tz')) || 0)); // 浏览器时区偏移（分钟，东八区=480）
  const bots = url.searchParams.get('bots') === '1';
  const now = Date.now();
  const since = now - days * 86400000;
  const prevSince = since - days * 86400000;
  const span = days * 1440;   // 上一周期的时间桶整体后移一个周期，和本期对齐
  return { days, tz, bots, since, prevSince, span };
}

async function linkStats(env, id, url) {
  const p = rangeParams(url);
  return p.days <= 1 || url.searchParams.get('raw') === '1' ? linkStatsRaw(env, id, url) : linkStatsAgg(env, id, p);
}

// 把“原因”拆成单条并归类计数（机房 IP 按运营商区分）
function reasonTop(rows) {
  const m = new Map();
  for (const r of rows) for (const one of r.k.split('；')) {
    const k = one.replace(/第 \d+ 次/, '多次');
    m.set(k, (m.get(k) || 0) + r.n);
  }
  return [...m].map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n).slice(0, 12);
}

async function linkClicks(env, id, url) {
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const size = Math.min(200, Math.max(1, Number(url.searchParams.get('size')) || 50));
  const bots = url.searchParams.get('bots') === '1';
  const where = `WHERE link_id = ? ${bots ? '' : 'AND is_bot = 0'}`;
  const [total, rows] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM clicks ${where}`).bind(id).first('n'),
    env.DB.prepare(`SELECT * FROM clicks ${where} ORDER BY id DESC LIMIT ${size} OFFSET ${(page - 1) * size}`)
      .bind(id).all(),
  ]);
  return json({ total, page, size, items: rows.results });
}

async function exportClicks(env, id) {
  const link = await env.DB.prepare('SELECT slug FROM links WHERE id = ?').bind(id).first();
  if (!link) return json({ error: 'not found' }, 404);
  const rows = (await env.DB.prepare('SELECT * FROM clicks WHERE link_id = ? ORDER BY id DESC LIMIT 100000')
    .bind(id).all()).results;
  const cols = ['ts', 'source', 'referer', 'utm_source', 'utm_medium', 'utm_campaign', 'ip', 'country',
    'region', 'city', 'asn_org', 'device', 'os', 'browser', 'is_bot', 'kind', 'reason', 'proxy', 'asn', 'tls', 'http', 'lang', 'rule_id', 'ua'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [cols.join(',')];
  for (const r of rows) {
    lines.push(cols.map((c) => esc(c === 'ts' ? new Date(r.ts).toISOString() : r[c])).join(','));
  }
  return new Response('﻿' + lines.join('\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="clicks-${link.slug}.csv"`,
    },
  });
}

async function overview(env, url) {
  const p = rangeParams(url);
  // raw=1：强制读原始明细（用于核对汇总结果）
  return p.days <= 1 || url.searchParams.get('raw') === '1' ? overviewRaw(env, url) : overviewAgg(env, url, p);
}

// ---------------------------------------------------------------- 统计（24 小时：读原始明细）
// 一次取出本期和上一期的明细（24 小时 + 上一个 24 小时），在内存里算出全部统计，
// 代替原来每个指标各查一次（每次都要扫一遍同样的行）。结果与逐条 SQL 统计一致。

async function rawRows(env, from, linkId) {
  return (await env.DB.prepare(`SELECT ${RAW_COLS} FROM clicks WHERE ts >= ? ${linkId ? 'AND link_id = ?' : ''}`)
    .bind(from, ...(linkId ? [linkId] : [])).all()).results;
}

async function overviewRaw(env, url) {
  const { days, tz, bots, since, prevSince, span } = rangeParams(url);
  const linkId = Math.max(0, parseInt(url.searchParams.get('link'), 10) || 0);
  const now = Date.now();
  const dayStart = Math.floor((now + tz * 60000) / 86400000) * 86400000 - tz * 60000;
  const from = Math.min(prevSince, dayStart - 86400000);
  const [links, rows, recent] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM links').first('n'),
    rawRows(env, from, linkId),
    recentClicks(env, bots, linkId),
  ]);
  const vis = bots ? rows : rows.filter((r) => !r.is_bot);          // 跟随“含机器访问”开关
  const cur = vis.filter((r) => r.ts >= since), before = vis.filter((r) => r.ts >= prevSince && r.ts < since);
  const all = rows.filter((r) => r.ts >= since);                    // 访客类型 / 机器访问：不受开关影响
  const bucket = days <= 1 ? hourKey : dateKey;   // 1 天以内按小时出趋势，否则按天
  const out = {
    links, activeLinks: uniq(cur, (r) => r.link_id),
    totals: { total: cur.length, unique_ips: uniq(cur) },
    prev: { total: before.length, unique_ips: uniq(before) },
    today: vis.filter((r) => r.ts >= dayStart).length,
    yesterday: vis.filter((r) => r.ts >= dayStart - 86400000 && r.ts < now - 86400000).length,
    daily: buckets(cur, (ts) => bucket(ts, tz)),
    prevDaily: buckets(before, (ts) => bucket(ts, tz + span), false),
    sources: tally(cur, (r) => r.source, 20),
    devices: tally(cur, (r) => r.device), browsers: tally(cur, (r) => r.browser), oses: tally(cur, (r) => r.os),
    countries: tally(cur, (r) => r.country, 20),
    recent,
  };
  // 热门短链
  const top = new Map();
  for (const r of cur) {
    if (!top.has(r.link_id)) top.set(r.link_id, { id: r.link_id, n: 0, ips: new Set(), last: 0 });
    const t = top.get(r.link_id); t.n++; t.ips.add(r.ip); if (r.ts > t.last) t.last = r.ts;
  }
  const topIds = [...top.values()].sort((a, b) => b.n - a.n).slice(0, 8);
  const meta = topIds.length ? new Map((await env.DB.prepare(`SELECT id, slug, title, target_url FROM links WHERE id IN (${topIds.map(() => '?').join(',')})`)
    .bind(...topIds.map((t) => t.id)).all()).results.map((l) => [l.id, l])) : new Map();
  out.topLinks = topIds.filter((t) => meta.has(t.id)).map((t) => ({ ...meta.get(t.id), n: t.n, u: t.ips.size, last: t.last }));
  // 星期 × 小时（0 = 周日，按浏览器时区）
  const heat = new Map();
  for (const r of cur) {
    const d = new Date(Math.floor((r.ts + tz * 60000) / 1000) * 1000), k = `${d.getUTCDay()}|${d.getUTCHours()}`;
    heat.set(k, (heat.get(k) || 0) + 1);
  }
  out.heat = [...heat].map(([k, n]) => { const [d, h] = k.split('|').map(Number); return { d, h, n }; });
  // 访客类型
  const km = new Map();
  for (const r of all) { const k = `${r.kind}|${r.proxy}`; km.set(k, (km.get(k) || 0) + 1); }
  out.kinds = [...km].map(([k, n]) => { const i = k.lastIndexOf('|'); return { k: k.slice(0, i), p: Number(k.slice(i + 1)), n }; });
  // 机器访问按运营商（有 ASN 按 ASN，否则按运营商名称）
  const mm = new Map();
  for (const r of all) {
    if (r.kind !== 'bot' && r.kind !== 'suspect') continue;
    const k = `${r.asn > 0 ? r.asn : 'o:' + r.asn_org}|${r.kind}`;
    if (!mm.has(k)) mm.set(k, { asn: r.asn, asn_org: r.asn_org, kind: r.kind, n: 0, links: new Set(), ips: new Set(), last: 0, reason: '' });
    const m = mm.get(k);
    m.n++; m.links.add(r.link_id); m.ips.add(r.ip);
    if (r.ts > m.last) m.last = r.ts;
    if (r.reason > m.reason) m.reason = r.reason;
  }
  out.machines = [...mm.values()].sort((a, b) => b.n - a.n).slice(0, 10)
    .map((m) => ({ asn: m.asn, asn_org: m.asn_org, kind: m.kind, n: m.n, links: m.links.size, ips: m.ips.size, last: m.last, reason: m.reason }));
  if (linkId) {
    // 单个短链：附带短链信息、来源完整统计和各跳转去向（地区规则 / 默认地址）的命中数
    const link = await env.DB.prepare('SELECT id, slug, title, target_url, last_click, enabled, expires_at FROM links WHERE id = ?').bind(linkId).first();
    if (!link) return json({ error: '短链不存在' }, 404);
    Object.assign(out, {
      sources: tally(cur, (r) => r.source, 20), refererHosts: tally(cur, (r) => r.referer_host, 20),
      utmSources: tally(cur, (r) => r.utm_source, 20), campaigns: tally(cur, (r) => r.utm_campaign, 20),
    });
    const n = new Map(tally(cur, (r) => r.rule_id).map((h) => [h.k, h.n]));
    const targets = await loadTargets(env, linkId);
    out.link = link;
    out.routes = [
      ...targets.map((t) => ({ countries: t.countries, url: t.url, n: n.get(t.id) || 0 })),
      { countries: [], url: link.target_url, n: n.get(0) || 0, def: true },
    ];
  }
  return json(out);
}

async function linkStatsRaw(env, id, url) {
  const { days, tz, bots, since, prevSince, span } = rangeParams(url);
  const rows = await rawRows(env, prevSince, id);
  const vis = bots ? rows : rows.filter((r) => !r.is_bot);
  const cur = vis.filter((r) => r.ts >= since), before = vis.filter((r) => r.ts < since);
  const all = rows.filter((r) => r.ts >= since);
  const key = days <= 1 ? hourKey : dateKey;
  const hourly = tally(cur, (r) => new Date(Math.floor((r.ts + tz * 60000) / 1000) * 1000).getUTCHours()).sort((a, b) => a.k - b.k);
  const km = new Map();
  for (const r of all) { const k = `${r.kind}|${r.proxy}`; km.set(k, (km.get(k) || 0) + 1); }
  const reasons = tally(all.filter((r) => r.kind !== 'human' && r.reason !== ''), (r) => r.reason, 200);
  return json({
    summary: { total: cur.length, unique_ips: uniq(cur) },
    prev: { total: before.length, unique_ips: uniq(before) },
    daily: buckets(cur, (ts) => key(ts, tz)), prevDaily: buckets(before, (ts) => key(ts, tz + span), false),
    hourly,
    targets: tally(cur, (r) => r.rule_id, 50),
    sources: tally(cur, (r) => r.source, 20), refererHosts: tally(cur, (r) => r.referer_host, 20),
    countries: tally(cur, (r) => r.country, 10), cities: tally(cur, (r) => r.city, 10),
    devices: tally(cur, (r) => r.device, 10), browsers: tally(cur, (r) => r.browser, 10), oses: tally(cur, (r) => r.os, 10),
    campaigns: tally(cur, (r) => r.utm_campaign, 10), utmSources: tally(cur, (r) => r.utm_source, 20),
    kinds: [...km].map(([k, n]) => { const i = k.lastIndexOf('|'); return { k: k.slice(0, i), p: Number(k.slice(i + 1)), n }; }),
    reasons: reasonTop(reasons),
  });
}

// ---------------------------------------------------------------- 统计（7 天及以上：读汇总表）

// 星期 × 小时、小时分布：把按小时的访问次数换算到浏览器时区
function localHourParts(ts, tz) {
  const d = new Date(ts + tz * 60000);
  return { d: d.getUTCDay(), h: d.getUTCHours() };
}

// 机器访问按运营商：k = 类型 \t ASN \t 运营商
const machineRows = (rows) => rows.map((r) => {
  const [kind, asn, org] = r.k.split('\t');
  return { kind, asn: Number(asn) || 0, asn_org: org || '', n: r.n };
});

async function overviewAgg(env, url, { days, tz, bots }) {
  const linkId = Math.max(0, parseInt(url.searchParams.get('link'), 10) || 0);
  const q = await aggQuery(env, { days, tz, bots, linkId });
  const { now, dayStart, start, prevStart, firstDay, today, prevFirst, prevLast } = q;

  const [links, activeRows, totals, prev, todayHours, ydayHours, daily, prevDaily, uvDays, heatHours, topRows,
    sources, devices, browsers, oses, countries, recent, kinds, machines] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM links').first('n'),
    q.all(`SELECT DISTINCT link_id FROM agg_d WHERE dim = '' AND day >= ? AND day <= ? ${bots ? '' : 'AND machine = 0'}`, firstDay, today),
    q.total(firstDay, today, start, now),
    q.total(prevFirst, prevLast, prevStart, start),
    q.hours(dayStart, now),
    q.hours(dayStart - DAY, now - DAY),
    q.daily(firstDay, today, start, now),
    q.daily(prevFirst, prevLast, prevStart, start, days),
    q.uvByDay(firstDay, today),
    q.hours(start, now),
    q.all(
      `SELECT link_id AS k, SUM(n) AS n FROM agg_d WHERE dim = '' AND day >= ? AND day <= ? ${bots ? '' : 'AND machine = 0'}
       ${linkId ? 'AND link_id = ?' : ''} GROUP BY link_id ORDER BY n DESC LIMIT 30`,
      firstDay, today, ...(linkId ? [linkId] : []),
    ),
    q.top('source', 20), q.top('device', 20), q.top('browser', 20), q.top('os', 20), q.top('country', 20),
    recentClicks(env, bots, linkId),
    q.kinds(),
    q.top('asn', 10, { who: 'machine', key: (r) => `${r.kind || ''}\t${r.asn || 0}\t${r.asn_org || ''}` }),
  ]);

  // 今日 / 昨日同时段
  const todayN = todayHours.reduce((a, b) => a + b.n, 0);
  const ydayN = ydayHours.filter((h) => h.ts < now - DAY).reduce((a, b) => a + b.n, 0);

  // 每日访客
  const tailUv = new Map();
  for (const r of q.tailIn(start, now)) {
    const k = dayKey(r.ts, tz);
    if (!tailUv.has(k)) tailUv.set(k, hllNew());
    hllAdd(tailUv.get(k), r.ip || '');
  }
  const uvOf = (day) => {
    const reg = hllNew();
    if (uvDays.has(`${linkId}|${day}`)) hllMerge(reg, uvDays.get(`${linkId}|${day}`));
    if (tailUv.has(day)) hllMerge(reg, tailUv.get(day));
    return hllCount(reg);
  };
  const dailyU = daily.map((r) => ({ ...r, u: Math.min(uvOf(r.k), r.n) }));   // 估算值封顶为当天访问次数

  // 活跃时段
  const heat = new Map();
  for (const h of heatHours) {
    const { d, h: hr } = localHourParts(h.ts, tz);
    heat.set(`${d}-${hr}`, (heat.get(`${d}-${hr}`) || 0) + h.n);
  }

  // 热门短链：合并原始尾巴后取前 8，独立访客按短链合并估算
  const counts = new Map(topRows.map((r) => [r.k, r.n]));
  for (const r of q.tailIn(start, now)) counts.set(r.link_id, (counts.get(r.link_id) || 0) + 1);
  const topIds = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id]) => id);
  let topLinks = [];
  if (topIds.length) {
    const [meta, uvs] = await Promise.all([
      env.DB.prepare(`SELECT id, slug, title, target_url, last_click FROM links WHERE id IN (${topIds.map(() => '?').join(',')})`).bind(...topIds).all(),
      q.uvByDay(firstDay, today, topIds),
    ]);
    const byId = new Map(meta.results.map((l) => [l.id, l]));
    topLinks = topIds.filter((id) => byId.has(id)).map((id) => {
      const reg = hllNew();
      for (const [key, r] of uvs) if (key.startsWith(id + '|')) hllMerge(reg, r);
      q.addTailIps(reg, start, now, id);
      const l = byId.get(id);
      return { id, slug: l.slug, title: l.title, target_url: l.target_url, n: counts.get(id), u: Math.min(hllCount(reg), counts.get(id)), last: l.last_click };
    });
  }

  const active = new Set(activeRows.map((r) => r.link_id));
  for (const r of q.tailIn(start, now)) active.add(r.link_id);

  const out = {
    links, activeLinks: active.size, totals, prev, today: todayN, yesterday: ydayN,
    daily: dailyU, prevDaily, topLinks, sources, devices, browsers, oses, countries,
    heat: [...heat].map(([k, n]) => { const [d, h] = k.split('-').map(Number); return { d, h, n }; }),
    recent, kinds, machines: machineRows(machines),
  };
  if (linkId) {
    const [link, hits, refererHosts, utmSources, campaigns] = await Promise.all([
      env.DB.prepare('SELECT id, slug, title, target_url, last_click, enabled, expires_at FROM links WHERE id = ?').bind(linkId).first(),
      q.top('rule', 100), q.top('referer_host', 20), q.top('utm_source', 20), q.top('utm_campaign', 20),
    ]);
    if (!link) return json({ error: '短链不存在' }, 404);
    const targets = await loadTargets(env, linkId);
    const n = new Map(hits.map((h) => [String(h.k), h.n]));
    Object.assign(out, { refererHosts, utmSources, campaigns, link });
    out.routes = [
      ...targets.map((t) => ({ countries: t.countries, url: t.url, n: n.get(String(t.id)) || 0 })),
      { countries: [], url: link.target_url, n: n.get('0') || 0, def: true },
    ];
  }
  return json(out);
}

async function linkStatsAgg(env, id, { days, tz, bots }) {
  const q = await aggQuery(env, { days, tz, bots, linkId: id });
  const { now, start, prevStart, firstDay, today, prevFirst, prevLast } = q;
  const [summary, prev, daily, prevDaily, uvDays, hourRows, sources, refererHosts, countries, cities, devices, browsers, oses,
    campaigns, targets, utmSources, kinds, reasons] = await Promise.all([
    q.total(firstDay, today, start, now),
    q.total(prevFirst, prevLast, prevStart, start),
    q.daily(firstDay, today, start, now),
    q.daily(prevFirst, prevLast, prevStart, start, days),
    q.uvByDay(firstDay, today),
    q.hours(start, now),
    q.top('source', 20), q.top('referer_host', 20), q.top('country'), q.top('city'),
    q.top('device'), q.top('browser'), q.top('os'), q.top('utm_campaign'), q.top('rule', 50), q.top('utm_source', 20),
    q.kinds(),
    q.top('reason', 200, { who: 'machine', key: (r) => (r.reason ? r.reason : null) }),
  ]);
  const tailUv = new Map();
  for (const r of q.tailIn(start, now)) {
    const k = dayKey(r.ts, tz);
    if (!tailUv.has(k)) tailUv.set(k, hllNew());
    hllAdd(tailUv.get(k), r.ip || '');
  }
  const dailyU = daily.map((r) => {
    const reg = hllNew();
    if (uvDays.has(`${id}|${r.k}`)) hllMerge(reg, uvDays.get(`${id}|${r.k}`));
    if (tailUv.has(r.k)) hllMerge(reg, tailUv.get(r.k));
    return { ...r, u: Math.min(hllCount(reg), r.n) };   // 估算值封顶为当天访问次数
  });
  const hm = new Map();
  for (const h of hourRows) { const { h: hr } = localHourParts(h.ts, tz); hm.set(hr, (hm.get(hr) || 0) + h.n); }
  return json({
    summary, prev, daily: dailyU, prevDaily,
    hourly: [...hm].map(([k, n]) => ({ k, n })).sort((a, b) => a.k - b.k),
    targets: targets.map((t) => ({ k: Number(t.k), n: t.n })),
    sources, refererHosts, countries, cities, devices, browsers, oses, campaigns, utmSources, kinds,
    reasons: reasonTop(reasons),
  });
}

// ---------------------------------------------------------------- Cloudflare 用量
// 需要 CF_ACCOUNT_ID（变量）和 CF_API_TOKEN（密钥，权限 帐户分析 · 读取；可选 账单 · 读取 用于识别套餐）。
// 额度按整个账户计算：免费版每天 UTC 0 点重置，付费版按自然月计。凭据里的 D1 数据库 ID / Worker 名称用于单独统计本项目。
// 结果缓存 5 分钟。
// Cloudflare 凭据：在后台填写，加密保存在 settings.int_cf。
// 旧版本写在环境变量 CF_ACCOUNT_ID / CF_API_TOKEN（及 D1_DATABASE_ID / WORKER_NAME）里的，第一次用到时导入一次，之后只认后台这份
async function cfCreds(env) {
  const s = await getSetting(env, 'int_cf');
  if (s) { try { return { ...(await google.unseal(await sessionSecret(env), s.value)), source: 'db' }; } catch { return null; } }
  if (env.CF_API_TOKEN && env.CF_ACCOUNT_ID && !(await getSetting(env, 'env_import_cf'))) {
    const c = { accountId: String(env.CF_ACCOUNT_ID).trim(), token: String(env.CF_API_TOKEN).trim(),
      dbId: String(env.D1_DATABASE_ID || '').trim(), worker: String(env.WORKER_NAME || '').trim() };
    await setSetting(env, 'int_cf', await google.seal(await sessionSecret(env), c));
    await setSetting(env, 'env_import_cf', String(Date.now()));
    return { ...c, source: 'db' };
  }
  return null;
}

// 保存前先请求一次 Cloudflare 接口，确认令牌有效、有分析读取权限
async function saveCfConfig(env, body) {
  const old = await cfCreds(env);
  const accountId = String(body.accountId || '').trim();
  const token = String(body.token || '').trim() || old?.token || '';
  const dbId = String(body.dbId || '').trim(), worker = String(body.worker || '').trim();
  if (!/^[0-9a-f]{32}$/i.test(accountId)) return { error: '账户 ID 应为 32 位十六进制字符，可在 Cloudflare 控制台首页右侧找到' };
  if (token.length < 20) return { error: '请填写 API 令牌' };
  if (dbId && !/^[0-9a-f-]{36}$/i.test(dbId)) return { error: 'D1 数据库 ID 格式不对' };
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query: 'query($a: string!, $d: Date!) { viewer { accounts(filter: { accountTag: $a }) { d1AnalyticsAdaptiveGroups(limit: 1, filter: { date_geq: $d }) { sum { rowsRead } } } } }',
      variables: { a: accountId, d: new Date().toISOString().slice(0, 10) },
    }),
  }).catch(() => null);
  const d = res ? await res.json().catch(() => ({})) : {};
  if (!res || !res.ok || d.errors?.length) {
    const msg = d.errors?.[0]?.message || (res ? `HTTP ${res.status}` : '无法连接 Cloudflare');
    return { error: /authentication/i.test(msg) ? '令牌无效：请确认粘贴的是 API 令牌的值（不是 Global API Key 或令牌 ID）' : `验证失败：${msg}（令牌需要“帐户分析 · 读取”权限）` };
  }
  if (!d.data?.viewer?.accounts?.length) return { error: '找不到这个账户：账户 ID 不对，或令牌没有包含这个账户' };
  await setSetting(env, 'int_cf', await google.seal(await sessionSecret(env), { accountId, token, dbId, worker }));
  await env.DB.prepare("DELETE FROM settings WHERE key = 'usage_cache'").run();
  return { ok: true };
}

// 给前端看的配置信息（不含令牌本身）
const cfMeta = (cf) => ({ config: { source: cf.source, accountId: cf.accountId, tokenTail: cf.token.slice(-4), dbId: cf.dbId || '', worker: cf.worker || '' } });

// 用量 + 预测（面板和用量预警共用）
async function cfUsage(env, force) {
  const u = await cfUsageRaw(env, force);
  return u.configured && u.days?.length ? { ...u, forecast: usageForecast(u) } : u;
}

async function cfUsageRaw(env, force) {
  const cf = await cfCreds(env);
  if (!cf) return { configured: false };
  const planSetting = (await getSetting(env, 'cf_plan'))?.value || 'auto';
  if (!force) {
    const c = await getSetting(env, 'usage_cache');
    if (c && c.updated_at > Date.now() - 5 * 60000) {
      const d = JSON.parse(c.value);
      return { ...d, ...cfMeta(cf), planSetting, plan: planSetting === 'auto' ? d.detected : planSetting, cached: true };
    }
  }
  const headers = { authorization: `Bearer ${cf.token}`, 'content-type': 'application/json' };
  const account = cf.accountId, dbId = cf.dbId || '', worker = cf.worker || '';
  const now = new Date(), today = now.toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';
  const weekStart = new Date(Date.now() - 6 * DAY).toISOString().slice(0, 10);
  const start = monthStart < weekStart ? monthStart : weekStart;
  const gql = async (field, body) => {
    try {
      const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST', headers,
        body: JSON.stringify({
          query: `query($a: string!, $s: Date!, $e: Date!) { viewer { accounts(filter: { accountTag: $a }) {
            ${field}(limit: 10000, filter: { date_geq: $s, date_leq: $e }) { ${body} } } } }`,
          variables: { a: account, s: start, e: today },
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.errors?.length) return { error: d.errors?.[0]?.message || `HTTP ${res.status}` };
      return { rows: d.data?.viewer?.accounts?.[0]?.[field] || [] };
    } catch (err) { return { error: String(err.message || err) }; }
  };
  const [d1, storage, workers, subs] = await Promise.all([
    gql('d1AnalyticsAdaptiveGroups', 'sum { readQueries writeQueries rowsRead rowsWritten } dimensions { date databaseId }'),
    gql('d1StorageAdaptiveGroups', 'max { databaseSizeBytes } dimensions { date databaseId }'),
    gql('workersInvocationsAdaptive', 'sum { requests errors } dimensions { date scriptName }'),
    fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/subscriptions`, { headers })
      .then((r) => r.json()).then((d) => (d.success ? (d.result || []) : null)).catch(() => null),
  ]);
  // 数据库名称：令牌有 D1 读取权限时才能拿到，否则界面上显示数据库 ID
  const dbNames = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database?per_page=1000`, { headers })
    .then((r) => r.json()).then((d) => (d.success ? Object.fromEntries((d.result || []).map((x) => [x.uuid, x.name])) : {})).catch(() => ({}));

  // 每天：账户合计 + 本项目
  const days = new Map();
  const day = (date) => {
    if (!days.has(date)) days.set(date, { date, rowsRead: 0, rowsWritten: 0, requests: 0, mine: { rowsRead: 0, rowsWritten: 0, requests: 0 } });
    return days.get(date);
  };
  for (let t = Date.parse(start + 'T00:00:00Z'); t <= Date.parse(today + 'T00:00:00Z'); t += DAY) day(new Date(t).toISOString().slice(0, 10));
  // 每天按数据库 / Worker 分开记，用来列出占用最多的几个
  const per = new Map();   // 日期 → { rowsRead: Map, rowsWritten: Map, requests: Map }
  const bump = (date, k, id, n) => {
    if (!n) return;
    if (!per.has(date)) per.set(date, { rowsRead: new Map(), rowsWritten: new Map(), requests: new Map() });
    const m = per.get(date)[k];
    m.set(id, (m.get(id) || 0) + n);
  };
  for (const r of d1.rows || []) {
    const x = day(r.dimensions.date);
    x.rowsRead += r.sum.rowsRead || 0; x.rowsWritten += r.sum.rowsWritten || 0;
    if (dbId && r.dimensions.databaseId === dbId) { x.mine.rowsRead += r.sum.rowsRead || 0; x.mine.rowsWritten += r.sum.rowsWritten || 0; }
    bump(r.dimensions.date, 'rowsRead', r.dimensions.databaseId, r.sum.rowsRead || 0);
    bump(r.dimensions.date, 'rowsWritten', r.dimensions.databaseId, r.sum.rowsWritten || 0);
  }
  for (const r of workers.rows || []) {
    const x = day(r.dimensions.date);
    x.requests += r.sum.requests || 0;
    if (worker && r.dimensions.scriptName === worker) x.mine.requests += r.sum.requests || 0;
    bump(r.dimensions.date, 'requests', r.dimensions.scriptName, r.sum.requests || 0);
  }
  const TOP = 3;
  const topOf = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, TOP);
  const merge = (dates, k) => {
    const m = new Map();
    for (const d of dates) for (const [id, n] of per.get(d)?.[k] || []) m.set(id, (m.get(id) || 0) + n);
    return m;
  };
  for (const x of days.values()) {
    const p = per.get(x.date);
    x.top = p ? { rowsRead: topOf(p.rowsRead), rowsWritten: topOf(p.rowsWritten), requests: topOf(p.requests) } : null;
  }
  // 存储：最近一天各数据库大小
  const lastDate = (storage.rows || []).map((r) => r.dimensions.date).sort().pop();
  let storageBytes = null, myStorage = null;
  if (lastDate) {
    storageBytes = 0;
    for (const r of storage.rows) if (r.dimensions.date === lastDate) {
      storageBytes += r.max.databaseSizeBytes || 0;
      if (dbId && r.dimensions.databaseId === dbId) myStorage = r.max.databaseSizeBytes || 0;
    }
  }
  const all = [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  // 套餐识别：
  // 1. 账户订阅里有 Workers 相关计划 → 付费版（订阅接口通常只列出域名套餐，不一定能看到 Workers 付费计划）；
  // 2. 最近有一天的用量超过免费版上限（免费版超出后请求会直接失败）→ 一定是付费版；
  // 3. 否则无法确定。
  const active = subs ? subs.filter((x) => !/cancel/i.test(x.state || '')) : null;
  const names = new Map();
  for (const x of active || []) {
    const n = x.rate_plan?.public_name || x.rate_plan?.id || x.product?.name || '';
    if (n) names.set(n, (names.get(n) || 0) + 1);
  }
  const subNames = active ? [...names].map(([n, c]) => (c > 1 ? `${n} × ${c}` : n)) : null;
  const overFree = all.some((x) => x.rowsRead > 5e6 || x.rowsWritten > 1e5 || x.requests > 1e5);
  const workersSub = (active || []).some((x) => /workers/i.test(JSON.stringify([x.rate_plan, x.product])));
  const detected = workersSub || overFree ? 'paid' : null;
  const detectedBy = workersSub ? 'subscription' : overFree ? 'usage' : null;
  const sum = (rows, k, mine) => rows.reduce((s, x) => s + (mine ? x.mine[k] : x[k]), 0);
  const month = all.filter((x) => x.date >= monthStart);
  const monthDates = month.map((x) => x.date), weekDates = all.filter((x) => x.date >= weekStart).map((x) => x.date);
  // 本月 / 今天占用最多的；用于颜色的“最近 7 天总排名”（每个数据库在各天的色块颜色保持一致）
  const tops = (dates) => ({ rowsRead: topOf(merge(dates, 'rowsRead')), rowsWritten: topOf(merge(dates, 'rowsWritten')), requests: topOf(merge(dates, 'requests')) });
  const out = {
    configured: true, today, monthStart, detected, detectedBy, subscriptions: subNames,
    hasMine: { d1: !!dbId, worker: !!worker },
    days: all.filter((x) => x.date >= weekStart),
    month: {
      rowsRead: sum(month, 'rowsRead'), rowsWritten: sum(month, 'rowsWritten'), requests: sum(month, 'requests'),
      mine: { rowsRead: sum(month, 'rowsRead', 1), rowsWritten: sum(month, 'rowsWritten', 1), requests: sum(month, 'requests', 1) },
    },
    storageBytes, myStorage,
    top: { month: tops(monthDates), today: tops([today]), week: tops(weekDates) },
    dbNames, myDb: dbId, myWorker: worker,
    errors: [d1.error && `D1：${d1.error}`, workers.error && `Workers：${workers.error}`, storage.error && `存储：${storage.error}`].filter(Boolean),
    updatedAt: Date.now(),
  };
  if (!out.errors.length) await setSetting(env, 'usage_cache', JSON.stringify(out));
  return { ...out, ...cfMeta(cf), planSetting, plan: planSetting === 'auto' ? detected : planSetting };
}

// ---------------------------------------------------------------- Google（GA4 + Search Console）
async function googleApi(request, env, url) {
  const path = url.pathname, method = request.method;
  const secret = await sessionSecret(env);
  try {
    if (path === '/api/google/status') return json(await google.status(env, secret));
    // 后台填写 OAuth 客户端（加密保存）
    if (path === '/api/google/config' && method === 'PUT') {
      const r = await google.saveGoogleConfig(env, secret, await request.json().catch(() => ({})));
      return r.error ? json(r, 400) : json(await google.status(env, secret));
    }
    if (path === '/api/google/config' && method === 'DELETE') {
      const r = await google.deleteGoogleConfig(env, secret);
      return r.error ? json(r, 400) : json(await google.status(env, secret));
    }
    // 网页索引：站点地图、网址检查结果（只关联了 Bing 的站点也走这里，所以放在 Google 客户端检查之前）
    const ihost = String(url.searchParams.get('host') || '');
    if (path === '/api/google/index' && method === 'GET') {
      const d = await gindex.siteIndex(env, secret, ihost);
      return d.error ? json(d, 404) : json(d);
    }
    if (path.startsWith('/api/google/index/') && method === 'POST') {
      const b = await request.json().catch(() => ({}));
      const host = String(b.host || '');
      const r = path === '/api/google/index/check' ? await gindex.checkNow(env, secret, host)
        : path === '/api/google/index/inspect' ? await gindex.inspectUrl(env, secret, host, String(b.url || ''), b.which === 'bing' ? 'bing' : 'google')
        : path === '/api/google/index/submit' ? await gindex.submitSitemap(env, secret, host, String(b.path || ''))
        : path === '/api/google/index/bing-feed' ? await gindex.bingFeed(env, secret, host, String(b.path || ''))
        : path === '/api/google/index/bing-submit' ? await gindex.bingSubmitNow(env, secret, host, b.url ? String(b.url) : '')
        : { error: 'not found' };
      return r.error ? json(r, 400) : json({ ...r, index: await gindex.siteIndex(env, secret, host) });
    }
    if (!(await google.googleConfigured(env, secret))) return json({ error: '未配置 Google OAuth 客户端' }, 400);
    if (path === '/api/google/auth') return json({ url: await google.authUrl(env, url.origin, secret, hmac) });
    if (path === '/api/google/sync' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (body.discover) await google.discover(env, secret);
      const cutoff = Number(body.before) > 0 ? Math.min(Number(body.before), Date.now()) : Date.now() - 6 * 3600000;
      return json(await google.syncBatch(env, secret, { limit: 12, cutoff }));
    }
    if (path === '/api/google/disconnect' && method === 'POST') {
      const id = String((await request.json().catch(() => ({}))).id || '');
      await google.disconnect(env, secret, id || undefined);
      return json(await google.status(env, secret));
    }
    const days = google.RANGE_DAYS.includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 28;
    if (path === '/api/google/sites') return json({ days, ranges: google.ranges(days), items: await google.sitesList(env, days) });
    if (path === '/api/google/tags' && method === 'GET') return json({ tags: await google.tagsList(env) });
    if (path === '/api/google/tags' && method === 'PUT') {
      const r = await google.tagsUpdate(env, await request.json().catch(() => ({})));
      return r.error ? json(r, 400) : json(r);
    }
    if (path === '/api/google/hosts') {
      // 只要域名列表（投放链接里选站点用），不查统计数据
      const rows = (await env.DB.prepare("SELECT host, ga4_name FROM g_sites WHERE host LIKE '%.%' ORDER BY host").all()).results;
      return json({ items: rows.map((r) => ({ host: r.host, name: r.ga4_name || '' })) });
    }
    if (path === '/api/google/link') return json({ days, ranges: google.ranges(days), ...(await google.linkSites(env, Number(url.searchParams.get('id')) || 0, days, secret)) });
    if (path === '/api/google/site') {
      const d = await google.siteDetail(env, secret, String(url.searchParams.get('host') || ''), days);
      return d.error ? json(d, 404) : json(d);
    }
  } catch (err) {
    return json({ error: err.message || String(err) }, 500);
  }
  return json({ error: 'not found' }, 404);
}

// Bing Webmaster：API Key 配置、状态、自动提交开关、立即同步
async function bingApi(request, env, url) {
  const path = url.pathname, method = request.method;
  const secret = await sessionSecret(env);
  try {
    if (path === '/api/bing/status') return json(await bing.status(env, secret));
    if (path === '/api/bing/config' && method === 'PUT') {
      const r = await bing.saveBingConfig(env, secret, await request.json().catch(() => ({})));
      if (r.error) return json(r, 400);
      if (!r.pending) await bing.syncBatch(env, secret, { limit: 10, cutoff: Date.now(), deadline: Date.now() + 15000 }).catch(() => {});
      return json({ ...(await bing.status(env, secret)), pending: !!r.pending });
    }
    if (path === '/api/bing/config' && method === 'DELETE') { await bing.deleteBingConfig(env); return json(await bing.status(env, secret)); }
    if (path === '/api/bing/auto' && method === 'PUT') {
      await bing.setBingAuto(env, !!(await request.json().catch(() => ({}))).on);
      return json(await bing.status(env, secret));
    }
    if (path === '/api/bing/sync' && method === 'POST') {
      await bing.discover(env, secret);
      const r = await bing.syncBatch(env, secret, { limit: 20, cutoff: Date.now() - 60000, deadline: Date.now() + 20000 });
      return json({ ...r, ...(await bing.status(env, secret)) });
    }
  } catch (err) {
    return json({ error: err.message || String(err) }, 500);
  }
  return json({ error: 'not found' }, 404);
}

async function googleCallback(env, url) {
  let r;
  const secret = await sessionSecret(env);
  if (!(await google.googleConfigured(env, secret))) r = { error: '未配置 Google OAuth 客户端' };
  else {
    r = await google.handleCallback(env, url, secret, hmac, safeEqual).catch((e) => ({ error: e.message }));
    if (r.ok) {
      // 授权完成后立即发现这个账号的站点并同步第一批
      await google.discover(env, secret, r.id).catch(() => {});
      await google.syncBatch(env, secret, { limit: 6, cutoff: Date.now() }).catch(() => {});
    }
  }
  // 用页面内跳转回后台（同站跳转会带上 Strict Cookie；服务端 302 仍算从 Google 发起，不会带）
  const to = `/admin#/sites?google=${r.ok ? 'ok' : encodeURIComponent(r.error)}`;
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>正在返回后台…</title>
<body style="font:14px -apple-system,sans-serif;color:#888;display:grid;place-items:center;min-height:90vh">正在返回后台…
<script>location.replace(${JSON.stringify(to)})</script></body>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

// ---------------------------------------------------------------- AI 分析链接
const SHARE_SECTIONS = ['search', 'traffic', 'links'];
const SHARE_MAX_HOSTS = 100, SHARE_PER_HOUR = 60;

const shareOut = (r, origin) => ({
  token: r.token, url: `${origin}/r/${r.token}`, label: r.label, hosts: JSON.parse(r.hosts), days: r.days,
  sections: r.sections ? JSON.parse(r.sections) : SHARE_SECTIONS, hide: !!r.hide,
  createdAt: r.created_at, expiresAt: r.expires_at, views: r.views, lastView: r.last_view,
  expired: !!(r.expires_at && r.expires_at < Date.now()),
});

async function listShares(env, url) {
  const rows = (await env.DB.prepare('SELECT * FROM shares ORDER BY created_at DESC').all()).results;
  // 每个链接被哪些工具打开过（去重）
  const ag = (await env.DB.prepare("SELECT token, agent, COUNT(*) AS n FROM share_views WHERE status = 200 GROUP BY token, agent").all()).results;
  const by = new Map();
  for (const a of ag) { if (!by.has(a.token)) by.set(a.token, []); by.get(a.token).push({ agent: a.agent || '未知', n: a.n }); }
  return { items: rows.map((r) => ({ ...shareOut(r, url.origin), agents: (by.get(r.token) || []).sort((a, b) => b.n - a.n) })) };
}

async function createShare(request, env, url) {
  const b = await request.json().catch(() => ({}));
  const known = new Set((await env.DB.prepare('SELECT host FROM g_sites').all()).results.map((r) => r.host));
  const hosts = [...new Set((Array.isArray(b.hosts) ? b.hosts : []).map(String))].filter((h) => known.has(h));
  if (!hosts.length) return json({ error: '请至少选择一个站点' }, 400);
  if (hosts.length > SHARE_MAX_HOSTS) return json({ error: `一个链接最多包含 ${SHARE_MAX_HOSTS} 个站点` }, 400);
  const days = [28, 90, 180].includes(Number(b.days)) ? Number(b.days) : 28;
  const sections = SHARE_SECTIONS.filter((k) => (Array.isArray(b.sections) ? b.sections : SHARE_SECTIONS).includes(k));
  if (!sections.length) return json({ error: '请至少选择一项内容' }, 400);
  const expDays = [7, 30, 0].includes(Number(b.expires)) ? Number(b.expires) : 7;
  // 128 位随机 token，URL 安全
  const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const now = Date.now();
  await env.DB.prepare('INSERT INTO shares (token, label, hosts, days, sections, hide, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(token, cut(String(b.label || '').trim(), 100), JSON.stringify(hosts), days, JSON.stringify(sections), b.hide === false ? 0 : 1, now, expDays ? now + expDays * 86400000 : null).run();
  return json(shareOut(await env.DB.prepare('SELECT * FROM shares WHERE token = ?').bind(token).first(), url.origin));
}

// 报告缓存 1 小时（同一个链接反复打开不会重复请求 Google 接口）；创建链接后后台会先生成一次
async function shareReport(env, secret, row, force = false) {
  const key = `ai-report|${row.token}`;
  const hit = force ? null : await env.DB.prepare('SELECT v, at FROM g_cache WHERE k = ?').bind(key).first();
  if (hit && hit.at > Date.now() - 3600000) return JSON.parse(hit.v);
  const rep = await google.aiReport(env, secret, JSON.parse(row.hosts), row.days, row.sections ? JSON.parse(row.sections) : null, !!row.hide);
  await env.DB.prepare('INSERT INTO g_cache (k, v, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at')
    .bind(key, JSON.stringify(rep), Date.now()).run();
  return rep;
}

// 常见 AI 工具的抓取 User-Agent
const AI_AGENTS = [
  [/ChatGPT-User|OAI-SearchBot|GPTBot|OpenAI/i, 'ChatGPT'], [/Claude-User|Claude-SearchBot|ClaudeBot|Anthropic/i, 'Claude'],
  [/Perplexity/i, 'Perplexity'], [/Google-Extended|Gemini|Google-CloudVertexBot/i, 'Gemini'], [/Bytespider|Doubao/i, '豆包'],
  [/DeepSeek/i, 'DeepSeek'], [/kimi|Moonshot/i, 'Kimi'], [/MistralAI/i, 'Mistral'], [/cohere/i, 'Cohere'], [/YouBot/i, 'You.com'],
  [/bot|crawler|spider|curl|wget|python|go-http|node-fetch|axios/i, '程序 / 爬虫'],
];
const agentOf = (ua) => (AI_AGENTS.find(([re]) => re.test(ua || '')) || [, ''])[1];

// 记一条打开记录，每个链接只留最近 200 条
async function logShareView(request, env, token, status) {
  const ua = request.headers.get('user-agent') || '';
  await env.DB.prepare('INSERT INTO share_views (token, at, ip, country, ua, agent, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(token, Date.now(), request.headers.get('cf-connecting-ip') || '', request.cf?.country || '', cut(ua, 300), agentOf(ua) || (ua ? '浏览器' : ''), status).run();
  await env.DB.prepare('DELETE FROM share_views WHERE token = ? AND id NOT IN (SELECT id FROM share_views WHERE token = ? ORDER BY at DESC LIMIT 200)')
    .bind(token, token).run();
}

// 公开的只读报告：/r/<token>（Markdown），?format=json 为结构化数据，?download=1 下载文件
async function shareView(request, env, ctx, url) {
  const text = (body, status = 200, type = 'text/markdown; charset=utf-8', extra = {}) => new Response(body, {
    status, headers: { 'content-type': type, 'x-robots-tag': 'noindex, nofollow', 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', ...extra },
  });
  const m = url.pathname.match(/^\/r\/([\w-]{16,40})(\.md|\.json)?$/);
  if (!m) return text('链接无效。', 404, 'text/plain; charset=utf-8');
  const row = await env.DB.prepare('SELECT * FROM shares WHERE token = ?').bind(m[1]).first();
  if (!row || (row.expires_at && row.expires_at < Date.now())) return text('这个分析链接已过期或已被撤销。', 410, 'text/plain; charset=utf-8');
  // 限流：每个链接每小时最多 60 次
  const hour = Math.floor(Date.now() / 3600000);
  const n = row.hour === hour ? row.hour_n + 1 : 1;
  if (n > SHARE_PER_HOUR) {
    ctx.waitUntil(logShareView(request, env, row.token, 429).catch(() => {}));
    return text('访问太频繁，请稍后再试。', 429, 'text/plain; charset=utf-8', { 'retry-after': '600' });
  }
  await env.DB.prepare('UPDATE shares SET views = views + 1, last_view = ?, hour = ?, hour_n = ? WHERE token = ?').bind(Date.now(), hour, n, row.token).run();
  ctx.waitUntil(logShareView(request, env, row.token, 200).catch(() => {}));
  const secret = await sessionSecret(env);
  if (!(await google.googleConfigured(env, secret))) return text('站点数据暂时不可用：Google 集成未配置。', 503, 'text/plain; charset=utf-8');
  const rep = await shareReport(env, secret, row);
  const json1 = url.searchParams.get('format') === 'json' || m[2] === '.json';
  const name = `seo-report-${new Date().toISOString().slice(0, 10)}.${json1 ? 'json' : 'md'}`;
  const dl = url.searchParams.get('download') === '1' ? { 'content-disposition': `attachment; filename="${name}"` } : {};
  return json1 ? text(JSON.stringify(rep, null, 2), 200, 'application/json; charset=utf-8', dl) : text(google.reportMarkdown(rep), 200, undefined, dl);
}

// 访问明细条数要扫整张表，一天最多数一次（存在 settings）；最早一条走 ts 索引，只读一行
async function retentionInfo(env) {
  const [days, st, first, cnt] = await Promise.all([
    getSetting(env, 'retention_days'),
    aggState(env),
    env.DB.prepare('SELECT ts FROM clicks ORDER BY ts LIMIT 1').first('ts'),
    getSetting(env, 'clicks_count'),
  ]);
  let count = Number(cnt?.value);
  if (!cnt || Date.now() - cnt.updated_at > DAY) {
    count = (await env.DB.prepare('SELECT COUNT(*) AS n FROM clicks').first('n')) || 0;
    await setSetting(env, 'clicks_count', String(count));
  }
  return { days: Number(days?.value) || 0, count, first: first || null, aggregated: st.mark || null };
}

async function recentClicks(env, bots, linkId = 0) {
  const where = [bots ? '' : 'c.is_bot = 0', linkId ? 'c.link_id = ?' : ''].filter(Boolean);
  const r = await env.DB.prepare(
    `SELECT c.id, c.ts, c.source, c.country, c.city, c.device, c.os, c.browser, c.kind, c.reason, c.proxy, l.id AS link_id, l.slug
     FROM clicks c JOIN links l ON l.id = c.link_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.ts DESC LIMIT 12`
  ).bind(...(linkId ? [linkId] : [])).all();
  return r.results;
}

// ---------------------------------------------------------------- 统计通知（日报 / 周报 / 月报 → Telegram / 邮件）

const KIND_NAME = { daily: '日报', weekly: '周报', monthly: '月报' };
const MASK = '••••';

const NOTIFY_DEFAULT = {
  reports: { daily: true, weekly: true, monthly: false },
  usage: { enabled: false, threshold: 80 },   // Cloudflare 用量预警
  seo: { enabled: false, tag: '' },           // 每周 SEO 变化（tag：只看某个分组）
  health: { enabled: true },                  // 目标页打不开 / 恢复时提醒
  hour: 9, tz: 480, base: '',
  tg: { enabled: false, token: '', chat: '' },
  email: { enabled: false, provider: 'resend', key: '', from: '', to: '' },
};

async function getNotify(env) {
  const row = await getSetting(env, 'notify');
  const v = row ? JSON.parse(row.value) : {};
  return {
    ...NOTIFY_DEFAULT, ...v,
    reports: { ...NOTIFY_DEFAULT.reports, ...(v.reports || {}) },
    usage: { ...NOTIFY_DEFAULT.usage, ...(v.usage || {}) },
    seo: { ...NOTIFY_DEFAULT.seo, ...(v.seo || {}) },
    health: { ...NOTIFY_DEFAULT.health, ...(v.health || {}) },
    tg: { ...NOTIFY_DEFAULT.tg, ...(v.tg || {}) },
    email: { ...NOTIFY_DEFAULT.email, ...(v.email || {}) },
  };
}

// 返回给后台时隐藏密钥，只露出末 4 位
const mask = (v) => (v ? MASK + String(v).slice(-4) : '');
async function notifyForClient(env) {
  const c = await getNotify(env);
  const st = await getSetting(env, 'notify_status');
  return {
    ...c,
    tg: { ...c.tg, token: mask(c.tg.token) },
    email: { ...c.email, key: mask(c.email.key) },
    status: st ? JSON.parse(st.value) : null,
    cloudflareEmail: !!env.EMAIL,
    cfConfigured: !!(await cfCreds(env)),
    googleConnected: !!(await env.DB.prepare('SELECT COUNT(*) AS n FROM g_accounts').first('n').catch(() => 0)),
    tags: (await env.DB.prepare('SELECT tag, COUNT(*) AS n FROM site_tags GROUP BY tag ORDER BY tag').all().catch(() => ({ results: [] }))).results,
  };
}

async function saveNotify(request, env, url) {
  const body = await request.json().catch(() => ({}));
  const cur = await getNotify(env);
  const keep = (v, old) => (typeof v === 'string' && v.startsWith(MASK) ? old : cut(String(v ?? '').trim(), 500));
  const hour = Number(body.hour);
  const tz = Number(body.tz);
  const next = {
    reports: { daily: !!body.reports?.daily, weekly: !!body.reports?.weekly, monthly: !!body.reports?.monthly },
    health: { enabled: body.health ? !!body.health.enabled : cur.health.enabled },
    seo: {
      enabled: body.seo ? !!body.seo.enabled : cur.seo.enabled,
      tag: body.seo ? cut(String(body.seo.tag || '').trim(), 40) : cur.seo.tag,
    },
    usage: {
      enabled: body.usage ? !!body.usage.enabled : cur.usage.enabled,
      threshold: [70, 80, 90].includes(Number(body.usage?.threshold)) ? Number(body.usage.threshold) : cur.usage.threshold,
    },
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : cur.hour,
    tz: Number.isFinite(tz) && Math.abs(tz) <= 840 ? tz : cur.tz,
    base: url.origin,
    tg: { enabled: !!body.tg?.enabled, token: keep(body.tg?.token, cur.tg.token), chat: cut(String(body.tg?.chat ?? '').trim(), 100) },
    email: {
      enabled: !!body.email?.enabled,
      provider: body.email?.provider === 'cloudflare' ? 'cloudflare' : 'resend',
      key: keep(body.email?.key, cur.email.key),
      from: cut(String(body.email?.from ?? '').trim(), 200),
      to: cut(String(body.email?.to ?? '').trim(), 500),
    },
  };
  if (next.tg.enabled && (!next.tg.token || !next.tg.chat)) return json({ error: 'Telegram 需要填写 Bot Token 和 Chat ID' }, 400);
  if (next.email.enabled) {
    if (!next.email.from || !next.email.to) return json({ error: '邮件需要填写发件人和收件人' }, 400);
    if (next.email.provider === 'resend' && !next.email.key) return json({ error: '使用 Resend 需要填写 API Key' }, 400);
    if (next.email.provider === 'cloudflare' && !env.EMAIL) return json({ error: '当前部署没有配置 send_email 绑定，无法使用 Cloudflare 邮件，见 README' }, 400);
  }
  await setSetting(env, 'notify', JSON.stringify(next));
  return json(await notifyForClient(env));
}

// 立即发送一份测试报告到指定渠道（使用已保存的配置）
async function testNotify(request, env) {
  const body = await request.json().catch(() => ({}));
  const cfg = await getNotify(env);
  let report;
  if (body.kind === 'seo') {
    const dg = await google.seoDigest(env, await sessionSecret(env), cfg.seo.tag).catch((e) => ({ error: e.message }));
    if (!dg || dg.error) return json({ error: dg?.error || '没有可用的站点数据（还没连接 Google，或这个分组里没有站点）' }, 400);
    report = buildSeoDigest(cfg, dg, true);
  } else if (body.kind === 'usage') {
    const u = await cfUsage(env, true);
    if (!u.configured) return json({ error: '还没有配置 Cloudflare 凭据，请先在 设置 → Cloudflare 用量 中填写' }, 400);
    if (!u.forecast) return json({ error: '暂时读取不到用量数据' }, 400);
    report = buildUsageAlert(cfg, u, [], true);
  } else {
    const kind = KIND_NAME[body.kind] ? body.kind : 'daily';
    report = await buildReport(env, cfg, kind, Date.now(), true);
  }
  try {
    if (body.channel === 'tg') await sendTelegram(cfg.tg, report.tg);
    else if (body.channel === 'email') await sendEmail(env, cfg.email, report);
    else return json({ error: '未知渠道' }, 400);
  } catch (err) {
    return json({ error: err.message }, 400);
  }
  return json({ ok: true });
}

async function runNotifications(env, now = Date.now()) {
  await ensureSchema(env);
  const cfg = await getNotify(env);
  if (!cfg.tg.enabled && !cfg.email.enabled) return;
  const local = new Date(now + cfg.tz * 60000);
  if (local.getUTCHours() !== cfg.hour) return;
  const today = local.toISOString().slice(0, 10);
  const lastRow = await getSetting(env, 'notify_last');
  const last = lastRow ? JSON.parse(lastRow.value) : {};
  const kinds = [];
  if (cfg.reports.daily && last.daily !== today) kinds.push('daily');
  if (cfg.reports.weekly && local.getUTCDay() === 1 && last.weekly !== today) kinds.push('weekly');
  if (cfg.reports.monthly && local.getUTCDate() === 1 && last.monthly !== today) kinds.push('monthly');
  if (cfg.seo.enabled && local.getUTCDay() === 1 && last.seo !== today) kinds.push('seo');
  for (const kind of kinds) {
    let report;
    if (kind === 'seo') {
      const dg = await google.seoDigest(env, await sessionSecret(env), cfg.seo.tag).catch(() => null);
      last.seo = today;
      if (!dg) { await setSetting(env, 'notify_last', JSON.stringify(last)); continue; }
      report = buildSeoDigest(cfg, dg);
    } else report = await buildReport(env, cfg, kind, now);
    const errors = [];
    if (cfg.tg.enabled) await sendTelegram(cfg.tg, report.tg).catch((e) => errors.push(e.message));
    if (cfg.email.enabled) await sendEmail(env, cfg.email, report).catch((e) => errors.push(e.message));
    last[kind] = today;
    await setSetting(env, 'notify_last', JSON.stringify(last));
    await setSetting(env, 'notify_status', JSON.stringify({ at: Date.now(), kind, ok: !errors.length, error: errors.join('；') }));
  }
}

// ---------------------------------------------------------------- Cloudflare 用量预警
// 每小时检查一次。触发条件（任一项）：已用达到阈值；已超出包含额度；按目前速度期末会超出（期内已过 15% 以上，免费版 25%，避免刚开始时误报）。
// 同一个计费周期里，每项指标的每种情况只提醒一次。
async function runUsageAlert(env) {
  const cfg = await getNotify(env);
  if (!cfg.usage.enabled || (!cfg.tg.enabled && !cfg.email.enabled)) return;
  if (!(await cfCreds(env))) return;
  const u = await cfUsage(env, false);
  const f = u.forecast;
  if (!f) return;
  const th = cfg.usage.threshold / 100;
  const level = (i) => (i.ratio >= 1 ? 'over' : i.ratio >= th ? 'used' : i.projRatio >= 1 && f.elapsed >= (f.paid ? 0.15 : 0.25) ? 'proj' : '');
  const row = await getSetting(env, 'notify_usage');
  let sent = row ? JSON.parse(row.value) : {};
  if (sent.period !== f.period) sent = { period: f.period, keys: [] };
  const fresh = f.items.filter((i) => level(i) && !sent.keys.includes(`${i.k}|${level(i)}`));
  if (!fresh.length) return;
  const report = buildUsageAlert(cfg, u, fresh.map((i) => i.k));
  const errors = [];
  if (cfg.tg.enabled) await sendTelegram(cfg.tg, report.tg).catch((e) => errors.push(e.message));
  if (cfg.email.enabled) await sendEmail(env, cfg.email, report).catch((e) => errors.push(e.message));
  sent.keys.push(...fresh.map((i) => `${i.k}|${level(i)}`));
  await setSetting(env, 'notify_usage', JSON.stringify(sent));
  await setSetting(env, 'notify_status', JSON.stringify({ at: Date.now(), kind: 'usage', ok: !errors.length, error: errors.join('；') }));
}

// 每周 SEO 变化
function buildSeoDigest(cfg, g, test = false) {
  const nf = new Intl.NumberFormat('en-US'), n = (v) => nf.format(Math.round(v || 0));
  const h = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const chg = (a, b) => (!b ? (a ? '新增' : '持平') : `${a >= b ? '↑' : '↓'} ${Math.abs(((a - b) / b) * 100).toFixed(0)}%`);
  const md = (s) => s.slice(5).replace('-', '/');
  const t = g.totals;
  const title = `${test ? '【测试】' : ''}每周 SEO 变化${g.tag ? ` · ${g.tag}` : ''} · 搜索点击 ${chg(t.clicks, t.prevClicks)}`;
  const admin = cfg.base ? `${cfg.base}/admin#/sites` : '';
  const site = (x) => `${x.host}：${n(x.prevClicks)} → ${n(x.clicks)}（${x.clicks - x.prevClicks >= 0 ? '+' : ''}${n(x.clicks - x.prevClicks)}）${x.position != null && x.prevPosition != null ? ` · 排名 ${x.prevPosition.toFixed(1)} → ${x.position.toFixed(1)}` : ''}`;
  const sections = [
    ['📉 点击下滑最多', g.drops.map(site)],
    ['📈 点击增长最多', g.gains.map(site)],
    ['⚠️ 跌出前 10 的搜索词', g.fellOut.map((x) => `${x.q}（${x.host}）：排名 ${x.from.toFixed(1)} → ${x.to.toFixed(1)}，上周展示 ${n(x.impressions)}`)],
    ['🎯 接近前 10 的搜索词', g.near.map((x) => `${x.q}（${x.host}）：排名 ${x.position.toFixed(1)}，展示 ${n(x.impressions)}`)],
  ].filter(([, items]) => items.length);
  const head = [
    `${g.sites} 个站点 · 搜索 ${md(g.range.from)}–${md(g.range.to)} 对比上一周（Search Console 数据延迟约 3 天），会话 ${md(g.gaRange.from)}–${md(g.gaRange.to)}`,
    `搜索点击 ${n(t.clicks)}（${chg(t.clicks, t.prevClicks)}） · 展示 ${n(t.impressions)}（${chg(t.impressions, t.prevImpressions)}）${g.bing ? ` · Bing 点击 ${n(t.bingClicks)}（${chg(t.bingClicks, t.prevBingClicks)}）` : ''} · 会话 ${n(t.sessions)}（${chg(t.sessions, t.prevSessions)}）`,
  ];
  const tg = [`🔎 <b>${h(title)}</b>`, ...head.map(h), '',
    ...sections.flatMap(([k, items]) => [`<b>${h(k)}</b>`, ...items.map((x) => `• ${h(x)}`), '']),
    sections.length ? '' : '这一周没有明显的变化。',
    admin ? `<a href="${h(admin)}">查看站点 →</a>` : ''].filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n').trim();
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e3e6ec;border-radius:16px"><tr><td style="padding:28px">
<div style="font-size:13px;color:#868e9e">cligc link · 每周 SEO 变化${test ? '（测试）' : ''}</div>
<h1 style="margin:6px 0 10px;font-size:20px;color:#0b1020">${h(title.replace('【测试】', ''))}</h1>
${head.map((x) => `<p style="margin:0 0 6px;font-size:13px;color:#454d5e">${h(x)}</p>`).join('')}
${sections.map(([k, items]) => `<h3 style="margin:22px 0 8px;font-size:14px;color:#0b1020">${h(k)}</h3>${items.map((x) => `<div style="font-size:13px;color:#454d5e;padding:4px 0;border-bottom:1px solid #f0f1f4">${h(x)}</div>`).join('')}`).join('')}
${sections.length ? '' : '<p style="margin:20px 0 0;color:#868e9e">这一周没有明显的变化。</p>'}
${admin ? `<p style="margin:24px 0 0"><a href="${h(admin)}" style="display:inline-block;padding:10px 18px;border-radius:10px;background:#0b1020;color:#fff;text-decoration:none;font-size:14px">查看站点</a></p>` : ''}
</td></tr></table></body></html>`;
  return { title, tg, html, text: tg.replace(/<[^>]+>/g, '') };
}

function buildUsageAlert(cfg, u, hot, test = false) {
  const f = u.forecast;
  const wan = (n) => (n >= 1e8 ? `${+(n / 1e8).toFixed(2)} 亿` : n >= 1e4 ? `${+(n / 1e4).toFixed(1)} 万` : new Intl.NumberFormat('en-US').format(Math.round(n)));
  const pct = (x) => (x > 0 && x < 0.01 ? '<1%' : `${Math.round(x * 100)}%`);
  const md = (ms) => { const d = new Date(ms + cfg.tz * 60000); return `${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日 ${String(d.getUTCHours()).padStart(2, '0')}:00`; };
  const h = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const when = f.paid ? '本月' : '今天', endName = f.paid ? '月底' : '今天结束时';
  const plan = f.paid ? '付费版' : '免费版';
  const lines = f.items.map((i) => {
    const state = i.ratio >= 1 ? `已超出包含额度` : i.runOut ? `预计 ${md(i.runOut)} 用完包含额度` : i.projRatio >= 0.8 ? '偏紧' : '充足';
    return { i, hot: hot.includes(i.k), head: `${i.name}：${when}已用 ${wan(i.used)} / ${wan(i.limit)}（${pct(i.ratio)}）`,
      tail: `按目前速度${endName}约 ${wan(i.proj)}（${pct(i.projRatio)}）· ${state}` };
  });
  const worst = f.items.reduce((a, b) => (b.projRatio > a.projRatio ? b : a));
  const title = `${test ? '【测试】' : ''}Cloudflare 用量${worst.ratio >= 1 ? '已超出' : worst.projRatio >= 1 ? '预计超出' : '提醒'} · ${worst.name} ${pct(worst.ratio)}`;
  const foot = f.paid ? '付费版超出包含额度的部分按量计费。' : '免费版超出后当天的请求会失败，UTC 0 点（北京时间 8 点）重置。';
  const admin = cfg.base ? `${cfg.base}/admin#/settings` : '';
  const tg = [
    `⚠️ <b>${h(title)}</b>`, `${plan} · 整个 Cloudflare 账户`, '',
    ...lines.map((l) => `${l.hot ? '🔴' : '▫️'} ${h(l.head)}\n    ${h(l.tail)}`), '',
    h(foot), admin ? `<a href="${h(admin)}">查看用量 →</a>` : '',
  ].filter((x) => x !== '').join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e3e6ec;border-radius:16px"><tr><td style="padding:28px">
<div style="font-size:13px;color:#868e9e">cligc link · Cloudflare 用量预警${test ? '（测试）' : ''} · ${plan}</div>
<h1 style="margin:6px 0 20px;font-size:20px;color:#0b1020">${h(title.replace('【测试】', ''))}</h1>
${lines.map((l) => `<div style="padding:12px 14px;margin-bottom:8px;border-radius:10px;background:${l.hot ? '#fff1f0' : '#f6f7f9'}">
  <div style="font-size:14px;font-weight:600;color:${l.hot ? '#c4321f' : '#0b1020'}">${h(l.head)}</div>
  <div style="font-size:13px;color:#454d5e;margin-top:4px">${h(l.tail)}</div></div>`).join('')}
<p style="margin:16px 0 0;font-size:13px;color:#454d5e">${h(foot)}</p>
${admin ? `<p style="margin:24px 0 0"><a href="${h(admin)}" style="display:inline-block;padding:10px 18px;border-radius:10px;background:#0b1020;color:#fff;text-decoration:none;font-size:14px">查看用量</a></p>` : ''}
</td></tr></table></body></html>`;
  return { title, tg, html, text: tg.replace(/<[^>]+>/g, '') };
}

// 计算报告的时间范围（按设定时区的自然日 / 自然周（周一开始）/ 自然月），返回 UTC 毫秒
function reportRange(kind, now, tz) {
  const off = tz * 60000, DAY = 86400000;
  const local = now + off;
  const todayStart = Math.floor(local / DAY) * DAY;
  let start, end, prev;
  if (kind === 'weekly') {
    const dow = new Date(todayStart).getUTCDay();
    end = todayStart - ((dow + 6) % 7) * DAY; start = end - 7 * DAY; prev = start - 7 * DAY;
  } else if (kind === 'monthly') {
    const d = new Date(todayStart);
    end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
    prev = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 2, 1);
  } else {
    end = todayStart; start = end - DAY; prev = start - DAY;
  }
  return { start: start - off, end: end - off, prev: prev - off, label: rangeLabelText(kind, start, end) };
}

function rangeLabelText(kind, start, end) {
  const f = (ms) => { const d = new Date(ms); return `${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`; };
  if (kind === 'monthly') { const d = new Date(start); return `${d.getUTCFullYear()} 年 ${d.getUTCMonth() + 1} 月`; }
  if (kind === 'weekly') return `${f(start)} – ${f(end - 86400000)}`;
  return f(start);
}

async function buildReport(env, cfg, kind, now, test = false) {
  const { start, end, prev, label } = reportRange(kind, now, cfg.tz);
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const all = (st) => st.all().then((r) => r.results);
  const [cur, before, created, links, sources, countries] = await Promise.all([
    q('SELECT COUNT(*) AS n, COUNT(DISTINCT ip) AS u FROM clicks WHERE ts >= ? AND ts < ? AND is_bot = 0', start, end).first(),
    q('SELECT COUNT(*) AS n, COUNT(DISTINCT ip) AS u FROM clicks WHERE ts >= ? AND ts < ? AND is_bot = 0', prev, start).first(),
    q('SELECT COUNT(*) AS n FROM links WHERE created_at >= ? AND created_at < ?', start, end).first('n'),
    all(q(`SELECT l.slug, l.title, COUNT(*) AS n FROM clicks c JOIN links l ON l.id = c.link_id
           WHERE c.ts >= ? AND c.ts < ? AND c.is_bot = 0 GROUP BY l.id ORDER BY n DESC LIMIT 5`, start, end)),
    all(q('SELECT source AS k, COUNT(*) AS n FROM clicks WHERE ts >= ? AND ts < ? AND is_bot = 0 GROUP BY source ORDER BY n DESC LIMIT 5', start, end)),
    all(q('SELECT country AS k, COUNT(*) AS n FROM clicks WHERE ts >= ? AND ts < ? AND is_bot = 0 GROUP BY country ORDER BY n DESC LIMIT 5', start, end)),
  ]);
  const nf = new Intl.NumberFormat('en-US');
  const n = (v) => nf.format(v || 0);
  const chg = (a, b) => (!b ? (a ? '新增' : '持平') : a === b ? '持平' : `${a > b ? '↑' : '↓'} ${Math.abs(Math.round(((a - b) / b) * 100))}%`);
  const h = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const host = cfg.base ? new URL(cfg.base).host : '';
  const title = `${test ? '【测试】' : ''}cligc link ${KIND_NAME[kind]} · ${label}`;
  const admin = cfg.base ? `${cfg.base}/admin` : '';

  // Telegram（HTML 格式）
  const tgLines = [
    `📊 <b>${h(title)}</b>`, '',
    `访问 <b>${n(cur.n)}</b>（${chg(cur.n, before.n)}）  独立访客 <b>${n(cur.u)}</b>（${chg(cur.u, before.u)}）`,
    created ? `新建短链 ${n(created)} 条` : '',
    links.length ? `\n<b>热门短链</b>\n${links.map((l, i) => `${i + 1}. <code>/${h(l.slug)}</code>${l.title ? ` ${h(l.title)}` : ''} — ${n(l.n)}`).join('\n')}` : '\n这段时间没有访问。',
    sources.length ? `\n<b>来源</b>\n${sources.map((x) => `${h(x.k)} ${n(x.n)}`).join(' · ')}` : '',
    countries.length ? `\n<b>国家 / 地区</b>\n${countries.map((x) => `${countryLabel(x.k)} ${n(x.n)}`).join(' · ')}` : '',
    admin ? `\n<a href="${h(admin)}">打开后台 →</a>` : '',
  ].filter((x) => x !== '');

  // 邮件（内联样式，兼容各邮件客户端）
  const row = (k, v) => `<tr><td style="padding:6px 0;color:#454d5e">${k}</td><td style="padding:6px 0;text-align:right;font-weight:600;color:#0b1020">${v}</td></tr>`;
  const list = (t, items) => items.length ? `<h3 style="margin:24px 0 8px;font-size:14px;color:#0b1020">${t}</h3><table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">${items.join('')}</table>` : '';
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e3e6ec;border-radius:16px"><tr><td style="padding:28px">
<div style="font-size:13px;color:#868e9e">cligc link · ${KIND_NAME[kind]}${test ? '（测试）' : ''}</div>
<h1 style="margin:6px 0 20px;font-size:22px;color:#0b1020">${h(label)}</h1>
<table width="100%" cellpadding="0" cellspacing="0"><tr>
  <td style="padding:16px;border-radius:12px;background:#ecf1ff;width:50%"><div style="font-size:12px;color:#454d5e">访问次数</div><div style="font-size:26px;font-weight:700;color:#0b1020">${n(cur.n)}</div><div style="font-size:12px;color:#1d4fd8">${chg(cur.n, before.n)}</div></td>
  <td style="width:12px"></td>
  <td style="padding:16px;border-radius:12px;background:#f1edff;width:50%"><div style="font-size:12px;color:#454d5e">独立访客</div><div style="font-size:26px;font-weight:700;color:#0b1020">${n(cur.u)}</div><div style="font-size:12px;color:#5b3fd9">${chg(cur.u, before.u)}</div></td>
</tr></table>
${created ? `<p style="margin:16px 0 0;font-size:14px;color:#454d5e">新建短链 ${n(created)} 条</p>` : ''}
${links.length ? list('热门短链', links.map((l, i) => row(`${i + 1}. <span style="font-family:ui-monospace,Menlo,monospace">/${h(l.slug)}</span> ${h(l.title)}`, n(l.n)))) : '<p style="margin:20px 0 0;color:#868e9e">这段时间没有访问。</p>'}
${list('来源', sources.map((x) => row(h(x.k), n(x.n))))}
${list('国家 / 地区', countries.map((x) => row(countryLabel(x.k), n(x.n))))}
${admin ? `<p style="margin:28px 0 0"><a href="${h(admin)}" style="display:inline-block;padding:10px 18px;border-radius:10px;background:#0b1020;color:#fff;text-decoration:none;font-size:14px">打开后台</a></p>` : ''}
</td></tr></table>
<p style="text-align:center;font-size:12px;color:#868e9e;margin:16px 0 0">${h(host)} · 在后台“通知”中可修改或关闭推送</p>
</body></html>`;
  const text = tgLines.join('\n').replace(/<[^>]+>/g, '');
  return { title, tg: tgLines.join('\n'), html, text };
}

function countryLabel(code) {
  if (!code || code.length !== 2) return code || '未知';
  let name = code;
  try { name = new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(code) || code; } catch {}
  const flag = code === 'TW' ? '' : String.fromCodePoint(...[...code.toUpperCase()].map((c) => 127397 + c.charCodeAt(0)));
  return `${flag} ${name}`.trim();
}

async function sendTelegram(tg, text) {
  if (!tg.token || !tg.chat) throw new Error('Telegram 未配置 Bot Token 或 Chat ID');
  const res = await fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: tg.chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram 发送失败：${data.description || res.status}`);
}

async function sendEmail(env, mail, report) {
  const to = mail.to.split(/[\s,，;；]+/).filter(Boolean);
  if (!mail.from || !to.length) throw new Error('邮件未配置发件人或收件人');
  if (mail.provider === 'cloudflare') {
    if (!env.EMAIL) throw new Error('当前部署没有配置 send_email 绑定');
    for (const addr of to) await env.EMAIL.send(new EmailMessage(bareAddress(mail.from), addr, mime(mail.from, addr, report)));
    return;
  }
  if (!mail.key) throw new Error('未配置 Resend API Key');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${mail.key}` },
    body: JSON.stringify({ from: mail.from, to, subject: report.title, html: report.html, text: report.text }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`邮件发送失败：${data.message || res.status}`);
  }
}

const bareAddress = (v) => (v.match(/<([^>]+)>/) || [, v])[1].trim();
const b64 = (str) => { const bytes = new TextEncoder().encode(str); let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin); };
function mime(from, to, report) {
  const domain = bareAddress(from).split('@')[1] || 'localhost';
  return [
    `From: ${from}`, `To: ${to}`, `Subject: =?UTF-8?B?${b64(report.title)}?=`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0', 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    b64(report.html).replace(/.{1,76}/g, '$&\r\n'),
  ].join('\r\n');
}

// ---------------------------------------------------------------- 工具

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

// 简单的提示页（短链不存在 / 暂不可用），风格与首页一致
function infoPage(title, message, status) {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title} · cligc</title>
<style>
:root{--bg:#f4f5f7;--text:#0d1321;--muted:#6b7385;--line:#e3e6ec;--accent:#2f6bff}
@media (prefers-color-scheme:dark){:root{--bg:#0a0c10;--text:#edeff3;--muted:#8a92a3;--line:#262a33;--accent:#5f8fff}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);
font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
main{text-align:center;max-width:380px;animation:r .6s cubic-bezier(.16,1,.3,1) both}
@keyframes r{from{opacity:0;transform:translateY(8px)}}
.code{font:600 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);letter-spacing:.1em;margin:22px 0 10px}
h1{margin:0 0 8px;font-size:22px;letter-spacing:-.02em}p{margin:0;color:var(--muted)}
a{display:inline-flex;align-items:center;gap:8px;margin-top:28px;color:var(--muted);text-decoration:none;font-size:13px}
a:hover{color:var(--accent)}
</style></head><body><main>
<svg width="44" height="44" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4b83ff"/><stop offset="1" stop-color="#1f4fd1"/></linearGradient></defs><rect width="32" height="32" rx="9" fill="url(#g)"/><path d="M10.5 21.5 21.5 10.5M13.5 10.5h8v8" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
<div class="code">${status}</div><h1>${title}</h1><p>${message}</p>
<a href="/">cligc 短链服务 →</a></main></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

function notConfigured() {
  return infoPage('链接暂不可用', '该链接在你所在的地区暂未开放，请稍后再试。', 404);
}

function notFound() {
  return infoPage('链接不存在', '这个短链接不存在或已被停用，请检查链接是否完整。', 404);
}

function cut(s, n) {
  return s.length > n ? s.slice(0, n) : s;
}

// ---------------------------------------------------------------- 目标页健康检查
// 定时任务每小时检查一批目标地址（启用中的短链的默认地址和跳转规则地址），每个地址至少 6 小时查一次，刚失败的 1 小时后复查。
// 404 / 410 / 5xx / 连接失败 / 超时连续 2 次才算“打不开”；401 / 403 / 429 和 Cloudflare 质询页算“无法验证”（对方拦截了自动访问），不报警。
// 状态从正常变成打不开、或从打不开恢复时，推送到已开启的通知渠道。
const HEALTH_BATCH = 25, HEALTH_EVERY = 6 * 3600000, HEALTH_RETRY = 3600000, HEALTH_TIMEOUT = 10000;

async function healthUrls(env) {
  return (await env.DB.prepare(
    `SELECT target_url AS url FROM links WHERE enabled = 1 AND target_url != ''
     UNION SELECT t.url FROM link_targets t JOIN links l ON l.id = t.link_id WHERE l.enabled = 1`
  ).all()).results.map((r) => r.url);
}

// 检查一个地址，返回 { state, status, error, ms }
async function probeUrl(url) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(HEALTH_TIMEOUT),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; cligc-link-healthcheck/1.0; +https://github.com/ccvar/cligc_link)', accept: 'text/html,*/*' },
    });
    res.body?.cancel().catch(() => {});
    const ms = Date.now() - t0, st = res.status;
    const challenge = res.headers.get('cf-mitigated') === 'challenge';
    if (st < 400) return { state: 'ok', status: st, error: '', ms };
    if (challenge || st === 401 || st === 403 || st === 429) return { state: 'blocked', status: st, error: challenge ? '对方开启了人机验证' : `HTTP ${st}（对方拒绝了自动访问）`, ms };
    return { state: 'down', status: st, error: st === 404 || st === 410 ? `页面不存在（HTTP ${st}）` : `HTTP ${st}`, ms };
  } catch (e) {
    const ms = Date.now() - t0;
    return { state: 'down', status: 0, error: e?.name === 'TimeoutError' ? `${HEALTH_TIMEOUT / 1000} 秒内没有响应` : `连接失败：${String(e?.message || e).slice(0, 120)}`, ms };
  }
}

// 写入检查结果；返回状态变化（'down' 新打不开 / 'up' 恢复 / null）
async function saveHealth(env, url, r) {
  const old = await env.DB.prepare('SELECT * FROM url_health WHERE url = ?').bind(url).first();
  const now = Date.now();
  const fails = r.state === 'down' ? (old?.fails || 0) + 1 : 0;
  // 连续 2 次失败才确认打不开；第一次失败先保持原状态
  const state = r.state === 'down' ? (fails >= 2 ? 'down' : old?.state === 'down' ? 'down' : old?.state || 'unknown') : r.state;
  const since = old && old.state === state ? old.since : now;
  await env.DB.prepare(
    `INSERT INTO url_health (url, state, status, error, ms, fails, checked_at, since) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET state = excluded.state, status = excluded.status, error = excluded.error, ms = excluded.ms,
       fails = excluded.fails, checked_at = excluded.checked_at, since = excluded.since`
  ).bind(url, state, r.status, r.error, r.ms, fails, now, since).run();
  if (state === 'down' && old?.state !== 'down') return 'down';
  if (old?.state === 'down' && state === 'ok') return 'up';
  return null;
}

async function runHealthChecks(env) {
  const urls = await healthUrls(env);
  const set = new Set(urls);
  // 不再使用的地址：清掉记录
  const known = (await env.DB.prepare('SELECT url, checked_at, fails FROM url_health').all()).results;
  const gone = known.filter((r) => !set.has(r.url));
  for (let i = 0; i < gone.length; i += 50) await env.DB.batch(gone.slice(i, i + 50).map((r) => env.DB.prepare('DELETE FROM url_health WHERE url = ?').bind(r.url)));
  const at = new Map(known.map((r) => [r.url, r]));
  const now = Date.now();
  const due = urls.filter((u) => { const r = at.get(u); return !r || now - r.checked_at > (r.fails ? HEALTH_RETRY : HEALTH_EVERY) - 60000; })
    .sort((a, b) => (at.get(a)?.checked_at || 0) - (at.get(b)?.checked_at || 0)).slice(0, HEALTH_BATCH);
  const changes = [];
  for (let i = 0; i < due.length; i += 5) {
    const part = due.slice(i, i + 5);
    const res = await Promise.all(part.map((u) => probeUrl(u)));
    for (let j = 0; j < part.length; j++) {
      const c = await saveHealth(env, part[j], res[j]);
      if (c) changes.push({ url: part[j], change: c, ...res[j] });
    }
  }
  if (changes.length) await notifyHealth(env, changes).catch((e) => console.error('health notify failed', e));
  return { checked: due.length, total: urls.length, changes: changes.length };
}

// 推送：哪些地址打不开 / 恢复了，以及受影响的短链
async function notifyHealth(env, changes) {
  const cfg = await getNotify(env);
  if (!cfg.health.enabled || (!cfg.tg.enabled && !cfg.email.enabled)) return;
  const users = await healthUsers(env, changes.map((c) => c.url));
  const h = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const down = changes.filter((c) => c.change === 'down'), up = changes.filter((c) => c.change === 'up');
  const line = (c) => `${c.url}\n    ${c.change === 'down' ? c.error : '已恢复'} · 短链：${(users.get(c.url) || []).map((s) => '/' + s).join('、') || '—'}`;
  const title = down.length ? `目标页打不开 · ${down.length} 个地址` : `目标页已恢复 · ${up.length} 个地址`;
  const admin = cfg.base ? `${cfg.base}/admin#/links` : '';
  const tg = [`${down.length ? '🚨' : '✅'} <b>${h(title)}</b>`, '',
    ...(down.length ? ['<b>打不开</b>', ...down.map((c) => h(line(c))), ''] : []),
    ...(up.length ? ['<b>已恢复</b>', ...up.map((c) => h(line(c))), ''] : []),
    '检查从 Cloudflare 节点发出；只对部分地区开放的地址可能误报。', admin ? `<a href="${h(admin)}">查看短链 →</a>` : ''].filter((x) => x !== '').join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e3e6ec;border-radius:16px"><tr><td style="padding:28px">
<div style="font-size:13px;color:#868e9e">cligc link · 目标页检查</div><h1 style="margin:6px 0 18px;font-size:20px;color:#0b1020">${h(title)}</h1>
${changes.map((c) => `<div style="padding:12px 14px;margin-bottom:8px;border-radius:10px;background:${c.change === 'down' ? '#fff1f0' : '#ecf8f1'}">
  <div style="font-size:13px;font-weight:600;color:#0b1020;word-break:break-all">${h(c.url)}</div>
  <div style="font-size:12.5px;color:#454d5e;margin-top:4px">${h(c.change === 'down' ? c.error : '已恢复')} · 短链：${h((users.get(c.url) || []).map((s) => '/' + s).join('、') || '—')}</div></div>`).join('')}
<p style="margin:14px 0 0;font-size:12.5px;color:#868e9e">检查从 Cloudflare 节点发出；只对部分地区开放的地址可能误报。</p>
${admin ? `<p style="margin:20px 0 0"><a href="${h(admin)}" style="display:inline-block;padding:10px 18px;border-radius:10px;background:#0b1020;color:#fff;text-decoration:none;font-size:14px">查看短链</a></p>` : ''}
</td></tr></table></body></html>`;
  const report = { title, tg, html, text: tg.replace(/<[^>]+>/g, '') };
  const errors = [];
  if (cfg.tg.enabled) await sendTelegram(cfg.tg, report.tg).catch((e) => errors.push(e.message));
  if (cfg.email.enabled) await sendEmail(env, cfg.email, report).catch((e) => errors.push(e.message));
  await setSetting(env, 'notify_status', JSON.stringify({ at: Date.now(), kind: 'health', ok: !errors.length, error: errors.join('；') }));
}

// 用到这些地址的短链后缀
async function healthUsers(env, urls) {
  if (!urls.length) return new Map();
  const q = urls.map(() => '?').join(',');
  const rows = (await env.DB.prepare(
    `SELECT target_url AS url, slug FROM links WHERE target_url IN (${q})
     UNION SELECT t.url, l.slug FROM link_targets t JOIN links l ON l.id = t.link_id WHERE t.url IN (${q})`
  ).bind(...urls, ...urls).all()).results;
  const m = new Map();
  for (const r of rows) { if (!m.has(r.url)) m.set(r.url, []); if (!m.get(r.url).includes(r.slug)) m.get(r.url).push(r.slug); }
  return m;
}

// 一个短链的目标地址的检查结果（短链列表 / 详情用）
async function healthOf(env, urls) {
  if (!urls.length) return new Map();
  const rows = (await env.DB.prepare(`SELECT * FROM url_health WHERE url IN (${urls.map(() => '?').join(',')})`).bind(...urls).all().catch(() => ({ results: [] }))).results;
  return new Map(rows.map((r) => [r.url, { state: r.state, status: r.status, error: r.error, ms: r.ms, checkedAt: r.checked_at, since: r.since }]));
}
