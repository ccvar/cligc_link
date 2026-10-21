// 把站点接入 Google Search Console 和 Bing Webmaster：验证所有权 → 添加站点 → 提交站点地图。
// 验证优先用 Cloudflare DNS（填了 DNS 令牌、域名在这个 Cloudflare 账号里时自动加记录，网站代码不用改）：
//   Google 验证整个域名（sc-domain:，含 www 和子域名），TXT 记录；Bing 用 CNAME 记录（<验证码>.<域名> → verify.bing.com）。
// 域名不在 Cloudflare 时用页面 meta 标签：先取标签贴到网站首页 <head>，再验证；Google 这时验证的是网址前缀（https://域名/）。
// 每一步都可以重复执行（已有的记录、已添加的站点不会重复建），DNS 还没生效时记为“验证中”，弹窗开着时和定时任务都会再试。
import { gfetch, siteHost, canVerify, canSubmit, addGsc, accountList, seal, unseal } from './google.js';
import { bget, bpost, bingCreds, discover as bingDiscover } from './bing.js';
import { fetchText, parseSitemap } from './gindex.js';
import { spend } from './budget.js';

const CF = 'https://api.cloudflare.com/client/v4';
const SV = 'https://www.googleapis.com/siteVerification/v1';
const SC = 'https://www.googleapis.com/webmasters/v3/sites/';
const MAX_TRIES = 48;   // DNS 验证最多自动重试的次数（定时任务每小时一次，约两天）
const COMMENT = 'cligc link：搜索引擎所有权验证，验证通过后请保留';

// ---------------------------------------------------------------- Cloudflare DNS 令牌（settings.int_cfdns，加密保存）

async function getSetting(env, key) {
  return (await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first('value')) ?? null;
}
async function setSetting(env, key, value) {
  await env.DB.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(key, value, Date.now()).run();
}
// DNS 用的令牌：单独填的（int_cfdns）优先；没填时试试“Cloudflare 用量”的令牌（int_cf）——它也带了 DNS 编辑权限的话，就不用再填一个。
// shared = 用的是“Cloudflare 用量”的令牌
export async function cfDnsToken(env, secret) {
  const s = await getSetting(env, 'int_cfdns');
  if (s) { try { return { token: (await unseal(secret, s)).token, shared: false }; } catch { return null; } }
  const u = await getSetting(env, 'int_cf');
  if (!u) return null;
  try { const t = (await unseal(secret, u)).token; return t ? { token: t, shared: true } : null; } catch { return null; }
}

async function cf(token, path, init = {}) {
  spend();
  let res;
  try {
    res = await fetch(CF + path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) }, signal: AbortSignal.timeout(15000) });
  } catch (e) { throw new Error(`连不上 Cloudflare：${e.message}`); }
  const d = await res.json().catch(() => ({}));
  if (!res.ok || d.success === false) {
    const e = d.errors?.[0];
    const msg = e?.message || `HTTP ${res.status}`;
    throw Object.assign(new Error(res.status === 403 || /authentication|permission/i.test(msg) ? `Cloudflare 令牌没有权限（要有“区域 · DNS · 编辑”，不是“DNS 设置”）：${msg}` : `Cloudflare：${msg}`), { status: res.status, raw: msg });
  }
  return d;
}

// 这个令牌能看到的全部域名（最多 1000 个）
async function listZones(token) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const d = await cf(token, `/zones?per_page=50&page=${page}&status=active`);
    out.push(...(d.result || []).map((z) => ({ id: z.id, name: z.name })));
    if (page >= (d.result_info?.total_pages || 1)) break;
  }
  return out;
}
// 域名所在的 Cloudflare 区域：最长匹配（blog.example.com → example.com）
const zoneOf = (zones, host) => zones.filter((z) => host === z.name || host.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0] || null;

// 令牌本身有没有效：个人令牌用 /user/tokens/verify，账户令牌用 /accounts/<ID>/tokens/verify（账户 ID 取“Cloudflare 用量”里填的）
async function tokenActive(env, secret, token) {
  try { if ((await cf(token, '/user/tokens/verify')).result?.status === 'active') return true; } catch (e) { if (e.budget) throw e; }
  const u = await getSetting(env, 'int_cf');
  const acc = u ? await unseal(secret, u).then((c) => c.accountId).catch(() => '') : '';
  if (acc) { try { if ((await cf(token, `/accounts/${acc}/tokens/verify`)).result?.status === 'active') return true; } catch (e) { if (e.budget) throw e; } }
  return false;
}
// 读不到域名时说清楚原因：令牌无效，还是有效但没给区域权限 / 区域资源
const ZONE_HINT = '令牌要有“区域 · DNS · 编辑”权限（不是“DNS 设置”），并且“区域资源”选“包括 → 所有区域”（或包含要接入的域名）';
async function zonesProblem(env, secret, token, err) {
  if (!(await tokenActive(env, secret, token))) return '令牌无效：请确认粘贴的是 API 令牌的值（不是 Global API Key 或令牌 ID），并且没有过期或停用';
  return err ? `令牌有效，但读不到域名：${ZONE_HINT}（Cloudflare：${err.raw || err.message}）` : `令牌有效，但看不到任何域名：${ZONE_HINT}`;
}

export async function saveCfDns(env, secret, body) {
  const token = String(body.token || '').trim();
  if (token.length < 20) return { error: '请填写 API 令牌' };
  let zones;
  try { zones = await listZones(token); } catch (e) { if (e.budget) throw e; return { error: await zonesProblem(env, secret, token, e) }; }
  if (!zones.length) return { error: await zonesProblem(env, secret, token, null) };
  await setSetting(env, 'int_cfdns', await seal(secret, { token, tail: token.slice(-4) }));
  return cfDnsStatus(env, secret, zones);
}
export async function deleteCfDns(env) {
  await env.DB.prepare("DELETE FROM settings WHERE key = 'int_cfdns'").run();
  return { configured: false };
}
export async function cfDnsStatus(env, secret, zones) {
  const s = await getSetting(env, 'int_cfdns');
  if (!s) {
    // 没单独填：“Cloudflare 用量”的令牌能看到域名就直接用它；看不到时说明缺什么（只在设置页看状态时查，接入时不查）
    const c = await cfDnsToken(env, secret);
    if (!c) return { configured: false };
    let z = [], err = null;
    try { z = await listZones(c.token); } catch (e) { if (e.budget) throw e; err = e; }
    if (z.length) return { configured: true, shared: true, zones: z.length, names: z.slice(0, 50).map((x) => x.name) };
    return { configured: false, usage: true, usageError: err && !/没有权限|authentication/i.test(err.message) ? err.message : '' };
  }
  let c;
  try { c = await unseal(secret, s); } catch { return { configured: true, error: '令牌无法解密（会话密钥变了？），请重新填写' }; }
  if (!zones) { try { zones = await listZones(c.token); } catch (e) { return { configured: true, tail: c.tail, error: e.message }; } }
  return { configured: true, tail: c.tail, zones: zones.length, names: zones.slice(0, 50).map((z) => z.name) };
}

// 加一条 DNS 记录；同名同值的已经有了就不再加。CNAME 同名但指向别处时改成新的（验证用的名字是随机码，不会和正常记录冲突）
async function ensureRecord(token, zone, type, name, content) {
  const bare = (v) => String(v || '').replace(/^"|"$/g, '').toLowerCase().replace(/\.$/, '');
  // Cloudflare 按名字查时不一定是精确匹配（会带出 ….example.com.example.com 这种），这里再按名字精确比一次
  const list = ((await cf(token, `/zones/${zone.id}/dns_records?type=${type}&name.exact=${encodeURIComponent(name)}&per_page=100`)).result || [])
    .filter((r) => bare(r.name) === bare(name));
  if (list.some((r) => bare(r.content) === bare(content))) return 'exists';
  const rec = { type, name, content: type === 'TXT' ? `"${content}"` : content, ttl: 1, ...(type === 'CNAME' ? { proxied: false } : {}), comment: COMMENT };
  if (type === 'CNAME' && list[0]) await cf(token, `/zones/${zone.id}/dns_records/${list[0].id}`, { method: 'PUT', body: JSON.stringify(rec) });
  else {
    try { await cf(token, `/zones/${zone.id}/dns_records`, { method: 'POST', body: JSON.stringify(rec) }); }
    catch (e) { if (/already exists/i.test(e.raw || e.message)) return 'exists'; throw e; }   // 一模一样的记录已经有了
  }
  return 'added';
}

// 删掉一条我们加的记录（名字、值都精确对上才删）
async function removeRecord(token, zone, type, name, content) {
  const bare = (v) => String(v || '').replace(/^"|"$/g, '').toLowerCase().replace(/\.$/, '');
  const list = (await cf(token, `/zones/${zone.id}/dns_records?type=${type}&name.exact=${encodeURIComponent(name)}&per_page=100`)).result || [];
  for (const r of list) if (bare(r.name) === bare(name) && bare(r.content) === bare(content)) await cf(token, `/zones/${zone.id}/dns_records/${r.id}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------- 工具

// 网站实际的首页地址：http 跳 https、不带 www 跳 www 之类，跟着跳转走一遍；打不开就用 https://域名/
export async function homeOrigin(host) {
  for (const u of [`https://${host}/`, `https://www.${host}/`]) {
    try {
      spend();
      const res = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; cligc-link)' } });
      res.body?.cancel().catch(() => {});
      if (res.status < 500) { const f = new URL(res.url || u); if (siteHost(f.origin) === host) return `${f.origin}/`; }
    } catch (e) { if (e.budget) throw e; }
  }
  return `https://${host}/`;
}

// 网站的站点地图：robots.txt 里写的，没有就试常见的几个地址
export async function findSitemaps(origin, host) {
  const base = origin.replace(/\/$/, '');
  const mine = (u) => { const h = siteHost(u); return h === host || h.endsWith(`.${host}`); };
  try {
    const list = [...(await fetchText(`${base}/robots.txt`)).matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]).filter(mine);
    if (list.length) return [...new Set(list)].slice(0, 5);
  } catch (e) { if (e.budget) throw e; }
  for (const p of ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml']) {
    try { if (parseSitemap(await fetchText(base + p)).locs.length) return [base + p]; } catch (e) { if (e.budget) throw e; }
  }
  return [];
}

const short = (e) => String(e?.message || e).slice(0, 300);
const eq = (a, b) => String(a || '').toLowerCase().replace(/\/+$/, '') === String(b || '').toLowerCase().replace(/\/+$/, '');

// ---------------------------------------------------------------- Google

async function googleToken(env, secret, acct, site, method) {
  const d = await gfetch(env, secret, acct, `${SV}/token`, { site, verificationMethod: method });
  return d.token;
}
async function googleVerify(env, secret, acct, site, method) {
  await gfetch(env, secret, acct, `${SV}/webResource?verificationMethod=${method}`, { site });
}
// 加进 Search Console 并提交站点地图；返回提交了几个
async function googleAdd(env, secret, acct, siteUrl, origin, host) {
  await gfetch(env, secret, acct, SC + encodeURIComponent(siteUrl), undefined, 'PUT');
  let n = 0;
  if (await canSubmit(env, secret, acct)) {
    for (const sm of await findSitemaps(origin, host)) {
      try { await gfetch(env, secret, acct, `${SC}${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(sm)}`, undefined, 'PUT'); n++; } catch (e) { if (e.budget) throw e; }
    }
  }
  await addGsc(env, acct, siteUrl);
  return n;
}

async function runGoogle(env, secret, ctx, row) {
  const { host, method, acct } = row;
  if (!acct) return { state: 'error', msg: '没有可用的 Google 账号：先到 设置 → Google 集成 连接账号' };
  if (!(await canVerify(env, secret, acct))) return { state: 'error', msg: '这个 Google 账号还没授予网站验证权限，请重新授权', reauth: true };
  try {
    if (method === 'dns') {
      const zone = zoneOf(ctx.zones, host);
      if (!zone) return { state: 'error', msg: '这个域名不在 Cloudflare 账号里，请改用页面标签验证' };
      const site = { type: 'INET_DOMAIN', identifier: host };
      const token = await googleToken(env, secret, acct, site, 'DNS_TXT');
      await ensureRecord(ctx.cfToken, zone, 'TXT', host, token);
      try { await googleVerify(env, secret, acct, site, 'DNS_TXT'); } catch (e) {
        if (e.budget) throw e;
        return { state: 'pending', msg: `DNS 记录已添加，等生效后验证（一般几分钟）：${short(e)}`, site: `sc-domain:${host}` };
      }
      const n = await googleAdd(env, secret, acct, `sc-domain:${host}`, ctx.origin || await homeOrigin(host), host);
      return { state: 'done', msg: n ? `已验证并添加，提交了 ${n} 个站点地图` : '已验证并添加（没找到站点地图）', site: `sc-domain:${host}` };
    }
    const origin = ctx.origin || await homeOrigin(host);
    const site = { type: 'SITE', identifier: origin };
    try { await googleVerify(env, secret, acct, site, 'META'); } catch (e) {
      if (e.budget) throw e;
      return { state: 'error', msg: `没通过验证：确认验证标签已经贴到 ${origin} 的 <head> 里（${short(e)}）`, site: origin };
    }
    const n = await googleAdd(env, secret, acct, origin, origin, host);
    return { state: 'done', msg: n ? `已验证并添加，提交了 ${n} 个站点地图` : '已验证并添加（没找到站点地图）', site: origin };
  } catch (e) {
    if (e.budget) throw e;
    return { state: 'error', msg: /insufficient|scope|permission/i.test(e.message) ? `没有权限，请重新授权：${short(e)}` : short(e), reauth: /insufficient|scope/i.test(e.message) };
  }
}

// ---------------------------------------------------------------- Bing

// 在 Bing 里加上这个站点（已经有了就跳过），返回 Bing 的站点信息（含验证码）
async function bingSite(c, origin) {
  const find = async () => ((await bget(c, 'GetUserSites')) || []).find((s) => eq(s.Url, origin));
  let s = await find();
  if (!s) {
    try { await bpost(c, 'AddSite', { siteUrl: origin }); } catch (e) { if (e.budget) throw e; }
    s = await find();
  }
  if (!s) throw new Error('Bing 没有添加这个站点');
  return s;
}

async function runBing(env, secret, ctx, row) {
  const { host, method } = row;
  const c = ctx.bing;
  if (!c) return { state: 'error', msg: '未配置 Bing API Key（设置 → Bing Webmaster）' };
  try {
    const origin = ctx.origin || await homeOrigin(host);
    const s = await bingSite(c, origin);
    const bhost = new URL(origin).hostname;
    if (!s.IsVerified) {
      let rec = '';
      if (method === 'dns') {
        const zone = zoneOf(ctx.zones, bhost);
        if (!zone) return { state: 'error', msg: '这个域名不在 Cloudflare 账号里，请改用页面标签验证' };
        if (!s.DnsVerificationCode) return { state: 'error', msg: 'Bing 没有给出 DNS 验证码，请改用页面标签验证' };
        // Bing 给的 DnsVerificationCode 就是完整的记录名（如 e4a2….example.com）；只有一串码（不带点）时才拼上域名
        const code = String(s.DnsVerificationCode).trim().replace(/\.$/, '').toLowerCase();
        rec = code.includes('.') ? code : `${code}.${bhost}`;
        await ensureRecord(ctx.cfToken, zone, 'CNAME', rec, 'verify.bing.com');
        // 以前的版本把域名多拼了一次（….example.com.example.com），加错的那条删掉
        if (code.includes('.')) await removeRecord(ctx.cfToken, zone, 'CNAME', `${code}.${bhost}`, 'verify.bing.com').catch(() => {});
      }
      // VerifySite 本身出错（限流、参数不对等）也记下来，不然只会一直显示“验证中”看不出原因
      let ok = false, verr = '';
      try { ok = !!(await bpost(c, 'VerifySite', { siteUrl: s.Url })); } catch (e) { if (e.budget) throw e; verr = short(e); }
      if (!ok) {
        return method === 'dns'
          ? { state: 'pending', msg: `DNS 记录已添加：CNAME ${rec} → verify.bing.com。Bing 检查 DNS 可能要几小时，最长一两天${verr ? `；这次 Bing 返回：${verr}` : ''}`, site: s.Url }
          : { state: 'error', msg: `没通过验证：确认验证标签已经贴到 ${origin} 的 <head> 里${verr ? `（Bing 返回：${verr}）` : ''}`, site: s.Url };
      }
    }
    let n = 0;
    for (const sm of await findSitemaps(origin, host)) {
      try { await bpost(c, 'SubmitFeed', { siteUrl: s.Url, feedUrl: sm }); n++; } catch (e) { if (e.budget) throw e; }
    }
    await bingDiscover(env, secret);
    // 刚接入：清掉接入前同步留下的报错（比如“还没验证”），同步时间清零，下一次定时任务就同步这个站点
    await env.DB.prepare("UPDATE g_sites SET b_synced_at = 0, b_error = '' WHERE host = ?").bind(host).run().catch(() => {});
    return { state: 'done', msg: n ? `已验证并添加，提交了 ${n} 个站点地图` : '已验证并添加（没找到站点地图）', site: s.Url };
  } catch (e) {
    if (e.budget) throw e;
    return { state: 'error', msg: short(e) };
  }
}

// ---------------------------------------------------------------- 对外

// Bing 站点是否已验证（按每天列出的 Bing 站点；不在列表里的按已验证算，免得列表读取出错时都显示成没接入）
async function bingVerified(env) {
  let f = null;
  try { f = JSON.parse((await getSetting(env, 'bing_found')) || 'null'); } catch {}
  const v = new Map((f?.sites || []).map((x) => [String(x.url).toLowerCase().replace(/\/+$/, ''), x.verified]));
  return (url) => !!url && v.get(String(url).toLowerCase().replace(/\/+$/, '')) !== false;
}
const normHost = (h) => siteHost(/^[a-z]+:\/\//i.test(String(h || '').trim()) ? String(h).trim() : `https://${String(h || '').trim()}`);
const rowOut = (r) => r && { method: r.method, acct: r.g_acct, g: { state: r.g_state, msg: r.g_msg }, b: { state: r.b_state, msg: r.b_msg }, at: r.updated_at };

async function context(env, secret, needCf) {
  const c = needCf ? await cfDnsToken(env, secret) : null;
  const zones = c ? await listZones(c.token).catch(() => []) : [];
  // “Cloudflare 用量”的令牌看不到域名（没有区域权限）：当作没有 DNS 令牌
  const cfToken = c && (!c.shared || zones.length) ? c.token : null;
  return { cfToken, zones: cfToken ? zones : [], bing: await bingCreds(env, secret) };
}

// 弹窗用：哪些站点还没接入、各自的进度，以及能不能用 DNS 自动验证
// hosts：只看这几个站点（站点详情页打开时）；extra：列表之外手动加的域名
export async function onboardList(env, secret, hosts, extra = []) {
  const want = (hosts || []).map(normHost).filter(Boolean);
  const sites = (await env.DB.prepare("SELECT host, gsc_site, bing_site, ga4_created FROM g_sites WHERE host LIKE '%.%'").all()).results;
  const rows = new Map((await env.DB.prepare('SELECT * FROM site_onboard').all()).results.map((r) => [r.host, r]));
  const by = new Map(sites.map((s) => [s.host, s]));
  const bv = await bingVerified(env);
  const list = want.length ? want : sites.filter((s) => !s.gsc_site || !bv(s.bing_site)).map((s) => s.host);
  for (const h of rows.keys()) if (!want.length && !list.includes(h) && !(by.get(h)?.gsc_site && bv(by.get(h)?.bing_site))) list.push(h);
  for (const h of extra.map(normHost).filter(Boolean)) if (!list.includes(h)) list.push(h);
  const ctx = await context(env, secret, true);
  const bingOk = await bingVerified(env);
  return {
    cf: { configured: !!ctx.cfToken, zones: ctx.zones.length },
    bing: !!ctx.bing,
    accounts: await accountList(env, secret),
    // since：GA4 网站数据流的创建时间（大致是站点上线 / 开始统计的时间）；新站点排在前面，没有的按域名排
    items: [...new Set(list)].map((host) => {
      const gsc = by.get(host)?.gsc_site || '', bingSite = bingOk(by.get(host)?.bing_site) ? by.get(host).bing_site : '';
      const o = rowOut(rows.get(host)) || {};
      // 行里记着“已接入”、但现在其实没关联上的（以前把没验证的 Bing 站点当成了已关联）：按没接入显示，可以重新接入
      if (o.g?.state === 'done' && !gsc) o.g = { state: '', msg: '' };
      if (o.b?.state === 'done' && !bingSite) o.b = { state: '', msg: '' };
      return { host, gsc, bingSite, since: by.get(host)?.ga4_created || 0, zone: ctx.cfToken ? !!zoneOf(ctx.zones, host) : null, ...o };
    }).sort((a, b) => (b.since || 0) - (a.since || 0) || a.host.localeCompare(b.host)),
  };
}

// 页面标签：Google 和 Bing 的验证 meta 标签（Bing 要先把站点加进去才有验证码）
export async function onboardMeta(env, secret, b) {
  const host = normHost(b.host);
  if (!host) return { error: '网站地址不对' };
  const origin = await homeOrigin(host);
  const out = { host, origin, google: '', bing: '', errors: [] };
  if (b.g !== false && b.acct) {
    try {
      if (!(await canVerify(env, secret, b.acct))) out.errors.push('Google：这个账号还没授予网站验证权限，请重新授权');
      else out.google = await googleToken(env, secret, b.acct, { type: 'SITE', identifier: origin }, 'META');
    } catch (e) { if (e.budget) throw e; out.errors.push(`Google：${short(e)}`); }
  }
  if (b.b !== false) {
    const c = await bingCreds(env, secret);
    if (c) {
      try { const s = await bingSite(c, origin); if (!s.IsVerified && s.AuthenticationCode) out.bing = `<meta name="msvalidate.01" content="${s.AuthenticationCode}" />`; }
      catch (e) { if (e.budget) throw e; out.errors.push(`Bing：${short(e)}`); }
    }
  }
  return out;
}

// 接入一个站点：b.g / b.b 选 Google / Bing，b.method 是 dns 或 meta，b.acct 是用哪个 Google 账号
export async function onboardRun(env, secret, b, ctx) {
  const host = normHost(b.host);
  if (!host) return { error: '网站地址不对' };
  const method = b.method === 'meta' ? 'meta' : 'dns';
  const site = await env.DB.prepare('SELECT gsc_site, bing_site, ga4_acct, gsc_acct FROM g_sites WHERE host = ?').bind(host).first();
  const old = await env.DB.prepare('SELECT * FROM site_onboard WHERE host = ?').bind(host).first();
  ctx = ctx || await context(env, secret, method === 'dns');
  if (method === 'dns' && !ctx.cfToken) return { error: 'Cloudflare 令牌还不能加 DNS 记录（设置 → Cloudflare → DNS 自动验证）' };
  ctx = { ...ctx, origin: method === 'meta' ? await homeOrigin(host) : null };
  const acct = b.acct || old?.g_acct || site?.gsc_acct || site?.ga4_acct || '';
  const row = { host, method, acct };
  const g = site?.gsc_site ? { state: 'done', msg: '已接入' } : b.g === false ? { state: old?.g_state || '', msg: old?.g_msg || '' } : await runGoogle(env, secret, ctx, row);
  const bb = (await bingVerified(env))(site?.bing_site) ? { state: 'done', msg: '已接入' } : b.b === false ? { state: old?.b_state || '', msg: old?.b_msg || '' } : await runBing(env, secret, ctx, row);
  const now = Date.now();
  const retry = (b.retry ? (old?.tries || 0) + 1 : 0);
  await env.DB.prepare(`INSERT INTO site_onboard (host, method, g_acct, g_site, g_state, g_msg, b_site, b_state, b_msg, tries, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(host) DO UPDATE SET method = excluded.method, g_acct = excluded.g_acct, g_site = excluded.g_site, g_state = excluded.g_state, g_msg = excluded.g_msg,
      b_site = excluded.b_site, b_state = excluded.b_state, b_msg = excluded.b_msg, tries = excluded.tries, updated_at = excluded.updated_at`)
    .bind(host, method, acct, g.site || old?.g_site || '', g.state, g.msg, bb.site || old?.b_site || '', bb.state, bb.msg, retry, old?.created_at || now, now).run();
  return { host, method, acct, g: { state: g.state, msg: g.msg, reauth: !!g.reauth }, b: { state: bb.state, msg: bb.msg } };
}

// 定时任务：DNS 验证还没通过的，10 分钟以后再试（每个站点最多 MAX_TRIES 次）
export async function onboardCron(env, secret, { limit = 10 } = {}) {
  const rows = (await env.DB.prepare(`SELECT * FROM site_onboard WHERE (g_state = 'pending' OR b_state = 'pending') AND tries < ? AND updated_at < ? ORDER BY updated_at LIMIT ?`)
    .bind(MAX_TRIES, Date.now() - 600000, limit).all()).results;
  if (!rows.length) return { done: 0 };
  const ctx = await context(env, secret, true);
  let done = 0;
  for (const r of rows) {
    await onboardRun(env, secret, { host: r.host, method: r.method, acct: r.g_acct, g: r.g_state === 'pending', b: r.b_state === 'pending', retry: true }, ctx);
    done++;
  }
  return { done };
}
