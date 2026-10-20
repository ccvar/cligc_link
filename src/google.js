// ---------------------------------------------------------------- Google：GA4 + Search Console
// 授权：OAuth 2.0（Web 应用），权限 analytics.readonly、analytics.edit（新建 GA4 媒体资源、管理事件）、webmasters（Search Console 读取 + 提交站点地图）。
// 早先授权的账号没有写权限，读取不受影响；要提交站点地图、新建媒体资源、管理事件需重新连接一次。
// OAuth 客户端：在后台填写，加密保存在 settings.int_google（旧版本的环境变量会自动导入一次）。
// 回调地址为 <域名>/api/google/callback。
// 可以连接多个 Google 账号：每个账号一行 g_accounts，刷新令牌用会话密钥派生的 AES-GCM 密钥加密保存。
// 所有账号的 GA4 媒体资源和 GSC 站点按域名合并到 g_sites，并记下各自来自哪个账号（ga4_acct / gsc_acct）。
// 每日数据存在 g_daily，由定时任务和“立即同步”分批更新；详情页的排行、实时数据现查并缓存一小时。

import { sourceUv, hllNew, hllMerge, hllCount } from './agg.js';
import { bingRaw, bingSummary, BL_RESET } from './bing.js';
import { spend } from './budget.js';
import { contentOf } from './content.js';

const SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/analytics.edit',
  'https://www.googleapis.com/auth/webmasters',
  'https://www.googleapis.com/auth/siteverification',
];
const SC_WRITE = 'https://www.googleapis.com/auth/webmasters';
export const GA_EDIT = 'https://www.googleapis.com/auth/analytics.edit';
async function hasScope(env, secret, acct, scope) {
  const row = acct && await env.DB.prepare('SELECT auth FROM g_accounts WHERE id = ?').bind(acct).first();
  if (!row) return false;
  try { return String((await unseal(secret, row.auth)).scope || '').split(/\s+/).includes(scope); } catch { return false; }
}
// 账号是否授予了 Search Console 写权限（提交站点地图要用）
export const canSubmit = (env, secret, acct) => hasScope(env, secret, acct, SC_WRITE);
// 账号是否授予了 GA4 编辑权限（新建媒体资源、管理事件要用）
export const canEdit = (env, secret, acct) => hasScope(env, secret, acct, GA_EDIT);
// 账号是否授予了网站验证权限（把新站点加进 Search Console 前要先验证所有权）
export const SITE_VERIFY = 'https://www.googleapis.com/auth/siteverification';
export const canVerify = (env, secret, acct) => hasScope(env, secret, acct, SITE_VERIFY);
const DAY = 86400000;
// 首次回填 486 天（Search Console 最多保留 16 个月），够“最近 6 个月”做环比；回填天数变了会重新回填一次
const BACKFILL_DAYS = 486, GA_REFRESH = 4, SC_REFRESH = 5;
// 渠道占比只回填一年（最长的区间是 12 个月，且不做环比），省写入
const CHANNEL_DAYS = 366;
export const RANGE_DAYS = [7, 14, 28, 90, 180, 365];
// 有完整的上一周期数据才做环比（365 天的上一周期超出了回填范围）
const hasPrev = (days) => days * 2 <= BACKFILL_DAYS;

// ---------------------------------------------------------------- 工具

async function getSetting(env, key) {
  return (await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first('value')) ?? null;
}
async function setSetting(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, value, Date.now()).run();
}
const delSetting = (env, key) => env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
const ymd = (t) => new Date(t).toISOString().slice(0, 10);
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aesKey(secret) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`google|${secret}`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(secret, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), new TextEncoder().encode(JSON.stringify(obj)));
  return `${b64(iv)}.${b64(new Uint8Array(ct))}`;
}
export async function unseal(secret, s) {
  const [iv, ct] = s.split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(secret), unb64(ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

// 主域名：去掉协议、端口、www.；GSC 的“网域”资源形如 sc-domain:example.com
export function siteHost(u) {
  if (!u) return '';
  if (u.startsWith('sc-domain:')) return u.slice(10).toLowerCase();
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

// ---------------------------------------------------------------- 授权

// 客户端 ID / 密钥：在后台填写，加密保存在 settings.int_google。
// 旧版本写在环境变量 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 里的，第一次用到时导入一次，之后只认后台这份（删除后也不会再导入）
export async function googleCreds(env, secret) {
  const s = await getSetting(env, 'int_google');
  if (s) { try { const c = await unseal(secret, s); return { ...c, source: 'db' }; } catch { return null; } }
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && !(await getSetting(env, 'env_import_google'))) {
    const c = { clientId: String(env.GOOGLE_CLIENT_ID).trim(), clientSecret: String(env.GOOGLE_CLIENT_SECRET).trim() };
    await setSetting(env, 'int_google', await seal(secret, c));
    await setSetting(env, 'env_import_google', String(Date.now()));
    return { ...c, source: 'db' };
  }
  return null;
}
export const googleConfigured = async (env, secret) => !!(await googleCreds(env, secret));

export async function saveGoogleConfig(env, secret, body) {
  const old = await googleCreds(env, secret);
  const clientId = String(body.clientId || '').trim();
  const clientSecret = String(body.clientSecret || '').trim() || old?.clientSecret || '';
  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)) return { error: '客户端 ID 格式不对，应以 .apps.googleusercontent.com 结尾' };
  if (clientSecret.length < 10) return { error: '请填写客户端密钥' };
  // 换了客户端，原来的授权就不能用了
  if (old && old.clientId !== clientId) await disconnect(env, secret);
  await setSetting(env, 'int_google', await seal(secret, { clientId, clientSecret }));
  tokenCache.clear();
  return { ok: true };
}

export async function deleteGoogleConfig(env, secret) {
  await disconnect(env, secret);
  await delSetting(env, 'int_google');
  await setSetting(env, 'env_import_google', String(Date.now()));   // 删除后不再从环境变量导入
  tokenCache.clear();
  return { ok: true };
}
const redirectUri = (origin) => `${origin}/api/google/callback`;

export async function authUrl(env, origin, secret, hmac) {
  const c = await googleCreds(env, secret);
  if (!c) throw new Error('未配置 Google OAuth 客户端');
  const exp = Date.now() + 10 * 60000;
  const state = `${exp}.${await hmac(secret, `goauth|${exp}`)}`;
  const q = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: redirectUri(origin),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent select_account',   // 每次都让用户选账号，方便添加第二个账号
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export async function handleCallback(env, url, secret, hmac, safeEqual) {
  const err = url.searchParams.get('error');
  if (err) return { error: err === 'access_denied' ? '已取消授权' : `授权失败：${err}` };
  const [exp, sig] = String(url.searchParams.get('state') || '').split('.');
  if (!exp || Number(exp) < Date.now() || !(await safeEqual(sig || '', await hmac(secret, `goauth|${exp}`), secret))) {
    return { error: '授权已过期，请重新连接' };
  }
  const c = await googleCreds(env, secret);
  if (!c) return { error: '未配置 Google OAuth 客户端' };
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: url.searchParams.get('code') || '',
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: redirectUri(url.origin),
      grant_type: 'authorization_code',
    }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.refresh_token) {
    const hint = d.error === 'invalid_client' ? '（客户端 ID 或密钥不对）' : d.error === 'redirect_uri_mismatch' ? '（回调地址和 Google Cloud 里填写的不一致）' : '';
    return { error: (d.error_description || d.error || '没有拿到刷新令牌，请重新连接') + hint };
  }
  let email = '', sub = '';
  try {
    const t = JSON.parse(atob(d.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    email = t.email || ''; sub = t.sub || '';
  } catch {}
  await accounts(env, secret);   // 先把旧版的单账号数据迁移过来
  // 同一个账号重新授权：更新令牌，保留原来的 id
  const ex = await env.DB.prepare('SELECT id FROM g_accounts WHERE id = ? OR (email != \'\' AND lower(email) = lower(?)) LIMIT 1').bind(sub, email).first();
  const id = ex?.id || sub || `e:${email.toLowerCase()}`;
  await env.DB.prepare(
    `INSERT INTO g_accounts (id, email, auth, connected_at, error) VALUES (?, ?, ?, ?, '')
     ON CONFLICT(id) DO UPDATE SET email = excluded.email, auth = excluded.auth, error = ''`
  ).bind(id, email, await seal(secret, { refresh: d.refresh_token, scope: d.scope }), Date.now()).run();
  tokenCache.set(id, { token: d.access_token, exp: Date.now() + (d.expires_in - 60) * 1000 });
  return { ok: true, email, id, existed: !!ex };
}

// 旧版只支持一个账号，令牌存在 settings.google_auth；第一次用到时搬进 g_accounts
let legacyChecked = false;
async function migrateLegacy(env, secret) {
  const s = await getSetting(env, 'google_auth');
  if (s) {
    try {
      const a = await unseal(secret, s);
      const id = `e:${String(a.email || '').toLowerCase()}`;
      await env.DB.batch([
        env.DB.prepare('INSERT OR IGNORE INTO g_accounts (id, email, auth, connected_at) VALUES (?, ?, ?, ?)')
          .bind(id, a.email || '', await seal(secret, { refresh: a.refresh, scope: a.scope }), a.at || Date.now()),
        env.DB.prepare("UPDATE g_sites SET ga4_acct = ? WHERE ga4_property != '' AND ga4_acct = ''").bind(id),
        env.DB.prepare("UPDATE g_sites SET gsc_acct = ? WHERE gsc_site != '' AND gsc_acct = ''").bind(id),
      ]);
    } catch {}
    await Promise.all(['google_auth', 'google_error', 'google_discovered'].map((k) => delSetting(env, k)));
  }
  legacyChecked = true;
}
async function accounts(env, secret) {
  if (!legacyChecked) await migrateLegacy(env, secret);
  return (await env.DB.prepare('SELECT * FROM g_accounts ORDER BY connected_at').all()).results;
}

// 每个账号的访问令牌缓存（同一个 Worker 实例内）
const tokenCache = new Map();

async function accessToken(env, secret, acct) {
  const hit = tokenCache.get(acct);
  if (hit && hit.exp > Date.now()) return hit.token;
  const row = acct && await env.DB.prepare('SELECT auth, email FROM g_accounts WHERE id = ?').bind(acct).first();
  if (!row) throw new Error('对应的 Google 账号已断开');
  let a;
  try { a = await unseal(secret, row.auth); } catch {
    await env.DB.prepare('UPDATE g_accounts SET error = ? WHERE id = ?').bind('令牌无法解密（会话密钥变了？），请重新连接', acct).run();
    throw new Error(`${row.email}：令牌无法解密，请重新连接`);
  }
  const c = await googleCreds(env, secret);
  if (!c) throw new Error('未配置 Google OAuth 客户端');
  spend();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: a.refresh,
      grant_type: 'refresh_token',
    }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 授权被撤销或已失效（例如测试状态的应用 7 天后过期）
    if (d.error === 'invalid_grant') await env.DB.prepare('UPDATE g_accounts SET error = ? WHERE id = ?').bind('授权已失效，请重新连接', acct).run();
    throw new Error(d.error === 'invalid_grant' ? `${row.email}：授权已失效，请重新连接` : d.error_description || d.error || 'Google 令牌刷新失败');
  }
  tokenCache.set(acct, { token: d.access_token, exp: Date.now() + (d.expires_in - 60) * 1000 });
  return d.access_token;
}

// 断开一个账号（id），或不传 id 时断开全部（更换 / 删除 OAuth 客户端时）
export async function disconnect(env, secret, id) {
  const list = (await accounts(env, secret)).filter((a) => !id || a.id === id);
  await Promise.all(list.map(async (a) => {
    try {
      const { refresh } = await unseal(secret, a.auth);
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, { method: 'POST' });
    } catch {}
    tokenCache.delete(a.id);
  }));
  if (!id) {
    await env.DB.batch(['g_accounts', 'g_sites', 'g_daily', 'g_cache', 'g_urls', 'g_sitemaps'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    await rebuildSites(env);   // Bing 的站点还在
    return;
  }
  await env.DB.prepare('DELETE FROM g_accounts WHERE id = ?').bind(id).run();
  await rebuildSites(env);
}

// 带令牌请求 Google 接口
export async function gfetch(env, secret, acct, url, body, method) {
  const token = await accessToken(env, secret, acct);
  spend();
  const res = await fetch(url, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = d.error?.message || `HTTP ${res.status}`;
    if (res.status === 429) throw Object.assign(new Error(`配额已用完：${msg}`), { quota: true });
    throw new Error(/has not been used|is disabled/i.test(msg) ? `接口未启用：${msg}` : msg);
  }
  return d;
}

// ---------------------------------------------------------------- 站点发现

// 列出一个账号的 GA4 媒体资源和 GSC 站点；某一项失败时返回 null，沿用上次的结果
// oldProps：上次发现的媒体资源（读取数据流失败时沿用上次的域名，避免站点对应关系来回变、数据被反复清空重填）
async function discoverAccount(env, secret, acct, oldProps = []) {
  // 令牌有问题时账号本身会标记错误（显示“重新连接”），这里不再重复报
  try { await accessToken(env, secret, acct); } catch (e) {
    const marked = await env.DB.prepare("SELECT error != '' AS bad FROM g_accounts WHERE id = ?").bind(acct).first('bad');
    return { props: null, gsc: null, errors: marked ? [] : [e.message], failed: true };
  }
  const errors = [];
  let props = [];
  try {
    let page = '';
    do {
      const d = await gfetch(env, secret, acct, `https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200${page ? `&pageToken=${page}` : ''}`);
      for (const a of d.accountSummaries || []) {
        for (const p of a.propertySummaries || []) props.push({ id: p.property.split('/')[1], name: p.displayName, account: a.displayName });
      }
      page = d.nextPageToken || '';
    } while (page);
  } catch (e) { errors.push(`GA4：${e.message}`); props = null; }

  // 每个媒体资源的网站数据流地址，用来确定域名。一次最多并发 5 个（一下子发几十个容易被限流）；
  // 某个读取失败时沿用上次的域名，而不是当成“没有域名”
  if (props) {
    const prevHost = new Map(oldProps.map((p) => [p.id, p.host])), prevCreated = new Map(oldProps.map((p) => [p.id, p.created]));
    let i = 0, failed = 0;
    const worker = async () => {
      while (i < props.length) {
        const p = props[i++];
        try {
          const d = await gfetch(env, secret, acct, `https://analyticsadmin.googleapis.com/v1beta/properties/${p.id}/dataStreams`);
          const web = (d.dataStreams || []).find((s) => s.webStreamData?.defaultUri);
          p.host = siteHost(web?.webStreamData?.defaultUri || '');
          // 网站数据流的创建时间：开始用 GA4 统计这个网站的时间，可以大致看作网站上线时间
          p.created = Date.parse(web?.createTime || '') || 0;
        } catch { p.host = prevHost.get(p.id) ?? ''; p.created = prevCreated.get(p.id) || 0; failed++; }
      }
    };
    await Promise.all(Array.from({ length: 5 }, worker));
    if (failed) console.warn(`GA4 数据流：${failed} 个读取失败，沿用上次的域名`);
  }

  let gsc = null;
  try {
    const d = await gfetch(env, secret, acct, 'https://www.googleapis.com/webmasters/v3/sites');
    gsc = (d.siteEntry || []).filter((s) => s.permissionLevel !== 'siteUnverifiedUser').map((s) => ({ url: s.siteUrl, host: siteHost(s.siteUrl) }));
  } catch (e) { errors.push(`Search Console：${e.message}`); }
  return { props, gsc, errors };
}

// 发现站点：只传 only 时只查这一个账号；其余账号用上次的结果
export async function discover(env, secret, only) {
  const now = Date.now();
  for (const a of await accounts(env, secret)) {
    if (only && a.id !== only) continue;
    const old = a.found ? JSON.parse(a.found) : {};
    const r = await discoverAccount(env, secret, a.id, old.props || []);
    const found = { props: r.props ?? old.props ?? [], gsc: r.gsc ?? old.gsc ?? [], errors: r.errors, failed: !!r.failed, at: now };
    await env.DB.prepare('UPDATE g_accounts SET found = ?, found_at = ? WHERE id = ?').bind(JSON.stringify(found), now, a.id).run();
  }
  return rebuildSites(env);
}

// AI 接口（GET /api/ai/sites）：所有站点的基本情况和近 28 天会话
export async function sitesForAi(env) {
  const rows = (await env.DB.prepare(`SELECT s.host, s.ga4_property, s.ga4_name, s.ga4_created, s.gsc_site, s.bing_site,
    (SELECT SUM(d.sessions) FROM g_daily d WHERE d.host = s.host AND d.date >= ?) AS sessions28,
    (SELECT SUM(d.clicks) FROM g_daily d WHERE d.host = s.host AND d.date >= ?) AS clicks28
    FROM g_sites s`).bind(ymd(Date.now() - 29 * DAY), ymd(Date.now() - 29 * DAY)).all()).results;
  return rows.map((r) => ({
    host: r.host, ga4: r.ga4_property ? { property: r.ga4_property, name: r.ga4_name, createdAt: r.ga4_created ? new Date(r.ga4_created).toISOString().slice(0, 10) : null } : null,
    gsc: !!r.gsc_site, bing: !!r.bing_site, sessions28: r.sessions28 ?? null, searchClicks28: r.clicks28 ?? null,
  })).sort((a, b) => (b.sessions28 || 0) - (a.sessions28 || 0) || a.host.localeCompare(b.host));
}

// 新建了 GA4 媒体资源（见 ga4admin.js）：直接加进这个账号上次的发现结果并合并站点，不用等下一次发现
export async function addProp(env, acct, prop) {
  const row = await env.DB.prepare('SELECT found FROM g_accounts WHERE id = ?').bind(acct).first();
  if (!row) return;
  const found = row.found ? JSON.parse(row.found) : { props: [], gsc: [], errors: [] };
  found.props = [...(found.props || []).filter((p) => p.id !== prop.id), prop];
  await env.DB.prepare('UPDATE g_accounts SET found = ? WHERE id = ?').bind(JSON.stringify(found), acct).run();
  await rebuildSites(env);
}

// 新加进 Search Console 的站点（见 onboard.js）：同样直接加进发现结果
export async function addGsc(env, acct, url) {
  const row = await env.DB.prepare('SELECT found FROM g_accounts WHERE id = ?').bind(acct).first();
  if (!row) return;
  const found = row.found ? JSON.parse(row.found) : { props: [], gsc: [], errors: [] };
  found.gsc = [...(found.gsc || []).filter((g) => g.url !== url), { url, host: siteHost(url) }];
  await env.DB.prepare('UPDATE g_accounts SET found = ? WHERE id = ?').bind(JSON.stringify(found), acct).run();
  await rebuildSites(env);
}
// 账号列表（给接入搜索引擎的弹窗选账号用）
export async function accountList(env, secret) {
  return Promise.all((await accounts(env, secret)).map(async (a) => ({ id: a.id, email: a.email, error: a.error || '',
    canVerify: await canVerify(env, secret, a.id), canSubmit: await canSubmit(env, secret, a.id) })));
}

// 把所有账号的发现结果按主域名合并进 g_sites。
// 同一个媒体资源 / 站点多个账号都能看到时，用最早连接的账号；同一域名有“网域”和“网址前缀”两种 GSC 资源时优先网域资源
export async function rebuildSites(env) {
  const accts = (await env.DB.prepare('SELECT id, found FROM g_accounts ORDER BY connected_at').all()).results
    .map((a) => ({ id: a.id, found: a.found ? JSON.parse(a.found) : null }));
  // 已有的对应关系优先保留：同一域名对应多个媒体资源 / 站点时，Google 返回的顺序变了也不换（否则会清空数据重新回填）
  const old = new Map((await env.DB.prepare('SELECT host, ga4_property, ga4_name, ga4_account, ga4_acct, ga4_created, gsc_site, gsc_acct, bing_site FROM g_sites').all()).results.map((r) => [r.host, r]));
  const sites = new Map();
  const get = (host) => {
    if (!sites.has(host)) sites.set(host, { host, ga4_property: '', ga4_name: '', ga4_account: '', ga4_acct: '', ga4_created: 0, gsc_site: '', gsc_acct: '', bing_site: '' });
    return sites.get(host);
  };
  for (const a of accts) {
    for (const p of a.found?.props || []) {
      const s = get(p.host || `ga4-${p.id}`);
      const keep = old.get(s.host)?.ga4_property;
      if (!s.ga4_property || (p.id === keep && s.ga4_property !== keep)) Object.assign(s, { ga4_property: p.id, ga4_name: p.name, ga4_account: p.account, ga4_acct: a.id, ga4_created: p.created || 0 });
    }
  }
  const gsc = accts.flatMap((a) => (a.found?.gsc || []).map((g) => ({ ...g, acct: a.id })));
  const dom = (g) => (g.url.startsWith('sc-domain:') ? 0 : 1);
  for (const g of gsc.sort((a, b) => dom(a) - dom(b))) {   // sort 是稳定的：同类里仍按账号连接顺序
    if (!g.host) continue;
    const s = get(g.host);
    const keep = old.get(g.host)?.gsc_site;
    if (!s.gsc_site || (g.url === keep && s.gsc_site !== keep)) Object.assign(s, { gsc_site: g.url, gsc_acct: g.acct });
  }

  // Bing Webmaster 的站点（bing.js 每天列一次，存在 settings.bing_found）；同一域名有多个时优先已验证的、https 的
  let bing = null;
  try { bing = JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key = 'bing_found'").first('value')) || 'null'); } catch {}
  const bscore = (b) => (b.verified ? 2 : 0) + (b.url.startsWith('https:') ? 1 : 0);
  for (const b of (bing?.sites || []).slice().sort((a, b2) => bscore(b2) - bscore(a))) {
    const s = get(b.host);
    if (!s.bing_site) s.bing_site = b.url;
  }

  const now = Date.now();
  const stmts = [];
  const COLS = ['ga4_property', 'ga4_name', 'ga4_account', 'ga4_acct', 'ga4_created', 'gsc_site', 'gsc_acct', 'bing_site'];
  for (const s of sites.values()) {
    const o = old.get(s.host);
    // 没变化的行不写（每天会重新合并好几次，158 个站点每次都写一遍很浪费）
    if (o && COLS.every((k) => (o[k] || '') === (s[k] || ''))) continue;
    stmts.push(env.DB.prepare(
      `INSERT INTO g_sites (host, ga4_property, ga4_name, ga4_account, ga4_acct, ga4_created, gsc_site, gsc_acct, bing_site, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(host) DO UPDATE SET ga4_property = excluded.ga4_property, ga4_name = excluded.ga4_name, ga4_account = excluded.ga4_account,
         ga4_acct = excluded.ga4_acct, ga4_created = excluded.ga4_created, gsc_site = excluded.gsc_site, gsc_acct = excluded.gsc_acct, bing_site = excluded.bing_site, updated_at = excluded.updated_at`
    ).bind(s.host, s.ga4_property, s.ga4_name, s.ga4_account, s.ga4_acct, s.ga4_created || 0, s.gsc_site, s.gsc_acct, s.bing_site, now));
    if (!o) continue;
    // 数据来源变了：清掉旧来源的每日数据，重新回填
    const gaChanged = o.ga4_property !== s.ga4_property, scChanged = o.gsc_site !== s.gsc_site;
    if (gaChanged) stmts.push(env.DB.prepare('UPDATE g_daily SET users = NULL, sessions = NULL, views = NULL, key_events = NULL, engagement = NULL WHERE host = ?').bind(s.host));
    if (scChanged) stmts.push(env.DB.prepare('UPDATE g_daily SET clicks = NULL, impressions = NULL, ctr = NULL, position = NULL WHERE host = ?').bind(s.host),
      env.DB.prepare('DELETE FROM g_urls WHERE host = ?').bind(s.host), env.DB.prepare('DELETE FROM g_sitemaps WHERE host = ?').bind(s.host));
    if (o.bing_site !== s.bing_site) {
      stmts.push(env.DB.prepare('UPDATE g_daily SET b_clicks = NULL, b_impressions = NULL WHERE host = ?').bind(s.host),
        env.DB.prepare(`UPDATE g_sites SET b_synced_at = 0, b_in_index = 0, b_error = '', ${BL_RESET} WHERE host = ?`).bind(s.host),
        // 换了 Bing 站点：网址重新排队检查；解除了关联：不再排队（免得占着队列）
        env.DB.prepare("UPDATE g_urls SET b_state = '', b_due_at = ?, b_submitted_at = 0 WHERE host = ?").bind(s.bing_site ? 0 : 9e15, s.host));
    }
    // GSC 和 Bing 都没关联了：网址清单和站点地图也删掉
    if (!s.gsc_site && !s.bing_site && (o.gsc_site || o.bing_site)) {
      stmts.push(env.DB.prepare('DELETE FROM g_urls WHERE host = ?').bind(s.host), env.DB.prepare('DELETE FROM g_sitemaps WHERE host = ?').bind(s.host));
    }
    if (gaChanged || scChanged) stmts.push(env.DB.prepare("UPDATE g_sites SET synced_at = 0, users = CASE WHEN ? THEN '' ELSE users END WHERE host = ?").bind(gaChanged ? 1 : 0, s.host));
  }
  // 不再出现在任何账号里的站点删掉（有账号这次查询出错时先保留，免得误删）
  const complete = accts.every((a) => a.found && !a.found.errors?.length && !a.found.failed) && !bing?.error;
  if (complete) {
    for (const host of old.keys()) {
      if (sites.has(host)) continue;
      stmts.push(env.DB.prepare('DELETE FROM g_sites WHERE host = ?').bind(host), env.DB.prepare('DELETE FROM g_daily WHERE host = ?').bind(host),
        env.DB.prepare('DELETE FROM site_ignores WHERE host = ?').bind(host),
        env.DB.prepare('DELETE FROM g_urls WHERE host = ?').bind(host), env.DB.prepare('DELETE FROM g_sitemaps WHERE host = ?').bind(host));
    }
  }
  // 有变化才更新数据版本；站点本身变了（新站点、关联关系、GA4 接入时间）另记 sites_ver，站点列表的缓存立即失效
  if (stmts.length) stmts.push(gVerStmt(env), env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('sites_ver', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).bind(String(now), now));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { sites: sites.size, changed: stmts.length };
}

// ---------------------------------------------------------------- 同步每日数据

async function syncSite(env, secret, s) {
  const first = !s.synced_at;
  // 复查窗口：GA4 的数据一两天内就定了，Search Console 要三四天；首次同步回填 16 个月
  const day = (n) => ymd(Date.now() - n * DAY);
  const end = ymd(Date.now());
  const gaStart = day(first ? BACKFILL_DAYS : GA_REFRESH), scStart = day(first ? BACKFILL_DAYS : SC_REFRESH);
  const chStart = s.ch_at ? gaStart : day(CHANNEL_DAYS);
  const stmts = [], errors = [];
  // 只写有变化的行：先读出窗口内已有的数据比对（读比写便宜得多）
  const from = [gaStart, scStart, chStart].sort()[0];
  const old = new Map((await env.DB.prepare('SELECT * FROM g_daily WHERE host = ? AND date >= ?').bind(s.host, from).all()).results.map((r) => [r.date, r]));
  const same = (a, b) => (a == null || b == null ? a == null && b == null : Math.abs(a - b) < 1e-9);
  if (s.ga4_property) {
    try {
      const d = await gfetch(env, secret, s.ga4_acct, `https://analyticsdata.googleapis.com/v1beta/properties/${s.ga4_property}:runReport`, {
        dateRanges: [{ startDate: gaStart, endDate: end }],
        dimensions: [{ name: 'date' }],
        metrics: ['activeUsers', 'sessions', 'screenPageViews', 'keyEvents', 'engagementRate'].map((name) => ({ name })),
        limit: 1000,
      });
      for (const r of d.rows || []) {
        const v = r.dateValue || r.dimensionValues[0].value;
        const date = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
        const m = r.metricValues.map((x) => Number(x.value) || 0);
        const o = old.get(date);
        if (o && ['users', 'sessions', 'views', 'key_events', 'engagement'].every((k, i) => same(o[k], m[i]))) continue;
        stmts.push(env.DB.prepare(
          `INSERT INTO g_daily (host, date, users, sessions, views, key_events, engagement) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(host, date) DO UPDATE SET users = excluded.users, sessions = excluded.sessions, views = excluded.views,
             key_events = excluded.key_events, engagement = excluded.engagement`
        ).bind(s.host, date, ...m));
      }
    } catch (e) { if (e.budget) throw e; errors.push(`GA4：${e.message}`); }
    // 每天的渠道分组会话数（存成 JSON），首次补一年
    try {
      const d = await gfetch(env, secret, s.ga4_acct, `https://analyticsdata.googleapis.com/v1beta/properties/${s.ga4_property}:runReport`, {
        dateRanges: [{ startDate: chStart, endDate: end }],
        dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
        metrics: [{ name: 'sessions' }],
        limit: 25000,
      });
      const byDay = new Map();
      for (const r of d.rows || []) {
        const v = r.dimensionValues[0].value, ch = r.dimensionValues[1].value || 'Unassigned';
        const date = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
        if (!byDay.has(date)) byDay.set(date, {});
        byDay.get(date)[ch] = Number(r.metricValues[0].value) || 0;
      }
      const norm = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1))));
      for (const [date, ch] of byDay) {
        const val = norm(ch), o = old.get(date)?.channels;
        if (o && (() => { try { return norm(JSON.parse(o)) === val; } catch { return false; } })()) continue;
        stmts.push(env.DB.prepare('INSERT INTO g_daily (host, date, channels) VALUES (?, ?, ?) ON CONFLICT(host, date) DO UPDATE SET channels = excluded.channels')
          .bind(s.host, date, val));
      }
      if (!s.ch_at) stmts.push(env.DB.prepare('UPDATE g_sites SET ch_at = ? WHERE host = ?').bind(Date.now(), s.host));
    } catch (e) { if (e.budget) throw e; errors.push(`GA4 渠道：${e.message}`); }
  }
  if (s.gsc_site) {
    try {
      const d = await gfetch(env, secret, s.gsc_acct, `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(s.gsc_site)}/searchAnalytics/query`, {
        startDate: scStart, endDate: end, dimensions: ['date'], rowLimit: 1000, dataState: 'all',
      });
      for (const r of d.rows || []) {
        const m = [r.clicks || 0, r.impressions || 0, r.ctr || 0, r.position || 0];
        const o = old.get(r.keys[0]);
        if (o && ['clicks', 'impressions', 'ctr', 'position'].every((k, i) => same(o[k], m[i]))) continue;
        stmts.push(env.DB.prepare(
          `INSERT INTO g_daily (host, date, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(host, date) DO UPDATE SET clicks = excluded.clicks, impressions = excluded.impressions,
             ctr = excluded.ctr, position = excluded.position`
        ).bind(s.host, r.keys[0], ...m));
      }
    } catch (e) { if (e.budget) throw e; errors.push(`GSC：${e.message}`); }
  }
  // 区间去重用户数（GA4 按天的用户数不能直接相加）
  if (s.ga4_property) {
    try {
      const y = (n) => ymd(Date.now() - n * DAY);
      // 每个区间和它的上一周期：键 7 / p7、28 / p28……；一次请求最多 4 个区间
      const ranges = RANGE_DAYS.flatMap((n) => [[String(n), n, 1], [`p${n}`, n * 2, n + 1]]);
      const users = {};
      for (let i = 0; i < ranges.length; i += 4) {
        const part = ranges.slice(i, i + 4);
        const d = await gfetch(env, secret, s.ga4_acct, `https://analyticsdata.googleapis.com/v1beta/properties/${s.ga4_property}:runReport`, {
          dateRanges: part.map(([k, a, b]) => ({ startDate: y(a), endDate: y(b), name: `r${k}` })),
          metrics: [{ name: 'activeUsers' }],
        });
        for (const r of d.rows || []) {
          const name = r.dimensionValues?.find((x) => /^rp?\d+$/.test(x.value))?.value;
          if (name) users[name.slice(1)] = Number(r.metricValues[0].value) || 0;
        }
        for (const [k] of part) users[k] ??= 0;
      }
      const val = JSON.stringify(Object.fromEntries(Object.entries(users).sort(([a], [b]) => (a < b ? -1 : 1))));
      let prevVal = '';
      try { prevVal = s.users ? JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(s.users)).sort(([a], [b]) => (a < b ? -1 : 1)))) : ''; } catch {}
      if (val !== prevVal) stmts.push(env.DB.prepare('UPDATE g_sites SET users = ? WHERE host = ?').bind(val, s.host));
    } catch (e) { if (e.budget) throw e; errors.push(`GA4 用户：${e.message}`); }
  }
  // 有数据变化时更新版本号，站点列表的缓存据此失效（没变化就继续用缓存）
  const err = errors.join('；');
  if (stmts.length || err !== (s.error || '')) stmts.push(gVerStmt(env));
  stmts.push(env.DB.prepare('UPDATE g_sites SET synced_at = ?, error = ? WHERE host = ?').bind(Date.now(), err, s.host));
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return errors;
}

// Google 数据版本号：每日数据、站点对应关系、区间用户数变了就更新
export const gVerStmt = (env) => env.DB.prepare(
  "INSERT INTO settings (key, value, updated_at) VALUES ('g_ver', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
).bind(String(Date.now()), Date.now());

// 一次最多同步 limit 个站点（每个约 3 个请求），按最久未同步优先；返回剩余待同步数。
// cutoff：同步时间早于它的站点才同步（默认 6 小时前）；手动“全部同步”时传入开始同步的时刻
export async function syncBatch(env, secret, { limit = 12, cutoff = Date.now() - 6 * 3600000 } = {}) {
  const accts = await accounts(env, secret);
  if (!accts.length) return { skipped: true };
  // 回填天数加长后，所有站点重新回填一次
  if ((await getSetting(env, 'g_backfill')) !== String(BACKFILL_DAYS)) {
    await env.DB.prepare('UPDATE g_sites SET synced_at = 0').run();
    await setSetting(env, 'g_backfill', String(BACKFILL_DAYS));
  }
  // 每个账号每天重新发现一次站点；每次最多一个（最久没查的），多个账号同时到期时分到之后几个小时，不挤在一次里
  const dueAcct = accts.filter((x) => x.found_at < Date.now() - DAY).sort((a, b) => a.found_at - b.found_at)[0];
  if (dueAcct) await discover(env, secret, dueAcct.id);
  // 还没补过渠道数据的 GA4 站点也算待同步（升级后一次性补）
  const DUE = `synced_at < ? OR (ga4_property IS NOT NULL AND ga4_property != '' AND ch_at = 0)`;
  const due = (await env.DB.prepare(`SELECT * FROM g_sites WHERE ${DUE} ORDER BY ch_at > 0, synced_at LIMIT ?`)
    .bind(cutoff, limit).all()).results;
  let done = 0;
  for (const s of due) {
    try { await syncSite(env, secret, s); done++; } catch (e) { if (e.budget) break; throw e; }
  }
  const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM g_sites WHERE ${DUE}`).bind(cutoff).first('n');
  return { done, left };
}

// ---------------------------------------------------------------- 读取

// 站点地图里有新网址或网页更新时，定时任务自动把站点地图重新提交给 Google（默认开启；sm_auto 是早先 Google / Bing 共用的开关）
export const smAutoGoogle = async (env) => ((await getSetting(env, 'sm_auto_g')) ?? (await getSetting(env, 'sm_auto'))) !== '0';
export async function setSmAutoGoogle(env, on) {
  await setSetting(env, 'sm_auto_g', on ? '1' : '0');
}

export async function status(env, secret) {
  const c = await googleCreds(env, secret);
  if (!c) return { configured: false };
  const config = { source: c.source, clientId: c.clientId, secretTail: c.clientSecret.slice(-4) };
  const [accts, cnt, last] = await Promise.all([
    accounts(env, secret),
    env.DB.prepare('SELECT COUNT(*) AS n FROM g_sites').first('n'),
    env.DB.prepare('SELECT MAX(synced_at) AS t, SUM(synced_at = 0) AS pending FROM g_sites').first(),
  ]);
  await Promise.all(accts.map(async (a) => {
    try { const sc = String((await unseal(secret, a.auth)).scope || '').split(/\s+/); a._w = sc.includes(SC_WRITE); a._e = sc.includes(GA_EDIT); a._v = sc.includes(SITE_VERIFY); } catch { a._w = a._e = a._v = false; }
  }));
  const list = accts.map((a) => {
    const f = a.found ? JSON.parse(a.found) : null;
    return { id: a.id, email: a.email, connectedAt: a.connected_at, error: a.error || '', canSubmit: !!a._w, canEdit: !!a._e, canVerify: !!a._v,
      ga4: f ? f.props.length : null, gsc: f ? f.gsc.length : null, errors: f?.errors || [], discoveredAt: a.found_at || null };
  });
  const many = list.length > 1;
  return {
    configured: true, config, connected: list.length > 0, accounts: list,
    // 汇总的错误提示：多个账号时前面带上邮箱
    error: list.filter((a) => a.error).map((a) => `${a.email}：${a.error}`).join('；'),
    errors: list.flatMap((a) => (a.error ? [] : a.errors.map((e) => (many ? `${a.email} · ${e}` : e)))),
    sites: cnt || 0, lastSync: last?.t || null, pending: last?.pending || 0, smAuto: await smAutoGoogle(env),
  };
}

const sumRange = (rows, from, to) => {
  const t = { users: 0, sessions: 0, views: 0, key_events: 0, clicks: 0, impressions: 0, posw: 0, engw: 0, hasGa: false, hasGsc: false, ch: null, bc: 0, bi: 0, hasBing: false };
  for (const r of rows) {
    if (r.date < from || r.date > to) continue;
    if (r.channels) {
      t.ch ??= {};
      try { for (const [k, n] of Object.entries(JSON.parse(r.channels))) t.ch[k] = (t.ch[k] || 0) + n; } catch {}
    }
    if (r.sessions != null) {
      t.hasGa = true; t.users += r.users; t.sessions += r.sessions; t.views += r.views; t.key_events += r.key_events;
      t.engw += (r.engagement || 0) * r.sessions;
    }
    if (r.clicks != null) { t.hasGsc = true; t.clicks += r.clicks; t.impressions += r.impressions; t.posw += (r.position || 0) * r.impressions; }
    if (r.b_clicks != null) { t.hasBing = true; t.bc += r.b_clicks; t.bi += r.b_impressions || 0; }
  }
  return {
    ga: t.hasGa ? { sessions: t.sessions, views: t.views, keyEvents: t.key_events, engagement: t.sessions ? t.engw / t.sessions : 0, ...(t.ch ? { channels: t.ch } : {}) } : null,
    gsc: t.hasGsc ? { clicks: t.clicks, impressions: t.impressions, ctr: t.impressions ? t.clicks / t.impressions : 0, position: t.impressions ? t.posw / t.impressions : 0 } : null,
    bing: t.hasBing ? { clicks: t.bc, impressions: t.bi, ctr: t.bi ? Math.min(1, t.bc / t.bi) : 0 } : null,
  };
};

// 区间：截至昨天的 days 天（GSC 数据通常延迟 2–3 天，最近两天会偏低）
export function ranges(days) {
  const to = ymd(Date.now() - DAY), from = ymd(Date.now() - days * DAY);
  const pto = ymd(Date.now() - (days + 1) * DAY), pfrom = ymd(Date.now() - days * 2 * DAY);
  return { from, to, pfrom, pto };
}

// 站点列表缓存 5 分钟；数据版本（Google 数据版本、访问汇总进度、短链改动、账号数）变了就重算。
// 其中按天汇总 Google 数据的部分最耗读取，单独按 Google 数据版本缓存，访问汇总每小时推进时不用重读
// fresh：刚手动同步完，Google / Bing 数据变了就重算（不沿用一小时内的旧结果）
export async function sitesList(env, days, { fresh = false } = {}) {
  const v = await env.DB.prepare(`SELECT
      COALESCE((SELECT value FROM settings WHERE key = 'g_ver'), '0') || ':' || (SELECT COUNT(*) FROM g_sites) AS g,
      (SELECT value FROM settings WHERE key = 'agg_mark') AS a,
      (SELECT COALESCE(MAX(updated_at), 0) || ':' || COUNT(*) FROM links) AS l,
      (SELECT COALESCE(MAX(updated_at), 0) || ':' || COUNT(*) FROM link_targets) AS t,
      (SELECT COUNT(*) FROM g_accounts) AS n,
      (SELECT value FROM settings WHERE key = 'tags_ver') AS tv,
      (SELECT value FROM settings WHERE key = 'bl_ver') AS bv,
      (SELECT value FROM settings WHERE key = 'sites_ver') AS sv`).first();
  // 固定的缓存键（每个时间范围一行，覆盖写，不会越积越多）；版本存在值里。
  // 短链、分组、访问汇总、外链开关、站点本身（新站点、关联关系、GA4 接入时间）变了立即重算；
  // Google / Bing 数据每小时都会小幅更新，变了以后最多沿用一小时
  const rest = `${ranges(days).to}|${v.a}|${v.l}|${v.t}|${v.n}|${v.tv || 0}|${v.bv || 0}|${v.sv || 0}`;
  const hit = await cacheGet(env, `sites|${days}`);
  if (hit && hit.rest === rest && (hit.g === v.g || (!fresh && hit.at > Date.now() - 3600000))) return hit.data;
  const out = await sitesListRaw(env, days, v.g, fresh);
  await cachePut(env, `sites|${days}`, { rest, g: v.g, at: Date.now(), data: out });
  return out;
}

// g_cache 的读写：值是 JSON；D1 单个值最大 2 MB，超过 1.5 MB 就不缓存
async function cacheGet(env, k) {
  const row = await env.DB.prepare('SELECT v FROM g_cache WHERE k = ?').bind(k).first().catch(() => null);
  if (!row) return null;
  try { return JSON.parse(row.v); } catch { return null; }
}
async function cachePut(env, k, val) {
  const body = JSON.stringify(val);
  if (body.length >= 1.5e6) return;
  await env.DB.prepare('INSERT INTO g_cache (k, v, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at')
    .bind(k, body, Date.now()).run().catch(() => {});
}

// 每个站点区间内的 Google / Bing 数据汇总和每日序列。按日期范围读 g_daily（有日期索引），是站点列表最耗读取的部分：
// 数据版本没变就一直用缓存；变了（每小时同步都会小幅更新）最多沿用一小时再重算
async function sitesDaily(env, days, ver, fresh = false) {
  const { from, to, pfrom, pto } = ranges(days);
  const hit = await cacheGet(env, `sitesd|${days}`);
  if (hit && hit.to === to && (hit.ver === ver || (!fresh && hit.at > Date.now() - 3600000))) return hit.data;
  const rows = (await env.DB.prepare('SELECT * FROM g_daily WHERE date >= ? AND date <= ?').bind(pfrom, to).all()).results;
  const byHost = new Map();
  for (const r of rows) { if (!byHost.has(r.host)) byHost.set(r.host, []); byHost.get(r.host).push(r); }
  const out = {};
  for (const [host, rs] of byHost) {
    out[host] = {
      cur: sumRange(rs, from, to), prev: hasPrev(days) ? sumRange(rs, pfrom, pto) : { ga: null, gsc: null },
      // 每日：n 会话、c 搜索点击、u 用户（按天）、i 搜索展示；prevSpark 是上一周期每天的会话
      spark: rs.filter((r) => r.date >= from).sort((a, b) => (a.date < b.date ? -1 : 1))
        .map((r) => ({ k: r.date, n: r.sessions ?? 0, c: r.clicks ?? 0, u: r.users ?? 0, i: r.impressions ?? 0, bc: r.b_clicks ?? 0, bi: r.b_impressions ?? 0 })),
      prevSpark: hasPrev(days) ? rs.filter((r) => r.date >= pfrom && r.date <= pto).map((r) => ({ k: r.date, n: r.sessions ?? 0 })) : [],
    };
  }
  await cachePut(env, `sitesd|${days}`, { to, ver, at: Date.now(), data: out });
  return out;
}

// 外链与权重（设置里开启后才查，见 backlinks.js）：没查到时为 null。opr.s 为 null 表示 Open PageRank 里没有这个域名
const oprHist = (s) => { try { return s.opr_hist ? JSON.parse(s.opr_hist) : []; } catch { return []; } };
function blFields(s, detail = false) {
  const hist = oprHist(s);
  const out = {
    bl: s.bl_total >= 0 ? { n: s.bl_total, p: s.bl_pages, more: !!s.bl_more, prev: s.bl_prev >= 0 ? s.bl_prev : null, at: s.bl_at } : null,
    blError: s.bl_error || '',
    // prev：上个月的分数（Open PageRank 每月更新一次）
    opr: s.opr_at ? { s: s.opr >= 0 ? s.opr : null, r: s.opr_rank || null, d: s.opr_ref || 0, prev: s.opr >= 0 && hist.length > 1 ? hist[hist.length - 2][1] : null, at: s.opr_at } : null,
  };
  if (detail) {
    let top = [];
    try { top = s.bl_top ? JSON.parse(s.bl_top) : []; } catch {}
    out.blTop = top;
    if (out.opr) out.opr.hist = hist;
  }
  return out;
}

async function sitesListRaw(env, days, ver, fresh = false) {
  const [sites, daily] = await Promise.all([
    env.DB.prepare(`SELECT s.*, a.email AS ga4_email, b.email AS gsc_email, m.n_urls, m.n_yes, m.n_done, m.nb_yes, m.nb_done,
      m.c_mod, m.c_trust, m.c_seen, m.c_since, m.c_new30, m.c_upd30 FROM g_sites s
      LEFT JOIN g_accounts a ON a.id = s.ga4_acct LEFT JOIN g_accounts b ON b.id = s.gsc_acct LEFT JOIN g_sitemaps m ON m.host = s.host ORDER BY s.host`).all().then((r) => r.results),
    sitesDaily(env, days, ver, fresh),
  ]);
  const hostSet = new Set(sites.map((s) => s.host));
  const tagRows = (await env.DB.prepare('SELECT host, tag FROM site_tags ORDER BY tag').all()).results;
  const tagsOf = new Map();
  for (const t of tagRows) { if (!tagsOf.has(t.host)) tagsOf.set(t.host, []); tagsOf.get(t.host).push(t.tag); }
  const [sl, sf] = await Promise.all([siteLinks(env, hostSet, days).catch(() => new Map()), siteSources(env, hostSet, days).catch(() => new Map())]);
  const EMPTY = { cur: { ga: null, gsc: null, bing: null }, prev: { ga: null, gsc: null, bing: null }, spark: [], prevSpark: [] };
  return sites.map((s) => {
    const g = daily[s.host] || EMPTY;
    const users = s.users ? JSON.parse(s.users) : {};
    return {
      host: s.host, chReady: !!s.ch_at, ga4: s.ga4_property ? { property: s.ga4_property, name: s.ga4_name, account: s.ga4_account, acct: s.ga4_acct, email: s.ga4_email || '', created: s.ga4_created || null } : null,
      gsc: s.gsc_site || null, gscAcct: s.gsc_acct || '', gscEmail: s.gsc_email || '', syncedAt: s.synced_at || null, error: s.error || '',
      users: users[days] ?? null, prevUsers: hasPrev(days) ? users[`p${days}`] ?? null : null,
      tags: tagsOf.get(s.host) || [],
      // 网页索引：网址数、已编入、已检查出结果的数量（还没刷新过站点地图时为 null）
      index: (s.gsc_site || s.bing_site) && s.n_urls != null ? { urls: s.n_urls, yes: s.n_yes, done: s.n_done, byes: s.nb_yes, bdone: s.nb_done } : null,
      content: (s.gsc_site || s.bing_site) ? contentOf(s) : null,   // 内容更新时间（按站点地图推测）
      bing: s.bing_site || null, bingInIndex: s.bing_site ? s.b_in_index || 0 : null, bingError: s.b_error || '', bingSyncedAt: s.b_synced_at || null,
      links: sl.get(s.host) || [],          // 跳转到这个站点的短链
      linksFrom: sf.get(s.host) || [],      // 从这个站点点出的短链
      linksFromVisitors: sf.visitors?.get(s.host) ?? null,   // 这些点击来自多少位访客（去重）
      cur: g.cur, prev: g.prev, spark: g.spark, prevSpark: g.prevSpark,
      ...blFields(s),
    };
  });
}

// ---------------------------------------------------------------- 站点分组
export async function tagsList(env) {
  return (await env.DB.prepare('SELECT tag, COUNT(*) AS n FROM site_tags GROUP BY tag ORDER BY tag').all()).results;
}
// 批量加 / 去掉分组；rename：把一个分组改名（合并到已有分组也可以）
export async function tagsUpdate(env, b) {
  const tag = String(b.tag || '').trim().slice(0, 40);
  const hosts = (Array.isArray(b.hosts) ? b.hosts : []).map(String).slice(0, 1000);
  const stmts = [];
  if (b.rename) {
    const to = String(b.rename).trim().slice(0, 40);
    if (!tag || !to) return { error: '分组名不能为空' };
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO site_tags (host, tag) SELECT host, ? FROM site_tags WHERE tag = ?').bind(to, tag),
      env.DB.prepare('DELETE FROM site_tags WHERE tag = ? AND tag != ?').bind(tag, to));
  } else if (b.drop) {
    stmts.push(env.DB.prepare('DELETE FROM site_tags WHERE tag = ?').bind(tag));
  } else {
    if (!tag) return { error: '请填写分组名' };
    if (!hosts.length) return { error: '没有选中站点' };
    for (const h of hosts) stmts.push(b.remove
      ? env.DB.prepare('DELETE FROM site_tags WHERE host = ? AND tag = ?').bind(h, tag)
      : env.DB.prepare('INSERT OR IGNORE INTO site_tags (host, tag) VALUES (?, ?)').bind(h, tag));
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  await setSetting(env, 'tags_ver', String(Date.now()));   // 让站点列表缓存失效
  return { ok: true, tags: await tagsList(env) };
}

// ---------------------------------------------------------------- 短链 ↔ 站点
// 按短链的跳转去向（默认地址、各条地区规则）的域名匹配站点：域名相同，或是站点的子域名。
// 点击数读访问汇总 agg_d 里按规则（dim = 'rule'）的数据，所以一条短链的不同去向会分别算到各自的站点。

// 找域名对应的站点：a.b.example.com → b.example.com → example.com
export function matchHost(host, hosts) {
  for (let h = host; h && h.includes('.'); h = h.slice(h.indexOf('.') + 1)) if (hosts.has(h)) return h;
  return null;
}

// 访问来源 → 站点：来源是域名时按域名（含子域名、忽略 www.）匹配；
// 是不带点的名字（如 ?src=gaterar）时，只有一个站点的主名称与它相同才算
export function sourceSite(k, hosts, labels) {
  const v = String(k || '').trim().toLowerCase().replace(/^www\./, '');
  if (!v || v === '(direct)') return null;
  if (v.includes('.')) return matchHost(v, hosts);
  const hit = labels.get(v);
  return hit && hit.length === 1 ? hit[0] : null;
}

// 从站点点出的短链：按访问来源（?src= / utm_source 优先，其次 Referer 域名）匹配站点。
// 返回 Map：站点 → [{ id, slug, title, cur, human, prev, prevHuman, daily }]
async function siteSources(env, hosts, days) {
  const { from, to, pfrom } = ranges(days);
  const labels = new Map();
  for (const h of hosts) { const l = h.split('.')[0]; if (!labels.has(l)) labels.set(l, []); labels.get(l).push(h); }
  const [links, counts, daily, uvs] = await Promise.all([
    env.DB.prepare('SELECT id, slug, title FROM links').all().then((r) => r.results),
    env.DB.prepare(
      `SELECT link_id, k, machine, SUM(CASE WHEN day >= ? THEN n ELSE 0 END) AS cur, SUM(CASE WHEN day < ? THEN n ELSE 0 END) AS prev
       FROM agg_d WHERE dim = 'source' AND day >= ? AND day <= ? AND k != '(direct)' GROUP BY link_id, k, machine`
    ).bind(from, from, pfrom, to).all().then((r) => r.results),
    env.DB.prepare(
      `SELECT link_id, k, day, SUM(n) AS n FROM agg_d WHERE dim = 'source' AND machine = 0 AND day >= ? AND day <= ? AND k != '(direct)' GROUP BY link_id, k, day`
    ).bind(from, to).all().then((r) => r.results),
    sourceUv(env, from, to).catch(() => []),
  ]);
  const byId = new Map(links.map((l) => [l.id, l]));
  const out = new Map();
  const entry = (site, id) => {
    if (!out.has(site)) out.set(site, new Map());
    const m = out.get(site), l = byId.get(id);
    if (!m.has(id)) m.set(id, { id, slug: l.slug, title: l.title, cur: 0, human: 0, prev: 0, prevHuman: 0, daily: {}, sources: new Set() });
    return m.get(id);
  };
  const siteOf = new Map();
  const site = (k) => { if (!siteOf.has(k)) siteOf.set(k, sourceSite(k, hosts, labels)); return siteOf.get(k); };
  for (const c of counts) {
    const h = site(c.k);
    if (!h || !byId.has(c.link_id)) continue;
    const e = entry(h, c.link_id);
    e.cur += c.cur; e.prev += c.prev; e.sources.add(c.k);
    if (!c.machine) { e.human += c.cur; e.prevHuman += c.prev; }
  }
  for (const d of daily) {
    const h = site(d.k);
    if (!h || !byId.has(d.link_id)) continue;
    const e = entry(h, d.link_id);
    e.daily[d.day] = (e.daily[d.day] || 0) + d.n;
  }
  // 独立访客：同一个短链在这个站点的所有来源标识合并去重（HyperLogLog 估算）；站点合计跨短链再合并一次
  const regs = new Map(), siteRegs = new Map();
  for (const u of uvs) {
    const h = site(u.k);
    if (!h || !byId.has(u.link_id)) continue;
    const key = `${h}|${u.link_id}`;
    regs.set(key, hllMerge(regs.get(key) || hllNew(), u.reg));
    siteRegs.set(h, hllMerge(siteRegs.get(h) || hllNew(), u.reg));
  }
  const res = new Map([...out].map(([k, m]) => [k, [...m.values()].map((e) => ({ ...e, sources: [...e.sources], visitors: regs.has(`${k}|${e.id}`) ? Math.min(hllCount(regs.get(`${k}|${e.id}`)), e.human) : null }))
    .filter((e) => e.cur > 0).sort((a, b) => b.human - a.human || b.cur - a.cur)]));
  // 站点访客封顶为站点的真人点击数（估算误差）
  res.visitors = new Map([...siteRegs].map(([k, r]) => [k, Math.min(hllCount(r), (res.get(k) || []).reduce((a, e) => a + e.human, 0))]));
  return res;
}

// 返回 Map：站点 → [{ id, slug, title, routes: [{ rule, url, countries }], cur, human, prev }]
async function siteLinks(env, hosts, days) {
  const { from, to, pfrom } = ranges(days);
  const [links, rules, counts, daily] = await Promise.all([
    env.DB.prepare('SELECT id, slug, title, target_url FROM links').all().then((r) => r.results),
    env.DB.prepare('SELECT id, link_id, url, countries, devices, ab_of FROM link_targets').all().then((r) => r.results),
    env.DB.prepare(
      `SELECT link_id, k, machine, SUM(CASE WHEN day >= ? THEN n ELSE 0 END) AS cur, SUM(CASE WHEN day < ? THEN n ELSE 0 END) AS prev
       FROM agg_d WHERE dim = 'rule' AND day >= ? AND day <= ? GROUP BY link_id, k, machine`
    ).bind(from, from, pfrom, to).all().then((r) => r.results),
    env.DB.prepare(
      `SELECT link_id, k, day, SUM(n) AS n FROM agg_d WHERE dim = 'rule' AND machine = 0 AND day >= ? AND day <= ? GROUP BY link_id, k, day`
    ).bind(from, to).all().then((r) => r.results),
  ]);
  const dayCnt = new Map();   // 短链|规则 → { 日期: 真人点击 }
  for (const d of daily) {
    const key = `${d.link_id}|${d.k}`;
    if (!dayCnt.has(key)) dayCnt.set(key, {});
    dayCnt.get(key)[d.day] = d.n;
  }
  const byId = new Map(links.map((l) => [l.id, l]));
  // 每个去向：短链 + 规则 → 站点
  const routes = [];
  for (const l of links) if (l.target_url) routes.push({ link: l, rule: '0', url: l.target_url, countries: '', devices: '' });
  // A/B 分流地址沿用所属去向（默认地址或规则）的国家 / 设备
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  for (const r of rules) {
    if (!byId.has(r.link_id)) continue;
    const p = r.ab_of > 0 ? ruleById.get(r.ab_of) : r.ab_of === 0 ? null : r;
    routes.push({ link: byId.get(r.link_id), rule: String(r.id), url: r.url, countries: p?.countries || '', devices: p?.devices || '', ab: r.ab_of >= 0, parent: r.ab_of > 0 ? r.ab_of : 0 });
  }
  const cnt = new Map();
  for (const c of counts) {
    const key = `${c.link_id}|${c.k}`;
    const t = cnt.get(key) || { cur: 0, human: 0, prev: 0, prevHuman: 0 };
    t.cur += c.cur; t.prev += c.prev;
    if (!c.machine) { t.human += c.cur; t.prevHuman += c.prev; }
    cnt.set(key, t);
  }
  const out = new Map();
  for (const r of routes) {
    const site = matchHost(siteHost(r.url), hosts);
    if (!site) continue;
    if (!out.has(site)) out.set(site, new Map());
    const m = out.get(site);
    if (!m.has(r.link.id)) m.set(r.link.id, { id: r.link.id, slug: r.link.slug, title: r.link.title, routes: [], cur: 0, human: 0, prev: 0, prevHuman: 0, daily: {} });
    const e = m.get(r.link.id), c = cnt.get(`${r.link.id}|${r.rule}`);
    for (const [day, n] of Object.entries(dayCnt.get(`${r.link.id}|${r.rule}`) || {})) e.daily[day] = (e.daily[day] || 0) + n;
    e.routes.push({ rule: Number(r.rule), url: r.url, countries: r.countries, devices: r.devices, ...(r.ab ? { ab: true, parent: r.parent } : {}) });
    if (c) { e.cur += c.cur; e.human += c.human; e.prev += c.prev; e.prevHuman += c.prevHuman; }
  }
  return new Map([...out].map(([k, m]) => [k, [...m.values()].sort((a, b) => b.human - a.human || b.cur - a.cur)]));
}

// 一条短链指向的站点（短链详情页用）：每个去向匹配到的站点及其区间数据
export async function linkSites(env, linkId, days, secret) {
  const l = await env.DB.prepare('SELECT slug, target_url, utm FROM links WHERE id = ?').bind(linkId).first();
  if (!l) return { targets: [], sources: [] };
  const urls = [l.target_url, ...(await env.DB.prepare('SELECT url FROM link_targets WHERE link_id = ?').bind(linkId).all()).results.map((r) => r.url)].filter(Boolean);
  const list = await sitesList(env, days);
  const hosts = new Set(list.map((x) => x.host));
  const want = new Set(urls.map((u) => matchHost(siteHost(u), hosts)).filter(Boolean));
  const pick = (x) => ({ ...x, links: (x.links || []).filter((e) => e.id === linkId), linksFrom: (x.linksFrom || []).filter((e) => e.id === linkId) });
  const targets = list.filter((x) => want.has(x.host)).map(pick);
  // 转化追踪：GA4 里来源为 cligc、广告系列为这个短链后缀的会话
  if (l.utm && secret) {
    const { from, to } = ranges(days);
    await Promise.all(targets.map(async (x) => {
      const s = await env.DB.prepare('SELECT ga4_property, ga4_acct FROM g_sites WHERE host = ?').bind(x.host).first();
      if (!s?.ga4_property) return;
      try {
        x.conversion = await cached(env, `conv|${s.ga4_property}|${l.slug}|${days}|${to}`, 3600000, async () => {
          const d = await gfetch(env, secret, s.ga4_acct, `https://analyticsdata.googleapis.com/v1beta/properties/${s.ga4_property}:runReport`, {
            dateRanges: [{ startDate: from, endDate: to }],
            metrics: ['sessions', 'engagedSessions', 'keyEvents', 'totalUsers'].map((name) => ({ name })),
            dimensionFilter: { andGroup: { expressions: [
              { filter: { fieldName: 'sessionSource', stringFilter: { matchType: 'EXACT', value: 'cligc' } } },
              { filter: { fieldName: 'sessionCampaignName', stringFilter: { matchType: 'EXACT', value: l.slug } } },
            ] } },
          });
          const m = (d.rows?.[0]?.metricValues || []).map((v) => Number(v.value) || 0);
          return { sessions: m[0] || 0, engaged: m[1] || 0, keyEvents: m[2] || 0, users: m[3] || 0 };
        });
      } catch (e) { x.conversion = { error: e.message }; }
    }));
  }
  return {
    utm: !!l.utm,
    targets,
    sources: list.filter((x) => x.linksFrom.some((e) => e.id === linkId)).map(pick).sort((a, b) => b.linksFrom[0].human - a.linksFrom[0].human),
  };
}

async function cached(env, key, ttl, fn) {
  const row = await env.DB.prepare('SELECT v, at FROM g_cache WHERE k = ?').bind(key).first();
  if (row && row.at > Date.now() - ttl) return JSON.parse(row.v);
  const v = await fn();
  await env.DB.prepare('INSERT INTO g_cache (k, v, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at')
    .bind(key, JSON.stringify(v), Date.now()).run();
  return v;
}

// 站点详情：每日趋势读 g_daily；区间汇总、排行、实时在线现查并缓存
export async function siteDetail(env, secret, host, days) {
  const s = await env.DB.prepare(`SELECT s.*, a.email AS ga4_email, b.email AS gsc_email, m.c_mod, m.c_trust, m.c_seen, m.c_since, m.c_new30, m.c_upd30 FROM g_sites s
    LEFT JOIN g_accounts a ON a.id = s.ga4_acct LEFT JOIN g_accounts b ON b.id = s.gsc_acct LEFT JOIN g_sitemaps m ON m.host = s.host WHERE s.host = ?`).bind(host).first();
  if (!s) return { error: '站点不存在' };
  const { from, to, pfrom, pto } = ranges(days);
  const rows = (await env.DB.prepare('SELECT * FROM g_daily WHERE host = ? AND date >= ? AND date <= ? ORDER BY date').bind(host, pfrom, to).all()).results;
  const out = {
    host, ga4: s.ga4_property ? { property: s.ga4_property, name: s.ga4_name, account: s.ga4_account, acct: s.ga4_acct, email: s.ga4_email || '', created: s.ga4_created || null } : null,
    gsc: s.gsc_site || null, gscAcct: s.gsc_acct || '', gscEmail: s.gsc_email || '',
    bingSite: s.bing_site || null, bingInIndex: s.bing_site ? s.b_in_index || 0 : null, bingSyncedAt: s.b_synced_at || null, bingError: s.b_error || '',
    content: (s.gsc_site || s.bing_site) ? contentOf(s) : null,
    syncedAt: s.synced_at || null, error: s.error || '', days,
    daily: rows.filter((r) => r.date >= from), prevDaily: hasPrev(days) ? rows.filter((r) => r.date < from) : [],
    cur: sumRange(rows, from, to), prev: hasPrev(days) ? sumRange(rows, pfrom, pto) : { ga: null, gsc: null }, errors: [],
    links: (await siteLinks(env, new Set([host]), days).catch(() => new Map())).get(host) || [],
    linksFrom: [],
    tags: (await env.DB.prepare('SELECT tag FROM site_tags WHERE host = ? ORDER BY tag').bind(host).all()).results.map((r) => r.tag),
    ...blFields(s, true),
  };
  // 来源匹配要用全部站点（不带点的 src 名称需要确认只对应一个站点）
  const all = new Set((await env.DB.prepare('SELECT host FROM g_sites').all()).results.map((r) => r.host));
  const sf = await siteSources(env, all, days).catch(() => new Map());
  out.linksFrom = sf.get(host) || [];
  out.linksFromVisitors = sf.visitors?.get(host) ?? null;
  const tasks = [];
  if (s.ga4_property) {
    const prop = s.ga4_property;
    const report = (dim, metrics, limit = 20, order = metrics[0]) => ({
      dateRanges: [{ startDate: from, endDate: to }], dimensions: [{ name: dim }],
      metrics: metrics.map((name) => ({ name })), limit, orderBys: [{ metric: { metricName: order }, desc: true }],
    });
    tasks.push(cached(env, `ga4b|${prop}|${days}|${to}`, 3600000, async () => {
      const [tot, tops] = await Promise.all([
        gfetch(env, secret, s.ga4_acct, `https://analyticsdata.googleapis.com/v1beta/properties/${prop}:runReport`, {
          dateRanges: [{ startDate: from, endDate: to, name: 'cur' }, { startDate: pfrom, endDate: pto, name: 'prev' }],
          metrics: ['activeUsers', 'newUsers', 'sessions', 'screenPageViews', 'keyEvents', 'engagementRate', 'averageSessionDuration'].map((name) => ({ name })),
        }),
        gfetch(env, secret, s.ga4_acct, `https://analyticsdata.googleapis.com/v1beta/properties/${prop}:batchRunReports`, {
          requests: [
            report('sessionSourceMedium', ['sessions', 'activeUsers', 'keyEvents']),
            report('pagePath', ['screenPageViews', 'activeUsers']),
            report('country', ['activeUsers', 'sessions']),
            report('deviceCategory', ['activeUsers', 'sessions'], 10),
            report('sessionDefaultChannelGroup', ['sessions', 'activeUsers', 'keyEvents'], 20),
          ],
        }),
      ]);
      const names = ['users', 'newUsers', 'sessions', 'views', 'keyEvents', 'engagement', 'duration'];
      const totals = {};
      for (const r of tot.rows || []) {
        const name = r.dimensionValues?.[0]?.value || 'cur';
        totals[name] = Object.fromEntries(r.metricValues.map((m, i) => [names[i], Number(m.value) || 0]));
      }
      const rows = (rep) => (rep.rows || []).map((r) => ({ k: r.dimensionValues[0].value, v: r.metricValues.map((m) => Number(m.value) || 0) }));
      const [src, pages, countries, devices, channels] = (tops.reports || []).map(rows);
      return { totals, src, pages, countries, devices, channels: channels || [] };
    }).then((v) => { out.ga = v; }).catch((e) => { out.errors.push(`GA4：${e.message}`); }));
    tasks.push(gfetch(env, secret, s.ga4_acct, `https://analyticsdata.googleapis.com/v1beta/properties/${prop}:runRealtimeReport`, { metrics: [{ name: 'activeUsers' }] })
      .then((d) => { out.realtime = Number(d.rows?.[0]?.metricValues?.[0]?.value) || 0; }).catch(() => { out.realtime = null; }));
  }
  if (s.gsc_site) {
    const site = s.gsc_site;
    const q = (dims, extra = {}) => gfetch(env, secret, s.gsc_acct, `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
      startDate: from, endDate: to, dimensions: dims, rowLimit: 25, dataState: 'all', ...extra,
    });
    // 搜索词取本期和上一周期各前 250 个：带上上期排名 / 点击，用来显示排名变化、筛出下滑和新出现的词
    const withPrev = hasPrev(days);
    tasks.push(cached(env, `gsc2|${site}|${days}|${to}`, 3600000, async () => {
      const [queries, prevQueries, pages, countries, devices] = await Promise.all([
        q(['query'], { rowLimit: 250 }), withPrev ? q(['query'], { rowLimit: 250, startDate: pfrom, endDate: pto }) : { rows: [] },
        q(['page']), q(['country'], { rowLimit: 15 }), q(['device'], { rowLimit: 5 }),
      ]);
      const rows = (d) => (d.rows || []).map((r) => ({ k: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));
      const cur = rows(queries), prev = new Map(rows(prevQueries).map((x) => [x.k, x]));
      const curMap = new Map(cur.map((x) => [x.k, x]));
      return {
        hasPrev: withPrev,
        queries: cur.map((x) => { const p = prev.get(x.k); return { ...x, prevClicks: p ? p.clicks : null, prevPosition: p ? p.position : null }; }),
        // 下滑：点击比上期少 3 次以上（包括这期掉出前 250 的词）
        declining: [...prev.values()].map((p) => {
          const c = curMap.get(p.k);
          return { k: p.k, clicks: c ? c.clicks : 0, impressions: c ? c.impressions : 0, ctr: c ? c.ctr : 0, position: c ? c.position : null, prevClicks: p.clicks, prevPosition: p.position, gone: !c };
        }).filter((x) => x.clicks - x.prevClicks <= -3).sort((a, b) => (a.clicks - a.prevClicks) - (b.clicks - b.prevClicks)).slice(0, 50),
        pages: rows(pages), countries: rows(countries), devices: rows(devices),
      };
    }).then((v) => { out.sc = v; }).catch((e) => { out.errors.push(`GSC：${e.message}`); }));
  }
  // Bing：搜索词 / 页面按周汇总，抓取统计按天；按区间汇总后缓存 1 小时
  if (s.bing_site) {
    tasks.push(cached(env, `bing|${s.bing_site}|${days}|${to}`, 3600000, async () => bingSummary(await bingRaw(env, secret, s.bing_site), from, to, pfrom, pto, hasPrev(days)))
      .then((v) => { out.bing = v; }).catch((e) => { out.errors.push(`Bing：${e.message}`); }));
  }
  await Promise.all(tasks);
  return out;
}

// ---------------------------------------------------------------- AI 分析报告
// 给 AI 读的只读报告：概览、站点对比、每个站点的搜索表现 / 机会 / 流量质量 / 短链。
// 机会类数据（排名 4–20 的高展示词、点击率偏低的词、下滑和新出现的词）在这里算好，AI 不用自己从原始数字里猜。

// 各排名的大致点击率（行业经验值），用来判断“点击率偏低”
const CTR_CURVE = [0, 0.28, 0.15, 0.1, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02, 0.018];
export const expectedCtr = (pos) => (pos < 1 ? 0.28 : pos <= 10 ? CTR_CURVE[Math.round(pos)] : pos <= 20 ? 0.01 : 0.003);

export async function aiReport(env, secret, hosts, days, sections, hide) {
  const { from, to, pfrom, pto } = ranges(days);
  const want = (k) => !sections || sections.includes(k);
  // D1 一条查询最多绑定 100 个参数，分批查
  const rows = [];
  for (let i = 0; i < hosts.length; i += 90) {
    const part = hosts.slice(i, i + 90);
    rows.push(...(await env.DB.prepare(`SELECT * FROM g_sites WHERE host IN (${part.map(() => '?').join(',')})`).bind(...part).all()).results);
  }
  const byHost = new Map(rows.map((r) => [r.host, r]));
  const links = want('links') ? await siteLinks(env, new Set(hosts), days).catch(() => new Map()) : new Map();
  const allHosts = new Set((await env.DB.prepare('SELECT host FROM g_sites').all()).results.map((r) => r.host));
  const fromLinks = want('links') ? await siteSources(env, allHosts, days).catch(() => new Map()) : new Map();
  // 站点多时每个站点的明细表少列一些，避免报告太长（机会类数据不受影响）。
  // 超过 30 个站点用精简格式：每个站点只保留核心指标和机会，不查 GA4 明细报表和 GSC 国家 / 设备，也不列趋势和搜索词全表
  const n = hosts.length, compact = n > 30;
  const lim = { top: compact ? 0 : n <= 3 ? 50 : n <= 10 ? 25 : 12, opp: compact ? 5 : n <= 10 ? 15 : 8, weekly: n > 5, compact };
  const one = async (host) => {
    const s = byHost.get(host);
    if (!s) return null;
    const daily = (await env.DB.prepare('SELECT * FROM g_daily WHERE host = ? AND date >= ? AND date <= ? ORDER BY date').bind(host, pfrom, to).all()).results;
    const users = s.users ? JSON.parse(s.users) : {};
    const site = {
      host,
      ga4: s.ga4_property ? { name: s.ga4_name, ...(hide ? {} : { property: s.ga4_property, account: s.ga4_account }) } : null,
      searchConsole: s.gsc_site ? (hide ? true : s.gsc_site) : null,
      bingWebmaster: s.bing_site ? (hide ? true : s.bing_site) : null,
      syncedAt: s.synced_at ? new Date(s.synced_at).toISOString() : null,
      cur: sumRange(daily, from, to), prev: hasPrev(days) ? sumRange(daily, pfrom, pto) : { ga: null, gsc: null },
      users: users[days] ?? null, prevUsers: hasPrev(days) ? users[`p${days}`] ?? null : null,
      trend: compact ? [] : trendRows(daily.filter((r) => r.date >= from), lim.weekly ? Math.max(days, 29) : days),
      errors: [],
    };
    if (want('search') && s.gsc_site) {
      try { site.search = await searchSection(env, secret, s, days, from, to, pfrom, pto, lim); } catch (e) { site.errors.push(`Search Console：${e.message}`); }
    }
    if (want('search') && s.bing_site) {
      try {
        const v = await cached(env, `bing|${s.bing_site}|${days}|${to}`, 3600000, async () => bingSummary(await bingRaw(env, secret, s.bing_site), from, to, pfrom, pto, hasPrev(days)));
        const r1 = (x) => ({ k: x.k, clicks: x.clicks, impressions: x.impressions, ctr: +(x.ctr * 100).toFixed(2), position: +x.position.toFixed(1) });
        const page = (u) => u.replace(/^https?:\/\/[^/]+/, '') || '/';
        const last = v.crawl[v.crawl.length - 1];
        site.bing = {
          position: v.position != null ? +v.position.toFixed(1) : null, prevPosition: v.prevPosition != null ? +v.prevPosition.toFixed(1) : null,
          strikingDistance: v.queries.filter((x) => x.position >= 4 && x.position <= 20 && x.impressions >= 5).sort((a, b) => b.impressions - a.impressions).slice(0, lim.opp).map(r1),
          topQueries: v.queries.slice(0, lim.top).map(r1),
          topPages: v.pages.slice(0, lim.top).map((x) => r1({ ...x, k: page(x.k) })),
          crawl: last ? { inIndex: last.inIndex, crawled: v.crawl.reduce((a, r) => a + r.crawled, 0), errors: v.crawl.reduce((a, r) => a + r.errors, 0) } : null,
          crawlIssues: v.issues.length,
        };
      } catch (e) { site.errors.push(`Bing：${e.message}`); }
    }
    // 收录：网址逐个检查的结果（Google 网址检查 / Bing GetUrlInfo）
    const ix = await env.DB.prepare('SELECT n_urls, n_yes, n_done, nb_yes, nb_done, c_mod, c_trust, c_seen, c_since, c_new30, c_upd30 FROM g_sitemaps WHERE host = ?').bind(host).first();
    site.index = ix?.n_urls ? { urls: ix.n_urls, googleIndexed: s.gsc_site ? ix.n_yes : null, googleChecked: s.gsc_site ? ix.n_done : null,
      bingIndexed: s.bing_site ? ix.nb_yes : null, bingChecked: s.bing_site ? ix.nb_done : null } : null;
    // 内容最后更新时间（按站点地图推测）
    const ct = contentOf(ix);
    if (ct?.at) site.contentUpdate = { date: ymd(ct.at), basis: { mod: '站点地图里网页的最后更新时间（lastmod）', seen: '每天读取站点地图时发现的变化（新网址或网页更新）', build: '站点地图日期（大部分网页同一天，多半是构建时间，不一定是内容更新）' }[ct.src],
      newPages30d: ct.new30, updatedPages30d: ct.upd30 };
    if (want('traffic') && s.ga4_property && !compact) {
      try { site.traffic = await trafficSection(env, secret, s, days, from, to, pfrom, pto, lim); } catch (e) { site.errors.push(`GA4：${e.message}`); }
    }
    if (want('links')) {
      site.linksFrom = (fromLinks.get(host) || []).map((l) => ({ slug: l.slug, title: l.title, humanClicks: l.human, visitors: l.visitors, allClicks: l.cur, prevHumanClicks: l.prevHuman, sources: l.sources }));
      site.linksFromVisitors = fromLinks.visitors?.get(host) ?? null;
      site.links = (links.get(host) || []).map((l) => ({ slug: l.slug, title: l.title, humanClicks: l.human, allClicks: l.cur, prevHumanClicks: l.prevHuman,
        routes: l.routes.map((r) => ({ to: r.url, when: ((r.rule ? [r.countries && `访客来自 ${r.countries}`, r.devices && `设备 ${r.devices}`].filter(Boolean).join('，') : '') || '默认') + (r.ab ? '（A/B 分流）' : '') })) }));
    }
    return site;
  };
  // 并发处理（精简格式每个站点请求更少，并发多一些）
  const sites = [], step = compact ? 10 : 5;
  for (let i = 0; i < hosts.length; i += step) sites.push(...(await Promise.all(hosts.slice(i, i + step).map(one))).filter(Boolean));
  return { compact, generatedAt: new Date().toISOString(), days, range: { from, to }, prevRange: hasPrev(days) ? { from: pfrom, to: pto } : null, sections: sections || ['search', 'traffic', 'links'], sites };
}

// 趋势：28 天以内按天，更长按周（周一开始）
function trendRows(daily, days) {
  const key = (d) => {
    if (days <= 28) return d;
    const t = new Date(d + 'T00:00:00Z'), dow = (t.getUTCDay() + 6) % 7;
    return new Date(t - dow * DAY).toISOString().slice(0, 10);
  };
  const m = new Map();
  for (const r of daily) {
    const k = key(r.date);
    const t = m.get(k) || { period: k, sessions: 0, users: 0, clicks: 0, impressions: 0, posw: 0 };
    t.sessions += r.sessions || 0; t.users += r.users || 0; t.clicks += r.clicks || 0; t.impressions += r.impressions || 0; t.posw += (r.position || 0) * (r.impressions || 0);
    m.set(k, t);
  }
  return [...m.values()].sort((a, b) => (a.period < b.period ? -1 : 1))
    .map(({ posw, ...t }) => ({ ...t, position: t.impressions ? +(posw / t.impressions).toFixed(1) : null }));
}

async function searchSection(env, secret, s, days, from, to, pfrom, pto, lim) {
  const site = s.gsc_site;
  const q = (start, end, dims, rowLimit) => gfetch(env, secret, s.gsc_acct, `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
    startDate: start, endDate: end, dimensions: dims, rowLimit, dataState: 'all',
  }).then((d) => (d.rows || []).map((r) => ({ k: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })));
  const d = await cached(env, `ai-gsc|${site}|${days}|${to}${lim.compact ? '|c' : ''}`, 3600000, async () => {
    const [queries, prevQueries, pages, prevPages, countries, devices] = await Promise.all([
      q(from, to, ['query'], 250), q(pfrom, pto, ['query'], 250), q(from, to, ['page'], 100), q(pfrom, pto, ['page'], 100),
      ...(lim.compact ? [[], []] : [q(from, to, ['country'], 15), q(from, to, ['device'], 5)]),
    ]);
    return { queries, prevQueries, pages, prevPages, countries, devices };
  });
  const r1 = (x) => ({ ...x, ctr: +(x.ctr * 100).toFixed(2), position: +x.position.toFixed(1) });
  const prevQ = new Map(d.prevQueries.map((x) => [x.k, x])), prevP = new Map(d.prevPages.map((x) => [x.k, x]));
  const page = (u) => u.replace(/^https?:\/\/[^/]+/, '') || '/';
  // 机会
  const striking = d.queries.filter((x) => x.position >= 4 && x.position <= 20 && x.impressions >= 10)
    .sort((a, b) => b.impressions - a.impressions).slice(0, lim.opp).map(r1);
  const lowCtr = d.queries.filter((x) => x.impressions >= 30 && x.ctr < expectedCtr(x.position) * 0.5)
    .map((x) => ({ ...x, expectedCtr: expectedCtr(x.position), lostClicks: Math.round(x.impressions * (expectedCtr(x.position) - x.ctr)) }))
    .sort((a, b) => b.lostClicks - a.lostClicks).slice(0, lim.opp)
    .map((x) => ({ ...r1(x), expectedCtr: +(x.expectedCtr * 100).toFixed(1), lostClicks: x.lostClicks }));
  const drop = (cur, prev) => [...prev.values()].map((p) => {
    const c = cur.get(p.k) || { clicks: 0, impressions: 0, position: null };
    return { k: p.k, clicks: c.clicks, prevClicks: p.clicks, change: c.clicks - p.clicks, position: c.position != null ? +c.position.toFixed(1) : null, prevPosition: +p.position.toFixed(1) };
  }).filter((x) => x.change <= -3).sort((a, b) => a.change - b.change);
  const curQ = new Map(d.queries.map((x) => [x.k, x])), curP = new Map(d.pages.map((x) => [x.k, x]));
  return {
    topQueries: d.queries.slice(0, lim.top).map(r1),
    topPages: d.pages.slice(0, lim.top).map((x) => r1({ ...x, k: page(x.k) })),
    countries: d.countries.map(r1), devices: d.devices.map(r1),
    opportunities: {
      strikingDistance: striking,
      lowCtr,
      decliningQueries: hasPrev(days) ? drop(curQ, prevQ).slice(0, lim.opp) : [],
      decliningPages: hasPrev(days) ? drop(curP, prevP).slice(0, Math.min(10, lim.opp)).map((x) => ({ ...x, k: page(x.k) })) : [],
      newQueries: hasPrev(days) ? d.queries.filter((x) => !prevQ.has(x.k) && x.impressions >= 20).slice(0, 10).map(r1) : [],
    },
  };
}

async function trafficSection(env, secret, s, days, from, to, pfrom, pto, lim) {
  const prop = s.ga4_property;
  const report = (dim, metrics, limit = 20) => ({
    dateRanges: [{ startDate: from, endDate: to }], dimensions: [{ name: dim }],
    metrics: metrics.map((name) => ({ name })), limit, orderBys: [{ metric: { metricName: metrics[0] }, desc: true }],
  });
  return cached(env, `ai-ga|${prop}|${days}|${to}`, 3600000, async () => {
    const [tot, tops] = await Promise.all([
      gfetch(env, secret, s.ga4_acct, `https://analyticsdata.googleapis.com/v1beta/properties/${prop}:runReport`, {
        dateRanges: [{ startDate: from, endDate: to, name: 'cur' }, ...(hasPrev(days) ? [{ startDate: pfrom, endDate: pto, name: 'prev' }] : [])],
        metrics: ['activeUsers', 'newUsers', 'sessions', 'screenPageViews', 'keyEvents', 'engagementRate', 'averageSessionDuration', 'bounceRate'].map((name) => ({ name })),
      }),
      gfetch(env, secret, s.ga4_acct, `https://analyticsdata.googleapis.com/v1beta/properties/${prop}:batchRunReports`, {
        requests: [
          report('sessionDefaultChannelGroup', ['sessions', 'engagementRate', 'keyEvents'], 12),
          report('sessionSourceMedium', ['sessions', 'engagementRate', 'keyEvents']),
          report('landingPage', ['sessions', 'engagementRate', 'keyEvents', 'activeUsers']),
          report('country', ['activeUsers', 'sessions'], 15),
          report('deviceCategory', ['activeUsers', 'sessions', 'engagementRate'], 5),
        ],
      }),
    ]);
    const names = ['users', 'newUsers', 'sessions', 'views', 'keyEvents', 'engagementRate', 'avgSessionSeconds', 'bounceRate'];
    const totals = {};
    for (const r of tot.rows || []) {
      const name = r.dimensionValues?.[0]?.value || 'cur';
      totals[name] = Object.fromEntries(r.metricValues.map((m, i) => [names[i], Math.round((Number(m.value) || 0) * 1000) / 1000]));
    }
    const rows = (rep, cols) => (rep.rows || []).map((r) => ({ k: r.dimensionValues[0].value, ...Object.fromEntries(r.metricValues.map((m, i) => [cols[i], Math.round((Number(m.value) || 0) * 1000) / 1000])) }));
    const [ch, src, land, countries, devices] = tops.reports || [];
    const cutN = (a, k) => a.slice(0, k);
    return {
      totals,
      channels: rows(ch || {}, ['sessions', 'engagementRate', 'keyEvents']),
      sourceMedium: cutN(rows(src || {}, ['sessions', 'engagementRate', 'keyEvents']), lim.top >= 25 ? 20 : 10),
      landingPages: cutN(rows(land || {}, ['sessions', 'engagementRate', 'keyEvents', 'users']), lim.top >= 25 ? 20 : 10),
      countries: cutN(rows(countries || {}, ['users', 'sessions']), lim.top >= 25 ? 15 : 8),
      devices: rows(devices || {}, ['users', 'sessions', 'engagementRate']),
    };
  });
}

// ---------------------------------------------------------------- 报告 → Markdown
export function reportMarkdown(r) {
  const nf = new Intl.NumberFormat('en-US');
  const n = (v) => (v == null ? '—' : nf.format(Math.round(v)));
  const pc = (v, d = 1) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
  const chg = (a, b) => (a == null || b == null || !b ? '—' : `${a >= b ? '+' : ''}${(((a - b) / b) * 100).toFixed(1)}%`);
  const cell = (v) => String(v ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const table = (head, data) => (data.length
    ? `| ${head.join(' | ')} |\n| ${head.map(() => '---').join(' | ')} |\n${data.map((row) => `| ${row.map(cell).join(' | ')} |`).join('\n')}\n`
    : '_（无数据）_\n');
  const has = (k) => r.sections.includes(k);
  const L = [];
  L.push(`# 站点 SEO 与流量数据报告`, '');
  L.push(`- 生成时间：${r.generatedAt}（UTC）`);
  L.push(`- 统计区间：${r.range.from} 至 ${r.range.to}（共 ${r.days} 天，截至昨天）`);
  L.push(`- 对比区间：${r.prevRange ? `${r.prevRange.from} 至 ${r.prevRange.to}（上一个同长度周期）` : '无（区间过长，不做环比）'}`);
  L.push(`- 站点数：${r.sites.length}`);
  L.push(`- 数据来源：Google Search Console（搜索表现）、${r.sites.some((s) => s.bingWebmaster) ? 'Bing Webmaster Tools（Bing 搜索表现、收录）、' : ''}Google Analytics 4（访问与转化）、cligc 短链（推广短链的点击）`);
  L.push(`- 说明：Search Console 数据通常延迟 2–3 天，最近两天偏低；CTR 和排名按展示加权；“机会”部分由程序按规则预先筛选。`);
  if (r.compact) L.push(`- 格式：站点较多（${r.sites.length} 个），使用精简格式——每个站点只列核心指标和搜索机会（每类前 5 条），不含趋势、搜索词 / 页面全表和 GA4 渠道、着陆页明细。需要深入分析某个站点时，可单独为它生成报告。`);
  L.push('');

  if (r.sites.length > 1) {
    L.push(`## 站点对比`, '');
    const hasB = r.sites.some((s) => s.bingWebmaster);
    L.push(table(['站点', '用户', '会话', '会话环比', '关键事件', '搜索点击', '点击环比', '展示', 'CTR', '平均排名', ...(hasB ? ['Bing 点击', 'Bing 点击环比'] : [])],
      r.sites.map((s) => [s.host, n(s.users), n(s.cur.ga?.sessions), chg(s.cur.ga?.sessions, s.prev.ga?.sessions), n(s.cur.ga?.keyEvents),
        n(s.cur.gsc?.clicks), chg(s.cur.gsc?.clicks, s.prev.gsc?.clicks), n(s.cur.gsc?.impressions), pc(s.cur.gsc?.ctr, 2),
        s.cur.gsc?.impressions ? s.cur.gsc.position.toFixed(1) : '—', ...(hasB ? [n(s.cur.bing?.clicks), chg(s.cur.bing?.clicks, s.prev.bing?.clicks)] : [])])));
  }

  for (const s of r.sites) {
    L.push(`## ${s.host}`, '');
    L.push(`- GA4：${s.ga4 ? `已关联（${s.ga4.name}${s.ga4.property ? `，媒体资源 ${s.ga4.property}` : ''}）` : '未关联'}`);
    L.push(`- Search Console：${s.searchConsole ? `已关联${typeof s.searchConsole === 'string' ? `（${s.searchConsole}）` : ''}` : '未关联'}`);
    L.push(`- Bing Webmaster：${s.bingWebmaster ? `已关联${typeof s.bingWebmaster === 'string' ? `（${s.bingWebmaster}）` : ''}` : '未关联'}`);
    if (s.errors.length) L.push(`- 读取出错：${s.errors.join('；')}`);
    L.push('');
    L.push(`### 核心指标`, '');
    const ga = s.traffic?.totals?.cur, gp = s.traffic?.totals?.prev;
    if (r.compact) {
      // 精简格式：只列有数据的指标
      L.push(table(['指标', '本期', '上期', '变化'], [
        ...(s.cur.ga ? [
          ['用户', n(s.users), n(s.prevUsers), chg(s.users, s.prevUsers)],
          ['会话', n(s.cur.ga.sessions), n(s.prev.ga?.sessions), chg(s.cur.ga.sessions, s.prev.ga?.sessions)],
          ['关键事件', n(s.cur.ga.keyEvents), n(s.prev.ga?.keyEvents), chg(s.cur.ga.keyEvents, s.prev.ga?.keyEvents)],
          ['互动率', pc(s.cur.ga.engagement), pc(s.prev.ga?.engagement), '—'],
        ] : []),
        ...(s.cur.gsc ? [
          ['搜索点击', n(s.cur.gsc.clicks), n(s.prev.gsc?.clicks), chg(s.cur.gsc.clicks, s.prev.gsc?.clicks)],
          ['搜索展示', n(s.cur.gsc.impressions), n(s.prev.gsc?.impressions), chg(s.cur.gsc.impressions, s.prev.gsc?.impressions)],
          ['CTR / 平均排名', `${pc(s.cur.gsc.ctr, 2)} / ${s.cur.gsc.impressions ? s.cur.gsc.position.toFixed(1) : '—'}`, `${pc(s.prev.gsc?.ctr, 2)} / ${s.prev.gsc?.impressions ? s.prev.gsc.position.toFixed(1) : '—'}`, '—'],
        ] : []),
      ]));
    } else
    L.push(table(['指标', '本期', '上期', '变化'], [
      ['用户', n(ga?.users ?? s.users), n(gp?.users ?? s.prevUsers), chg(ga?.users ?? s.users, gp?.users ?? s.prevUsers)],
      ['新用户', n(ga?.newUsers), n(gp?.newUsers), chg(ga?.newUsers, gp?.newUsers)],
      ['会话', n(s.cur.ga?.sessions), n(s.prev.ga?.sessions), chg(s.cur.ga?.sessions, s.prev.ga?.sessions)],
      ['浏览量', n(s.cur.ga?.views), n(s.prev.ga?.views), chg(s.cur.ga?.views, s.prev.ga?.views)],
      ['关键事件', n(s.cur.ga?.keyEvents), n(s.prev.ga?.keyEvents), chg(s.cur.ga?.keyEvents, s.prev.ga?.keyEvents)],
      ['互动率', pc(ga?.engagementRate ?? s.cur.ga?.engagement), pc(gp?.engagementRate ?? s.prev.ga?.engagement), '—'],
      ['平均会话时长（秒）', n(ga?.avgSessionSeconds), n(gp?.avgSessionSeconds), chg(ga?.avgSessionSeconds, gp?.avgSessionSeconds)],
      ['搜索点击', n(s.cur.gsc?.clicks), n(s.prev.gsc?.clicks), chg(s.cur.gsc?.clicks, s.prev.gsc?.clicks)],
      ['搜索展示', n(s.cur.gsc?.impressions), n(s.prev.gsc?.impressions), chg(s.cur.gsc?.impressions, s.prev.gsc?.impressions)],
      ['搜索 CTR', pc(s.cur.gsc?.ctr, 2), pc(s.prev.gsc?.ctr, 2), '—'],
      ['平均排名', s.cur.gsc?.impressions ? s.cur.gsc.position.toFixed(1) : '—', s.prev.gsc?.impressions ? s.prev.gsc.position.toFixed(1) : '—', '—'],
    ]));
    if (s.cur.bing || s.bing) {
      const b = s.bing;
      L.push(`### Bing 搜索`, '');
      L.push(table(['指标', '本期', '上期', '变化'], [
        ['Bing 点击', n(s.cur.bing?.clicks), n(s.prev.bing?.clicks), chg(s.cur.bing?.clicks, s.prev.bing?.clicks)],
        ['Bing 展示', n(s.cur.bing?.impressions), n(s.prev.bing?.impressions), chg(s.cur.bing?.impressions, s.prev.bing?.impressions)],
        ['Bing CTR', pc(s.cur.bing?.ctr, 2), pc(s.prev.bing?.ctr, 2), '—'],
        ['Bing 平均排名（按搜索词估算）', b?.position ?? '—', b?.prevPosition ?? '—', '—'],
        ...(b?.crawl ? [['Bing 索引中网页 / 区间抓取 / 抓取错误', `${n(b.crawl.inIndex)} / ${n(b.crawl.crawled)} / ${n(b.crawl.errors)}`, '—', '—']] : []),
      ]));
      if (b?.strikingDistance?.length) L.push('**Bing 排名 4–20、展示较多的搜索词**', '', table(['搜索词', '点击', '展示', 'CTR', '排名'], b.strikingDistance.map((x) => [x.k, n(x.clicks), n(x.impressions), `${x.ctr}%`, x.position])));
      if (!r.compact && b?.topQueries?.length) L.push(`**Bing 搜索词（前 ${b.topQueries.length}，按点击；Bing 按周汇总）**`, '', table(['搜索词', '点击', '展示', 'CTR', '排名'], b.topQueries.map((x) => [x.k, n(x.clicks), n(x.impressions), `${x.ctr}%`, x.position])));
      if (!r.compact && b?.topPages?.length) L.push(`**Bing 页面（前 ${b.topPages.length}，按点击）**`, '', table(['页面', '点击', '展示', 'CTR', '排名'], b.topPages.map((x) => [x.k, n(x.clicks), n(x.impressions), `${x.ctr}%`, x.position])));
    }
    if (s.index) {
      const i = s.index;
      L.push(`### 收录（站点地图和搜索结果里的 ${n(i.urls)} 个网址逐个检查）`, '');
      L.push(table(['搜索引擎', '已收录', '已检查', '收录率'], [
        ...(i.googleIndexed != null ? [['Google', n(i.googleIndexed), n(i.googleChecked), i.googleChecked ? pc(i.googleIndexed / i.googleChecked) : '—']] : []),
        ...(i.bingIndexed != null ? [['Bing', n(i.bingIndexed), n(i.bingChecked), i.bingChecked ? pc(i.bingIndexed / i.bingChecked) : '—']] : []),
      ]));
    }
    if (s.contentUpdate) {
      const c = s.contentUpdate;
      L.push(`**内容最后更新**：${c.date}（依据：${c.basis}）；近 30 天新出现 ${n(c.newPages30d)} 个网址${c.updatedPages30d != null ? `，${n(c.updatedPages30d)} 个网页有更新` : ''}`, '');
    }
    if (s.trend.length) {
      L.push(`### 趋势（${r.days <= 28 && r.sites.length <= 5 ? '按天' : '按周，日期为周一'}）`, '');
      L.push(table(['日期', '会话', '用户（按天相加）', '搜索点击', '展示', '平均排名'], s.trend.map((t) => [t.period, n(t.sessions), n(t.users), n(t.clicks), n(t.impressions), t.position ?? '—'])));
    }
    if (has('search') && s.search) {
      const o = s.search.opportunities;
      const qrow = (x) => [x.k, n(x.clicks), n(x.impressions), `${x.ctr}%`, x.position];
      // 精简格式只输出有内容的机会；全都没有时写一句
      const blocks = [
        ['**排名 4–20、展示较多的搜索词**（优化后最容易进入前三）', o.strikingDistance, () => table(['搜索词', '点击', '展示', 'CTR', '排名'], o.strikingDistance.map(qrow))],
        ['**点击率明显偏低的搜索词**（低于该排名常见点击率的一半，可能是标题 / 描述不够吸引人）', o.lowCtr, () => table(['搜索词', '点击', '展示', 'CTR', '排名', '该排名常见 CTR', '估计少拿的点击'], o.lowCtr.map((x) => [...qrow(x), `${x.expectedCtr}%`, n(x.lostClicks)]))],
        ...(r.prevRange ? [
          ['**点击下滑最多的搜索词**', o.decliningQueries, () => table(['搜索词', '本期点击', '上期点击', '变化', '本期排名', '上期排名'], o.decliningQueries.map((x) => [x.k, n(x.clicks), n(x.prevClicks), x.change, x.position ?? '—', x.prevPosition]))],
          ['**点击下滑最多的页面**', o.decliningPages, () => table(['页面', '本期点击', '上期点击', '变化', '本期排名', '上期排名'], o.decliningPages.map((x) => [x.k, n(x.clicks), n(x.prevClicks), x.change, x.position ?? '—', x.prevPosition]))],
          ['**本期新出现的搜索词**（上期不在前 250 名里）', o.newQueries, () => table(['搜索词', '点击', '展示', 'CTR', '排名'], o.newQueries.map(qrow))],
        ] : []),
      ].filter(([, rows]) => !r.compact || rows.length);
      L.push(`### 搜索机会`, '');
      if (!blocks.length) L.push('_没有明显的搜索机会（展示量太少）_', '');
      for (const [title, , render] of blocks) L.push(title, '', render());
      if (!r.compact) {
        L.push(`### 搜索词（前 ${s.search.topQueries.length}，按点击）`, '');
        L.push(table(['搜索词', '点击', '展示', 'CTR', '排名'], s.search.topQueries.map(qrow)));
        L.push(`### 页面（前 ${s.search.topPages.length}，按点击）`, '');
        L.push(table(['页面', '点击', '展示', 'CTR', '排名'], s.search.topPages.map(qrow)));
        L.push(`### 搜索：国家 / 设备`, '');
        L.push(table(['国家', '点击', '展示', 'CTR', '排名'], s.search.countries.map((x) => [x.k.toUpperCase(), n(x.clicks), n(x.impressions), `${x.ctr}%`, x.position])));
        L.push(table(['设备', '点击', '展示', 'CTR', '排名'], s.search.devices.map(qrow)));
      }
    }
    if (has('traffic') && s.traffic) {
      const t = s.traffic;
      L.push(`### 流量渠道（GA4）`, '');
      L.push(table(['渠道', '会话', '互动率', '关键事件'], t.channels.map((x) => [x.k, n(x.sessions), pc(x.engagementRate), n(x.keyEvents)])));
      L.push(`### 来源 / 媒介（GA4，前 ${t.sourceMedium.length}）`, '');
      L.push(table(['来源 / 媒介', '会话', '互动率', '关键事件'], t.sourceMedium.map((x) => [x.k, n(x.sessions), pc(x.engagementRate), n(x.keyEvents)])));
      L.push(`### 着陆页（GA4，前 ${t.landingPages.length}）`, '');
      L.push(table(['着陆页', '会话', '用户', '互动率', '关键事件'], t.landingPages.map((x) => [x.k, n(x.sessions), n(x.users), pc(x.engagementRate), n(x.keyEvents)])));
      L.push(`### 访问：国家 / 设备（GA4）`, '');
      L.push(table(['国家', '用户', '会话'], t.countries.map((x) => [x.k, n(x.users), n(x.sessions)])));
      L.push(table(['设备', '用户', '会话', '互动率'], t.devices.map((x) => [x.k, n(x.users), n(x.sessions), pc(x.engagementRate)])));
    }
    if (has('links') && (!r.compact || s.linksFrom?.length)) {
      const out = (s.linksFrom || []).reduce((a, l) => a + l.humanClicks, 0), ses = s.cur.ga?.sessions;
      L.push(`### 站点上的推广短链（从这个站点点出去的短链）`, '');
      if (s.linksFrom?.length) L.push(`共 ${n(out)} 次真人点击${s.linksFromVisitors != null ? `，来自约 ${n(s.linksFromVisitors)} 位访客（按 IP 去重，估算）` : ''}${ses ? `，约为站点会话的 ${pc(out / ses)}（点出率）` : ''}。按短链访问的来源（src 参数或 Referer）匹配。`, '');
      L.push(s.linksFrom?.length
        ? table(['短链', '标题', '真人点击', '访客（去重）', '上期真人点击', '含机器访问', '来源标识'], s.linksFrom.map((l) => [`/${l.slug}`, l.title || '—', n(l.humanClicks), n(l.visitors), r.prevRange ? n(l.prevHumanClicks) : '—', n(l.allClicks), l.sources.join('、')]))
        : '_没有从这个站点点出的短链_\n');
    }
    if (has('links') && s.links?.length) {
      L.push(`### 跳转到这个站点的短链`, '');
      L.push(s.links?.length
        ? table(['短链', '标题', '真人点击', '上期真人点击', '含机器访问', '跳转'], s.links.map((l) => [`/${l.slug}`, l.title || '—', n(l.humanClicks), r.prevRange ? n(l.prevHumanClicks) : '—', n(l.allClicks), l.routes.map((x) => `${x.when} → ${x.to}`).join('；')]))
        : '_没有短链跳转到这个站点_\n');
    }
  }
  L.push('---', '', '_本报告由 cligc link 生成，只读；链接过期或被撤销后无法访问。_');
  return L.join('\n');
}

// ---------------------------------------------------------------- 每周 SEO 变化（通知用）
// Search Console 数据通常延迟 2–3 天，搜索对比用“3–9 天前 vs 再往前 7 天”，避免把还没出来的数据当成下滑；
// 会话用最近 7 天 vs 上一个 7 天。搜索词变化只查展示最多的 10 个站点，省接口调用。
export async function seoDigest(env, secret, tag) {
  const d = (n) => ymd(Date.now() - n * DAY);
  const S = { from: d(9), to: d(3), pfrom: d(16), pto: d(10) }, G = { from: d(7), to: d(1), pfrom: d(14), pto: d(8) };
  let sites = (await env.DB.prepare('SELECT * FROM g_sites').all()).results;
  if (tag) {
    const set = new Set((await env.DB.prepare('SELECT host FROM site_tags WHERE tag = ?').bind(tag).all()).results.map((r) => r.host));
    sites = sites.filter((s) => set.has(s.host));
  }
  if (!sites.length) return null;
  const rows = (await env.DB.prepare('SELECT * FROM g_daily WHERE date >= ? AND date <= ?').bind(S.pfrom, G.to).all()).results;
  const by = new Map();
  for (const r of rows) { if (!by.has(r.host)) by.set(r.host, []); by.get(r.host).push(r); }
  const list = sites.map((s) => {
    const rs = by.get(s.host) || [];
    const sc = sumRange(rs, S.from, S.to).gsc, ps = sumRange(rs, S.pfrom, S.pto).gsc;
    const ga = sumRange(rs, G.from, G.to).ga, pg = sumRange(rs, G.pfrom, G.pto).ga;
    const bc = sumRange(rs, S.from, S.to).bing, bp = sumRange(rs, S.pfrom, S.pto).bing;
    return { s, host: s.host, bingClicks: bc?.clicks ?? null, prevBingClicks: bp?.clicks ?? null, clicks: sc?.clicks ?? null, prevClicks: ps?.clicks ?? null, impressions: sc?.impressions ?? null, prevImpressions: ps?.impressions ?? null,
      position: sc?.impressions ? sc.position : null, prevPosition: ps?.impressions ? ps.position : null, sessions: ga?.sessions ?? null, prevSessions: pg?.sessions ?? null };
  });
  const sum = (k) => list.reduce((a, x) => a + (x[k] || 0), 0);
  const withSc = list.filter((x) => x.clicks != null && x.prevClicks != null);
  const change = (x) => x.clicks - x.prevClicks;
  const drops = withSc.filter((x) => change(x) <= -3).sort((a, b) => change(a) - change(b)).slice(0, 5);
  const gains = withSc.filter((x) => change(x) >= 3).sort((a, b) => change(b) - change(a)).slice(0, 5);
  // 搜索词：展示最多的 10 个站点
  const top = list.filter((x) => x.s.gsc_site && x.impressions).sort((a, b) => b.impressions - a.impressions).slice(0, 10);
  const fellOut = [], near = [];
  for (const x of top) {
    try {
      const q = (start, end) => gfetch(env, secret, x.s.gsc_acct, `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(x.s.gsc_site)}/searchAnalytics/query`,
        { startDate: start, endDate: end, dimensions: ['query'], rowLimit: 250, dataState: 'all' }).then((r) => r.rows || []);
      const [cur, prev] = await Promise.all([q(S.from, S.to), q(S.pfrom, S.pto)]);
      const pm = new Map(prev.map((r) => [r.keys[0], r]));
      for (const r of cur) {
        const p = pm.get(r.keys[0]);
        // 跌出前 10：按上一周的展示衡量这个词有多重要（跌出去之后本周展示自然会变少）
        if (p && p.position <= 10 && r.position > 10 && p.impressions >= 20) fellOut.push({ host: x.host, q: r.keys[0], from: p.position, to: r.position, impressions: p.impressions });
        if (r.position > 10 && r.position <= 15 && r.impressions >= 30) near.push({ host: x.host, q: r.keys[0], position: r.position, impressions: r.impressions });
      }
    } catch {}
  }
  return {
    range: S, gaRange: G, sites: list.length, tag: tag || '',
    bing: list.some((x) => x.s.bing_site),
    totals: { bingClicks: sum('bingClicks'), prevBingClicks: sum('prevBingClicks'), clicks: sum('clicks'), prevClicks: sum('prevClicks'), impressions: sum('impressions'), prevImpressions: sum('prevImpressions'), sessions: sum('sessions'), prevSessions: sum('prevSessions') },
    drops, gains,
    fellOut: fellOut.sort((a, b) => b.impressions - a.impressions).slice(0, 8),
    near: near.sort((a, b) => b.impressions - a.impressions).slice(0, 8),
  };
}
