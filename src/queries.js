// 热门搜索词：把多个站点的 Google（Search Console）和 Bing 搜索词合并到一起，按热度（展示次数）排序。
// 每个站点的搜索词单独缓存 1 小时（键里带日期，第二天自动换新）；一次请求最多现查 MAX_FETCH 个站点，
// 其余的标成“还没加载”，再打开一次就会接着查（已经查过的直接读缓存）。
import { gfetch, ranges } from './google.js';
import { bget, bingCreds, weekly } from './bing.js';

const TTL = 3600000;
const MAX_FETCH = 60;   // 每次请求最多现查的站点数（Google、Bing 各算一次），避免超过 Worker 的子请求上限
const TOP = 500;        // 返回的搜索词数
const norm = (q) => String(q || '').toLowerCase().replace(/\s+/g, ' ').trim();

// 并发执行，最多 n 个同时进行
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

async function cacheRead(env, keys) {
  const out = new Map();
  for (let i = 0; i < keys.length; i += 90) {
    const part = keys.slice(i, i + 90);
    const rows = (await env.DB.prepare(`SELECT k, v, at FROM g_cache WHERE k IN (${part.map(() => '?').join(',')})`).bind(...part).all()).results;
    for (const r of rows) if (r.at > Date.now() - TTL) { try { out.set(r.k, JSON.parse(r.v)); } catch {} }
  }
  return out;
}

// 搜索词压缩成 [词, 点击, 展示, 平均排名]，省缓存空间
const slim = (rows) => rows.filter((r) => r.impressions > 0).map((r) => [r.k, r.clicks, r.impressions, Math.round(r.position * 10) / 10]);

// kind：query = 搜索词；country = 地区（只有 Google 有：Bing 的接口不按国家 / 地区拆分搜索数据）
export async function hotQueries(env, secret, hosts, days, kind = 'query') {
  const country = kind === 'country';
  const { from, to } = ranges(days);
  const want = new Set((hosts || []).map(String));
  let sites = (await env.DB.prepare(`SELECT s.host, s.gsc_site, s.gsc_acct, s.bing_site, COALESCE(SUM(d.impressions), 0) + COALESCE(SUM(d.b_impressions), 0) AS imp
    FROM g_sites s LEFT JOIN g_daily d ON d.host = s.host AND d.date >= ? AND d.date <= ? WHERE s.gsc_site != '' OR s.bing_site != '' GROUP BY s.host`).bind(from, to).all()).results;
  if (want.size) sites = sites.filter((s) => want.has(s.host));
  // 展示多的站点先查：一次查不完时，先出来的是最重要的那部分
  sites.sort((a, b) => b.imp - a.imp);
  const jobs = [];
  for (const s of sites) {
    if (s.gsc_site) jobs.push({ s, src: 'g', key: `${country ? 'hq-gc' : 'hq-g'}|${s.gsc_site}|${days}|${to}` });
    if (s.bing_site && !country) jobs.push({ s, src: 'b', key: `hq-b|${s.bing_site}|${days}|${to}` });
  }
  const got = await cacheRead(env, jobs.map((j) => j.key));
  const todo = jobs.filter((j) => !got.has(j.key));
  const now = todo.slice(0, MAX_FETCH), later = todo.slice(MAX_FETCH);
  const errors = [], puts = [];
  const bc = now.some((j) => j.src === 'b') ? await bingCreds(env, secret).catch(() => null) : null;
  const run = async (j) => {
    try {
      let rows;
      if (j.src === 'g') {
        const d = await gfetch(env, secret, j.s.gsc_acct, `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(j.s.gsc_site)}/searchAnalytics/query`,
          { startDate: from, endDate: to, dimensions: [country ? 'country' : 'query'], rowLimit: country ? 250 : 1000, dataState: 'all' });
        // 国家 / 地区是 ISO 三位代码（小写，如 usa），统一成大写
        rows = slim((d.rows || []).map((r) => ({ k: country ? String(r.keys[0]).toUpperCase() : r.keys[0], clicks: r.clicks, impressions: r.impressions, position: r.position })));
      } else {
        if (!bc) throw new Error('未配置 Bing API Key');
        rows = slim(weekly(await bget(bc, 'GetQueryStats', { siteUrl: j.s.bing_site }), from, to));
      }
      got.set(j.key, rows);
      puts.push(env.DB.prepare('INSERT INTO g_cache (k, v, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at').bind(j.key, JSON.stringify(rows), Date.now()));
    } catch (e) {
      errors.push({ host: j.s.host, src: j.src, error: e.message || String(e) });
    }
  };
  // Bing 按 IP / 账号限流比较严，并发少一点
  await Promise.all([pool(now.filter((j) => j.src === 'g'), 8, run), pool(now.filter((j) => j.src === 'b'), 3, run)]);
  for (let i = 0; i < puts.length; i += 50) await env.DB.batch(puts.slice(i, i + 50)).catch(() => {});

  // 合并：同一个词（不分大小写、空白）在各站点、两个搜索引擎的数据加在一起；排名按展示加权
  const m = new Map();
  for (const j of jobs) {
    const rows = got.get(j.key);
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
  const loaded = (src) => jobs.filter((j) => j.src === src && got.has(j.key)).length;
  return {
    days, from, to, total: items.length, items: items.slice(0, TOP),
    sites: sites.length,
    g: { sites: jobs.filter((j) => j.src === 'g').length, loaded: loaded('g') },
    b: { sites: jobs.filter((j) => j.src === 'b').length, loaded: loaded('b') },
    pending: later.length, errors,
  };
}
