// ---------------------------------------------------------------- AI 接口：给 AI 用的临时令牌和接口
// 后台“设置 → AI 接口”生成令牌（有效期 1 小时 / 1 天 / 7 天，选权限），把接口说明地址（GET /api/ai）和令牌交给 AI。
// AI 用 Authorization: Bearer <令牌> 调用 /api/ai/*：读取站点、新建 GA4 媒体资源和统计代码、管理事件。
// 令牌只存哈希；每次写操作记进 ai_ops。删除类操作（删除事件规则、取消关键事件）默认停在“待确认”，在后台确认后才执行。

import * as ga from './ga4admin.js';

const HOUR = 3600000;
export const PERMS = ['read', 'create', 'events', 'delete'];   // delete：删除类操作不用确认直接执行
const LIFETIMES = { 1: HOUR, 24: 24 * HOUR, 168: 168 * HOUR };
const RATE = 300;   // 每个令牌每小时最多请求次数

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const tokenHash = async (t) => hex(await crypto.subtle.digest('SHA-256', enc.encode(`ai|${t}`)));
const rand = (n) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// ---------------------------------------------------------------- 令牌（后台调用）

export async function createToken(env, b) {
  const hours = LIFETIMES[Number(b.hours)] ? Number(b.hours) : 24;
  const perms = PERMS.filter((p) => (Array.isArray(b.perms) ? b.perms : ['read']).includes(p));
  if (!perms.length) return { error: '请至少选择一项权限' };
  if (!perms.includes('read')) perms.unshift('read');   // 其他操作都要先读站点列表
  const id = rand(6), token = `cl_tk_${rand(24)}`, now = Date.now();
  await env.DB.prepare('INSERT INTO ai_tokens (id, hash, tail, label, perms, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, await tokenHash(token), token.slice(-4), String(b.label || '').trim().slice(0, 60), JSON.stringify(perms), now, now + LIFETIMES[hours]).run();
  return { token, ...tokenOut(await env.DB.prepare('SELECT * FROM ai_tokens WHERE id = ?').bind(id).first()) };
}
const tokenOut = (r) => ({ id: r.id, tail: r.tail, label: r.label, perms: parse(r.perms, []), createdAt: r.created_at, expiresAt: r.expires_at,
  revoked: !!r.revoked_at, expired: r.expires_at < Date.now(), lastUsed: r.last_used || null, uses: r.uses || 0 });
export async function listTokens(env) {
  // 过期 30 天以上的令牌和它们的操作记录一起清掉
  const old = Date.now() - 30 * 24 * HOUR;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM ai_ops WHERE token_id IN (SELECT id FROM ai_tokens WHERE expires_at < ?)').bind(old),
    env.DB.prepare('DELETE FROM ai_tokens WHERE expires_at < ?').bind(old),
  ]);
  return (await env.DB.prepare('SELECT * FROM ai_tokens ORDER BY created_at DESC LIMIT 50').all()).results.map(tokenOut);
}
export async function revokeToken(env, id) {
  await env.DB.prepare('UPDATE ai_tokens SET revoked_at = ? WHERE id = ? AND revoked_at = 0').bind(Date.now(), String(id)).run();
  // 还在等确认的操作一起作废
  await env.DB.prepare("UPDATE ai_ops SET status = 'rejected', result = '令牌已吊销', done_at = ? WHERE token_id = ? AND status = 'pending'").bind(Date.now(), String(id)).run();
  return { ok: true };
}

// ---------------------------------------------------------------- 操作记录

const opOut = (r) => ({ id: r.id, tokenId: r.token_id, at: r.at, action: r.action, host: r.host, params: parse(r.params, {}),
  status: r.status, result: parse(r.result, r.result), doneAt: r.done_at || null });
export async function listOps(env, { pending = false } = {}) {
  return (await env.DB.prepare(`SELECT o.*, t.tail, t.label FROM ai_ops o LEFT JOIN ai_tokens t ON t.id = o.token_id
    ${pending ? "WHERE o.status = 'pending'" : ''} ORDER BY o.id DESC LIMIT 100`).all()).results
    .map((r) => ({ ...opOut(r), tokenTail: r.tail || '', tokenLabel: r.label || '' }));
}
async function logOp(env, tokenId, action, host, params, status, result) {
  const r = await env.DB.prepare('INSERT INTO ai_ops (token_id, at, action, host, params, status, result, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
    .bind(tokenId, Date.now(), action, host || '', JSON.stringify(params || {}), status, typeof result === 'string' ? result : JSON.stringify(result ?? null),
      status === 'pending' ? 0 : Date.now()).first();
  return r.id;
}

// 每种操作：执行函数、需要的权限、是否是删除类（默认要确认）
const ACTIONS = {
  create_property: { perm: 'create', run: (env, secret, host, p, origin) => ga.createProperty(env, secret, p) },
  account_ticket: { perm: 'create', run: (env, secret, host, p, origin) => ga.accountTicket(env, secret, p, origin) },
  key_event: { perm: 'events', destructive: (p) => !p.on, run: (env, secret, host, p) => ga.setKeyEvent(env, secret, host, p.event, !!p.on) },
  create_rule: { perm: 'events', run: (env, secret, host, p) => ga.createEventRule(env, secret, host, p) },
  delete_rule: { perm: 'events', destructive: () => true, run: (env, secret, host, p) => ga.deleteEventRule(env, secret, host, p.id) },
};
export const ACTION_NAMES = { create_property: '新建站点统计', account_ticket: '新建 GA4 账号', key_event: '设置关键事件', create_rule: '新建事件规则', delete_rule: '删除事件规则' };

// 后台确认 / 拒绝一条待确认的操作
export async function decideOp(env, secret, id, ok, origin) {
  const r = await env.DB.prepare("SELECT * FROM ai_ops WHERE id = ? AND status = 'pending'").bind(Number(id)).first();
  if (!r) return { error: '这条操作已经处理过了' };
  if (!ok) {
    await env.DB.prepare("UPDATE ai_ops SET status = 'rejected', result = '已拒绝', done_at = ? WHERE id = ?").bind(Date.now(), r.id).run();
    return { ok: true, status: 'rejected' };
  }
  let status = 'done', result;
  try { result = await ACTIONS[r.action].run(env, secret, r.host, parse(r.params, {}), origin); }
  catch (e) { if (e.budget) throw e; status = 'failed'; result = e.message; }
  await env.DB.prepare('UPDATE ai_ops SET status = ?, result = ?, done_at = ? WHERE id = ?')
    .bind(status, typeof result === 'string' ? result : JSON.stringify(result ?? null), Date.now(), r.id).run();
  return { ok: status === 'done', status, result };
}

// ---------------------------------------------------------------- AI 调用的接口

const out = (data, status = 200) => new Response(JSON.stringify(data, null, 1), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

async function authToken(env, request) {
  const m = /^Bearer\s+(cl_tk_[A-Za-z0-9_-]{20,64})$/.exec(request.headers.get('authorization') || '');
  if (!m) return { error: '缺少令牌：请求头加上 Authorization: Bearer <令牌>', status: 401 };
  const t = await env.DB.prepare('SELECT * FROM ai_tokens WHERE hash = ?').bind(await tokenHash(m[1])).first();
  if (!t) return { error: '令牌无效', status: 401 };
  if (t.revoked_at) return { error: '令牌已被吊销', status: 401 };
  if (t.expires_at < Date.now()) return { error: '令牌已过期，请让用户在后台重新生成', status: 401 };
  const hour = Math.floor(Date.now() / HOUR), n = t.hour === hour ? t.hour_n + 1 : 1;
  if (n > RATE) return { error: `请求太频繁：每个令牌每小时最多 ${RATE} 次`, status: 429 };
  await env.DB.prepare('UPDATE ai_tokens SET hour = ?, hour_n = ?, last_used = ?, uses = uses + 1 WHERE id = ?').bind(hour, n, Date.now(), t.id).run();
  return { token: { ...t, perms: parse(t.perms, []) } };
}

// /api/ai/*。deps：{ secret, origin, sitesForAi } —— 由 index.js 传入，避免这里依赖站点列表的实现
export async function handleAi(request, env, url, deps) {
  const path = url.pathname.replace(/\/+$/, ''), method = request.method;
  if (path === '/api/ai' && method === 'GET') {
    return new Response(aiDoc(url.origin), { headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' } });
  }
  const a = await authToken(env, request);
  if (a.error) return out({ error: a.error }, a.status);
  const tk = a.token, can = (p) => tk.perms.includes(p);
  const need = (p) => out({ error: `这个令牌没有“${{ read: '读取', create: '新建站点统计', events: '管理事件' }[p]}”权限` }, 403);
  const body = method === 'GET' ? {} : await request.json().catch(() => ({}));
  const { secret } = deps;
  const m = (re) => re.exec(path);
  let r;

  // 执行一个操作：删除类且令牌没有 delete 权限时，先记为待确认
  const act = async (action, host, params) => {
    const A = ACTIONS[action];
    if (!can(A.perm)) return need(A.perm);
    if (A.destructive?.(params) && !can('delete')) {
      const id = await logOp(env, tk.id, action, host, params, 'pending', null);
      return out({ status: 'pending', op: id, message: '这是删除类操作，已提交给用户在后台确认，确认后才会执行。可以稍后用 GET /api/ai/ops/{op} 查看结果' }, 202);
    }
    try {
      const res = await A.run(env, secret, host, params, url.origin);
      await logOp(env, tk.id, action, host, params, 'done', res);
      return out({ status: 'done', ...res });
    } catch (e) {
      if (e.budget) throw e;
      await logOp(env, tk.id, action, host, params, 'failed', e.message);
      return out({ status: 'failed', error: e.message, ...(e.reauth ? { reauth: true } : {}) }, e.status || 400);
    }
  };

  try {
    if (path === '/api/ai/me' && method === 'GET') return out({ perms: tk.perms, expiresAt: new Date(tk.expires_at).toISOString(), label: tk.label });
    if (!can('read')) return need('read');
    if (path === '/api/ai/sites' && method === 'GET') return out({ sites: await deps.sitesForAi(env) });
    if (path === '/api/ai/ga4/accounts' && method === 'GET') return out({ accounts: await ga.ga4Accounts(env, secret) });
    if (path === '/api/ai/ga4/properties' && method === 'POST') return act('create_property', '', body);
    if (path === '/api/ai/ga4/account-ticket' && method === 'POST') return act('account_ticket', '', body);
    if ((r = m(/^\/api\/ai\/ops\/(\d+)$/)) && method === 'GET') {
      const op = await env.DB.prepare('SELECT * FROM ai_ops WHERE id = ? AND token_id = ?').bind(Number(r[1]), tk.id).first();
      return op ? out(opOut(op)) : out({ error: '没有这条操作' }, 404);
    }
    if ((r = m(/^\/api\/ai\/sites\/([^/]+)\/(code|events|key-events|event-rules)(?:\/(\d+))?$/))) {
      const host = decodeURIComponent(r[1]).toLowerCase(), what = r[2];
      if (what === 'code' && method === 'GET') return out(await ga.siteCode(env, secret, host));
      if (what === 'events' && method === 'GET') return out(await ga.listEvents(env, secret, host));
      if (what === 'key-events' && method === 'POST') return act('key_event', host, { event: body.event, on: body.on !== false });
      if (what === 'event-rules' && method === 'POST' && !r[3]) return act('create_rule', host, body);
      if (what === 'event-rules' && method === 'DELETE' && r[3]) return act('delete_rule', host, { id: r[3] });
    }
    return out({ error: '没有这个接口，接口说明见 GET /api/ai' }, 404);
  } catch (e) {
    if (e.budget) throw e;
    return out({ error: e.message, ...(e.reauth ? { reauth: true } : {}) }, e.status || 400);
  }
}

// ---------------------------------------------------------------- 接口说明（给 AI 读）

export function aiDoc(origin) {
  return `# cligc link AI 接口

用户把这份说明和一个临时令牌交给你，让你帮他管理网站统计：查看站点、新建 GA4 媒体资源并拿到统计代码、管理 GA4 事件。

- 地址前缀：${origin}/api/ai
- 认证：每个请求的请求头加上 \`Authorization: Bearer <令牌>\`（令牌以 cl_tk_ 开头，有有效期，用户随时可以吊销）
- 请求和返回都是 JSON；出错时返回 \`{ "error": "原因" }\`
- 令牌有权限范围，先调用 \`GET /api/ai/me\` 看能做什么：read（读取）、create（新建站点统计）、events（管理事件）、delete（删除类操作不用确认）
- 每个令牌每小时最多 ${RATE} 次请求；你的每个写操作都会记在用户后台
- 返回 \`"reauth": true\` 表示用户的 Google 账号还没授予 GA4 编辑权限，请让用户到后台 设置 → Google 集成 重新授权，不要重试

## 查看

- \`GET /api/ai/me\`：令牌的权限和过期时间
- \`GET /api/ai/sites\`：所有站点。每项有 host（域名）、ga4（关联的 GA4 媒体资源，没有为 null）、sessions28（近 28 天会话）、gsc / bing（是否关联 Search Console / Bing）
- \`GET /api/ai/ga4/accounts\`：可以新建媒体资源的 GA4 账号。每项 acct 是已连接的 Google 账号 ID，canEdit 表示有没有编辑权限，accounts 里的 name（如 accounts/123）是 GA4 账号
- \`GET /api/ai/sites/{host}/code\`：站点的衡量 ID（G-XXXX）和统计代码 snippet
- \`GET /api/ai/sites/{host}/events\`：最近 28 天收到的事件（name、count、key 是否关键事件、rules 由哪些规则生成、type 类型），以及事件创建规则 rules。type：auto 自动收集、enhanced 增强型衡量（也是自动收集）、recommended Google 推荐的事件名（要网站代码发送）、custom 自定义

## 新建站点统计（需要 create 权限）

\`POST /api/ai/ga4/properties\`

\`\`\`json
{ "url": "https://newsite.com", "acct": "<ga4/accounts 返回的 acct>", "account": "accounts/123", "timeZone": "Asia/Shanghai", "currency": "USD" }
\`\`\`

在指定 GA4 账号下新建媒体资源和网站数据流，返回 measurementId 和 snippet（统计代码，需要贴到网站每个页面的 <head> 里）。这个域名已经有 GA4 媒体资源时会报错，确实要再建一个时加 \`"force": true\`。

新建 GA4 账号：\`POST /api/ai/ga4/account-ticket\` \`{ "acct": "...", "name": "账号名称", "region": "US" }\`，返回一个链接，必须由用户本人打开并同意 Google Analytics 服务条款，账号才会建好。

## 管理事件（需要 events 权限）

- 标记关键事件：\`POST /api/ai/sites/{host}/key-events\` \`{ "event": "purchase", "on": true }\`
- 取消关键事件：同上，\`"on": false\`（删除类，见下）
- 新建事件规则：\`POST /api/ai/sites/{host}/event-rules\`

  \`\`\`json
  { "event": "purchase", "source": "page_view", "field": "page_location", "match": "CONTAINS", "value": "/thank-you", "key": true }
  \`\`\`

  意思是：来源事件 source 的参数 field 满足条件时，额外记一个新事件 event（参数会复制过去）。match 可以是 ${ga.MATCHES.join('、')}。key 为 true 时同时标记为关键事件。事件名只能用字母、数字、下划线，字母开头，最长 40 个字符。
- 删除事件规则：\`DELETE /api/ai/sites/{host}/event-rules/{规则 id}\`（删除类，见下）

需要改网站代码才能发的事件（比如点击某个按钮），GA4 接口做不到；请把类似 \`gtag('event', 'sign_up')\` 的代码交给用户或直接改用户的网站代码。已经收集到的历史事件数据无法删除。

## 删除类操作

取消关键事件、删除事件规则默认需要用户确认：接口返回 HTTP 202 和 \`{ "status": "pending", "op": 12 }\`，用户在后台确认后才执行。用 \`GET /api/ai/ops/{op}\` 查看结果（status：pending 等待确认、done 完成、failed 失败、rejected 用户拒绝）。令牌带 delete 权限时直接执行。

## 建议的做法

1. 先 \`GET /api/ai/me\` 和 \`GET /api/ai/sites\` 了解情况
2. 动手前把要做的事告诉用户；新建媒体资源前确认放在哪个 GA4 账号下
3. 改完后再读一次（events / code）确认结果，把衡量 ID 和统计代码交给用户
`;
}
