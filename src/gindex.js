// ---------------------------------------------------------------- 站点地图 + 网页索引（Google Search Console + Bing Webmaster）
// Google 没有开放“网页索引”报告的接口，这里用 URL Inspection API 逐个检查网址，自己汇总出已编入 / 未编入和原因。
// 网址来源：站点地图里的网址（会读取站点地图文件，支持索引文件和 .gz），加上最近 28 天在搜索结果里出现过的页面。
// 每个站点最多检查 MAX_URLS 个网址；已编入的 7 天复查一次，其余 3 天一次。
// 配额：每个资源每天 2000 次、每分钟 600 次，这里每天最多用 QUOTA 次；定时任务每次最多查 RUN_LIMIT 个。
// Bing：同一份网址清单用 GetUrlInfo 检查是否收录（逐个查，每小时约 36 个；已收录的 30 天复查，未收录的 7 天），没收录的按每天的提交配额自动提交（可在设置里关掉）。
// 只关联了 Bing 的站点也能用：站点地图来自 Bing 的 GetFeeds 或网站根目录的 /sitemap.xml。

import { gfetch, canSubmit } from './google.js';
import * as bing from './bing.js';
import { spend } from './budget.js';

const DAY = 86400000, HOUR = 3600000;
// 定时任务每次：刷新 SITEMAP_PER_RUN 个站点的站点地图（约 100 秒），再用 G_BUDGET 检查最多 RUN_LIMIT 个 Google 网址（两者各算各的时间）
const MAX_URLS = 500, QUOTA = 1800, RUN_LIMIT = 400, SITEMAP_PER_RUN = 8, CONCURRENCY = 8, G_BUDGET = 120000;
// Bing 的 GetUrlInfo 限流很严（实测约每分钟 10 次），只能逐个、间隔 B_GAP 查；定时任务每次给它 B_BUDGET
const B_RUN_LIMIT = 40, B_GAP = 6500, B_BUDGET = 240000, B_AUTO_MAX = 100, NEVER = 9e15;
const ymd = (t) => new Date(t).toISOString().slice(0, 10);
const API = 'https://www.googleapis.com/webmasters/v3/sites/';

// 汇总一个站点的已编入 / 已检查数，存进 g_sitemaps（站点列表直接读这几列，不用扫 g_urls）
const INDEXED_SQL = "(verdict = 'PASS' OR state LIKE 'Submitted and indexed%' OR state LIKE 'Indexed%')";
const recountStmt = (env, host) => env.DB.prepare(
  `UPDATE g_sitemaps SET (n_urls, n_yes, n_done, nb_yes, nb_done) = (SELECT COUNT(*), COALESCE(SUM(state != '' AND ${INDEXED_SQL}), 0), COALESCE(SUM(state != ''), 0),
     COALESCE(SUM(b_state = 'yes'), 0), COALESCE(SUM(b_state IN ('yes', 'no')), 0)
     FROM g_urls WHERE host = ?) WHERE host = ?`
).bind(host, host);

// 增量更新计数（检查一批网址后用，不用再扫这个站点的全部网址）
const bumpStmt = (env, host, d) => env.DB.prepare(
  `UPDATE g_sitemaps SET n_yes = MAX(0, n_yes + ?), n_done = MAX(0, n_done + ?), nb_yes = MAX(0, nb_yes + ?), nb_done = MAX(0, nb_done + ?) WHERE host = ?`
).bind(d.yes || 0, d.done || 0, d.byes || 0, d.bdone || 0, host);
const addDelta = (m, host, k, v) => { if (!v) return; const d = m.get(host) || {}; d[k] = (d[k] || 0) + v; m.set(host, d); };
// 一个站点停下时，把它剩下的到期网址整体往后推，免得一直占着队首、拖住其他站点
const deferStmt = (env, host, col, until) => env.DB.prepare(`UPDATE g_urls SET ${col} = ? WHERE host = ? AND ${col} <= ?`).bind(until, host, Date.now());

// 已编入：Submitted and indexed / Indexed, not submitted in sitemap / Indexed, though blocked by robots.txt
export const isIndexed = (r) => r.verdict === 'PASS' || /^(submitted and )?indexed\b/i.test(r.state || '');
// 需要修的问题：抓取失败、被 robots.txt 屏蔽、noindex
const BAD_FETCH = new Set(['SOFT_404', 'BLOCKED_ROBOTS_TXT', 'NOT_FOUND', 'ACCESS_DENIED', 'SERVER_ERROR', 'REDIRECT_ERROR', 'ACCESS_FORBIDDEN', 'BLOCKED_4XX', 'INTERNAL_CRAWL_ERROR', 'INVALID_URL']);
export const hasProblem = (r) => BAD_FETCH.has(r.fetch) || r.robots === 'DISALLOWED' || /^BLOCKED_BY/.test(r.indexing || '');

// 网址是否属于这个 Search Console 资源
export function inProperty(url, site) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  if (site.startsWith('sc-domain:')) {
    const d = site.slice(10).toLowerCase(), h = u.hostname.toLowerCase();
    return h === d || h.endsWith('.' + d);
  }
  return url.startsWith(site);
}

// 从站点地图 XML 里取 <loc>；返回 { index: 是否为索引文件, locs }
export function parseSitemap(xml) {
  const locs = [];
  const re = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) {
    locs.push(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
  }
  return { index: /<sitemapindex[\s>]/i.test(xml), locs };
}

// 站点地图最多读 MAX_BYTES（解压后），超过就只用已读到的部分，避免超大文件或压缩炸弹撑爆内存
const MAX_BYTES = 8 * 1024 * 1024;
async function readCapped(stream) {
  const reader = stream.getReader(), parts = [];
  let total = 0, cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) { parts.push(value.slice(0, value.byteLength - (total - MAX_BYTES))); cut = true; await reader.cancel().catch(() => {}); break; }
    parts.push(value);
  }
  const buf = new Uint8Array(Math.min(total, MAX_BYTES));
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.byteLength; }
  return { buf, cut };
}
async function fetchText(url) {
  spend();
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; cligc-link sitemap reader)', accept: 'application/xml,text/xml,*/*' }, signal: AbortSignal.timeout(10000), redirect: 'follow' });
  if (!res.ok) { res.body?.cancel().catch(() => {}); throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status }); }
  if (!res.body) return '';
  // 先看前两个字节判断是不是 .gz（服务器没按 Content-Encoding 解压时）
  const [a, b] = res.body.tee();
  const head = await a.getReader().read().then((r) => r.value || new Uint8Array());
  a.cancel().catch(() => {});
  const gz = head[0] === 0x1f && head[1] === 0x8b;
  const { buf } = await readCapped(gz ? b.pipeThrough(new DecompressionStream('gzip')) : b);
  return new TextDecoder().decode(buf);
}

// 读取站点地图里的网址：索引文件最多再读 20 个子站点地图
async function sitemapUrls(paths, site) {
  const out = new Set(), errors = [];
  const queue = [...paths], seen = new Set();
  let fetched = 0;
  while (queue.length && fetched < 21 && out.size < MAX_URLS * 2) {
    const p = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p); fetched++;
    try {
      const { index, locs } = parseSitemap(await fetchText(p));
      // 索引文件里的子站点地图也必须属于这个站点
      if (index) queue.push(...locs.filter((u) => inProperty(u, site)));
      else for (const u of locs) if (inProperty(u, site)) out.add(u);
    } catch (e) { errors.push(`${p}：${e.message}`); }
  }
  return { urls: [...out], errors };
}

const n = (v) => Number(v) || 0;
const t = (v) => (v ? Date.parse(v) || 0 : 0);
function sitemapOut(x) {
  const c = x.contents || [];
  return { path: x.path, type: x.type || '', index: !!x.isSitemapsIndex, pending: !!x.isPending,
    submitted: t(x.lastSubmitted), downloaded: t(x.lastDownloaded), errors: n(x.errors), warnings: n(x.warnings),
    urls: c.reduce((a, b) => a + n(b.submitted), 0) };
}
const hasG = (s) => !!(s.gsc_site && s.gsc_acct);
// 网址归属：有 GSC 时按 GSC 资源；只有 Bing 时按主域名（含子域名）
const prop = (s) => (hasG(s) ? s.gsc_site : `sc-domain:${s.host}`);
// 没提交过站点地图的资源，看看网站根目录有没有 /sitemap.xml（标为“未提交”，可以一键提交）
const origin = (s) => (hasG(s) && !s.gsc_site.startsWith('sc-domain:') ? s.gsc_site.replace(/\/$/, '') : s.bing_site ? s.bing_site.replace(/\/$/, '') : `https://${s.host}`);
const today = () => ymd(Date.now());

// 刷新一个站点的站点地图列表和网址清单（只写有变化的行）；auto = true（只有定时任务这样调用）且 Bing 开着自动提交时顺便提交
export async function refreshSite(env, secret, s, bkey, { auto = false } = {}) {
  const now = Date.now(), errs = [];
  const old = await env.DB.prepare('SELECT list, b_feeds, g_on, b_on FROM g_sitemaps WHERE host = ?').bind(s.host).first();
  // 先记下这次刷新的时间：万一读到一半出事（比如超大的站点地图），这个站点今天不会被反复重试
  await env.DB.prepare('INSERT INTO g_sitemaps (host, at) VALUES (?, ?) ON CONFLICT(host) DO UPDATE SET at = excluded.at').bind(s.host, now).run();
  let list = [], bfeeds = null, berr = '', unsure = false;
  if (hasG(s)) {
    try {
      const d = await gfetch(env, secret, s.gsc_acct, `${API}${encodeURIComponent(s.gsc_site)}/sitemaps`);
      list = (d.sitemap || []).map(sitemapOut);
    } catch (e) {
      if (e.budget) throw e;
      errs.push(`站点地图：${e.message}`);
      list = old ? JSON.parse(old.list || '[]').filter((x) => !x.local) : [];
    }
  }
  if (s.bing_site && bkey) {
    try { bfeeds = await bing.feeds(bkey, s.bing_site); } catch (e) { if (e.budget) throw e; berr = `Bing 站点地图：${e.message}`; unsure = true; }
  }
  const bf = bfeeds ?? (old ? JSON.parse(old.b_feeds || '[]') : []);
  let paths = [...new Set([...list.map((x) => x.path), ...bf.map((x) => x.path)])];
  if (!paths.length) {
    const guess = `${origin(s)}/sitemap.xml`;
    try {
      const { locs } = parseSitemap(await fetchText(guess));
      if (locs.length) { list.push({ path: guess, local: true, urls: locs.length }); paths = [guess]; }
    } catch (e) {
      if (e.budget) throw e;
      // 404 / 410 说明确实没有；其他错误（超时、5xx）说不准，不能据此删网址
      if (e.status !== 404 && e.status !== 410) unsure = true;
    }
  }
  const sm = paths.length ? await sitemapUrls(paths, prop(s)) : { urls: [], errors: [] };
  if (sm.errors.length) errs.push(`读取站点地图失败：${sm.errors.slice(0, 2).join('；')}`);
  // 最近 28 天在 Google 搜索结果里出现过的页面
  let pages = [];
  if (hasG(s)) {
    try {
      const d = await gfetch(env, secret, s.gsc_acct, `${API}${encodeURIComponent(s.gsc_site)}/searchAnalytics/query`, {
        startDate: ymd(now - 29 * DAY), endDate: ymd(now - DAY), dimensions: ['page'], rowLimit: MAX_URLS, dataState: 'all',
      });
      pages = (d.rows || []).map((r) => r.keys[0]).filter((u) => inProperty(u, s.gsc_site));
    } catch (e) { if (e.budget) throw e; errs.push(`搜索页面：${e.message}`); }
  }

  // 合并：站点地图优先，总数不超过 MAX_URLS
  const want = new Map();
  const inSm = new Set(sm.urls), inSc = new Set(pages);
  for (const u of [...sm.urls, ...pages]) {
    if (want.size >= MAX_URLS) break;
    if (!want.has(u)) want.set(u, (inSm.has(u) ? 1 : 0) | (inSc.has(u) ? 2 : 0));
  }
  const have = new Map((await env.DB.prepare('SELECT url, src FROM g_urls WHERE host = ?').bind(s.host).all()).results.map((r) => [r.url, r.src]));
  const stmts = [];
  // 拿不到网址、又有出错或说不准的时候不删旧数据（免得一次接口抖动就丢掉收录状态和提交记录）
  const reliable = want.size > 0 || (!errs.length && !unsure);
  // 没关联的一边不排检查（NEVER）；之后关联上了再放开
  const gOn = hasG(s) ? 1 : 0, bOn = s.bing_site ? 1 : 0;
  const gDue = gOn ? 0 : NEVER, bDue = bOn ? 0 : NEVER;
  let changed = 0;
  for (const [u, src] of want) {
    if (!have.has(u)) { stmts.push(env.DB.prepare('INSERT INTO g_urls (host, url, src, due_at, b_due_at) VALUES (?, ?, ?, ?, ?)').bind(s.host, u, src, gDue, bDue)); changed++; }
    else if (have.get(u) !== src) stmts.push(env.DB.prepare('UPDATE g_urls SET src = ? WHERE host = ? AND url = ?').bind(src, s.host, u));
  }
  if (reliable) for (const u of have.keys()) if (!want.has(u)) { stmts.push(env.DB.prepare('DELETE FROM g_urls WHERE host = ? AND url = ?').bind(s.host, u)); changed++; }
  // 关联状态变了才调整已有网址的排期（平时不用整站扫一遍）
  if (have.size && old?.g_on !== gOn) {
    stmts.push(gOn ? env.DB.prepare('UPDATE g_urls SET due_at = 0 WHERE host = ? AND due_at >= ?').bind(s.host, NEVER)
      : env.DB.prepare('UPDATE g_urls SET due_at = ? WHERE host = ? AND due_at < ?').bind(NEVER, s.host, NEVER));
  }
  if (have.size && old?.b_on !== bOn) {
    stmts.push(bOn ? env.DB.prepare('UPDATE g_urls SET b_due_at = 0 WHERE host = ? AND b_due_at >= ?').bind(s.host, NEVER)
      : env.DB.prepare('UPDATE g_urls SET b_due_at = ? WHERE host = ? AND b_due_at < ?').bind(NEVER, s.host, NEVER));
  }
  stmts.push(env.DB.prepare(
    `UPDATE g_sitemaps SET list = ?, urls = ?, error = ?, at = ?, b_feeds = ?, b_error = ?, g_on = ?, b_on = ? WHERE host = ?`
  ).bind(JSON.stringify(list), sm.urls.length, errs.join('；'), now, JSON.stringify(bf), berr, gOn, bOn, s.host));
  // 网址有增删时才整站重新计数；平时检查结果用增量更新
  if (changed || !old) stmts.push(recountStmt(env, s.host));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  if (auto && s.bing_site && bkey && await bing.bingAuto(env)) {
    await bingSubmit(env, bkey, s, { limit: B_AUTO_MAX }).catch(async (e) => {
      if (e.budget) return;
      // 提交失败（多半是配额不够）：今天不再试，并把原因记下来
      await env.DB.prepare('UPDATE g_sitemaps SET b_quota = 0, b_quota_at = ?, b_error = ? WHERE host = ?').bind(Date.now(), `自动提交失败：${String(e.message).slice(0, 150)}`, s.host).run();
    });
  }
  return { urls: want.size, added: [...want.keys()].filter((u) => !have.has(u)).length };
}

// ---------------------------------------------------------------- Google：网址检查

// 检查一个网址；返回要写回的字段
async function inspectOne(env, secret, s, url) {
  const d = await gfetch(env, secret, s.gsc_acct, 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
    inspectionUrl: url, siteUrl: s.gsc_site, languageCode: 'en-US',
  });
  const r = d.inspectionResult?.indexStatusResult || {};
  const canon = r.googleCanonical && r.googleCanonical !== url ? r.googleCanonical : '';
  const row = { state: r.coverageState || '', verdict: r.verdict || '', fetch: r.pageFetchState || '', robots: r.robotsTxtState || '',
    indexing: r.indexingState || '', canon, crawled_at: t(r.lastCrawlTime), error: '' };
  // 已编入的 7 天后复查，其余 3 天；加一点随机，避免同一批网址总挤在同一个小时
  row.due_at = Date.now() + (isIndexed(row) ? 7 : 3) * DAY + Math.floor(Math.random() * 12 * HOUR);
  return row;
}
const saveStmt = (env, host, url, r) => env.DB.prepare(
  `UPDATE g_urls SET state = ?, verdict = ?, fetch = ?, robots = ?, indexing = ?, canon = ?, crawled_at = ?, error = ?, checked_at = ?, due_at = ?
   WHERE host = ? AND url = ?`
).bind(r.state, r.verdict, r.fetch, r.robots, r.indexing, r.canon, r.crawled_at, r.error, Date.now(), r.due_at, host, url);

// 一条查询最多绑定 100 个参数（D1 的限制），站点多时分批查
async function quotaOf(env, hosts) {
  const day = today(), out = new Map();
  for (let i = 0; i < hosts.length; i += 90) {
    const part = hosts.slice(i, i + 90);
    const rs = (await env.DB.prepare(`SELECT host, q_day, q_n FROM g_sitemaps WHERE host IN (${part.map(() => '?').join(',')})`).bind(...part).all()).results;
    for (const q of rs) out.set(q.host, q.q_day === day ? q.q_n : 0);
  }
  return out;
}
// 到期网址：rows 里带上旧的检查结果（state / verdict / b_state），用来增量更新计数
const ROW_COLS = 'u.host, u.url, u.state, u.verdict, u.b_state';

// 检查一批网址，按站点控制当天配额；deadline 之后不再发新请求
async function inspectRows(env, secret, sites, rows, deadline) {
  const day = today();
  const quota = await quotaOf(env, [...new Set(rows.map((r) => r.host))]);
  const used = new Map(), stop = new Map(), delta = new Map(), stmts = [];
  let done = 0, failed = 0, i = 0, halt = false;
  const worker = async () => {
    while (i < rows.length && Date.now() < deadline && !halt) {
      const row = rows[i++], { host, url } = row;
      const s = sites.get(host);
      if (!s || !hasG(s) || stop.has(host)) continue;
      if ((quota.get(host) || 0) + (used.get(host) || 0) >= QUOTA) { stop.set(host, 'quota'); continue; }
      used.set(host, (used.get(host) || 0) + 1);
      try {
        const r = await inspectOne(env, secret, s, url);
        stmts.push(saveStmt(env, host, url, r));
        addDelta(delta, host, 'yes', (isIndexed(r) ? 1 : 0) - (row.state && isIndexed(row) ? 1 : 0));
        addDelta(delta, host, 'done', (r.state ? 1 : 0) - (row.state ? 1 : 0));
        done++;
      } catch (e) {
        if (e.budget) { halt = true; used.set(host, used.get(host) - 1); break; }   // 外部请求数到上限：直接停，不写
        if (e.quota) { stop.set(host, 'quota'); continue; }   // 配额用完：这个站点今天先停，下次再查
        failed++;
        // 其他错误（无权限、网址不属于资源等）：记下来，一天后再试
        stmts.push(env.DB.prepare('UPDATE g_urls SET error = ?, checked_at = ?, due_at = ? WHERE host = ? AND url = ?')
          .bind(String(e.message).slice(0, 200), Date.now(), Date.now() + DAY, host, url));
        // 账号对这个资源没有权限：后面的网址也一样会失败，这个站点先停
        if (/do not own|permission|not part of this property/i.test(e.message)) stop.set(host, 'perm');
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  for (const [host, k] of used) {
    if (!k) continue;
    stmts.push(env.DB.prepare(
      `INSERT INTO g_sitemaps (host, q_day, q_n) VALUES (?, ?, ?)
       ON CONFLICT(host) DO UPDATE SET q_n = CASE WHEN q_day = excluded.q_day THEN q_n + excluded.q_n ELSE excluded.q_n END, q_day = excluded.q_day`
    ).bind(host, day, k));
  }
  for (const [host, d] of delta) stmts.push(bumpStmt(env, host, d));
  // 停下的站点：剩下到期的网址整体往后推（配额用完推到明天，没权限推一天）
  for (const [host, why] of stop) stmts.push(deferStmt(env, host, 'due_at', why === 'quota' ? Date.parse(`${day}T08:00:00Z`) + DAY : Date.now() + DAY));
  for (let j = 0; j < stmts.length; j += 50) await env.DB.batch(stmts.slice(j, j + 50));
  return { done, failed };
}

// ---------------------------------------------------------------- Bing：收录检查、提交

async function bingRows(env, key, sites, rows, deadline) {
  const stop = new Set(), delta = new Map(), stmts = [];
  let done = 0, failed = 0, last = 0;
  for (const row of rows) {
    const { host, url } = row;
    const s = sites.get(host);
    if (!s?.bing_site || stop.has(host)) continue;
    // 逐个查，两次请求至少间隔 B_GAP
    const wait = last + B_GAP - Date.now();
    if (Date.now() + Math.max(0, wait) > deadline) break;
    if (wait > 0 && last) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    try {
      const r = await bing.urlInfo(key, s.bing_site, url);
      const due = Date.now() + (r.state === 'yes' ? 30 : 7) * DAY + Math.floor(Math.random() * DAY);
      stmts.push(env.DB.prepare("UPDATE g_urls SET b_state = ?, b_crawled_at = ?, b_checked_at = ?, b_due_at = ?, b_error = '' WHERE host = ? AND url = ?")
        .bind(r.state, r.crawled, Date.now(), due, host, url));
      const was = row.b_state || '';
      addDelta(delta, host, 'byes', (r.state === 'yes' ? 1 : 0) - (was === 'yes' ? 1 : 0));
      addDelta(delta, host, 'bdone', 1 - (was === 'yes' || was === 'no' ? 1 : 0));
      done++;
    } catch (e) {
      if (e.throttle || e.budget) break;   // 被限流或外部请求数到上限：这一轮停下，下次再查
      failed++;
      stmts.push(env.DB.prepare("UPDATE g_urls SET b_state = CASE WHEN b_state = '' THEN 'err' ELSE b_state END, b_error = ?, b_checked_at = ?, b_due_at = ? WHERE host = ? AND url = ?")
        .bind(String(e.message).slice(0, 200), Date.now(), Date.now() + DAY, host, url));
      // Key 无效或站点没有权限：这个站点剩下的网址一天后再查
      if (e.code === 14 || e.code === 3) { stop.add(host); stmts.push(deferStmt(env, host, 'b_due_at', Date.now() + DAY)); }
    }
  }
  for (const [host, d] of delta) stmts.push(bumpStmt(env, host, d));
  for (let j = 0; j < stmts.length; j += 50) await env.DB.batch(stmts.slice(j, j + 50));
  return { done, failed };
}

// 提交到 Bing：urls 不传时提交“未收录、30 天内没提交过”的网址（新网址也算），不超过当天剩余配额和 limit
export async function bingSubmit(env, key, s, { urls, limit = 500 } = {}) {
  const m = await env.DB.prepare('SELECT b_quota, b_quota_at FROM g_sitemaps WHERE host = ?').bind(s.host).first();
  let left = m && m.b_quota >= 0 && ymd(m.b_quota_at) === today() ? m.b_quota : await bing.quota(key, s.bing_site).then((q) => Math.min(q.day, q.month || q.day));
  let list = urls;
  if (!list) {
    list = (await env.DB.prepare(`SELECT url FROM g_urls WHERE host = ? AND b_state != 'yes' AND b_submitted_at < ?
      ORDER BY b_state = 'no' DESC, src & 1 DESC, url LIMIT ?`).bind(s.host, Date.now() - 30 * DAY, Math.max(0, Math.min(left, limit))).all()).results.map((r) => r.url);
  } else list = list.slice(0, Math.max(0, left));
  if (list.length) await bing.submitUrls(key, s.bing_site, list);
  left = Math.max(0, left - list.length);
  const now = Date.now(), stmts = [env.DB.prepare(
    `INSERT INTO g_sitemaps (host, b_quota, b_quota_at) VALUES (?, ?, ?) ON CONFLICT(host) DO UPDATE SET b_quota = excluded.b_quota, b_quota_at = excluded.b_quota_at`
  ).bind(s.host, left, now)];
  for (const u of list) stmts.push(env.DB.prepare('UPDATE g_urls SET b_submitted_at = ? WHERE host = ? AND url = ?').bind(now, s.host, u));
  for (let j = 0; j < stmts.length; j += 50) await env.DB.batch(stmts.slice(j, j + 50));
  return { submitted: list.length, quota: left };
}

// ---------------------------------------------------------------- 定时任务

const idxSites = async (env, host) => new Map((await env.DB.prepare(
  `SELECT host, gsc_site, gsc_acct, bing_site FROM g_sites WHERE ((gsc_site != '' AND gsc_acct != '') OR bing_site != '')${host ? ' AND host = ?' : ''}`
).bind(...(host ? [host] : [])).all()).results.map((s) => [s.host, s]));
// Bing 的凭据 { key, proxy }；没配置时为 null
const bingKey = async (env, secret) => (await bing.bingCreds(env, secret)) || null;

// 刷新几个站点的站点地图，再检查一批到期的网址（Google 和 Bing 各一批）
export async function cronBatch(env, secret, { budgetMs = 100000, inspectBudget = G_BUDGET, bingBudget = B_BUDGET, autoSubmit = true } = {}) {
  const deadline = Date.now() + budgetMs, margin = Math.min(40000, budgetMs / 2);
  const sites = await idxSites(env);
  if (!sites.size) return { skipped: true };
  const bkey = await bingKey(env, secret);
  const stale = (await env.DB.prepare(
    `SELECT s.host FROM g_sites s LEFT JOIN g_sitemaps m ON m.host = s.host
     WHERE ((s.gsc_site != '' AND s.gsc_acct != '') OR s.bing_site != '') AND COALESCE(m.at, 0) < ? ORDER BY COALESCE(m.at, 0) LIMIT ?`
  ).bind(Date.now() - DAY, SITEMAP_PER_RUN).all()).results;
  let refreshed = 0;
  for (const { host } of stale) {
    if (Date.now() > deadline - margin) break;
    try { await refreshSite(env, secret, sites.get(host), bkey, { auto: autoSubmit }); refreshed++; } catch (e) { if (e.budget) break; console.error('sitemap refresh', host, e); }
  }
  // 只取还关联着 GSC / Bing 的站点的网址（解除关联的不占队列）
  const due = (await env.DB.prepare(`SELECT ${ROW_COLS} FROM g_urls u JOIN g_sites s ON s.host = u.host
    WHERE u.due_at <= ? AND s.gsc_site != '' AND s.gsc_acct != '' ORDER BY u.due_at LIMIT ?`).bind(Date.now(), RUN_LIMIT).all()).results;
  // 网址检查有自己的时间预算，不被前面刷新站点地图用掉（之前共用时每小时只查得到几十个）
  const g = due.length ? await inspectRows(env, secret, sites, due, Date.now() + inspectBudget) : { done: 0, failed: 0 };
  let b = { done: 0, failed: 0 };
  if (bkey) {
    const bdue = (await env.DB.prepare(`SELECT ${ROW_COLS} FROM g_urls u JOIN g_sites s ON s.host = u.host
      WHERE u.b_due_at <= ? AND s.bing_site != '' ORDER BY u.b_due_at LIMIT ?`).bind(Date.now(), B_RUN_LIMIT).all()).results;
    if (bdue.length) b = await bingRows(env, bkey, sites, bdue, Date.now() + bingBudget);
  }
  return { refreshed, inspected: g.done, failed: g.failed, bing: b.done, bingFailed: b.failed };
}

// ---------------------------------------------------------------- 后台接口

export async function siteIndex(env, secret, host) {
  const s = (await idxSites(env, host)).get(host);
  if (!s) return { error: '该站点没有关联 Search Console 或 Bing' };
  let m = await env.DB.prepare('SELECT * FROM g_sitemaps WHERE host = ?').bind(host).first();
  // 第一次打开：先把站点地图和网址清单拉下来
  if (!m?.at) { await refreshSite(env, secret, s, await bingKey(env, secret)); m = await env.DB.prepare('SELECT * FROM g_sitemaps WHERE host = ?').bind(host).first(); }
  const urls = (await env.DB.prepare(`SELECT url, src, state, verdict, fetch, robots, indexing, canon, crawled_at, checked_at, error,
    b_state, b_crawled_at, b_checked_at, b_submitted_at, b_error FROM g_urls WHERE host = ?`).bind(host).all()).results;
  const email = hasG(s) ? await env.DB.prepare('SELECT email FROM g_accounts WHERE id = ?').bind(s.gsc_acct).first('email') : '';
  return {
    host, google: hasG(s), site: s.gsc_site || '', email: email || '', canSubmit: hasG(s) ? await canSubmit(env, secret, s.gsc_acct) : false,
    sitemaps: m ? JSON.parse(m.list || '[]') : [], sitemapUrls: m?.urls || 0, refreshedAt: m?.at || 0, issues: m?.error || '',
    quota: m?.q_day === today() ? m.q_n : 0, quotaMax: QUOTA, maxUrls: MAX_URLS,
    bing: s.bing_site ? {
      site: s.bing_site, feeds: JSON.parse(m?.b_feeds || '[]'), issues: m?.b_error || '', auto: await bing.bingAuto(env),
      quota: m && m.b_quota >= 0 && ymd(m.b_quota_at) === today() ? m.b_quota : null,
    } : null,
    urls: urls.map((r) => ({ url: r.url, src: r.src, state: r.state, fetch: r.fetch, robots: r.robots, indexing: r.indexing, canon: r.canon,
      crawledAt: r.crawled_at || null, checkedAt: r.checked_at || null, error: r.error, indexed: r.checked_at && r.state ? isIndexed(r) : null, problem: hasProblem(r),
      b: r.b_state || '', bCrawledAt: r.b_crawled_at || null, bCheckedAt: r.b_checked_at || null, bSubmittedAt: r.b_submitted_at || null, bError: r.b_error || '' })),
  };
}

// “立即检查”：刷新站点地图，再检查这个站点里还没查过或已到期的网址（Google 最多 limit 个；Bing 限流严，20 秒内只能查几个）
export async function checkNow(env, secret, host, { limit = 60 } = {}) {
  const s = (await idxSites(env, host)).get(host);
  if (!s) return { error: '该站点没有关联 Search Console 或 Bing' };
  const bkey = await bingKey(env, secret);
  await refreshSite(env, secret, s, bkey);
  const sites = new Map([[host, s]]), deadline = Date.now() + 20000;
  const [g, b] = await Promise.all([
    hasG(s) ? env.DB.prepare(`SELECT ${ROW_COLS} FROM g_urls u WHERE host = ? AND due_at <= ? ORDER BY due_at LIMIT ?`).bind(host, Date.now(), limit).all()
      .then(({ results }) => (results.length ? inspectRows(env, secret, sites, results, deadline) : { done: 0, failed: 0 })) : { done: 0, failed: 0 },
    s.bing_site && bkey ? env.DB.prepare(`SELECT ${ROW_COLS} FROM g_urls u WHERE host = ? AND b_due_at <= ? ORDER BY b_due_at LIMIT 4`).bind(host, Date.now()).all()
      .then(({ results }) => (results.length ? bingRows(env, bkey, sites, results, deadline) : { done: 0, failed: 0 })) : { done: 0, failed: 0 },
  ]);
  const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM g_urls WHERE host = ? AND (due_at <= ? OR b_due_at <= ?)').bind(host, Date.now(), Date.now()).first('n');
  return { done: g.done + b.done, failed: g.failed + b.failed, left };
}

// 单个网址立即重新检查（which: google / bing）
export async function inspectUrl(env, secret, host, url, which = 'google') {
  const s = (await idxSites(env, host)).get(host);
  if (!s) return { error: '该站点没有关联 Search Console 或 Bing' };
  const ex = await env.DB.prepare(`SELECT ${ROW_COLS} FROM g_urls u WHERE host = ? AND url = ?`).bind(host, url).first();
  if (!ex) return { error: '网址不在检查列表里' };
  const sites = new Map([[host, s]]);
  if (which === 'bing') {
    const bkey = await bingKey(env, secret);
    if (!s.bing_site) return { error: '该站点没有关联 Bing' };
    if (!bkey) return { error: '未配置 Bing API Key（设置 → Bing Webmaster）' };
    const { done } = await bingRows(env, bkey, sites, [ex], Date.now() + 20000);
    if (!done) return { error: (await env.DB.prepare('SELECT b_error FROM g_urls WHERE host = ? AND url = ?').bind(host, url).first('b_error')) || 'Bing 暂时限流，稍后再试' };
    return { ok: true };
  }
  if (!hasG(s)) return { error: '该站点没有关联 Search Console' };
  const { done } = await inspectRows(env, secret, sites, [ex], Date.now() + 20000);
  if (!done) {
    const e = await env.DB.prepare('SELECT error FROM g_urls WHERE host = ? AND url = ?').bind(host, url).first('error');
    return { error: e || '今天的检查配额已用完，明天再试' };
  }
  return { ok: true };
}

// 提交（或重新提交）站点地图到 Google；需要 webmasters 写权限
export async function submitSitemap(env, secret, host, path) {
  const s = (await idxSites(env, host)).get(host);
  if (!s || !hasG(s)) return { error: '该站点没有关联 Search Console' };
  if (!inProperty(path, s.gsc_site)) return { error: '站点地图地址不属于这个 Search Console 资源' };
  if (!(await canSubmit(env, secret, s.gsc_acct))) return { error: '这个 Google 账号还没授予提交权限，请到 设置 → Google 集成 重新连接', reauth: true };
  try {
    await gfetch(env, secret, s.gsc_acct, `${API}${encodeURIComponent(s.gsc_site)}/sitemaps/${encodeURIComponent(path)}`, undefined, 'PUT');
  } catch (e) {
    return { error: /insufficient|permission|scope/i.test(e.message) ? `没有提交权限：${e.message}` : e.message };
  }
  await refreshSite(env, secret, s, await bingKey(env, secret));
  return { ok: true };
}

// 提交站点地图到 Bing
export async function bingFeed(env, secret, host, path) {
  const s = (await idxSites(env, host)).get(host);
  const bkey = await bingKey(env, secret);
  if (!s?.bing_site) return { error: '该站点没有关联 Bing' };
  if (!bkey) return { error: '未配置 Bing API Key（设置 → Bing Webmaster）' };
  if (!inProperty(path, prop(s))) return { error: '站点地图地址不属于这个站点' };
  try { await bing.submitFeed(bkey, s.bing_site, path); } catch (e) { return { error: e.message }; }
  await refreshSite(env, secret, s, bkey);
  return { ok: true };
}

// 手动提交网址到 Bing：url 传一个时只提交它，不传时提交全部未收录的（受当天配额限制）
export async function bingSubmitNow(env, secret, host, url) {
  const s = (await idxSites(env, host)).get(host);
  const bkey = await bingKey(env, secret);
  if (!s?.bing_site) return { error: '该站点没有关联 Bing' };
  if (!bkey) return { error: '未配置 Bing API Key（设置 → Bing Webmaster）' };
  if (url && !(await env.DB.prepare('SELECT 1 FROM g_urls WHERE host = ? AND url = ?').bind(host, url).first())) return { error: '网址不在检查列表里' };
  try {
    const r = await bingSubmit(env, bkey, s, url ? { urls: [url] } : {});
    if (!r.submitted) return { error: r.quota ? '没有需要提交的网址' : '今天的 Bing 提交配额已用完，明天再试' };
    return r;
  } catch (e) { return { error: e.message }; }
}
