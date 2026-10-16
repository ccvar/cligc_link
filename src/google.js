// ---------------------------------------------------------------- Google：GA4 + Search Console
// 授权：OAuth 2.0（Web 应用），只读权限 analytics.readonly、webmasters.readonly。
// 需要 GOOGLE_CLIENT_ID（变量）和 GOOGLE_CLIENT_SECRET（密钥）；回调地址为 <域名>/api/google/callback。
// 刷新令牌用会话密钥派生的 AES-GCM 密钥加密后存进 settings.google_auth。
// 每日数据存在 g_daily，由定时任务和“立即同步”分批更新；详情页的排行、实时数据现查并缓存一小时。

const SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
];
const DAY = 86400000;
const BACKFILL_DAYS = 120, REFRESH_DAYS = 10;

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
async function seal(secret, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), new TextEncoder().encode(JSON.stringify(obj)));
  return `${b64(iv)}.${b64(new Uint8Array(ct))}`;
}
async function unseal(secret, s) {
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

export const googleConfigured = (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
const redirectUri = (origin) => `${origin}/api/google/callback`;

export async function authUrl(env, origin, secret, hmac) {
  const exp = Date.now() + 10 * 60000;
  const state = `${exp}.${await hmac(secret, `goauth|${exp}`)}`;
  const q = new URLSearchParams({
    client_id: String(env.GOOGLE_CLIENT_ID).trim(),
    redirect_uri: redirectUri(origin),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
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
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: url.searchParams.get('code') || '',
      client_id: String(env.GOOGLE_CLIENT_ID).trim(),
      client_secret: String(env.GOOGLE_CLIENT_SECRET).trim(),
      redirect_uri: redirectUri(url.origin),
      grant_type: 'authorization_code',
    }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.refresh_token) return { error: d.error_description || d.error || '没有拿到刷新令牌，请重新连接' };
  let email = '';
  try { email = JSON.parse(atob(d.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).email || ''; } catch {}
  await setSetting(env, 'google_auth', await seal(secret, { refresh: d.refresh_token, email, scope: d.scope, at: Date.now() }));
  tokenCache = { token: d.access_token, exp: Date.now() + (d.expires_in - 60) * 1000 };
  return { ok: true, email };
}

let tokenCache = null;
async function authInfo(env, secret) {
  const s = await getSetting(env, 'google_auth');
  if (!s) return null;
  try { return await unseal(secret, s); } catch { return null; }
}

async function accessToken(env, secret) {
  if (tokenCache && tokenCache.exp > Date.now()) return tokenCache.token;
  const a = await authInfo(env, secret);
  if (!a) throw new Error('未连接 Google 账号');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: String(env.GOOGLE_CLIENT_ID).trim(),
      client_secret: String(env.GOOGLE_CLIENT_SECRET).trim(),
      refresh_token: a.refresh,
      grant_type: 'refresh_token',
    }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 授权被撤销或已失效（例如测试状态的应用 7 天后过期）
    if (d.error === 'invalid_grant') await setSetting(env, 'google_error', '授权已失效，请重新连接 Google 账号');
    throw new Error(d.error_description || d.error || 'Google 令牌刷新失败');
  }
  tokenCache = { token: d.access_token, exp: Date.now() + (d.expires_in - 60) * 1000 };
  return tokenCache.token;
}

export async function disconnect(env, secret) {
  const a = await authInfo(env, secret);
  if (a) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(a.refresh)}`, { method: 'POST' }).catch(() => {});
  tokenCache = null;
  await Promise.all(['google_auth', 'google_error', 'google_discovered'].map((k) => delSetting(env, k)));
  await env.DB.batch([env.DB.prepare('DELETE FROM g_sites'), env.DB.prepare('DELETE FROM g_daily'), env.DB.prepare('DELETE FROM g_cache')]);
}

// 带令牌请求 Google 接口
async function gfetch(env, secret, url, body) {
  const token = await accessToken(env, secret);
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

// 列出所有 GA4 媒体资源和 GSC 站点，按主域名配对，写入 g_sites
export async function discover(env, secret) {
  const errors = [];
  const props = [];
  try {
    let page = '';
    do {
      const d = await gfetch(env, secret, `https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200${page ? `&pageToken=${page}` : ''}`);
      for (const a of d.accountSummaries || []) {
        for (const p of a.propertySummaries || []) props.push({ id: p.property.split('/')[1], name: p.displayName, account: a.displayName });
      }
      page = d.nextPageToken || '';
    } while (page);
  } catch (e) { errors.push(`GA4：${e.message}`); }

  // 每个媒体资源的网站数据流地址，用来确定域名
  await Promise.all(props.map(async (p) => {
    try {
      const d = await gfetch(env, secret, `https://analyticsadmin.googleapis.com/v1beta/properties/${p.id}/dataStreams`);
      const web = (d.dataStreams || []).find((s) => s.webStreamData?.defaultUri);
      p.host = siteHost(web?.webStreamData?.defaultUri || '');
    } catch { p.host = ''; }
  }));

  let gsc = [];
  try {
    const d = await gfetch(env, secret, 'https://www.googleapis.com/webmasters/v3/sites');
    gsc = (d.siteEntry || []).filter((s) => s.permissionLevel !== 'siteUnverifiedUser').map((s) => ({ url: s.siteUrl, host: siteHost(s.siteUrl) }));
  } catch (e) { errors.push(`Search Console：${e.message}`); }

  const sites = new Map();
  const get = (host) => {
    if (!sites.has(host)) sites.set(host, { host, ga4_property: '', ga4_name: '', ga4_account: '', gsc_site: '' });
    return sites.get(host);
  };
  for (const p of props) {
    const s = get(p.host || `ga4-${p.id}`);
    if (!s.ga4_property) Object.assign(s, { ga4_property: p.id, ga4_name: p.name, ga4_account: p.account });
  }
  // 同一域名有“网域”和“网址前缀”两种资源时，优先用网域资源
  for (const g of gsc.sort((a, b) => (a.url.startsWith('sc-domain:') ? -1 : 1) - (b.url.startsWith('sc-domain:') ? -1 : 1))) {
    if (!g.host) continue;
    const s = get(g.host);
    if (!s.gsc_site) s.gsc_site = g.url;
  }

  const now = Date.now();
  const stmts = [...sites.values()].map((s) => env.DB.prepare(
    `INSERT INTO g_sites (host, ga4_property, ga4_name, ga4_account, gsc_site, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(host) DO UPDATE SET ga4_property = excluded.ga4_property, ga4_name = excluded.ga4_name,
       ga4_account = excluded.ga4_account, gsc_site = excluded.gsc_site, updated_at = excluded.updated_at`
  ).bind(s.host, s.ga4_property, s.ga4_name, s.ga4_account, s.gsc_site, now));
  if (sites.size && !errors.length) {
    // 不再出现在账号里的站点删掉
    stmts.push(env.DB.prepare('DELETE FROM g_sites WHERE updated_at < ?').bind(now));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  await setSetting(env, 'google_discovered', JSON.stringify({ at: now, errors, ga4: props.length, gsc: gsc.length }));
  return { sites: sites.size, errors };
}

// ---------------------------------------------------------------- 同步每日数据

async function syncSite(env, secret, s) {
  const first = !s.synced_at;
  const end = ymd(Date.now()), start = ymd(Date.now() - (first ? BACKFILL_DAYS : REFRESH_DAYS) * DAY);
  const stmts = [], errors = [];
  if (s.ga4_property) {
    try {
      const d = await gfetch(env, secret, `https://analyticsdata.googleapis.com/v1beta/properties/${s.ga4_property}:runReport`, {
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
      const d = await gfetch(env, secret, `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(s.gsc_site)}/searchAnalytics/query`, {
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
      const ranges = [[7, 1], [28, 1], [90, 1], [56, 29]];
      const d = await gfetch(env, secret, `https://analyticsdata.googleapis.com/v1beta/properties/${s.ga4_property}:runReport`, {
        dateRanges: ranges.map(([a, b], i) => ({ startDate: y(a), endDate: y(b), name: `r${i}` })),
        metrics: [{ name: 'activeUsers' }],
      });
      const users = {};
      for (const r of d.rows || []) {
        const name = r.dimensionValues?.find((x) => /^r\d$/.test(x.value))?.value;
        if (name) users[name] = Number(r.metricValues[0].value) || 0;
      }
      stmts.push(env.DB.prepare('UPDATE g_sites SET users = ? WHERE host = ?')
        .bind(JSON.stringify({ 7: users.r0 || 0, 28: users.r1 || 0, 90: users.r2 || 0, prev28: users.r3 || 0 }), s.host));
    } catch (e) { errors.push(`GA4 用户：${e.message}`); }
  }
  stmts.push(env.DB.prepare('UPDATE g_sites SET synced_at = ?, error = ? WHERE host = ?').bind(Date.now(), errors.join('；'), s.host));
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return errors;
}

// 一次最多同步 limit 个站点（每个约 3 个请求），按最久未同步优先；返回剩余待同步数。
// cutoff：同步时间早于它的站点才同步（默认 6 小时前）；手动“全部同步”时传入开始同步的时刻
export async function syncBatch(env, secret, { limit = 12, cutoff = Date.now() - 6 * 3600000 } = {}) {
  if (!(await getSetting(env, 'google_auth'))) return { skipped: true };
  const disc = JSON.parse((await getSetting(env, 'google_discovered')) || 'null');
  if (!disc || disc.at < Date.now() - DAY) await discover(env, secret);
  const due = (await env.DB.prepare('SELECT * FROM g_sites WHERE synced_at < ? ORDER BY synced_at LIMIT ?')
    .bind(cutoff, limit).all()).results;
  let done = 0;
  for (const s of due) { await syncSite(env, secret, s); done++; }
  const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM g_sites WHERE synced_at < ?').bind(cutoff).first('n');
  await delSetting(env, 'google_error');
  return { done, left };
}

// ---------------------------------------------------------------- 读取

export async function status(env, secret) {
  if (!googleConfigured(env)) return { configured: false };
  const [a, disc, err, cnt, last] = await Promise.all([
    authInfo(env, secret),
    getSetting(env, 'google_discovered'),
    getSetting(env, 'google_error'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM g_sites').first('n'),
    env.DB.prepare('SELECT MAX(synced_at) AS t, SUM(synced_at = 0) AS pending FROM g_sites').first(),
  ]);
  return {
    configured: true, connected: !!a, email: a?.email || '', connectedAt: a?.at || null,
    discovered: disc ? JSON.parse(disc) : null, error: err || '', sites: cnt || 0,
    lastSync: last?.t || null, pending: last?.pending || 0,
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
    env.DB.prepare('SELECT * FROM g_sites ORDER BY host').all().then((r) => r.results),
    env.DB.prepare('SELECT * FROM g_daily WHERE date >= ? AND date <= ?').bind(pfrom, to).all().then((r) => r.results),
  ]);
  const byHost = new Map();
  for (const r of rows) { if (!byHost.has(r.host)) byHost.set(r.host, []); byHost.get(r.host).push(r); }
  return sites.map((s) => {
    const rs = byHost.get(s.host) || [];
    const users = s.users ? JSON.parse(s.users) : {};
    return {
      host: s.host, ga4: s.ga4_property ? { property: s.ga4_property, name: s.ga4_name, account: s.ga4_account } : null,
      gsc: s.gsc_site || null, syncedAt: s.synced_at || null, error: s.error || '',
      users: users[days] ?? null, prevUsers: days === 28 ? users.prev28 ?? null : null,
      cur: sumRange(rs, from, to), prev: sumRange(rs, pfrom, pto),
      spark: rs.filter((r) => r.date >= from).sort((a, b) => (a.date < b.date ? -1 : 1))
        .map((r) => ({ k: r.date, n: r.sessions ?? 0, c: r.clicks ?? 0 })),
    };
  });
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
  const s = await env.DB.prepare('SELECT * FROM g_sites WHERE host = ?').bind(host).first();
  if (!s) return { error: '站点不存在' };
  const { from, to, pfrom, pto } = ranges(days);
  const rows = (await env.DB.prepare('SELECT * FROM g_daily WHERE host = ? AND date >= ? AND date <= ? ORDER BY date').bind(host, pfrom, to).all()).results;
  const out = {
    host, ga4: s.ga4_property ? { property: s.ga4_property, name: s.ga4_name, account: s.ga4_account } : null, gsc: s.gsc_site || null,
    syncedAt: s.synced_at || null, error: s.error || '', days,
    daily: rows.filter((r) => r.date >= from), prevDaily: rows.filter((r) => r.date < from),
    cur: sumRange(rows, from, to), prev: sumRange(rows, pfrom, pto), errors: [],
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
        gfetch(env, secret, `https://analyticsdata.googleapis.com/v1beta/properties/${prop}:runReport`, {
          dateRanges: [{ startDate: from, endDate: to, name: 'cur' }, { startDate: pfrom, endDate: pto, name: 'prev' }],
          metrics: ['activeUsers', 'newUsers', 'sessions', 'screenPageViews', 'keyEvents', 'engagementRate', 'averageSessionDuration'].map((name) => ({ name })),
        }),
        gfetch(env, secret, `https://analyticsdata.googleapis.com/v1beta/properties/${prop}:batchRunReports`, {
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
    tasks.push(gfetch(env, secret, `https://analyticsdata.googleapis.com/v1beta/properties/${prop}:runRealtimeReport`, { metrics: [{ name: 'activeUsers' }] })
      .then((d) => { out.realtime = Number(d.rows?.[0]?.metricValues?.[0]?.value) || 0; }).catch(() => { out.realtime = null; }));
  }
  if (s.gsc_site) {
    const site = s.gsc_site;
    const q = (dims, extra = {}) => gfetch(env, secret, `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
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
