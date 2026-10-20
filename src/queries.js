// 热门搜索词：把多个站点的 Google（Search Console）和 Bing 搜索词合并到一起，按热度（展示次数）排序。
// 每个站点的数据单独缓存（键不带日期），24 小时内直接用；定时任务每天把“最近 28 天”的提前查好（warmQueries），打开弹窗不用等。
// 过期的、或者早于“手动刷新”时间的，先拿旧数据显示，同时重新查：一次请求最多现查 MAX_FETCH 个，弹窗自动接着请求剩下的。
import { gfetch, ranges } from './google.js';
import { bget, bingCreds, weekly } from './bing.js';

const TTL = 24 * 3600000;
const WARM_AGE = 20 * 3600000;   // 定时任务把超过 20 小时的提前重查，用的时候总在 24 小时以内
const MAX_FETCH = 60;   // 每次请求最多现查的站点数（Google、Bing 各算一次），避免超过 Worker 的子请求上限
const TOP = 500;        // 返回的搜索词数
const norm = (q) => String(q || '').toLowerCase().replace(/\s+/g, ' ').trim();

// 并发执行，最多 n 个同时进行
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

// 读缓存：返回 键 → { v, at }（不管新旧，调用方决定要不要重查）
async function cacheRead(env, keys) {
  const out = new Map();
  for (let i = 0; i < keys.length; i += 90) {
    const part = keys.slice(i, i + 90);
    const rows = (await env.DB.prepare(`SELECT k, v, at FROM g_cache WHERE k IN (${part.map(() => '?').join(',')})`).bind(...part).all()).results;
    for (const r of rows) { try { out.set(r.k, { v: JSON.parse(r.v), at: r.at }); } catch {} }
  }
  return out;
}

// 搜索词压缩成 [词, 点击, 展示, 平均排名]，省缓存空间
const slim = (rows) => rows.filter((r) => r.impressions > 0).map((r) => [r.k, r.clicks, r.impressions, Math.round(r.position * 10) / 10]);

// 有 Search Console / Bing 的站点，展示多的在前（一次查不完时，先出来的是最重要的那部分）
async function siteRows(env, from, to) {
  const rows = (await env.DB.prepare(`SELECT s.host, s.gsc_site, s.gsc_acct, s.bing_site, COALESCE(SUM(d.impressions), 0) + COALESCE(SUM(d.b_impressions), 0) AS imp
    FROM g_sites s LEFT JOIN g_daily d ON d.host = s.host AND d.date >= ? AND d.date <= ? WHERE s.gsc_site != '' OR s.bing_site != '' GROUP BY s.host`).bind(from, to).all()).results;
  return rows.sort((a, b) => b.imp - a.imp);
}
// 每个站点要查的：Google 搜索词、Bing 搜索词（kind = query），或者 Google 的国家 / 地区（kind = country）
function jobsOf(sites, days, kind) {
  const country = kind === 'country', jobs = [];
  for (const s of sites) {
    if (s.gsc_site) jobs.push({ s, src: 'g', kind, key: `${country ? 'hq-gc' : 'hq-g'}|${s.gsc_site}|${days}` });
    if (s.bing_site && !country) jobs.push({ s, src: 'b', kind, key: `hq-b|${s.bing_site}|${days}` });
  }
  return jobs;
}
// 查一个站点，写进缓存（返回要执行的写入语句，调用方批量写）
async function fetchJob(env, secret, j, { from, to, bc }) {
  let rows;
  if (j.src === 'g') {
    const country = j.kind === 'country';
    const d = await gfetch(env, secret, j.s.gsc_acct, `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(j.s.gsc_site)}/searchAnalytics/query`,
      { startDate: from, endDate: to, dimensions: [country ? 'country' : 'query'], rowLimit: country ? 250 : 1000, dataState: 'all' });
    // 国家 / 地区是 ISO 三位代码（小写，如 usa），统一成大写
    rows = slim((d.rows || []).map((r) => ({ k: country ? String(r.keys[0]).toUpperCase() : r.keys[0], clicks: r.clicks, impressions: r.impressions, position: r.position })));
  } else {
    if (!bc) throw new Error('未配置 Bing API Key');
    rows = slim(weekly(await bget(bc, 'GetQueryStats', { siteUrl: j.s.bing_site }), from, to));
  }
  const at = Date.now();
  return { rows, at, stmt: env.DB.prepare('INSERT INTO g_cache (k, v, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at').bind(j.key, JSON.stringify(rows), at) };
}
async function runJobs(env, secret, list, ctx, onDone, onErr) {
  const puts = [];
  const run = async (j) => {
    try { const r = await fetchJob(env, secret, j, ctx); puts.push(r.stmt); onDone(j, r); }
    catch (e) { if (e.budget) throw e; onErr(j, e); }
  };
  // Bing 按 IP / 账号限流比较严，并发少一点
  await Promise.all([pool(list.filter((j) => j.src === 'g'), 8, run), pool(list.filter((j) => j.src === 'b'), 3, run)]);
  for (let i = 0; i < puts.length; i += 50) await env.DB.batch(puts.slice(i, i + 50)).catch(() => {});
}

// kind：query = 搜索词；country = 地区（只有 Google 有：Bing 的接口不按国家 / 地区拆分搜索数据）
// fresh：手动刷新的时间，早于它的缓存都重查
export async function hotQueries(env, secret, hosts, days, kind = 'query', { fresh = 0 } = {}) {
  const { from, to } = ranges(days);
  const want = new Set((hosts || []).map(String));
  let sites = await siteRows(env, from, to);
  if (want.size) sites = sites.filter((s) => want.has(s.host));
  const jobs = jobsOf(sites, days, kind);
  const got = await cacheRead(env, jobs.map((j) => j.key));
  const stale = (c) => !c || c.at < Date.now() - TTL || c.at < fresh;
  const todo = jobs.filter((j) => stale(got.get(j.key)));
  const now = todo.slice(0, MAX_FETCH), later = todo.slice(MAX_FETCH);
  const errors = [];
  const bc = now.some((j) => j.src === 'b') ? await bingCreds(env, secret).catch(() => null) : null;
  await runJobs(env, secret, now, { from, to, bc }, (j, r) => got.set(j.key, { v: r.rows, at: r.at }), (j, e) => errors.push({ host: j.s.host, src: j.src, error: e.message || String(e) }));
  // 旧数据先拿来显示（重查失败的也一样）
  const cache = new Map([...got].map(([k, c]) => [k, c.v]));
  const ats = jobs.map((j) => got.get(j.key)?.at).filter(Boolean);
  // 合并：同一个词（不分大小写、空白）在各站点、两个搜索引擎的数据加在一起；排名按展示加权
  const m = new Map();
  for (const j of jobs) {
    const rows = cache.get(j.key);
    if (!rows) continue;
    for (const [q, c, i, p] of rows) {
      const k = norm(q);
      if (!k) continue;
      let o = m.get(k);
      if (!o) m.set(k, (o = { q, g: null, b: null, hosts: new Map() }));
      const e = o[j.src] || (o[j.src] = { c: 0, i: 0, pw: 0 });
      e.c += c; e.i += i; e.pw += p * i;
      const h = o.hosts.get(j.s.host) || { g: 0, b: 0 };
      h[j.src] += i;
      o.hosts.set(j.s.host, h);
    }
  }
  const fin = (e) => (e ? { c: e.c, i: e.i, p: e.i ? Math.round((e.pw / e.i) * 10) / 10 : null } : null);
  const items = [...m.values()].map((o) => ({
    q: o.q, g: fin(o.g), b: fin(o.b),
    // 出现这个词的站点，展示多的在前（最多带 8 个，n 是总数）
    hosts: [...o.hosts.entries()].sort((a, b) => (b[1].g + b[1].b) - (a[1].g + a[1].b)).slice(0, 8).map(([h, v]) => [h, v.g, v.b]),
    n: o.hosts.size,
  })).sort((a, b) => ((b.g?.i || 0) + (b.b?.i || 0)) - ((a.g?.i || 0) + (a.b?.i || 0)) || ((b.g?.c || 0) + (b.b?.c || 0)) - ((a.g?.c || 0) + (a.b?.c || 0)));
  const loaded = (src) => jobs.filter((j) => j.src === src && cache.has(j.key)).length;
  return {
    days, from, to, total: items.length, items: items.slice(0, TOP),
    sites: sites.length,
    g: { sites: jobs.filter((j) => j.src === 'g').length, loaded: loaded('g') },
    b: { sites: jobs.filter((j) => j.src === 'b').length, loaded: loaded('b') },
    // pending：还没查的（Google、Bing 各算一次）；pendingSites：其中涉及几个站点；progress：已经有数据的 / 总共要查的
    pending: later.length, pendingSites: new Set(later.map((j) => j.s.host)).size,
    progress: { done: jobs.length - later.length - now.filter((j) => stale(got.get(j.key))).length, all: jobs.length }, errors,
    // 数据更新时间：各站点里最早、最晚的一次
    updated: ats.length ? { min: Math.min(...ats), max: Math.max(...ats) } : null,
  };
}

// 定时任务：把所有站点“最近 28 天”的搜索词和地区提前查好（超过 20 小时的重查，最旧的先查），打开弹窗时直接用
export async function warmQueries(env, secret, { limit = 40, days = 28 } = {}) {
  const { from, to } = ranges(days);
  const sites = await siteRows(env, from, to);
  const jobs = [...jobsOf(sites, days, 'query'), ...jobsOf(sites, days, 'country')];
  if (!jobs.length) return { done: 0, left: 0 };
  const got = await cacheRead(env, jobs.map((j) => j.key));
  const due = jobs.map((j) => ({ j, at: got.get(j.key)?.at || 0 })).filter((x) => x.at < Date.now() - WARM_AGE).sort((a, b) => a.at - b.at).map((x) => x.j);
  const list = due.slice(0, limit);
  const bc = list.some((j) => j.src === 'b') ? await bingCreds(env, secret).catch(() => null) : null;
  let done = 0, failed = 0;
  await runJobs(env, secret, list, { from, to, bc }, () => { done++; }, () => { failed++; });
  return { done, failed, left: due.length - list.length };
}
