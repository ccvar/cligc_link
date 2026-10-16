// ---------------------------------------------------------------- Google：GA4 + Search Console
// 授权：OAuth 2.0（Web 应用），只读权限 analytics.readonly、webmasters.readonly。
// OAuth 客户端：优先读环境变量 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET，否则读后台填写的（加密保存在 settings.int_google）。
// 回调地址为 <域名>/api/google/callback。
// 可以连接多个 Google 账号：每个账号一行 g_accounts，刷新令牌用会话密钥派生的 AES-GCM 密钥加密保存。
// 所有账号的 GA4 媒体资源和 GSC 站点按域名合并到 g_sites，并记下各自来自哪个账号（ga4_acct / gsc_acct）。
// 每日数据存在 g_daily，由定时任务和“立即同步”分批更新；详情页的排行、实时数据现查并缓存一小时。

const SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
];
const DAY = 86400000;
// 首次回填 486 天（Search Console 最多保留 16 个月），够“最近 6 个月”做环比；回填天数变了会重新回填一次
const BACKFILL_DAYS = 486, REFRESH_DAYS = 10;
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

// 客户端 ID / 密钥：环境变量优先
export async function googleCreds(env, secret) {
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    return { clientId: String(env.GOOGLE_CLIENT_ID).trim(), clientSecret: String(env.GOOGLE_CLIENT_SECRET).trim(), source: 'env' };
  }
  const s = await getSetting(env, 'int_google');
  if (!s) return null;
  try { const c = await unseal(secret, s); return { ...c, source: 'db' }; } catch { return null; }
}
export const googleConfigured = async (env, secret) => !!(await googleCreds(env, secret));

export async function saveGoogleConfig(env, secret, body) {
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) return { error: '已通过环境变量配置，请在 wrangler.toml 中修改' };
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
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) return { error: '已通过环境变量配置，请在 wrangler.toml 中修改' };
  await disconnect(env, secret);
  await delSetting(env, 'int_google');
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
    await env.DB.batch(['g_accounts', 'g_sites', 'g_daily', 'g_cache'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    return;
  }
  await env.DB.prepare('DELETE FROM g_accounts WHERE id = ?').bind(id).run();
  await rebuildSites(env);
}

// 带令牌请求 Google 接口
async function gfetch(env, secret, acct, url, body) {
  const token = await accessToken(env, secret, acct);
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = d.error?.message || `HTTP ${res.status}`;
    throw new Error(/has not been used|is disabled/i.test(msg) ? `接口未启用：${msg}` : msg);
  }
  return d;
}

// ---------------------------------------------------------------- 站点发现

// 列出一个账号的 GA4 媒体资源和 GSC 站点；某一项失败时返回 null，沿用上次的结果
async function discoverAccount(env, secret, acct) {
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

  // 每个媒体资源的网站数据流地址，用来确定域名
  if (props) await Promise.all(props.map(async (p) => {
    try {
      const d = await gfetch(env, secret, acct, `https://analyticsadmin.googleapis.com/v1beta/properties/${p.id}/dataStreams`);
      const web = (d.dataStreams || []).find((s) => s.webStreamData?.defaultUri);
      p.host = siteHost(web?.webStreamData?.defaultUri || '');
    } catch { p.host = ''; }
  }));

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
    const r = await discoverAccount(env, secret, a.id);
    const found = { props: r.props ?? old.props ?? [], gsc: r.gsc ?? old.gsc ?? [], errors: r.errors, failed: !!r.failed, at: now };
    await env.DB.prepare('UPDATE g_accounts SET found = ?, found_at = ? WHERE id = ?').bind(JSON.stringify(found), now, a.id).run();
  }
  return rebuildSites(env);
}

// 把所有账号的发现结果按主域名合并进 g_sites。
// 同一个媒体资源 / 站点多个账号都能看到时，用最早连接的账号；同一域名有“网域”和“网址前缀”两种 GSC 资源时优先网域资源
async function rebuildSites(env) {
  const accts = (await env.DB.prepare('SELECT id, found FROM g_accounts ORDER BY connected_at').all()).results
    .map((a) => ({ id: a.id, found: a.found ? JSON.parse(a.found) : null }));
  const sites = new Map();
  const get = (host) => {
    if (!sites.has(host)) sites.set(host, { host, ga4_property: '', ga4_name: '', ga4_account: '', ga4_acct: '', gsc_site: '', gsc_acct: '' });
    return sites.get(host);
  };
  for (const a of accts) {
    for (const p of a.found?.props || []) {
      const s = get(p.host || `ga4-${p.id}`);
      if (!s.ga4_property) Object.assign(s, { ga4_property: p.id, ga4_name: p.name, ga4_account: p.account, ga4_acct: a.id });
    }
  }
  const gsc = accts.flatMap((a) => (a.found?.gsc || []).map((g) => ({ ...g, acct: a.id })));
  const dom = (g) => (g.url.startsWith('sc-domain:') ? 0 : 1);
  for (const g of gsc.sort((a, b) => dom(a) - dom(b))) {   // sort 是稳定的：同类里仍按账号连接顺序
    if (!g.host) continue;
    const s = get(g.host);
    if (!s.gsc_site) Object.assign(s, { gsc_site: g.url, gsc_acct: g.acct });
  }

  const now = Date.now();
  const old = new Map((await env.DB.prepare('SELECT host, ga4_property, gsc_site FROM g_sites').all()).results.map((r) => [r.host, r]));
  const stmts = [];
  for (const s of sites.values()) {
    const o = old.get(s.host);
    stmts.push(env.DB.prepare(
      `INSERT INTO g_sites (host, ga4_property, ga4_name, ga4_account, ga4_acct, gsc_site, gsc_acct, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(host) DO UPDATE SET ga4_property = excluded.ga4_property, ga4_name = excluded.ga4_name, ga4_account = excluded.ga4_account,
         ga4_acct = excluded.ga4_acct, gsc_site = excluded.gsc_site, gsc_acct = excluded.gsc_acct, updated_at = excluded.updated_at`
    ).bind(s.host, s.ga4_property, s.ga4_name, s.ga4_account, s.ga4_acct, s.gsc_site, s.gsc_acct, now));
    if (!o) continue;
    // 数据来源变了：清掉旧来源的每日数据，重新回填
    const gaChanged = o.ga4_property !== s.ga4_property, scChanged = o.gsc_site !== s.gsc_site;
    if (gaChanged) stmts.push(env.DB.prepare('UPDATE g_daily SET users = NULL, sessions = NULL, views = NULL, key_events = NULL, engagement = NULL WHERE host = ?').bind(s.host));
    if (scChanged) stmts.push(env.DB.prepare('UPDATE g_daily SET clicks = NULL, impressions = NULL, ctr = NULL, position = NULL WHERE host = ?').bind(s.host));
    if (gaChanged || scChanged) stmts.push(env.DB.prepare("UPDATE g_sites SET synced_at = 0, users = CASE WHEN ? THEN '' ELSE users END WHERE host = ?").bind(gaChanged ? 1 : 0, s.host));
  }
  // 不再出现在任何账号里的站点删掉（有账号这次查询出错时先保留，免得误删）
  const complete = accts.every((a) => a.found && !a.found.errors?.length && !a.found.failed);
  if (complete) {
    for (const host of old.keys()) {
      if (sites.has(host)) continue;
      stmts.push(env.DB.prepare('DELETE FROM g_sites WHERE host = ?').bind(host), env.DB.prepare('DELETE FROM g_daily WHERE host = ?').bind(host));
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { sites: sites.size };
}

// ---------------------------------------------------------------- 同步每日数据

async function syncSite(env, secret, s) {
  const first = !s.synced_at;
  const end = ymd(Date.now()), start = ymd(Date.now() - (first ? BACKFILL_DAYS : REFRESH_DAYS) * DAY);
  const stmts = [], errors = [];
  if (s.ga4_property) {
    try {
      const d = await gfetch(env, secret, s.ga4_acct, `https://analyticsdata.googleapis.com/v1beta/properties/${s.ga4_property}:runReport`, {
        dateRanges: [{ startDate: start, endDate: end }],
        dimensions: [{ name: 'date' }],
        metrics: ['activeUsers', 'sessions', 'screenPageViews', 'keyEvents', 'engagementRate'].map((name) => ({ name })),
        limit: 1000,
      });
      for (const r of d.rows || []) {
        const v = r.dateValue || r.dimensionValues[0].value;
        const date = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
        const m = r.metricValues.map((x) => Number(x.value) || 0);
        stmts.push(env.DB.prepare(
          `INSERT INTO g_daily (host, date, users, sessions, views, key_events, engagement) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(host, date) DO UPDATE SET users = excluded.users, sessions = excluded.sessions, views = excluded.views,
             key_events = excluded.key_events, engagement = excluded.engagement`
        ).bind(s.host, date, ...m));
      }
    } catch (e) { errors.push(`GA4：${e.message}`); }
  }
  if (s.gsc_site) {
    try {
      const d = await gfetch(env, secret, s.gsc_acct, `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(s.gsc_site)}/searchAnalytics/query`, {
        startDate: start, endDate: end, dimensions: ['date'], rowLimit: 1000, dataState: 'all',
      });
      for (const r of d.rows || []) {
        stmts.push(env.DB.prepare(
          `INSERT INTO g_daily (host, date, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(host, date) DO UPDATE SET clicks = excluded.clicks, impressions = excluded.impressions,
             ctr = excluded.ctr, position = excluded.position`
        ).bind(s.host, r.keys[0], r.clicks || 0, r.impressions || 0, r.ctr || 0, r.position || 0));
      }
    } catch (e) { errors.push(`GSC：${e.message}`); }
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
      stmts.push(env.DB.prepare('UPDATE g_sites SET users = ? WHERE host = ?').bind(JSON.stringify(users), s.host));
    } catch (e) { errors.push(`GA4 用户：${e.message}`); }
  }
  stmts.push(env.DB.prepare('UPDATE g_sites SET synced_at = ?, error = ? WHERE host = ?').bind(Date.now(), errors.join('；'), s.host));
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return errors;
}

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
  // 每个账号每天重新发现一次站点
  if (accts.some((a) => a.found_at < Date.now() - DAY)) await discover(env, secret);
  const due = (await env.DB.prepare('SELECT * FROM g_sites WHERE synced_at < ? ORDER BY synced_at LIMIT ?')
    .bind(cutoff, limit).all()).results;
  let done = 0;
  for (const s of due) { await syncSite(env, secret, s); done++; }
  const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM g_sites WHERE synced_at < ?').bind(cutoff).first('n');
  return { done, left };
}

// ---------------------------------------------------------------- 读取

export async function status(env, secret) {
  const c = await googleCreds(env, secret);
  if (!c) return { configured: false };
  const config = { source: c.source, clientId: c.clientId, secretTail: c.clientSecret.slice(-4) };
  const [accts, cnt, last] = await Promise.all([
    accounts(env, secret),
    env.DB.prepare('SELECT COUNT(*) AS n FROM g_sites').first('n'),
    env.DB.prepare('SELECT MAX(synced_at) AS t, SUM(synced_at = 0) AS pending FROM g_sites').first(),
  ]);
  const list = accts.map((a) => {
    const f = a.found ? JSON.parse(a.found) : null;
    return { id: a.id, email: a.email, connectedAt: a.connected_at, error: a.error || '',
      ga4: f ? f.props.length : null, gsc: f ? f.gsc.length : null, errors: f?.errors || [], discoveredAt: a.found_at || null };
  });
  const many = list.length > 1;
  return {
    configured: true, config, connected: list.length > 0, accounts: list,
    // 汇总的错误提示：多个账号时前面带上邮箱
    error: list.filter((a) => a.error).map((a) => `${a.email}：${a.error}`).join('；'),
    errors: list.flatMap((a) => (a.error ? [] : a.errors.map((e) => (many ? `${a.email} · ${e}` : e)))),
    sites: cnt || 0, lastSync: last?.t || null, pending: last?.pending || 0,
  };
}

const sumRange = (rows, from, to) => {
  const t = { users: 0, sessions: 0, views: 0, key_events: 0, clicks: 0, impressions: 0, posw: 0, engw: 0, hasGa: false, hasGsc: false };
  for (const r of rows) {
    if (r.date < from || r.date > to) continue;
    if (r.sessions != null) {
      t.hasGa = true; t.users += r.users; t.sessions += r.sessions; t.views += r.views; t.key_events += r.key_events;
      t.engw += (r.engagement || 0) * r.sessions;
    }
    if (r.clicks != null) { t.hasGsc = true; t.clicks += r.clicks; t.impressions += r.impressions; t.posw += (r.position || 0) * r.impressions; }
  }
  return {
    ga: t.hasGa ? { sessions: t.sessions, views: t.views, keyEvents: t.key_events, engagement: t.sessions ? t.engw / t.sessions : 0 } : null,
    gsc: t.hasGsc ? { clicks: t.clicks, impressions: t.impressions, ctr: t.impressions ? t.clicks / t.impressions : 0, position: t.impressions ? t.posw / t.impressions : 0 } : null,
  };
};

// 区间：截至昨天的 days 天（GSC 数据通常延迟 2–3 天，最近两天会偏低）
export function ranges(days) {
  const to = ymd(Date.now() - DAY), from = ymd(Date.now() - days * DAY);
  const pto = ymd(Date.now() - (days + 1) * DAY), pfrom = ymd(Date.now() - days * 2 * DAY);
  return { from, to, pfrom, pto };
}

export async function sitesList(env, days) {
  const { from, to, pfrom, pto } = ranges(days);
  const [sites, rows] = await Promise.all([
    env.DB.prepare(`SELECT s.*, a.email AS ga4_email, b.email AS gsc_email FROM g_sites s
      LEFT JOIN g_accounts a ON a.id = s.ga4_acct LEFT JOIN g_accounts b ON b.id = s.gsc_acct ORDER BY s.host`).all().then((r) => r.results),
    env.DB.prepare('SELECT * FROM g_daily WHERE date >= ? AND date <= ?').bind(pfrom, to).all().then((r) => r.results),
  ]);
  const byHost = new Map();
  for (const r of rows) { if (!byHost.has(r.host)) byHost.set(r.host, []); byHost.get(r.host).push(r); }
  const sl = await siteLinks(env, new Set(sites.map((s) => s.host)), days).catch(() => new Map());
  return sites.map((s) => {
    const rs = byHost.get(s.host) || [];
    const users = s.users ? JSON.parse(s.users) : {};
    return {
      host: s.host, ga4: s.ga4_property ? { property: s.ga4_property, name: s.ga4_name, account: s.ga4_account, acct: s.ga4_acct, email: s.ga4_email || '' } : null,
      gsc: s.gsc_site || null, gscAcct: s.gsc_acct || '', gscEmail: s.gsc_email || '', syncedAt: s.synced_at || null, error: s.error || '',
      users: users[days] ?? null, prevUsers: hasPrev(days) ? users[`p${days}`] ?? null : null,
      links: sl.get(s.host) || [],
      cur: sumRange(rs, from, to), prev: hasPrev(days) ? sumRange(rs, pfrom, pto) : { ga: null, gsc: null },
      // 每日：n 会话、c 搜索点击、u 用户（按天）；prevSpark 是上一周期每天的会话
      spark: rs.filter((r) => r.date >= from).sort((a, b) => (a.date < b.date ? -1 : 1))
        .map((r) => ({ k: r.date, n: r.sessions ?? 0, c: r.clicks ?? 0, u: r.users ?? 0 })),
      prevSpark: hasPrev(days) ? rs.filter((r) => r.date >= pfrom && r.date <= pto).map((r) => ({ k: r.date, n: r.sessions ?? 0 })) : [],
    };
  });
}

// ---------------------------------------------------------------- 短链 ↔ 站点
// 按短链的跳转去向（默认地址、各条地区规则）的域名匹配站点：域名相同，或是站点的子域名。
// 点击数读访问汇总 agg_d 里按规则（dim = 'rule'）的数据，所以一条短链的不同去向会分别算到各自的站点。

// 找域名对应的站点：a.b.example.com → b.example.com → example.com
function matchHost(host, hosts) {
  for (let h = host; h && h.includes('.'); h = h.slice(h.indexOf('.') + 1)) if (hosts.has(h)) return h;
  return null;
}

// 返回 Map：站点 → [{ id, slug, title, routes: [{ rule, url, countries }], cur, human, prev }]
async function siteLinks(env, hosts, days) {
  const { from, to, pfrom } = ranges(days);
  const [links, rules, counts, daily] = await Promise.all([
    env.DB.prepare('SELECT id, slug, title, target_url FROM links').all().then((r) => r.results),
    env.DB.prepare('SELECT id, link_id, url, countries FROM link_targets').all().then((r) => r.results),
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
  for (const l of links) if (l.target_url) routes.push({ link: l, rule: '0', url: l.target_url, countries: '' });
  for (const r of rules) if (byId.has(r.link_id)) routes.push({ link: byId.get(r.link_id), rule: String(r.id), url: r.url, countries: r.countries });
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
    e.routes.push({ rule: Number(r.rule), url: r.url, countries: r.countries });
    if (c) { e.cur += c.cur; e.human += c.human; e.prev += c.prev; e.prevHuman += c.prevHuman; }
  }
  return new Map([...out].map(([k, m]) => [k, [...m.values()].sort((a, b) => b.human - a.human || b.cur - a.cur)]));
}

// 一条短链指向的站点（短链详情页用）：每个去向匹配到的站点及其区间数据
export async function linkSites(env, linkId, days) {
  const l = await env.DB.prepare('SELECT target_url FROM links WHERE id = ?').bind(linkId).first();
  if (!l) return [];
  const urls = [l.target_url, ...(await env.DB.prepare('SELECT url FROM link_targets WHERE link_id = ?').bind(linkId).all()).results.map((r) => r.url)].filter(Boolean);
  const list = await sitesList(env, days);
  const hosts = new Set(list.map((x) => x.host));
  const want = new Set(urls.map((u) => matchHost(siteHost(u), hosts)).filter(Boolean));
  return list.filter((x) => want.has(x.host)).map((x) => ({ ...x, links: (x.links || []).filter((e) => e.id === linkId) }));
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
  const s = await env.DB.prepare(`SELECT s.*, a.email AS ga4_email, b.email AS gsc_email FROM g_sites s
    LEFT JOIN g_accounts a ON a.id = s.ga4_acct LEFT JOIN g_accounts b ON b.id = s.gsc_acct WHERE s.host = ?`).bind(host).first();
  if (!s) return { error: '站点不存在' };
  const { from, to, pfrom, pto } = ranges(days);
  const rows = (await env.DB.prepare('SELECT * FROM g_daily WHERE host = ? AND date >= ? AND date <= ? ORDER BY date').bind(host, pfrom, to).all()).results;
  const out = {
    host, ga4: s.ga4_property ? { property: s.ga4_property, name: s.ga4_name, account: s.ga4_account, acct: s.ga4_acct, email: s.ga4_email || '' } : null,
    gsc: s.gsc_site || null, gscAcct: s.gsc_acct || '', gscEmail: s.gsc_email || '',
    syncedAt: s.synced_at || null, error: s.error || '', days,
    daily: rows.filter((r) => r.date >= from), prevDaily: hasPrev(days) ? rows.filter((r) => r.date < from) : [],
    cur: sumRange(rows, from, to), prev: hasPrev(days) ? sumRange(rows, pfrom, pto) : { ga: null, gsc: null }, errors: [],
    links: (await siteLinks(env, new Set([host]), days).catch(() => new Map())).get(host) || [],
  };
  const tasks = [];
  if (s.ga4_property) {
    const prop = s.ga4_property;
    const report = (dim, metrics, limit = 20, order = metrics[0]) => ({
      dateRanges: [{ startDate: from, endDate: to }], dimensions: [{ name: dim }],
      metrics: metrics.map((name) => ({ name })), limit, orderBys: [{ metric: { metricName: order }, desc: true }],
    });
    tasks.push(cached(env, `ga4|${prop}|${days}|${to}`, 3600000, async () => {
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
      const [src, pages, countries, devices] = (tops.reports || []).map(rows);
      return { totals, src, pages, countries, devices };
    }).then((v) => { out.ga = v; }).catch((e) => { out.errors.push(`GA4：${e.message}`); }));
    tasks.push(gfetch(env, secret, s.ga4_acct, `https://analyticsdata.googleapis.com/v1beta/properties/${prop}:runRealtimeReport`, { metrics: [{ name: 'activeUsers' }] })
      .then((d) => { out.realtime = Number(d.rows?.[0]?.metricValues?.[0]?.value) || 0; }).catch(() => { out.realtime = null; }));
  }
  if (s.gsc_site) {
    const site = s.gsc_site;
    const q = (dims, extra = {}) => gfetch(env, secret, s.gsc_acct, `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
      startDate: from, endDate: to, dimensions: dims, rowLimit: 25, dataState: 'all', ...extra,
    });
    tasks.push(cached(env, `gsc|${site}|${days}|${to}`, 3600000, async () => {
      const [queries, pages, countries, devices] = await Promise.all([q(['query']), q(['page']), q(['country'], { rowLimit: 15 }), q(['device'], { rowLimit: 5 })]);
      const rows = (d) => (d.rows || []).map((r) => ({ k: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));
      return { queries: rows(queries), pages: rows(pages), countries: rows(countries), devices: rows(devices) };
    }).then((v) => { out.sc = v; }).catch((e) => { out.errors.push(`GSC：${e.message}`); }));
  }
  await Promise.all(tasks);
  return out;
}
