// ---------------------------------------------------------------- Bing Webmaster Tools
// 授权：API Key（Bing Webmaster → 设置 → API 访问），加密保存在 settings.int_bing；一个 Key 能访问该账号下所有已验证的站点。
// 代理：Bing 会按来源 IP 限流（ThrottleIP），Cloudflare 的出口 IP 是共用的，常被拦下；可以填一个代理地址（自己服务器上的 nginx / Caddy 转发），
// 请求改为 <代理地址><方法>?…，由代理转到 https://ssl.bing.com/webmaster/api.svc/json/<方法>?…。
// 下面的 cred 是 { key, proxy }（也兼容只传 Key 字符串）。
// 站点按主域名并入 g_sites.bing_site（和 GA4 / GSC 合并显示）；每日点击 / 展示存在 g_daily.b_clicks / b_impressions。
// 接口：https://ssl.bing.com/webmaster/api.svc/json/<方法>?apikey=…；读取用 GET + 查询参数，写入用 POST + JSON；
// 返回 {"d": …}，日期是 .NET 格式 /Date(1399014000000-0700)/，出错时返回 {"ErrorCode", "Message"}。
// 搜索词 / 页面统计是按周汇总的，没有日期参数，一次返回全部（约 6 个月）。

import { seal, unseal, siteHost, rebuildSites, gVerStmt } from './google.js';
import { spend } from './budget.js';

const DAY = 86400000;
// 清空外链数据（见 src/backlinks.js）：换 Key、删除 Key、站点换了 Bing 资源时用
export const BL_RESET = "bl_total = -1, bl_pages = 0, bl_more = 0, bl_prev = -1, bl_top = '', bl_error = '', bl_at = 0";
const API = 'https://ssl.bing.com/webmaster/api.svc/json/';
const ymd = (t) => new Date(t).toISOString().slice(0, 10);

async function getSetting(env, key) {
  return (await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first('value')) ?? null;
}
async function setSetting(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, value, Date.now()).run();
}

// .NET 日期 → 毫秒（带时区偏移时按当地时间算日期，避免跨天）；“没有日期”（负数）返回 0
export function bingTime(v, local = false) {
  const m = /\/Date\((-?\d+)([+-]\d{4})?\)\//.exec(String(v || ''));
  if (!m || Number(m[1]) <= 0) return 0;
  let t = Number(m[1]);
  if (local && m[2]) t += (m[2][0] === '-' ? -1 : 1) * (Number(m[2].slice(1, 3)) * 60 + Number(m[2].slice(3))) * 60000;
  return t;
}
export const bingDate = (v) => { const t = bingTime(v, true); return t ? ymd(t) : ''; };

const ERR = { 3: 'API Key 无效', 4: '请求太频繁（用户限流）', 5: '请求太频繁（站点限流）', 6: '账号已被限制', 7: '网址无效', 8: '参数无效',
  11: '没有找到', 13: '不允许的操作', 14: '没有权限：站点不在这个 Bing 账号下或还没验证' };
// 限流（ThrottleUser / ThrottleHost / ThrottleIP，以及 HTTP 429）时自动等一会儿重试两次
async function call(cred, method, params, body) {
  for (let i = 0; ; i++) {
    try { return await call1(cred, method, params, body); } catch (e) {
      if (!e.throttle || e.budget || i >= 2) throw e;
      await new Promise((r) => setTimeout(r, i ? 5000 : 2000));
    }
  }
}
async function call1(cred, method, params, body) {
  const key = typeof cred === 'string' ? cred : cred.key, proxy = typeof cred === 'string' ? '' : cred.proxy || '';
  const q = new URLSearchParams({ ...(params || {}), apikey: key });
  spend();
  let res;
  try {
    res = await fetch(`${proxy || API}${method}?${q}`, body
    ? { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) }
    : { signal: AbortSignal.timeout(20000) });
  } catch (e) { throw new Error(proxy ? `连不上代理地址：${e.message}` : e.message); }
  const text = await res.text();
  let d = null;
  try { d = text ? JSON.parse(text) : null; } catch {}
  // 代理配置不对时（404、502 之类）返回的不是 Bing 的 JSON
  if (proxy && !res.ok && !d) throw new Error(`代理返回 HTTP ${res.status}，请检查代理配置`);
  if (!res.ok || d?.ErrorCode) {
    const code = d?.ErrorCode ?? 0, raw = String(d?.Message || '');
    // ThrottleIP：Bing 按来源 IP 限流（Cloudflare 的出口 IP 是共用的，偶尔会碰上），文档里没有对应的错误码
    const throttle = code === 4 || code === 5 || res.status === 429 || /throttle/i.test(raw);
    const msg = ERR[code] || (/throttleip/i.test(raw) ? 'Bing 暂时按 IP 限流' : throttle ? '请求太频繁，Bing 暂时限流' : raw.replace(/^ERROR!+\s*/, '')) || `HTTP ${res.status}`;
    throw Object.assign(new Error(msg), { code, throttle });
  }
  return d?.d ?? null;
}
export const bget = (cred, method, params) => call(cred, method, params);
export const bpost = (cred, method, body) => call(cred, method, null, body);

// ---------------------------------------------------------------- 凭据

export async function bingCreds(env, secret) {
  const s = await getSetting(env, 'int_bing');
  if (!s) return null;
  try { return await unseal(secret, s); } catch { return null; }
}

// 代理地址：必须是 https（Key 在查询参数里），统一以 / 结尾
export function normProxy(v) {
  const t = String(v || '').trim();
  if (!t) return { proxy: '' };
  let u;
  try { u = new URL(t); } catch { return { error: '代理地址格式不对，应类似 https://你的域名/bing-一串随机字符/' }; }
  if (u.protocol !== 'https:') return { error: '代理地址必须是 https（API Key 会放在请求参数里）' };
  if (u.search || u.hash) return { error: '代理地址不要带 ? 或 # 后面的部分' };
  return { proxy: u.href.endsWith('/') ? u.href : `${u.href}/` };
}

// 保存前先列一次站点，确认 Key（和代理）有效。body.proxy 不传时沿用原来的代理，传空字符串表示不用代理
export async function saveBingConfig(env, secret, body) {
  const old = await bingCreds(env, secret);
  const key = String(body.key || '').trim() || old?.key || '';
  if (!/^[0-9a-f]{32}$/i.test(key)) return { error: 'API Key 应为 32 位十六进制字符，在 Bing Webmaster Tools → 设置 → API 访问 里生成' };
  const np = body.proxy === undefined ? { proxy: old?.proxy || '' } : normProxy(body.proxy);
  if (np.error) return { error: np.error };
  const cred = { key, ...(np.proxy ? { proxy: np.proxy } : {}) };
  const keyChanged = key !== old?.key;
  let sites;
  try { sites = await bget(cred, 'GetUserSites'); } catch (e) {
    if (!e.throttle) return { error: `验证失败：${e.message}` };
    // 被限流没法验证：先保存，定时任务稍后会重新列出站点；Key 不对的话会在状态里显示错误。
    // 已知的站点保留，并带上错误标记——这样在重新列出之前，合并站点时不会把 Bing 的站点当成已经没了而删掉
    await setSetting(env, 'int_bing', await seal(secret, cred));
    const prev = await bingFound(env);
    await setSetting(env, 'bing_found', JSON.stringify({ sites: prev?.sites || [], at: 0, error: e.message, errorAt: Date.now() }));
    if (keyChanged) await env.DB.prepare(`UPDATE g_sites SET b_synced_at = 0, ${BL_RESET}`).run();
    return { ok: true, pending: true };
  }
  await setSetting(env, 'int_bing', await seal(secret, cred));
  await saveFound(env, sites || []);
  await rebuildSites(env);
  // 新 Key：所有站点重新同步
  if (keyChanged) await env.DB.prepare(`UPDATE g_sites SET b_synced_at = 0, ${BL_RESET}`).run();
  return { ok: true };
}

export async function deleteBingConfig(env) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM settings WHERE key IN ('int_bing', 'bing_found')"),
    env.DB.prepare('UPDATE g_daily SET b_clicks = NULL, b_impressions = NULL WHERE b_clicks IS NOT NULL OR b_impressions IS NOT NULL'),
    // 外链数据（src/backlinks.js）也清掉，免得之后换个账号重新填写时还显示旧的数字
    env.DB.prepare(`UPDATE g_sites SET ${BL_RESET} WHERE bl_at > 0`),
  ]);
  await rebuildSites(env);
}

export async function setBingAuto(env, on) {
  await setSetting(env, 'bing_auto', on ? '1' : '0');
}
export const bingAuto = async (env) => (await getSetting(env, 'bing_auto')) !== '0';
// 站点地图里有新网址或网页更新时，定时任务自动把站点地图重新提交给 Bing（默认开启；sm_auto 是早先 Google / Bing 共用的开关）
export const smAutoBing = async (env) => ((await getSetting(env, 'sm_auto_b')) ?? (await getSetting(env, 'sm_auto'))) !== '0';
export async function setSmAutoBing(env, on) {
  await setSetting(env, 'sm_auto_b', on ? '1' : '0');
}

// ---------------------------------------------------------------- 站点

async function saveFound(env, list, error = '') {
  const sites = list.map((s) => ({ url: s.Url, host: siteHost(s.Url), verified: !!s.IsVerified })).filter((s) => s.host);
  await setSetting(env, 'bing_found', JSON.stringify({ sites, at: Date.now(), error }));
}
export async function bingFound(env) {
  try { return JSON.parse((await getSetting(env, 'bing_found')) || 'null'); } catch { return null; }
}

export async function discover(env, secret) {
  const c = await bingCreds(env, secret);
  if (!c) return;
  try { await saveFound(env, (await bget(c, 'GetUserSites')) || []); }
  catch (e) {
    // 出错时保留上次的站点和读取时间，只记下错误（定时任务每小时会再试）
    const old = await bingFound(env);
    await setSetting(env, 'bing_found', JSON.stringify({ sites: old?.sites || [], at: old?.at || 0, error: e.message, errorAt: Date.now() }));
    return;
  }
  await rebuildSites(env);
}

export async function status(env, secret) {
  const c = await bingCreds(env, secret);
  if (!c) return { configured: false };
  const f = await bingFound(env);
  const r = await env.DB.prepare("SELECT COUNT(*) AS n, MAX(b_synced_at) AS t, SUM(b_error != '') AS bad FROM g_sites WHERE bing_site != ''").first();
  return {
    configured: true, keyTail: c.key.slice(-4), proxy: c.proxy || '', auto: await bingAuto(env), smAuto: await smAutoBing(env),
    sites: f?.sites?.length || 0, verified: f?.sites?.filter((s) => s.verified).length || 0,
    linked: r?.n || 0, lastSync: r?.t || null, siteErrors: r?.bad || 0, error: f?.error || '', discoveredAt: f?.at || null,
  };
}

// ---------------------------------------------------------------- 每日数据

// 同步一个站点：每日点击 / 展示（只写有变化的行），以及索引中的网页数（抓取统计里最新一天的 InIndex）
async function syncSite(env, key, s) {
  const stmts = [], errors = [];
  let inIndex = s.b_in_index || 0;
  try {
    const rows = (await bget(key, 'GetRankAndTrafficStats', { siteUrl: s.bing_site })) || [];
    const days = new Map();
    for (const r of rows) {
      const d = bingDate(r.Date);
      if (!d) continue;
      const o = days.get(d) || { c: 0, i: 0 };
      o.c += Number(r.Clicks) || 0; o.i += Number(r.Impressions) || 0;
      days.set(d, o);
    }
    // 首次同步写入全部（约 6 个月）；之后只比对最近 21 天（更早的数据 Bing 不会再改），省得每次读 180 行
    if (s.b_synced_at) { const cut = ymd(Date.now() - 21 * DAY); for (const d of [...days.keys()]) if (d < cut) days.delete(d); }
    const from = [...days.keys()].sort()[0];
    const old = from ? new Map((await env.DB.prepare('SELECT date, b_clicks, b_impressions FROM g_daily WHERE host = ? AND date >= ?').bind(s.host, from).all())
      .results.map((r) => [r.date, r])) : new Map();
    for (const [date, v] of days) {
      const o = old.get(date);
      if (o && o.b_clicks === v.c && o.b_impressions === v.i) continue;
      stmts.push(env.DB.prepare(
        `INSERT INTO g_daily (host, date, b_clicks, b_impressions) VALUES (?, ?, ?, ?)
         ON CONFLICT(host, date) DO UPDATE SET b_clicks = excluded.b_clicks, b_impressions = excluded.b_impressions`
      ).bind(s.host, date, v.c, v.i));
    }
  } catch (e) { if (e.throttle || e.budget) throw e; errors.push(e.message); }
  try {
    const cs = (await bget(key, 'GetCrawlStats', { siteUrl: s.bing_site })) || [];
    const last = cs.map((r) => ({ t: bingTime(r.Date), n: Number(r.InIndex) || 0 })).filter((r) => r.t).sort((a, b) => b.t - a.t)[0];
    if (last) inIndex = last.n;
  } catch (e) { if (e.throttle || e.budget) throw e; }
  const err = errors.join('；');
  if (stmts.length || err !== (s.b_error || '') || inIndex !== (s.b_in_index || 0)) stmts.push(gVerStmt(env));
  stmts.push(env.DB.prepare('UPDATE g_sites SET b_synced_at = ?, b_error = ?, b_in_index = ? WHERE host = ?').bind(Date.now(), err, inIndex, s.host));
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
}

// 定时任务：每天重新列一次站点，再同步到期的站点（12 小时一次）
export async function syncBatch(env, secret, { limit = 25, cutoff = Date.now() - 12 * 3600000, deadline = Date.now() + 60000 } = {}) {
  const c = await bingCreds(env, secret);
  if (!c) return { skipped: true };
  const f = await bingFound(env);
  if (!f || f.error || f.at < Date.now() - DAY) await discover(env, secret);
  const due = (await env.DB.prepare("SELECT host, bing_site, b_error, b_in_index, b_synced_at FROM g_sites WHERE bing_site != '' AND b_synced_at < ? ORDER BY b_synced_at LIMIT ?")
    .bind(cutoff, limit).all()).results;
  let done = 0;
  for (const s of due) {
    if (Date.now() > deadline) break;
    try { await syncSite(env, c, s); done++; } catch (e) { if (e.throttle || e.budget) break; }
  }
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM g_sites WHERE bing_site != '' AND b_synced_at < ?").bind(cutoff).first('n');
  return { done, left };
}

// ---------------------------------------------------------------- 详情页：搜索词 / 页面 / 抓取

// 按周的统计行：落在区间里的周相加；排名按展示加权
export function weekly(rows, from, to) {
  const m = new Map();
  for (const r of rows || []) {
    const d = bingDate(r.Date);
    if (!d || d < from || d > to) continue;
    const k = r.Query;
    const o = m.get(k) || { k, clicks: 0, impressions: 0, posw: 0 };
    const imp = Number(r.Impressions) || 0;
    o.clicks += Number(r.Clicks) || 0; o.impressions += imp; o.posw += (Number(r.AvgImpressionPosition) || 0) * imp;
    m.set(k, o);
  }
  // Bing 的按周数据偶尔点击比展示还多（统计口径不同），点击率封顶 100%
  return [...m.values()].map(({ posw, ...x }) => ({ ...x, ctr: x.impressions ? Math.min(1, x.clicks / x.impressions) : 0, position: x.impressions ? posw / x.impressions : 0 }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
}

// 一次拉齐详情页要的 Bing 数据（缓存 1 小时，由调用方负责）
export async function bingRaw(env, secret, site) {
  const c = await bingCreds(env, secret);
  if (!c) throw new Error('未配置 Bing API Key');
  const [queries, pages, crawl, issues] = await Promise.all([
    bget(c, 'GetQueryStats', { siteUrl: site }),
    bget(c, 'GetPageStats', { siteUrl: site }),
    bget(c, 'GetCrawlStats', { siteUrl: site }).catch(() => []),
    bget(c, 'GetCrawlIssues', { siteUrl: site }).catch(() => []),
  ]);
  const slim = (rows) => (rows || []).map((r) => ({ Query: r.Query, Date: r.Date, Clicks: r.Clicks, Impressions: r.Impressions, AvgImpressionPosition: r.AvgImpressionPosition }));
  return {
    queries: slim(queries), pages: slim(pages),
    crawl: (crawl || []).map((r) => ({ date: bingDate(r.Date), crawled: Number(r.CrawledPages) || 0, errors: Number(r.CrawlErrors) || 0, inIndex: Number(r.InIndex) || 0,
      c4xx: Number(r.Code4xx) || 0, c5xx: Number(r.Code5xx) || 0, robots: Number(r.BlockedByRobotsTxt) || 0 })).filter((r) => r.date).sort((a, b) => (a.date < b.date ? -1 : 1)),
    issues: (issues || []).slice(0, 200).map((r) => ({ url: r.Url, code: Number(r.HttpCode) || 0, issues: Number(r.Issues) || 0, inLinks: Number(r.InLinks) || 0 })),
  };
}

export function bingSummary(raw, from, to, pfrom, pto, withPrev) {
  const queries = weekly(raw.queries, from, to), pages = weekly(raw.pages, from, to);
  const prevQ = withPrev ? new Map(weekly(raw.queries, pfrom, pto).map((x) => [x.k, x])) : new Map();
  // 平均排名：用搜索词的展示加权估算（Bing 没有按天的整体排名）
  const imp = queries.reduce((a, x) => a + x.impressions, 0);
  const pimp = [...prevQ.values()].reduce((a, x) => a + x.impressions, 0);
  return {
    hasPrev: withPrev,
    position: imp ? queries.reduce((a, x) => a + x.position * x.impressions, 0) / imp : null,
    prevPosition: pimp ? [...prevQ.values()].reduce((a, x) => a + x.position * x.impressions, 0) / pimp : null,
    queries: queries.slice(0, 250).map((x) => { const p = prevQ.get(x.k); return { ...x, prevClicks: p ? p.clicks : null, prevPosition: p ? p.position : null }; }),
    pages: pages.slice(0, 100),
    crawl: raw.crawl.filter((r) => r.date >= from && r.date <= to),
    issues: raw.issues,
  };
}

// 抓取问题的位标记
export const ISSUE_BITS = [[1, '301 重定向'], [2, '302 重定向'], [4, '4xx 错误'], [8, '5xx 错误'], [16, '被 robots.txt 屏蔽'], [32, '含恶意软件'],
  [64, '重要网址被 robots.txt 屏蔽'], [128, 'DNS 错误'], [256, '超时']];

// ---------------------------------------------------------------- 收录：网址信息、提交

// 网址是否在 Bing 索引里：有抓取时间或 HTTP 状态就算已收录；“没有找到”算未收录
export async function urlInfo(key, site, url) {
  try {
    const d = await bget(key, 'GetUrlInfo', { siteUrl: site, url });
    const crawled = bingTime(d?.LastCrawledDate), status = Number(d?.HttpStatus) || 0;
    return { state: d && (crawled || status) ? 'yes' : 'no', crawled, http: status };
  } catch (e) {
    if (e.code === 11) return { state: 'no', crawled: 0, http: 0 };
    throw e;
  }
}

// 剩余提交配额（每天 / 每月）
export async function quota(key, site) {
  const d = await bget(key, 'GetUrlSubmissionQuota', { siteUrl: site });
  return { day: Number(d?.DailyQuota) || 0, month: Number(d?.MonthlyQuota) || 0 };
}

export async function submitUrls(key, site, urls) {
  for (let i = 0; i < urls.length; i += 500) await bpost(key, 'SubmitUrlBatch', { siteUrl: site, urlList: urls.slice(i, i + 500) });
}

export async function feeds(key, site) {
  const d = (await bget(key, 'GetFeeds', { siteUrl: site })) || [];
  return d.map((f) => ({ path: f.Url, type: f.Type || '', status: f.Status || '', crawled: bingTime(f.LastCrawled), submitted: bingTime(f.Submitted),
    urls: Number(f.UrlCount) || 0, size: Number(f.FileSize) || 0 }));
}
export const submitFeed = (key, site, feedUrl) => bpost(key, 'SubmitFeed', { siteUrl: site, feedUrl });
