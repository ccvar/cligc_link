// 站点地图批量提交：看每个站点给 Google（Search Console）和 Bing 各提交了哪些站点地图，把缺的补交上。
// 已知的站点地图 = Search Console 里的 + Bing 里的 + 网站根目录找到但还没提交的（g_sitemaps.list 里 local 的）；
// 两边都没有时，手动提交会再去 robots.txt 和常见地址找一遍。
// 定时任务也会自动补交（只补已知的，跟着设置里“自动重新提交站点地图”的开关走），每个站点一天最多试一次。
import { gfetch, canSubmit, smAutoGoogle, siteHost } from './google.js';
import * as bing from './bing.js';
import { inProperty } from './gindex.js';
import { homeOrigin, findSitemaps } from './onboard.js';

const SC = 'https://www.googleapis.com/webmasters/v3/sites/';
const DAY = 86400000;
const parse = (v) => { try { return JSON.parse(v || '[]'); } catch { return []; } };
const short = (e) => String(e?.message || e).slice(0, 200);
// Bing 的站点地图要在这个站点（含子域名）下面
const inBing = (path, s) => { const h = siteHost(path); return !!h && (h === s.host || h.endsWith(`.${s.host}`)); };

async function rows(env, host) {
  return (await env.DB.prepare(`SELECT s.host, s.gsc_site, s.gsc_acct, s.bing_site, m.list, m.b_feeds, m.at
    FROM g_sites s LEFT JOIN g_sitemaps m ON m.host = s.host WHERE ((s.gsc_site != '' AND s.gsc_acct != '') OR s.bing_site != '')${host ? ' AND s.host = ?' : ''}`)
    .bind(...(host ? [host] : [])).all()).results;
}

// 一个站点的情况：两边各提交了哪些、缺哪些（只算属于这个资源 / 站点的）
function stateOf(r) {
  const list = parse(r.list), feeds = parse(r.b_feeds);
  const gSub = list.filter((x) => !x.local).map((x) => x.path), local = list.filter((x) => x.local).map((x) => x.path);
  const bSub = feeds.map((x) => x.path);
  const known = [...new Set([...gSub, ...bSub, ...local])];
  const gOn = !!(r.gsc_site && r.gsc_acct), bOn = !!r.bing_site;
  const g = gOn ? { on: true, n: gSub.length, missing: known.filter((p) => !gSub.includes(p) && inProperty(p, r.gsc_site)) } : { on: false, n: 0, missing: [] };
  const b = bOn ? { on: true, n: bSub.length, missing: known.filter((p) => !bSub.includes(p) && inBing(p, r)) } : { on: false, n: 0, missing: [] };
  return { host: r.host, known, g, b, checked: r.at || 0 };
}

// 弹窗用：所有已接入的站点
export async function smList(env) {
  return { items: (await rows(env)).map(stateOf) };
}

// 把提交结果记进 g_sitemaps，不用等下一次刷新站点地图（下次刷新时会换成 Google / Bing 返回的真实状态）
async function remember(env, host, gDone, bDone) {
  if (!gDone.length && !bDone.length) return;
  const now = Date.now();
  const m = await env.DB.prepare('SELECT list, b_feeds FROM g_sitemaps WHERE host = ?').bind(host).first();
  const list = parse(m?.list), feeds = parse(m?.b_feeds);
  for (const p of gDone) {
    const x = list.find((y) => y.path === p);
    if (x) { x.local = false; x.submitted = now; x.pending = true; } else list.push({ path: p, type: '', index: false, pending: true, submitted: now, downloaded: 0, errors: 0, warnings: 0, urls: 0 });
  }
  for (const p of bDone) if (!feeds.some((y) => y.path === p)) feeds.push({ path: p, type: '', status: 'Pending', crawled: 0, submitted: now, urls: 0, size: 0 });
  if (m) await env.DB.prepare('UPDATE g_sitemaps SET list = ?, b_feeds = ? WHERE host = ?').bind(JSON.stringify(list), JSON.stringify(feeds), host).run();
  else await env.DB.prepare('INSERT INTO g_sitemaps (host, list, b_feeds) VALUES (?, ?, ?)').bind(host, JSON.stringify(list), JSON.stringify(feeds)).run();
}

// 补交一个站点缺的站点地图；discover：两边都没有已知的站点地图时，去 robots.txt 和常见地址找
// only：只补交哪一边（定时任务里关掉了自动提交的那一边不动）
export async function smSubmit(env, secret, host, { discover = true, bkey, only = { g: true, b: true } } = {}) {
  const r = (await rows(env, host))[0];
  if (!r) return { error: '这个站点没有关联 Search Console 或 Bing' };
  let st = stateOf(r);
  let found = [];
  if (!st.known.length && discover) {
    found = await findSitemaps(await homeOrigin(host), host);
    st = { ...st, known: found,
      g: st.g.on ? { ...st.g, missing: found.filter((p) => inProperty(p, r.gsc_site)) } : st.g,
      b: st.b.on ? { ...st.b, missing: found.filter((p) => inBing(p, r)) } : st.b };
  }
  const out = { host, found: st.known.length, g: { done: [], errors: [] }, b: { done: [], errors: [] } };
  if (only.g && st.g.missing.length) {
    if (!(await canSubmit(env, secret, r.gsc_acct))) out.g.errors.push('这个 Google 账号还没授予提交权限，请重新授权');
    else for (const p of st.g.missing) {
      try { await gfetch(env, secret, r.gsc_acct, `${SC}${encodeURIComponent(r.gsc_site)}/sitemaps/${encodeURIComponent(p)}`, undefined, 'PUT'); out.g.done.push(p); }
      catch (e) { if (e.budget) throw e; out.g.errors.push(`${p}：${short(e)}`); }
    }
  }
  if (only.b && st.b.missing.length) {
    const c = bkey === undefined ? await bing.bingCreds(env, secret) : bkey;
    if (!c) out.b.errors.push('未配置 Bing API Key');
    else for (const p of st.b.missing) {
      try { await bing.submitFeed(c, r.bing_site, p); out.b.done.push(p); }
      catch (e) { if (e.budget) throw e; out.b.errors.push(`${p}：${short(e)}`); }
    }
  }
  await remember(env, host, out.g.done, out.b.done);
  return { ...out, state: stateOf((await rows(env, host))[0]) };
}

// 定时任务：自动补交已知但没提交的站点地图（跟着“自动重新提交站点地图”的开关；每个站点一天最多试一次）
export async function smAutoFill(env, secret, { limit = 20 } = {}) {
  const gAuto = await smAutoGoogle(env), bAuto = await bing.smAutoBing(env);
  if (!gAuto && !bAuto) return { skipped: true };
  const tried = new Map((await env.DB.prepare("SELECT k, at FROM g_cache WHERE k LIKE 'smfill|%'").all()).results.map((x) => [x.k.slice(7), x.at]));
  const due = (await rows(env)).map(stateOf)
    .filter((x) => ((gAuto && x.g.missing.length) || (bAuto && x.b.missing.length)) && !(tried.get(x.host) > Date.now() - DAY))
    .slice(0, limit);
  if (!due.length) return { done: 0 };
  const bkey = bAuto ? await bing.bingCreds(env, secret) : null;
  let g = 0, b = 0, failed = 0;
  for (const x of due) {
    await env.DB.prepare('INSERT INTO g_cache (k, v, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET at = excluded.at').bind(`smfill|${x.host}`, '1', Date.now()).run();
    const r = await smSubmit(env, secret, x.host, { discover: false, bkey: bAuto ? bkey : null, only: { g: gAuto, b: bAuto } }).catch(() => null);
    if (!r || r.error) { failed++; continue; }
    g += r.g.done.length; b += r.b.done.length; failed += r.g.errors.length + r.b.errors.length;
  }
  return { sites: due.length, google: g, bing: b, failed };
}
