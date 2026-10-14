import ADMIN_HTML from './admin.html';
import HOME_HTML from './home.html';
import SCHEMA_SQL from '../schema.sql';

const RESERVED = new Set(['admin', 'api', 'favicon.ico', 'robots.txt', '_fb']);
// 回退检测：访客浏览器内探测地区地址的超时时间
const PROBE_TIMEOUT = 2500;
const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_TTL = 7 * 24 * 3600 * 1000;
// 未设置任何密码时使用的默认密码；用它登录后必须先修改密码才能使用后台
const DEFAULT_PASSWORD = 'admin';
const MIN_PASSWORD_LENGTH = 8;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // 首页和 robots.txt 不需要数据库，其余请求先确保表已创建
      if (path !== '/' && path !== '' && path !== '/robots.txt') await ensureSchema(env);
      if (path === '/admin' || path === '/admin/' || path.startsWith('/api/')) {
        if (env.ADMIN_HOST && url.hostname !== env.ADMIN_HOST) return notFound();
        if (path.startsWith('/api/')) return await handleApi(request, env, url);
        return new Response(ADMIN_HTML.replace('__TURNSTILE_SITEKEY__', env.TURNSTILE_SITEKEY || ''), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
      if (path === '/_fb' && request.method === 'POST') return await recordFallback(request, env);
      if (path === '/robots.txt') {
        return new Response('User-agent: *\nDisallow: /\n', { headers: { 'content-type': 'text/plain' } });
      }
      if (path === '/' || path === '') {
        if (env.HOME_URL) return Response.redirect(env.HOME_URL, 302);
        return new Response(HOME_HTML.replaceAll('__YEAR__', String(new Date().getUTCFullYear())), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' },
        });
      }
      return await handleRedirect(request, env, ctx, url);
    } catch (err) {
      console.error(err);
      return json({ error: 'internal error' }, 500);
    }
  },
};

// ---------------------------------------------------------------- 首次运行自动建表

// 每个 Worker 实例只执行一次；表已存在时 CREATE ... IF NOT EXISTS 不会有影响
let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = migrate(env).catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

async function migrate(env) {
  const statements = SCHEMA_SQL
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
  // 老版本数据库补列
  const cols = (await env.DB.prepare('PRAGMA table_info(clicks)').all()).results.map((c) => c.name);
  if (!cols.includes('rule_id')) {
    await env.DB.prepare('ALTER TABLE clicks ADD COLUMN rule_id INTEGER NOT NULL DEFAULT 0').run();
  }
  const tcols = (await env.DB.prepare('PRAGMA table_info(link_targets)').all()).results.map((c) => c.name);
  if (!tcols.includes('fallback')) {
    await env.DB.prepare('ALTER TABLE link_targets ADD COLUMN fallback INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!tcols.includes('fallbacks')) {
    await env.DB.prepare('ALTER TABLE link_targets ADD COLUMN fallbacks INTEGER NOT NULL DEFAULT 0').run();
  }
}

// ---------------------------------------------------------------- 跳转

async function handleRedirect(request, env, ctx, url) {
  const slug = decodeURIComponent(url.pathname.slice(1)).replace(/\/$/, '');
  if (!SLUG_RE.test(slug)) return notFound();

  const link = await env.DB.prepare(
    'SELECT id, target_url, enabled, pass_query, expires_at FROM links WHERE slug = ?'
  ).bind(slug).first();
  if (!link || !link.enabled) return notFound();
  if (link.expires_at && link.expires_at < Date.now()) return new Response('Link expired', { status: 410 });

  // 按访问者所在国家 / 地区匹配跳转规则，未命中则用默认地址
  const country = request.cf?.country || '';
  let rule = null;
  if (country) {
    rule = await env.DB.prepare(
      `SELECT id, url, fallback FROM link_targets WHERE link_id = ? AND (',' || countries || ',') LIKE ?`
    ).bind(link.id, `%,${country},%`).first();
  }
  const ruleId = rule ? rule.id : 0;
  const raw = rule ? rule.url : link.target_url;
  if (!raw) return notConfigured();

  const withQuery = (u) => {
    if (!link.pass_query) return u;
    const t = new URL(u);
    for (const [k, v] of url.searchParams) {
      if (k !== 'src') t.searchParams.set(k, v);
    }
    return t.toString();
  };
  const target = withQuery(raw);

  if (request.method === 'GET') {
    ctx.waitUntil(logClick(request, env, link.id, url, ruleId).catch((e) => console.error('log failed', e)));
  }

  // 规则开启了“打不开时回退”：先在访客浏览器里探测地区地址，连不上再改去默认地址。
  // 爬虫 / 链接预览不执行脚本，直接跳转；http 地址在 https 页面里无法探测，也直接跳转。
  if (rule && rule.fallback && link.target_url && request.method === 'GET'
    && target.startsWith('https:') && !parseUA(request.headers.get('user-agent') || '').bot) {
    const exp = Date.now() + 10 * 60 * 1000;
    const sig = await hmac(await sessionSecret(env), `fb|${rule.id}|${exp}`);
    return probePage(target, withQuery(link.target_url), { r: rule.id, e: exp, s: sig });
  }

  return new Response(null, {
    status: 302,
    headers: { location: target, 'cache-control': 'no-store, private' },
  });
}

// 过渡页：探测目标站点能否在访客网络中打开（任何 HTTP 响应都算能打开），失败则回退
function probePage(target, backup, beacon) {
  const js = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>正在跳转…</title>
<noscript><meta http-equiv="refresh" content="0;url=${target.replace(/"/g, '&quot;')}"></noscript>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f9;color:#868e9e;font:14px -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
@media (prefers-color-scheme:dark){body{background:#08090c;color:#757d8c}}
.s{display:flex;align-items:center;gap:10px;opacity:0;transition:opacity .4s}.s.on{opacity:1}
.d{width:14px;height:14px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:r .8s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}
</style></head><body><div class="s" id="s"><i class="d"></i>正在跳转…</div>
<script>
(function () {
  var t = ${js(target)}, b = ${js(backup)}, fb = ${js(beacon)}, done = false;
  setTimeout(function () { document.getElementById('s').className = 's on'; }, 500);
  function go(u) { if (done) return; done = true; location.replace(u); }
  function fail() {
    if (done) return;
    try { navigator.sendBeacon('/_fb', JSON.stringify(fb)); } catch (e) {}
    go(b);
  }
  var timer = setTimeout(fail, ${PROBE_TIMEOUT});
  try {
    fetch(new URL('/favicon.ico', t).href, { mode: 'no-cors', cache: 'no-store', credentials: 'omit' })
      .then(function () { clearTimeout(timer); go(t); }, function () { clearTimeout(timer); fail(); });
  } catch (e) { clearTimeout(timer); go(t); }
})();
</script></body></html>`;
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, private', 'referrer-policy': 'no-referrer-when-downgrade' },
  });
}

// 记录一次回退（由过渡页通过 sendBeacon 上报，带有效期签名）
async function recordFallback(request, env) {
  const body = await request.text().then((t) => JSON.parse(t)).catch(() => ({}));
  const r = Number(body.r), e = Number(body.e);
  if (!r || !e || e < Date.now() || typeof body.s !== 'string') return new Response(null, { status: 204 });
  const secret = await sessionSecret(env);
  if (await safeEqual(body.s, await hmac(secret, `fb|${r}|${e}`), secret)) {
    await env.DB.prepare('UPDATE link_targets SET fallbacks = fallbacks + 1 WHERE id = ?').bind(r).run();
  }
  return new Response(null, { status: 204 });
}

async function logClick(request, env, linkId, url, ruleId) {
  const h = request.headers;
  const cf = request.cf || {};
  const referer = h.get('referer') || '';
  let refererHost = '';
  try { refererHost = referer ? new URL(referer).hostname : ''; } catch {}

  const qs = url.searchParams;
  const utmSource = qs.get('utm_source') || '';
  const source = qs.get('src') || utmSource || refererHost || '(direct)';
  const ua = h.get('user-agent') || '';
  const parsed = parseUA(ua);
  const now = Date.now();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO clicks (link_id, ts, source, referer, referer_host, utm_source, utm_medium, utm_campaign,
         ip, country, region, city, asn_org, ua, browser, os, device, is_bot, lang, rule_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      linkId, now, cut(source, 200), cut(referer, 1000), cut(refererHost, 200),
      cut(utmSource, 200), cut(qs.get('utm_medium') || '', 200), cut(qs.get('utm_campaign') || '', 200),
      h.get('cf-connecting-ip') || '', cf.country || '', cf.region || '', cf.city || '',
      cut(cf.asOrganization || '', 200), cut(ua, 500),
      parsed.browser, parsed.os, parsed.device, parsed.bot ? 1 : 0,
      cut((h.get('accept-language') || '').split(',')[0], 32),
      ruleId
    ),
    env.DB.prepare('UPDATE links SET clicks = clicks + 1, last_click = ? WHERE id = ?').bind(now, linkId),
  ]);
}

function parseUA(ua) {
  const s = ua.toLowerCase();
  const bot = /bot|crawl|spider|slurp|facebookexternalhit|preview|curl|wget|python|go-http|headless|monitor/.test(s);
  let browser = 'Other';
  if (/micromessenger/.test(s)) browser = 'WeChat';
  else if (/qq\//.test(s) || /mqqbrowser/.test(s)) browser = 'QQ';
  else if (/edg\//.test(s)) browser = 'Edge';
  else if (/opr\/|opera/.test(s)) browser = 'Opera';
  else if (/samsungbrowser/.test(s)) browser = 'Samsung';
  else if (/ucbrowser/.test(s)) browser = 'UC';
  else if (/firefox|fxios/.test(s)) browser = 'Firefox';
  else if (/chrome|crios/.test(s)) browser = 'Chrome';
  else if (/safari/.test(s)) browser = 'Safari';

  let os = 'Other';
  if (/iphone|ipad|ipod/.test(s)) os = 'iOS';
  else if (/android/.test(s)) os = 'Android';
  else if (/windows/.test(s)) os = 'Windows';
  else if (/mac os x|macintosh/.test(s)) os = 'macOS';
  else if (/linux/.test(s)) os = 'Linux';

  let device = 'Desktop';
  if (bot) device = 'Bot';
  else if (/ipad|tablet/.test(s) || (/android/.test(s) && !/mobile/.test(s))) device = 'Tablet';
  else if (/mobi|iphone|android/.test(s)) device = 'Mobile';

  return { browser, os, device, bot };
}

// ---------------------------------------------------------------- 后台 API

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/login' && method === 'POST') return login(request, env);
  if (path === '/api/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
  }

  const cred = await authedCredential(request, env);
  if (!cred) return json({ error: 'unauthorized' }, 401);
  if (method !== 'GET' && !(request.headers.get('content-type') || '').includes('application/json')) {
    return json({ error: 'content-type must be application/json' }, 415);
  }

  const mustChange = cred.source === 'default';
  if (path === '/api/me') return json({ ok: true, mustChange });
  if (path === '/api/password' && method === 'POST') return changePassword(request, env, cred);
  // 仍在使用默认密码时，除修改密码外的接口一律拒绝
  if (mustChange) return json({ error: '请先修改默认密码', mustChange: true }, 403);
  if (path === '/api/overview' && method === 'GET') return overview(env, url);
  if (path === '/api/recent' && method === 'GET') {
    return json({ items: await recentClicks(env, url.searchParams.get('bots') === '1') });
  }
  if (path === '/api/links' && method === 'GET') return listLinks(env, url);
  if (path === '/api/links' && method === 'POST') return createLink(request, env);

  const t = path.match(/^\/api\/links\/(\d+)\/targets(?:\/(\d+))?$/);
  if (t) {
    const linkId = Number(t[1]);
    const tid = t[2] ? Number(t[2]) : null;
    if (!tid && method === 'POST') return saveTarget(request, env, linkId, null);
    if (tid && method === 'PUT') return saveTarget(request, env, linkId, tid);
    if (tid && method === 'DELETE') return deleteTarget(env, linkId, tid);
  }

  const m = path.match(/^\/api\/links\/(\d+)(?:\/(stats|clicks|export))?$/);
  if (m) {
    const id = Number(m[1]);
    const sub = m[2];
    if (!sub && method === 'GET') return getLink(env, id);
    if (!sub && method === 'PUT') return updateLink(request, env, id);
    if (!sub && method === 'DELETE') return deleteLink(env, id);
    if (sub === 'stats' && method === 'GET') return linkStats(env, id, url);
    if (sub === 'clicks' && method === 'GET') return linkClicks(env, id, url);
    if (sub === 'export' && method === 'GET') return exportClicks(env, id);
  }
  return json({ error: 'not found' }, 404);
}

async function login(request, env) {
  const body = await request.json().catch(() => ({}));
  // 配置了 Turnstile 时，先过人机验证再核对密码，防止暴力破解
  if (env.TURNSTILE_SECRET && !(await verifyTurnstile(env, body.turnstile, request))) {
    return json({ error: '人机验证未通过，请重试', turnstile: true }, 403);
  }
  const secret = await sessionSecret(env);
  const cred = await credential(env);
  if (!(await cred.verify(String(body.password || ''), secret))) {
    await new Promise((r) => setTimeout(r, 800));
    return json({ error: '密码错误' }, 401);
  }
  return json({ ok: true, mustChange: cred.source === 'default' }, 200,
    { 'set-cookie': sessionCookie(await issueToken(secret, cred), SESSION_TTL / 1000) });
}

async function changePassword(request, env, cred) {
  const body = await request.json().catch(() => ({}));
  const secret = await sessionSecret(env);
  const current = String(body.current || '');
  const next = String(body.next || '');
  if (!(await cred.verify(current, secret))) {
    await new Promise((r) => setTimeout(r, 800));
    return json({ error: '当前密码不正确' }, 400);
  }
  if (next.length < MIN_PASSWORD_LENGTH) return json({ error: `新密码至少 ${MIN_PASSWORD_LENGTH} 位` }, 400);
  if (next.length > 200) return json({ error: '新密码太长' }, 400);
  if (next === DEFAULT_PASSWORD || next === current) return json({ error: '新密码不能与当前密码或默认密码相同' }, 400);

  await setSetting(env, 'admin_password', JSON.stringify(await hashPassword(next)));
  // 密码变化后，旧会话全部失效；给当前浏览器换发新会话
  const fresh = await credential(env);
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(await issueToken(secret, fresh), SESSION_TTL / 1000) });
}

/**
 * 当前生效的管理员密码，优先级：后台修改过的密码 > ADMIN_PASSWORD > 默认密码
 * stamp 参与会话签名：密码一变，旧会话自动失效
 */
async function credential(env) {
  const row = await getSetting(env, 'admin_password');
  if (row) {
    const stored = JSON.parse(row.value);
    return { source: 'custom', stamp: `custom:${row.updated_at}`, verify: (pw) => verifyPassword(pw, stored) };
  }
  if (env.ADMIN_PASSWORD) {
    return { source: 'env', stamp: 'env', verify: (pw, secret) => safeEqual(pw, env.ADMIN_PASSWORD, secret) };
  }
  return { source: 'default', stamp: 'default', verify: (pw, secret) => safeEqual(pw, DEFAULT_PASSWORD, secret) };
}

async function issueToken(secret, cred) {
  const exp = Date.now() + SESSION_TTL;
  return `${exp}.${await hmac(secret, `${exp}|${cred.stamp}`)}`;
}

// 已登录则返回当前密码信息，否则返回 null
async function authedCredential(request, env) {
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)sl_session=([^;]+)/);
  if (!m) return null;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return null;
  const secret = await sessionSecret(env);
  const cred = await credential(env);
  return (await safeEqual(sig, await hmac(secret, `${exp}|${cred.stamp}`), secret)) ? cred : null;
}

// 会话签名密钥：优先用 SESSION_SECRET，未设置时首次运行自动生成并保存
let cachedSecret = null;
async function sessionSecret(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (cachedSecret) return cachedSecret;
  let row = await getSetting(env, 'session_secret');
  if (!row) {
    await env.DB.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
      .bind('session_secret', toHex(crypto.getRandomValues(new Uint8Array(32))), Date.now()).run();
    row = await getSetting(env, 'session_secret');
  }
  cachedSecret = row.value;
  return cachedSecret;
}

async function getSetting(env, key) {
  return env.DB.prepare('SELECT value, updated_at FROM settings WHERE key = ?').bind(key).first();
}

async function setSetting(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, value, Date.now()).run();
}

// PBKDF2-SHA256 加盐哈希（Workers 上限为 10 万次迭代）
const PBKDF2_ITERATIONS = 100000;
async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return toHex(new Uint8Array(bits));
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { alg: 'pbkdf2-sha256', iter: PBKDF2_ITERATIONS, salt: toHex(salt), hash: await pbkdf2(password, salt, PBKDF2_ITERATIONS) };
}

async function verifyPassword(password, stored) {
  const salt = new Uint8Array(stored.salt.match(/../g).map((h) => parseInt(h, 16)));
  const hash = await pbkdf2(password, salt, stored.iter);
  let diff = hash.length ^ stored.hash.length;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ stored.hash.charCodeAt(i);
  return diff === 0;
}

function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifyTurnstile(env, token, request) {
  if (!token || typeof token !== 'string' || token.length > 2048) return false;
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) form.append('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.error('turnstile verify failed', err);
    return false;
  }
}

function sessionCookie(value, maxAge) {
  return `sl_session=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 先做 HMAC 再比较，避免长度和时序泄露
async function safeEqual(a, b, secret) {
  const [x, y] = await Promise.all([hmac(secret, a), hmac(secret, b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------- 短链 CRUD

async function validateLinkInput(body, env, currentId) {
  const out = {};
  if (body.slug !== undefined) {
    const slug = String(body.slug).trim();
    if (!SLUG_RE.test(slug)) return { error: '短链后缀只能包含字母、数字、- 和 _，长度 1-64' };
    if (RESERVED.has(slug.toLowerCase())) return { error: `"${slug}" 是保留字` };
    const exists = await env.DB.prepare('SELECT id FROM links WHERE slug = ?').bind(slug).first();
    if (exists && exists.id !== currentId) return { error: `短链 "${slug}" 已存在` };
    out.slug = slug;
  }
  if (body.target_url !== undefined) {
    const raw = String(body.target_url ?? '').trim();
    if (raw) {
      const u = normalizeUrl(raw);
      if (!u) return { error: '默认目标地址必须是合法的 http / https 地址' };
      out.target_url = u;
    } else {
      out.target_url = '';
    }
  }
  if (body.title !== undefined) out.title = cut(String(body.title), 200);
  if (body.note !== undefined) out.note = cut(String(body.note), 2000);
  if (body.enabled !== undefined) out.enabled = body.enabled ? 1 : 0;
  if (body.pass_query !== undefined) out.pass_query = body.pass_query ? 1 : 0;
  if (body.expires_at !== undefined) {
    out.expires_at = body.expires_at ? Number(body.expires_at) : null;
    if (out.expires_at !== null && !Number.isFinite(out.expires_at)) return { error: '过期时间不合法' };
  }
  return { data: out };
}

async function createLink(request, env) {
  const body = await request.json().catch(() => ({}));
  // 后缀和默认推广地址至少填一个
  if (!String(body.slug || '').trim() && !String(body.target_url || '').trim()) {
    return json({ error: '请填写短链后缀或默认推广地址' }, 400);
  }
  if (!body.slug) body.slug = await uniqueSlug(env);
  const { error, data } = await validateLinkInput(body, env);
  if (error) return json({ error }, 400);

  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO links (slug, target_url, title, note, enabled, pass_query, expires_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?) RETURNING *`
  ).bind(
    data.slug, data.target_url || '', data.title || '', data.note || '',
    data.enabled ?? 1, data.pass_query ?? 0, data.expires_at ?? null, now, now
  ).first();
  return json(row, 201);
}

async function updateLink(request, env, id) {
  const body = await request.json().catch(() => ({}));
  const { error, data } = await validateLinkInput(body, env, id);
  if (error) return json({ error }, 400);
  const keys = Object.keys(data);
  if (!keys.length) return json({ error: '没有要更新的字段' }, 400);
  data.updated_at = Date.now();
  const cols = Object.keys(data);
  const row = await env.DB.prepare(
    `UPDATE links SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? RETURNING *`
  ).bind(...cols.map((c) => data[c]), id).first();
  return row ? json(row) : json({ error: 'not found' }, 404);
}

async function deleteLink(env, id) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM clicks WHERE link_id = ?').bind(id),
    env.DB.prepare('DELETE FROM link_targets WHERE link_id = ?').bind(id),
    env.DB.prepare('DELETE FROM links WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
}

async function getLink(env, id) {
  const row = await env.DB.prepare('SELECT * FROM links WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'not found' }, 404);
  row.targets = await loadTargets(env, id);
  return json(row);
}

async function loadTargets(env, linkId) {
  const r = await env.DB.prepare('SELECT * FROM link_targets WHERE link_id = ? ORDER BY id').bind(linkId).all();
  return r.results.map((t) => ({ ...t, countries: t.countries.split(',').filter(Boolean) }));
}

// ---------------------------------------------------------------- 地区跳转规则

async function saveTarget(request, env, linkId, tid) {
  const link = await env.DB.prepare('SELECT id FROM links WHERE id = ?').bind(linkId).first();
  if (!link) return json({ error: '短链不存在' }, 404);
  const body = await request.json().catch(() => ({}));

  const url = normalizeUrl(String(body.url || '').trim());
  if (!url) return json({ error: '目标地址必须是合法的 http / https 地址' }, 400);
  const countries = [...new Set((Array.isArray(body.countries) ? body.countries : [])
    .map((c) => String(c).trim().toUpperCase()))];
  if (!countries.length) return json({ error: '至少选择一个国家 / 地区' }, 400);
  if (countries.some((c) => !/^[A-Z]{2}$/.test(c))) return json({ error: '国家代码不合法' }, 400);

  // 同一个国家只能出现在一条规则里
  const others = (await loadTargets(env, linkId)).filter((t) => t.id !== tid);
  const taken = countries.filter((c) => others.some((t) => t.countries.includes(c)));
  if (taken.length) return json({ error: `这些国家 / 地区已在其他规则中：${taken.join('、')}`, taken }, 400);

  const now = Date.now();
  const note = cut(String(body.note || ''), 200);
  const fallback = body.fallback ? 1 : 0;
  const row = tid
    ? await env.DB.prepare(
      'UPDATE link_targets SET countries = ?, url = ?, note = ?, fallback = ?, updated_at = ? WHERE id = ? AND link_id = ? RETURNING *'
    ).bind(countries.join(','), url, note, fallback, now, tid, linkId).first()
    : await env.DB.prepare(
      'INSERT INTO link_targets (link_id, countries, url, note, fallback, created_at, updated_at) VALUES (?,?,?,?,?,?,?) RETURNING *'
    ).bind(linkId, countries.join(','), url, note, fallback, now, now).first();
  if (!row) return json({ error: 'not found' }, 404);
  return json({ ...row, countries }, tid ? 200 : 201);
}

async function deleteTarget(env, linkId, tid) {
  await env.DB.prepare('DELETE FROM link_targets WHERE id = ? AND link_id = ?').bind(tid, linkId).run();
  return json({ ok: true });
}

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    return ['http:', 'https:'].includes(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

const SORTS = {
  created: 'id DESC',
  clicks: 'clicks DESC, id DESC',
  last_click: 'last_click IS NULL, last_click DESC, id DESC',
};

async function listLinks(env, url) {
  const q = (url.searchParams.get('q') || '').trim();
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const size = Math.min(100, Math.max(1, Number(url.searchParams.get('size')) || 20));
  const order = SORTS[url.searchParams.get('sort')] || SORTS.created;
  const tz = Math.max(-840, Math.min(840, Number(url.searchParams.get('tz')) || 0));
  const where = q ? 'WHERE slug LIKE ?1 OR target_url LIKE ?1 OR title LIKE ?1 OR note LIKE ?1' : '';
  const params = q ? [`%${q}%`] : [];
  const [total, rows] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM links ${where}`).bind(...params).first('n'),
    env.DB.prepare(`SELECT *, (SELECT COUNT(*) FROM link_targets t WHERE t.link_id = links.id) AS rules
      FROM links ${where} ORDER BY ${order} LIMIT ${size} OFFSET ${(page - 1) * size}`)
      .bind(...params).all(),
  ]);
  const items = rows.results;

  // 每个短链最近 14 天的每日访问（用于列表里的迷你趋势图）
  if (items.length) {
    const ids = items.map((l) => l.id);
    const spark = await env.DB.prepare(
      `SELECT link_id, date((ts + ? * 60000) / 1000, 'unixepoch') AS k, COUNT(*) AS n FROM clicks
       WHERE link_id IN (${ids.map(() => '?').join(',')}) AND ts >= ? AND is_bot = 0
       GROUP BY link_id, k`
    ).bind(tz, ...ids, Date.now() - 15 * 86400000).all();
    const byId = new Map();
    for (const r of spark.results) {
      if (!byId.has(r.link_id)) byId.set(r.link_id, []);
      byId.get(r.link_id).push({ k: r.k, n: r.n });
    }
    for (const l of items) l.spark = byId.get(l.id) || [];
  }
  return json({ total, page, size, items });
}

async function uniqueSlug(env) {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let len = 5; ; len++) {
    for (let i = 0; i < 5; i++) {
      const bytes = crypto.getRandomValues(new Uint8Array(len));
      const slug = [...bytes].map((b) => chars[b % chars.length]).join('');
      const exists = await env.DB.prepare('SELECT 1 FROM links WHERE slug = ?').bind(slug).first();
      if (!exists) return slug;
    }
  }
}

// ---------------------------------------------------------------- 统计

function rangeParams(url) {
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
  const tz = Math.max(-840, Math.min(840, Number(url.searchParams.get('tz')) || 0)); // 浏览器时区偏移（分钟，东八区=480）
  const bots = url.searchParams.get('bots') === '1';
  const now = Date.now();
  const since = now - days * 86400000;
  const prevSince = since - days * 86400000;
  // 1 天以内按小时出趋势，否则按天
  const bucket = (tzParam) => days <= 1
    ? `strftime('%Y-%m-%d %H:00', (ts + ${tzParam} * 60000) / 1000, 'unixepoch')`
    : `date((ts + ${tzParam} * 60000) / 1000, 'unixepoch')`;
  const span = days * 1440;
  return { days, tz, bots, since, prevSince, bucket, span };
}

async function linkStats(env, id, url) {
  const { tz, bots, since, prevSince, bucket, span } = rangeParams(url);
  const botFilter = bots ? '' : 'AND is_bot = 0';
  const base = `FROM clicks WHERE link_id = ?1 AND ts >= ?2 ${botFilter}`;
  const top = (col, limit = 10) =>
    env.DB.prepare(`SELECT ${col} AS k, COUNT(*) AS n ${base} GROUP BY ${col} ORDER BY n DESC LIMIT ${limit}`)
      .bind(id, since).all().then((r) => r.results);

  const [summary, prev, daily, prevDaily, hourly, sources, refererHosts, countries, cities, devices, browsers, oses, campaigns, targets] =
    await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) AS total, COUNT(DISTINCT ip) AS unique_ips ${base}`).bind(id, since).first(),
      env.DB.prepare(
        `SELECT COUNT(*) AS total, COUNT(DISTINCT ip) AS unique_ips FROM clicks
         WHERE link_id = ?1 AND ts >= ?2 AND ts < ?3 ${botFilter}`
      ).bind(id, prevSince, since).first(),
      env.DB.prepare(
        `SELECT ${bucket('?3')} AS k, COUNT(*) AS n, COUNT(DISTINCT ip) AS u ${base} GROUP BY k ORDER BY k`
      ).bind(id, since, tz).all().then((r) => r.results),
      env.DB.prepare(
        `SELECT ${bucket('?4')} AS k, COUNT(*) AS n FROM clicks WHERE link_id = ?1 AND ts >= ?2 AND ts < ?3 ${botFilter}
         GROUP BY k ORDER BY k`
      ).bind(id, prevSince, since, tz + span).all().then((r) => r.results),
      env.DB.prepare(
        `SELECT CAST(strftime('%H', (ts + ?3 * 60000) / 1000, 'unixepoch') AS INTEGER) AS k, COUNT(*) AS n
         ${base} GROUP BY k ORDER BY k`
      ).bind(id, since, tz).all().then((r) => r.results),
      top('source', 20), top('referer_host', 20), top('country'), top('city'),
      top('device'), top('browser'), top('os'), top('utm_campaign'), top('rule_id', 50),
    ]);

  return json({ summary, prev, daily, prevDaily, hourly, targets, sources, refererHosts, countries, cities, devices, browsers, oses, campaigns });
}

async function linkClicks(env, id, url) {
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const size = Math.min(200, Math.max(1, Number(url.searchParams.get('size')) || 50));
  const bots = url.searchParams.get('bots') === '1';
  const where = `WHERE link_id = ? ${bots ? '' : 'AND is_bot = 0'}`;
  const [total, rows] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM clicks ${where}`).bind(id).first('n'),
    env.DB.prepare(`SELECT * FROM clicks ${where} ORDER BY id DESC LIMIT ${size} OFFSET ${(page - 1) * size}`)
      .bind(id).all(),
  ]);
  return json({ total, page, size, items: rows.results });
}

async function exportClicks(env, id) {
  const link = await env.DB.prepare('SELECT slug FROM links WHERE id = ?').bind(id).first();
  if (!link) return json({ error: 'not found' }, 404);
  const rows = (await env.DB.prepare('SELECT * FROM clicks WHERE link_id = ? ORDER BY id DESC LIMIT 100000')
    .bind(id).all()).results;
  const cols = ['ts', 'source', 'referer', 'utm_source', 'utm_medium', 'utm_campaign', 'ip', 'country',
    'region', 'city', 'asn_org', 'device', 'os', 'browser', 'is_bot', 'lang', 'rule_id', 'ua'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [cols.join(',')];
  for (const r of rows) {
    lines.push(cols.map((c) => esc(c === 'ts' ? new Date(r.ts).toISOString() : r[c])).join(','));
  }
  return new Response('﻿' + lines.join('\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="clicks-${link.slug}.csv"`,
    },
  });
}

async function overview(env, url) {
  const { tz, bots, since, prevSince, bucket, span } = rangeParams(url);
  const botFilter = bots ? '' : 'AND c.is_bot = 0';
  const now = Date.now();
  // 浏览器所在时区的今天 0 点，以及昨天同一时刻
  const dayStart = Math.floor((now + tz * 60000) / 86400000) * 86400000 - tz * 60000;
  const q = (sql, ...args) => env.DB.prepare(sql).bind(...args);
  const all = (stmt) => stmt.all().then((r) => r.results);

  const [links, activeLinks, totals, prev, today, yesterday, daily, prevDaily, topLinks, sources, devices, countries, heat, recent] =
    await Promise.all([
      env.DB.prepare('SELECT COUNT(*) AS n FROM links').first('n'),
      q(`SELECT COUNT(DISTINCT link_id) AS n FROM clicks c WHERE ts >= ? ${botFilter}`, since).first('n'),
      q(`SELECT COUNT(*) AS total, COUNT(DISTINCT ip) AS unique_ips FROM clicks c WHERE ts >= ? ${botFilter}`, since).first(),
      q(`SELECT COUNT(*) AS total, COUNT(DISTINCT ip) AS unique_ips FROM clicks c WHERE ts >= ? AND ts < ? ${botFilter}`, prevSince, since).first(),
      q(`SELECT COUNT(*) AS n FROM clicks c WHERE ts >= ? ${botFilter}`, dayStart).first('n'),
      q(`SELECT COUNT(*) AS n FROM clicks c WHERE ts >= ? AND ts < ? ${botFilter}`, dayStart - 86400000, now - 86400000).first('n'),
      all(q(`SELECT ${bucket('?2')} AS k, COUNT(*) AS n, COUNT(DISTINCT ip) AS u FROM clicks c
             WHERE ts >= ?1 ${botFilter} GROUP BY k ORDER BY k`, since, tz)),
      all(q(`SELECT ${bucket('?3')} AS k, COUNT(*) AS n FROM clicks c
             WHERE ts >= ?1 AND ts < ?2 ${botFilter} GROUP BY k ORDER BY k`, prevSince, since, tz + span)),
      all(q(`SELECT l.id, l.slug, l.title, l.target_url, COUNT(*) AS n, COUNT(DISTINCT c.ip) AS u, MAX(c.ts) AS last
             FROM clicks c JOIN links l ON l.id = c.link_id
             WHERE c.ts >= ? ${botFilter} GROUP BY l.id ORDER BY n DESC LIMIT 8`, since)),
      all(q(`SELECT source AS k, COUNT(*) AS n FROM clicks c WHERE ts >= ? ${botFilter} GROUP BY source ORDER BY n DESC LIMIT 8`, since)),
      all(q(`SELECT device AS k, COUNT(*) AS n FROM clicks c WHERE ts >= ? ${botFilter} GROUP BY device ORDER BY n DESC`, since)),
      all(q(`SELECT country AS k, COUNT(*) AS n FROM clicks c WHERE ts >= ? ${botFilter} GROUP BY country ORDER BY n DESC LIMIT 8`, since)),
      // 星期 × 小时（0 = 周日）
      all(q(`SELECT CAST(strftime('%w', (ts + ?2 * 60000) / 1000, 'unixepoch') AS INTEGER) AS d,
                    CAST(strftime('%H', (ts + ?2 * 60000) / 1000, 'unixepoch') AS INTEGER) AS h, COUNT(*) AS n
             FROM clicks c WHERE ts >= ?1 ${botFilter} GROUP BY d, h`, since, tz)),
      recentClicks(env, bots),
    ]);
  return json({ links, activeLinks, totals, prev, today, yesterday, daily, prevDaily, topLinks, sources, devices, countries, heat, recent });
}

async function recentClicks(env, bots) {
  const r = await env.DB.prepare(
    `SELECT c.id, c.ts, c.source, c.country, c.city, c.device, c.os, c.browser, l.id AS link_id, l.slug
     FROM clicks c JOIN links l ON l.id = c.link_id
     ${bots ? '' : 'WHERE c.is_bot = 0'} ORDER BY c.ts DESC LIMIT 12`
  ).all();
  return r.results;
}

// ---------------------------------------------------------------- 工具

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

// 简单的提示页（短链不存在 / 暂不可用），风格与首页一致
function infoPage(title, message, status) {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title} · cligc</title>
<style>
:root{--bg:#f4f5f7;--text:#0d1321;--muted:#6b7385;--line:#e3e6ec;--accent:#2f6bff}
@media (prefers-color-scheme:dark){:root{--bg:#0a0c10;--text:#edeff3;--muted:#8a92a3;--line:#262a33;--accent:#5f8fff}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);
font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
main{text-align:center;max-width:380px;animation:r .6s cubic-bezier(.16,1,.3,1) both}
@keyframes r{from{opacity:0;transform:translateY(8px)}}
.code{font:600 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);letter-spacing:.1em;margin:22px 0 10px}
h1{margin:0 0 8px;font-size:22px;letter-spacing:-.02em}p{margin:0;color:var(--muted)}
a{display:inline-flex;align-items:center;gap:8px;margin-top:28px;color:var(--muted);text-decoration:none;font-size:13px}
a:hover{color:var(--accent)}
</style></head><body><main>
<svg width="44" height="44" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4b83ff"/><stop offset="1" stop-color="#1f4fd1"/></linearGradient></defs><rect width="32" height="32" rx="9" fill="url(#g)"/><path d="M10.5 21.5 21.5 10.5M13.5 10.5h8v8" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
<div class="code">${status}</div><h1>${title}</h1><p>${message}</p>
<a href="/">cligc 短链服务 →</a></main></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

function notConfigured() {
  return infoPage('链接暂不可用', '该链接在你所在的地区暂未开放，请稍后再试。', 404);
}

function notFound() {
  return infoPage('链接不存在', '这个短链接不存在或已被停用，请检查链接是否完整。', 404);
}

function cut(s, n) {
  return s.length > n ? s.slice(0, n) : s;
}
