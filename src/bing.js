// ---------------------------------------------------------------- Bing Webmaster Tools
// 授权：API Key（Bing Webmaster → 设置 → API 访问），加密保存在 settings.int_bing；一个 Key 能访问该账号下所有已验证的站点。
// 站点按主域名并入 g_sites.bing_site（和 GA4 / GSC 合并显示）；每日点击 / 展示存在 g_daily.b_clicks / b_impressions。
// 接口：https://ssl.bing.com/webmaster/api.svc/json/<方法>?apikey=…；读取用 GET + 查询参数，写入用 POST + JSON；
// 返回 {"d": …}，日期是 .NET 格式 /Date(1399014000000-0700)/，出错时返回 {"ErrorCode", "Message"}。
// 搜索词 / 页面统计是按周汇总的，没有日期参数，一次返回全部（约 6 个月）。

import { seal, unseal, siteHost, rebuildSites, gVerStmt } from './google.js';

const DAY = 86400000;
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
async function call(key, method, params, body) {
  const q = new URLSearchParams({ ...(params || {}), apikey: key });
  const res = await fetch(`${API}${method}?${q}`, body
    ? { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) }
    : { signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let d = null;
  try { d = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok || d?.ErrorCode) {
    const code = d?.ErrorCode ?? 0;
    const msg = ERR[code] || d?.Message || `HTTP ${res.status}`;
    throw Object.assign(new Error(msg), { code, throttle: code === 4 || code === 5 || res.status === 429 });
  }
  return d?.d ?? null;
}
export const bget = (key, method, params) => call(key, method, params);
export const bpost = (key, method, body) => call(key, method, null, body);

// ---------------------------------------------------------------- 凭据

export async function bingCreds(env, secret) {
  const s = await getSetting(env, 'int_bing');
  if (!s) return null;
  try { return await unseal(secret, s); } catch { return null; }
}

// 保存前先列一次站点，确认 Key 有效
export async function saveBingConfig(env, secret, body) {
  const old = await bingCreds(env, secret);
  const key = String(body.key || '').trim() || old?.key || '';
  if (!/^[0-9a-f]{32}$/i.test(key)) return { error: 'API Key 应为 32 位十六进制字符，在 Bing Webmaster Tools → 设置 → API 访问 里生成' };
  let sites;
  try { sites = await bget(key, 'GetUserSites'); } catch (e) { return { error: `验证失败：${e.message}` }; }
  await setSetting(env, 'int_bing', await seal(secret, { key }));
  await saveFound(env, sites || []);
  await rebuildSites(env);
  // 新 Key：所有站点重新同步
  await env.DB.prepare('UPDATE g_sites SET b_synced_at = 0').run();
  return { ok: true };
}

export async function deleteBingConfig(env) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM settings WHERE key IN ('int_bing', 'bing_found')"),
    env.DB.prepare('UPDATE g_daily SET b_clicks = NULL, b_impressions = NULL WHERE b_clicks IS NOT NULL OR b_impressions IS NOT NULL'),
  ]);
  await rebuildSites(env);
}

export async function setBingAuto(env, on) {
  await setSetting(env, 'bing_auto', on ? '1' : '0');
}
export const bingAuto = async (env) => (await getSetting(env, 'bing_auto')) !== '0';

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
  try { await saveFound(env, (await bget(c.key, 'GetUserSites')) || []); }
  catch (e) {
    // 出错时保留上次的站点，只记下错误
    const old = await bingFound(env);
    await setSetting(env, 'bing_found', JSON.stringify({ ...(old || { sites: [] }), at: Date.now(), error: e.message }));
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
    configured: true, keyTail: c.key.slice(-4), auto: await bingAuto(env),
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
  } catch (e) { errors.push(e.message); if (e.throttle) throw e; }
  try {
    const cs = (await bget(key, 'GetCrawlStats', { siteUrl: s.bing_site })) || [];
    const last = cs.map((r) => ({ t: bingTime(r.Date), n: Number(r.InIndex) || 0 })).filter((r) => r.t).sort((a, b) => b.t - a.t)[0];
    if (last) inIndex = last.n;
  } catch (e) { if (e.throttle) throw e; }
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
  if (!f || f.at < Date.now() - DAY) await discover(env, secret);
  const due = (await env.DB.prepare("SELECT host, bing_site, b_error, b_in_index FROM g_sites WHERE bing_site != '' AND b_synced_at < ? ORDER BY b_synced_at LIMIT ?")
    .bind(cutoff, limit).all()).results;
  let done = 0;
  for (const s of due) {
    if (Date.now() > deadline) break;
    try { await syncSite(env, c.key, s); done++; } catch (e) { if (e.throttle) break; }
  }
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM g_sites WHERE bing_site != '' AND b_synced_at < ?").bind(cutoff).first('n');
  return { done, left };
}

// ---------------------------------------------------------------- 详情页：搜索词 / 页面 / 抓取

// 按周的统计行：落在区间里的周相加；排名按展示加权
function weekly(rows, from, to) {
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
  return [...m.values()].map(({ posw, ...x }) => ({ ...x, ctr: x.impressions ? x.clicks / x.impressions : 0, position: x.impressions ? posw / x.impressions : 0 }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
}

// 一次拉齐详情页要的 Bing 数据（缓存 1 小时，由调用方负责）
export async function bingRaw(env, secret, site) {
  const c = await bingCreds(env, secret);
  if (!c) throw new Error('未配置 Bing API Key');
  const [queries, pages, crawl, issues] = await Promise.all([
    bget(c.key, 'GetQueryStats', { siteUrl: site }),
    bget(c.key, 'GetPageStats', { siteUrl: site }),
    bget(c.key, 'GetCrawlStats', { siteUrl: site }).catch(() => []),
    bget(c.key, 'GetCrawlIssues', { siteUrl: site }).catch(() => []),
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
