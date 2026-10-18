// ---------------------------------------------------------------- 外链与权重（可选功能，在“设置 → 外链与权重”里开启）
// 两项默认都关闭：关闭时不发任何请求，站点列表和详情页也不显示。
//
// Bing 外链：用已保存的 Bing Webmaster API Key。GetLinkCounts 按页面列出 Bing 发现的外链数，每个站点每周查一次，
//   每次定时任务最多查 10 个站点（Bing 按来源 IP 限流，分散开查）。某个页面具体是哪些网址链过来的（GetUrlLinks）
//   在详情页点开时才查，缓存一天。
// Open PageRank（Keywords Everywhere 提供，https://keywordseverywhere.com/openpagerank）：按 Common Crawl 公开数据
//   计算的域名权重 0–10、全球排名、引用域名数，数据每月更新一次（返回里的 as_of），这里每周查一次。
//   一次最多查 100 个域名；免费版每月 3 万个域名、每分钟 60 次请求，用量在响应头 X-Domains-* 里。
// 设置：bl_cfg = {"bing":0/1,"opr":0/1}；int_opr = 加密的 {key}；opr_usage = 最近一次的用量和数据月份；opr_error = 最近一次出错原因。
// 开关或配置变了会更新 bl_ver，站点列表的缓存据此立即失效；定时任务更新数据只更新 g_ver（列表最多沿用一小时）。

import { seal, unseal, siteHost, gVerStmt } from './google.js';
import { bget, bingCreds } from './bing.js';
import { spend } from './budget.js';

const DAY = 86400000, WEEK = 7 * DAY;
const OPR_API = 'https://openpagerank.keywordseverywhere.com/v1/';
export const BL_PAGES = 5;    // GetLinkCounts 每个站点最多翻几页
export const BL_TOP = 50;     // 每个站点保存外链最多的前 50 个页面
export const OPR_BATCH = 100; // Open PageRank 一次最多查 100 个域名
const OPR_HIST = 13;          // 保存最近 13 个月的分数

async function getSetting(env, key) {
  return (await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first('value')) ?? null;
}
async function setSetting(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, value, Date.now()).run();
}
const delSettings = (env, keys) => env.DB.prepare(`DELETE FROM settings WHERE key IN (${keys.map(() => '?').join(', ')})`).bind(...keys).run();
const json = (s, def) => { try { return s ? JSON.parse(s) : def; } catch { return def; } };
const bumpVer = (env) => setSetting(env, 'bl_ver', String(Date.now()));

// ---------------------------------------------------------------- 开关

export async function blConfig(env) {
  const c = json(await getSetting(env, 'bl_cfg'), {});
  return { bing: !!c.bing, opr: !!c.opr };
}
async function setConfig(env, patch) {
  const c = { ...(await blConfig(env)), ...patch };
  await setSetting(env, 'bl_cfg', JSON.stringify({ bing: c.bing ? 1 : 0, opr: c.opr ? 1 : 0 }));
  await bumpVer(env);
  return c;
}

// 站点列表 / 详情页要不要显示：开关开着、而且对应的凭据还在（只看有没有这一行，不解密）
export async function blFlags(env) {
  const rows = (await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('bl_cfg', 'int_bing', 'int_opr')").all()).results;
  const m = new Map(rows.map((r) => [r.key, r.value]));
  const c = json(m.get('bl_cfg'), {});
  return { bing: !!c.bing && m.has('int_bing'), opr: !!c.opr && m.has('int_opr') };
}

// ---------------------------------------------------------------- Open PageRank 接口

export async function oprCreds(env, secret) {
  const s = await getSetting(env, 'int_opr');
  if (!s) return null;
  try { return await unseal(secret, s); } catch { return null; }
}

// 出错时抛出带 status 的错误；429（太频繁或本月额度用完）带 throttle 标记
async function oprFetch(key, path, body) {
  spend();
  let res;
  try {
    res = await fetch(OPR_API + path, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) { throw new Error(`连不上 Open PageRank：${e.message}`); }
  const d = await res.json().catch(() => null);
  if (!res.ok) {
    const raw = String(d?.error?.message || '');
    const msg = res.status === 401 ? 'API Key 无效' : res.status === 429 ? (/limit|quota|exceed/i.test(raw) && !/minute/i.test(raw) ? '本月额度已用完' : '请求太频繁，稍后再试')
      : raw || `HTTP ${res.status}`;
    throw Object.assign(new Error(msg), { status: res.status, throttle: res.status === 429 });
  }
  // 用量：每次请求的响应头里都有（/usage 接口本身返回在正文里）
  const lim = Number(res.headers.get('x-domains-limit')), rem = Number(res.headers.get('x-domains-remaining'));
  const usage = lim > 0 && Number.isFinite(rem) ? { limit: lim, remaining: rem, resets: (Number(res.headers.get('x-domains-reset')) || 0) * 1000 } : null;
  return { d, usage };
}

async function saveUsage(env, usage, extra = {}) {
  const old = json(await getSetting(env, 'opr_usage'), {});
  await setSetting(env, 'opr_usage', JSON.stringify({ ...old, ...(usage || {}), ...extra, at: Date.now() }));
}

const OPR_KEY_RE = /^opr_[a-z]+_[A-Za-z0-9]{16,}$/;

// 保存前先查一次用量，确认 Key 有效；保存后自动开启，并立即查一批
export async function saveOprConfig(env, secret, body) {
  const old = await oprCreds(env, secret);
  const key = String(body.key || '').trim() || old?.key || '';
  if (!OPR_KEY_RE.test(key)) return { error: 'API Key 格式不对，应以 opr_live_ 开头，在 Keywords Everywhere 的 Open PageRank 页面生成' };
  let u;
  try { u = (await oprFetch(key, 'usage')).d || {}; } catch (e) { return { error: `验证失败：${e.message}` }; }
  await setSetting(env, 'int_opr', await seal(secret, { key }));
  await saveUsage(env, {
    limit: Number(u.monthly_domain_limit) || 0, remaining: Number(u.domains_remaining) || 0,
    resets: Date.parse(u.resets_at) || 0, tier: String(u.tier || ''),
  });
  await delSettings(env, ['opr_error']);
  // 换了 Key：全部重新查
  if (old?.key && old.key !== key) await env.DB.prepare('UPDATE g_sites SET opr_at = 0').run();
  await setConfig(env, { opr: true });
  await syncOpr(env, secret, { maxReq: 2 }).catch(() => {});
  await bumpVer(env);
  return { ok: true };
}

// 删除 Key：同时关掉开关、清掉已查到的分数
export async function deleteOprConfig(env) {
  await delSettings(env, ['int_opr', 'opr_usage', 'opr_error']);
  await env.DB.prepare("UPDATE g_sites SET opr = -1, opr_rank = 0, opr_ref = 0, opr_hist = '', opr_at = 0 WHERE opr_at > 0").run();
  await setConfig(env, { opr: false });
}

// 解析一个域名的结果；没收录（found: false）或无效的域名记为 -1
export function oprRow(r) {
  if (!r?.found || r.open_page_rank == null) return { opr: -1, rank: 0, ref: 0, hist: [] };
  const hist = (Array.isArray(r.history) ? r.history : [])
    .filter((h) => /^\d{4}-\d{2}/.test(String(h?.date || '')) && h.open_page_rank != null)
    .map((h) => [String(h.date).slice(0, 7), Math.round(Number(h.open_page_rank) * 100) / 100])
    .slice(-OPR_HIST);
  return { opr: Math.round(Number(r.open_page_rank) * 100) / 100, rank: Number(r.rank) || 0, ref: Number(r.referring_domains) || 0, hist };
}

// 定时任务：到期（一周没查过）的域名，每次最多 maxReq 个请求（每个 100 个域名）
export async function syncOpr(env, secret, { maxReq = 2, cutoff = Date.now() - WEEK } = {}) {
  if (!(await blConfig(env)).opr) return { skipped: true };
  const c = await oprCreds(env, secret);
  if (!c) return { skipped: true };
  // ga4-123 这类没有域名的站点不查
  const due = (await env.DB.prepare("SELECT host FROM g_sites WHERE host LIKE '%_.__%' AND opr_at < ? ORDER BY opr_at, host LIMIT ?")
    .bind(cutoff, maxReq * OPR_BATCH).all()).results.map((r) => r.host);
  let done = 0, error = '';
  for (let i = 0; i < due.length; i += OPR_BATCH) {
    const chunk = due.slice(i, i + OPR_BATCH);
    let r;
    try { r = await oprFetch(c.key, 'domains/bulk', { domains: chunk, include_history: true }); } catch (e) {
      if (e.budget) break;
      error = e.message;
      break;
    }
    // 结果按注册域名合并：blog.example.com 的分数在 example.com 那一项的 hosts[] 里（引用数叫 referring_hosts）；
    // 先登记子域名，再登记域名本身（同名时用域名那一项，它带引用域名数）
    const by = new Map();
    for (const x of r.d?.results || []) {
      for (const h of x.hosts || []) by.set(String(h.host || '').toLowerCase(), { ...h, referring_domains: h.referring_hosts });
    }
    for (const x of r.d?.results || []) by.set(String(x.domain || '').toLowerCase(), x);
    const now = Date.now();
    const stmts = chunk.map((host) => {
      const o = oprRow(by.get(host));
      return env.DB.prepare('UPDATE g_sites SET opr = ?, opr_rank = ?, opr_ref = ?, opr_hist = ?, opr_at = ? WHERE host = ?')
        .bind(o.opr, o.rank, o.ref, o.hist.length ? JSON.stringify(o.hist) : '', now, host);
    });
    stmts.push(gVerStmt(env));
    await env.DB.batch(stmts);
    await saveUsage(env, r.usage, r.d?.as_of ? { asOf: String(r.d.as_of) } : {});
    done += chunk.length;
  }
  if (error) await setSetting(env, 'opr_error', JSON.stringify({ msg: error, at: Date.now() }));
  // 没出错（包括没有到期的域名）就清掉旧的错误，免得一直显示“查询出错”
  else await delSettings(env, ['opr_error']);
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM g_sites WHERE host LIKE '%_.__%' AND opr_at < ?").bind(cutoff).first('n');
  return { done, left, ...(error ? { error } : {}) };
}

// ---------------------------------------------------------------- Bing 外链

// 一个站点：GetLinkCounts 最多翻 BL_PAGES 页，合并同一网址，保存总数和外链最多的页面。
// 翻到一半超时：不保存（不完整的总数会被当成本周结果），抛出 budget 让这次停下，下次这个站点排在最前面重新查
async function syncBingSite(env, cred, s, deadline = Infinity) {
  const counts = new Map();
  let pages = 0, total = 1;
  for (let p = 0; p < Math.min(total, BL_PAGES); p++) {
    if (p && Date.now() > deadline) throw Object.assign(new Error('这次的时间用完了，下次接着查'), { budget: true });
    const r = await bget(cred, 'GetLinkCounts', { siteUrl: s.bing_site, page: p });
    total = Number(r?.TotalPages) || 0;
    for (const l of r?.Links || []) {
      const u = String(l?.Url || '');
      if (u) counts.set(u, (counts.get(u) || 0) + (Number(l.Count) || 0));
    }
    pages++;
  }
  const list = [...counts].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const sum = list.reduce((a, [, n]) => a + n, 0);
  // bl_prev 取更新前的 bl_total（UPDATE 右边读到的都是旧值）
  await env.DB.prepare(`UPDATE g_sites SET bl_prev = bl_total, bl_total = ?, bl_pages = ?, bl_more = ?, bl_top = ?, bl_error = '', bl_at = ? WHERE host = ?`)
    .bind(sum, list.length, total > pages ? 1 : 0, list.length ? JSON.stringify(list.slice(0, BL_TOP)) : '', Date.now(), s.host).run();
}

// 定时任务：到期的站点（一周没查过），每次最多 limit 个；被限流就停下，下次接着查
export async function syncBingLinks(env, secret, { limit = 10, cutoff = Date.now() - WEEK, deadline = Date.now() + 60000 } = {}) {
  if (!(await blConfig(env)).bing) return { skipped: true };
  const c = await bingCreds(env, secret);
  if (!c) return { skipped: true };
  const due = (await env.DB.prepare("SELECT host, bing_site FROM g_sites WHERE bing_site != '' AND bl_at < ? ORDER BY bl_at, host LIMIT ?")
    .bind(cutoff, limit).all()).results;
  let done = 0, throttled = false;
  for (const s of due) {
    if (Date.now() > deadline) break;
    try { await syncBingSite(env, c, s, deadline); done++; } catch (e) {
      if (e.budget) break;
      if (e.throttle) { throttled = true; break; }
      // 其他错误（站点没权限之类）：记下原因，一天后再试；已有的数字保留
      await env.DB.prepare('UPDATE g_sites SET bl_error = ?, bl_at = ? WHERE host = ?')
        .bind(String(e.message || e).slice(0, 200), Date.now() - WEEK + DAY, s.host).run();
    }
  }
  if (done) await gVerStmt(env).run();
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM g_sites WHERE bing_site != '' AND bl_at < ?").bind(cutoff).first('n');
  return { done, left, ...(throttled ? { throttled: true } : {}) };
}

// 详情页点开某个页面：Bing 发现的链到这个网址的页面（每页最多约 10–20 条，按页翻），缓存一天
export async function urlLinks(env, secret, host, url, page = 0) {
  if (!(await blConfig(env)).bing) return { error: '没有开启 Bing 外链' };
  const s = await env.DB.prepare('SELECT bing_site FROM g_sites WHERE host = ?').bind(host).first();
  if (!s?.bing_site) return { error: '这个站点没有关联 Bing Webmaster' };
  // 只查这个站点自己的网址
  if (siteHost(url) !== host) return { error: '网址不属于这个站点' };
  const p = Math.max(0, Math.min(100, Math.floor(Number(page)) || 0));
  const k = `bll|${host}|${p}|${url}`;
  const row = await env.DB.prepare('SELECT v, at FROM g_cache WHERE k = ?').bind(k).first().catch(() => null);
  if (row && row.at > Date.now() - DAY) return json(row.v, {});
  const c = await bingCreds(env, secret);
  if (!c) return { error: '没有配置 Bing Webmaster' };
  let r;
  try { r = await bget(c, 'GetUrlLinks', { siteUrl: s.bing_site, link: url, page: p }); } catch (e) { return { error: e.message }; }
  const out = {
    page: p, pages: Number(r?.TotalPages) || 0,
    items: (r?.Details || []).map((x) => ({ u: String(x?.Url || ''), a: String(x?.AnchorText || '').trim().slice(0, 200) })).filter((x) => x.u),
  };
  await env.DB.prepare('INSERT INTO g_cache (k, v, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at')
    .bind(k, JSON.stringify(out), Date.now()).run().catch(() => {});
  return out;
}

// ---------------------------------------------------------------- 开关、状态、定时任务

// 打开时立即查一批（Bing 最多 5 个站点 / 15 秒；Open PageRank 最多 200 个域名），其余交给定时任务
export async function setEnabled(env, secret, body) {
  const patch = {};
  if (body.bing !== undefined) {
    if (body.bing && !(await bingCreds(env, secret))) return { error: '请先在“Bing Webmaster”里填写 API Key' };
    patch.bing = !!body.bing;
  }
  if (body.opr !== undefined) {
    if (body.opr && !(await oprCreds(env, secret))) return { error: '请先填写 Open PageRank 的 API Key' };
    patch.opr = !!body.opr;
  }
  await setConfig(env, patch);
  if (patch.bing) await syncBingLinks(env, secret, { limit: 5, deadline: Date.now() + 15000 }).catch(() => {});
  if (patch.opr) await syncOpr(env, secret, { maxReq: 2 }).catch(() => {});
  if (patch.bing || patch.opr) await bumpVer(env);
  return { ok: true };
}

// 立即更新：一小时内查过的不再查
export async function syncNow(env, secret) {
  const cutoff = Date.now() - 3600000;
  const bing = await syncBingLinks(env, secret, { limit: 10, cutoff, deadline: Date.now() + 20000 }).catch((e) => ({ error: e.message }));
  const opr = await syncOpr(env, secret, { maxReq: 2, cutoff }).catch((e) => ({ error: e.message }));
  await bumpVer(env);
  return { bing, opr };
}

export async function cronBatch(env, secret, { manual = false } = {}) {
  const cfg = await blConfig(env);
  if (!cfg.bing && !cfg.opr) return { skipped: true };
  const out = {};
  if (cfg.bing) out.bing = await syncBingLinks(env, secret, manual ? { limit: 3, deadline: Date.now() + 10000 } : {});
  if (cfg.opr) out.opr = await syncOpr(env, secret, { maxReq: manual ? 1 : 2 });
  return out;
}

export async function status(env, secret) {
  const [cfg, bc, oc, usage, err, r] = await Promise.all([
    blConfig(env), bingCreds(env, secret), oprCreds(env, secret),
    getSetting(env, 'opr_usage').then((v) => json(v, null)), getSetting(env, 'opr_error').then((v) => json(v, null)),
    env.DB.prepare(`SELECT
        SUM(bing_site != '') AS b_sites, SUM(bing_site != '' AND bl_total >= 0) AS b_done, SUM(bl_total > 0) AS b_with, SUM(bl_error != '') AS b_bad, MAX(bl_at) AS b_at,
        SUM(host LIKE '%_.__%') AS o_sites, SUM(opr_at > 0) AS o_done, SUM(opr >= 0 AND opr_at > 0) AS o_ranked, MAX(opr_at) AS o_at, MAX(opr) AS o_max
      FROM g_sites`).first(),
  ]);
  return {
    bing: { available: !!bc, on: cfg.bing && !!bc, sites: r?.b_sites || 0, synced: r?.b_done || 0, withLinks: r?.b_with || 0, errors: r?.b_bad || 0, lastSync: r?.b_at || null },
    opr: {
      configured: !!oc, keyTail: oc ? oc.key.slice(-4) : '', on: cfg.opr && !!oc, usage: oc ? usage : null, error: oc ? err : null,
      sites: r?.o_sites || 0, synced: r?.o_done || 0, ranked: r?.o_ranked || 0, max: r?.o_max >= 0 ? r.o_max : null, lastSync: r?.o_at || null,
    },
  };
}
