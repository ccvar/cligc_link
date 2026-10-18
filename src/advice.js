// ---------------------------------------------------------------- 站点优化建议（只用数据库里已有的数据，不额外调用外部接口）
// 每条建议：{ rule, level: 'high' | 'mid' | 'low', impact（排序用，越大越靠前）, n: { 具体数字 } }，文字由后台页面按 rule 生成。
// 规则都有门槛（曝光、会话太少的不提醒），免得新站全是建议。
// 忽略：site_ignores(host, rule, until)，until 之前不再显示这一类建议（永久忽略记为 9e15）。
// 站点详情页另外用现查的搜索词 / 页面数据算“高曝光低点击的页面”“差一点上首页的词”（规则名 page_ctr / near_top，也能忽略）。

import { isIndexed, hasProblem } from './gindex.js';
import { contentOf, C_COLS } from './content.js';

const DAY = 86400000;
export const RULES = ['ga_stopped', 'traffic_drop', 'site_ctr', 'low_index', 'url_problems', 'sitemap_error', 'bing_low', 'no_conversion', 'stale_content', 'page_ctr', 'near_top'];
const ymd = (t) => new Date(t).toISOString().slice(0, 10);
// 各排名的大致点击率（和后台页面、AI 报告用的一致）
const G_CTR = [0, 0.28, 0.15, 0.1, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02, 0.018];
export const expCtr = (pos) => (pos < 1 ? 0.28 : pos <= 10 ? G_CTR[Math.round(pos)] : pos <= 20 ? 0.01 : 0.003);
const LEVEL = { high: 3, mid: 2, low: 1 };

// 第 a 到第 b 天前（含）的日期范围；GA4 / Search Console 的数据有一两天延迟，各规则自己跳过最近几天
const span = (a, b) => [ymd(Date.now() - b * DAY), ymd(Date.now() - a * DAY)];
const inSpan = (d, [from, to]) => d >= from && d <= to;

// 一个站点的建议（rows：这个站点最近 40 天的 g_daily；m：g_sitemaps；idx：网址检查结果按状态汇总）
export function siteRules(s, rows, m, idx) {
  const out = [];
  const sum = (sp, f) => rows.reduce((a, r) => a + (inSpan(r.date, sp) ? Number(f(r)) || 0 : 0), 0);

  // GA4 可能停了：前两周每天都有访问，最近 3 天（跳过昨天）一次会话都没有
  if (s.ga4_property && !s.error && s.synced_at > Date.now() - 2 * DAY) {
    const recent = sum(span(2, 4), (r) => r.sessions), before = sum(span(5, 18), (r) => r.sessions);
    if (recent === 0 && before >= 50) out.push({ rule: 'ga_stopped', level: 'high', impact: 1e9, n: { before, days: 14 } });
  }

  // 搜索点击下滑（Google + Bing）：最近 7 天比再前 7 天少了 30% 以上（Search Console 数据晚两三天，跳过最近 2 天）
  if (s.gsc_site || s.bing_site) {
    const clk = (r) => (Number(r.clicks) || 0) + (Number(r.b_clicks) || 0);
    const cur = sum(span(3, 9), clk), prev = sum(span(10, 16), clk);
    if (prev >= 30 && cur <= prev * 0.7) out.push({ rule: 'traffic_drop', level: cur <= prev * 0.5 ? 'high' : 'mid', impact: prev - cur, n: { cur, prev, pct: Math.round((1 - cur / prev) * 100) } });
  }

  // 整站曝光多、点击率明显低于这个排名的常见值（近 28 天，按展示加权的平均排名）
  if (s.gsc_site) {
    const sp = span(3, 30);
    const imp = sum(sp, (r) => r.impressions), clicks = sum(sp, (r) => r.clicks), posw = sum(sp, (r) => (Number(r.position) || 0) * (Number(r.impressions) || 0));
    if (imp >= 2000) {
      const pos = posw / imp, ctr = clicks / imp, e = expCtr(pos);
      if (ctr < e * 0.5) out.push({ rule: 'site_ctr', level: 'mid', impact: Math.round(imp * (e - ctr)), n: { imp, ctr, pos, exp: e, lost: Math.round(imp * (e - ctr)) } });
    }
  }

  // 收录率低：检查出结果的网址里，已编入的不到一半；附上最多的未编入原因
  if (s.gsc_site && m && m.n_done >= 20 && m.n_yes / m.n_done < 0.5) {
    const top = (idx?.reasons || []).slice(0, 3);
    out.push({ rule: 'low_index', level: m.n_yes / m.n_done < 0.2 ? 'high' : 'mid', impact: (m.n_done - m.n_yes) * 2, n: { yes: m.n_yes, done: m.n_done, urls: m.n_urls, reasons: top } });
  }

  // 有问题的网址：打不开（404、服务器错误、重定向错误……）、被 robots.txt 或 noindex 拦住
  if (idx?.problems) out.push({ rule: 'url_problems', level: idx.problems >= 10 ? 'high' : 'mid', impact: idx.problems * 10, n: { count: idx.problems } });

  // 站点地图读取失败，或者 Search Console 里一个站点地图都没有
  if (s.gsc_site && m?.at) {
    let list = [];
    try { list = JSON.parse(m.list || '[]'); } catch {}
    if (m.error) out.push({ rule: 'sitemap_error', level: 'mid', impact: 50, n: { error: String(m.error).slice(0, 200) } });
    else if (!list.length) out.push({ rule: 'sitemap_error', level: 'mid', impact: 50, n: { none: 1 } });
  }

  // Bing 收录明显比 Google 少：Bing 已检查的网址里收录不到 20%
  if (s.bing_site && m && m.nb_done >= 20 && m.nb_yes / m.nb_done < 0.2) {
    const g = m.n_done ? m.n_yes / m.n_done : null;
    if (g == null || g >= 0.5) out.push({ rule: 'bing_low', level: 'low', impact: m.nb_done - m.nb_yes, n: { yes: m.nb_yes, done: m.nb_done, g } });
  }

  // 内容很久没更新：按站点地图推测，90 天以上没有新网址、也没有网页更新，同时搜索点击在下滑（最近两周比之前两周少 15% 以上）。
  // 推测不出更新时间时，看开始观察以来是不是一直没变化（观察满 90 天才算）
  const ct = contentOf(m);
  if (ct && (s.gsc_site || s.bing_site)) {
    const last = ct.at || ct.since, days = Math.floor((Date.now() - last) / DAY);
    const clk = (r) => (Number(r.clicks) || 0) + (Number(r.b_clicks) || 0);
    const cur = sum(span(3, 16), clk), prev = sum(span(17, 30), clk);
    if (days >= 90 && prev >= 30 && cur <= prev * 0.85) {
      out.push({ rule: 'stale_content', level: cur <= prev * 0.7 ? 'mid' : 'low', impact: prev - cur,
        n: { days, at: ct.at, src: ct.src, cur, prev, pct: Math.round((1 - cur / prev) * 100) } });
    }
  }

  // 有流量没转化：近 28 天会话不少，但一次关键事件都没有（多半是 GA4 里没设置转化）
  if (s.ga4_property) {
    const sp = span(2, 29), ses = sum(sp, (r) => r.sessions), ev = sum(sp, (r) => r.key_events);
    if (ses >= 300 && ev === 0) out.push({ rule: 'no_conversion', level: 'low', impact: 10, n: { sessions: ses } });
  }
  return out;
}

const sortAdvice = (a) => a.sort((x, y) => LEVEL[y.level] - LEVEL[x.level] || y.impact - x.impact);

// 忽略中的规则：Map(host → Map(rule → until))
async function ignoresOf(env, host) {
  const rows = (await env.DB.prepare(`SELECT host, rule, until FROM site_ignores WHERE until > ?${host ? ' AND host = ?' : ''}`)
    .bind(...(host ? [Date.now(), host] : [Date.now()])).all()).results;
  const m = new Map();
  for (const r of rows) { if (!m.has(r.host)) m.set(r.host, new Map()); m.get(r.host).set(r.rule, r.until); }
  return m;
}

// 计算建议：host 为空时算全部站点（站点列表用）
export async function advice(env, host = '') {
  const w = host ? ' WHERE host = ?' : '', b = host ? [host] : [];
  const [sites, daily, maps, urls, ign] = await Promise.all([
    env.DB.prepare(`SELECT host, ga4_property, gsc_site, bing_site, error, synced_at FROM g_sites${w}`).bind(...b).all().then((r) => r.results),
    env.DB.prepare(`SELECT host, date, sessions, key_events, clicks, impressions, position, b_clicks FROM g_daily WHERE date >= ?${host ? ' AND host = ?' : ''}`)
      .bind(ymd(Date.now() - 40 * DAY), ...b).all().then((r) => r.results),
    env.DB.prepare(`SELECT host, list, error, at, n_urls, n_yes, n_done, nb_yes, nb_done, ${C_COLS} FROM g_sitemaps${w}`).bind(...b).all().then((r) => r.results),
    // 网址检查结果按状态汇总（同一组合只读一行，不把每个网址传回来）
    env.DB.prepare(`SELECT host, state, verdict, fetch, robots, indexing, COUNT(*) AS n FROM g_urls WHERE state != ''${host ? ' AND host = ?' : ''}
      GROUP BY host, state, verdict, fetch, robots, indexing`).bind(...b).all().then((r) => r.results),
    ignoresOf(env, host),
  ]);
  const byHost = (list) => { const m = new Map(); for (const r of list) { if (!m.has(r.host)) m.set(r.host, []); m.get(r.host).push(r); } return m; };
  const dm = byHost(daily), mm = new Map(maps.map((r) => [r.host, r])), um = byHost(urls);
  const out = {};
  for (const s of sites) {
    const reasons = new Map();
    let problems = 0;
    for (const u of um.get(s.host) || []) {
      if (hasProblem(u)) problems += u.n;
      else if (!isIndexed(u)) reasons.set(u.state, (reasons.get(u.state) || 0) + u.n);
    }
    const idx = { problems, reasons: [...reasons].sort((a, c) => c[1] - a[1]).map(([state, n]) => ({ state, n })) };
    const all = siteRules(s, dm.get(s.host) || [], mm.get(s.host), idx);
    const ig = ign.get(s.host) || new Map();
    const items = sortAdvice(all.filter((a) => !ig.has(a.rule)));
    if (items.length || ig.size) out[s.host] = { items, ignored: [...ig].map(([rule, until]) => ({ rule, until })) };
  }
  return out;
}

// 忽略 / 恢复：days > 0 忽略这么多天，0 = 永久，< 0 = 恢复
export async function setIgnore(env, host, rule, days) {
  if (!host || !RULES.includes(rule)) return { error: '参数不对' };
  if (days < 0) await env.DB.prepare('DELETE FROM site_ignores WHERE host = ? AND rule = ?').bind(host, rule).run();
  else await env.DB.prepare('INSERT INTO site_ignores (host, rule, until) VALUES (?, ?, ?) ON CONFLICT(host, rule) DO UPDATE SET until = excluded.until')
    .bind(host, rule, days > 0 ? Date.now() + Math.min(days, 365) * DAY : 9e15).run();
  await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('adv_ver', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(String(Date.now()), Date.now()).run();
  return { ok: true };
}

// 站点列表用：全部站点的建议，缓存在 g_cache。忽略 / 恢复、站点变化后立即重算；每小时的数据更新最多沿用一小时
export async function adviceAll(env) {
  const v = await env.DB.prepare(`SELECT (SELECT value FROM settings WHERE key = 'g_ver') AS g, (SELECT value FROM settings WHERE key = 'sites_ver') AS s,
    (SELECT value FROM settings WHERE key = 'adv_ver') AS a`).first();
  const strict = `${ymd(Date.now())}|${v?.s || 0}|${v?.a || 0}`;
  const row = await env.DB.prepare("SELECT v FROM g_cache WHERE k = 'advice'").first('v').catch(() => null);
  let hit = null;
  try { hit = row ? JSON.parse(row) : null; } catch {}
  if (hit && hit.strict === strict && (hit.g === v?.g || hit.at > Date.now() - 3600000)) return hit.data;
  const data = await advice(env);
  await env.DB.prepare("INSERT INTO g_cache (k, v, at) VALUES ('advice', ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at")
    .bind(JSON.stringify({ strict, g: v?.g, at: Date.now(), data }), Date.now()).run().catch(() => {});
  return data;
}
