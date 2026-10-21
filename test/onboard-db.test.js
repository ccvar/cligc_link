// 接入 Search Console / Bing（src/onboard.js）：用假的 Cloudflare / Google / Bing 接口跑 DNS 验证和页面标签两种方式（node:sqlite 模拟 D1）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seal } from '../src/google.js';
import * as ob from '../src/onboard.js';

const sqlite = await import('node:sqlite').catch(() => null);
const SQL = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const skip = !sqlite && '需要 Node 22.13+（node:sqlite）';
const SECRET = 'test-secret';
const SCOPE = 'openid email https://www.googleapis.com/auth/webmasters https://www.googleapis.com/auth/siteverification';

async function setup({ scope = SCOPE } = {}) {
  const db = new sqlite.DatabaseSync(':memory:');
  for (const s of SQL.replace(/--[^\n]*/g, '').split(';').map((x) => x.trim()).filter(Boolean)) db.exec(s);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async first(col) { const r = db.prepare(sql).get(...args); return r ? (col ? r[col] : { ...r }) : null; },
    async all() { return { results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }; },
    async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  const env = { DB: { prepare: (sql) => stmt(sql), async batch(list) { for (const s of list) await s.run(); return []; } },
    GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'secret-secret' };
  const uid = `u${Math.random().toString(36).slice(2)}`;
  db.prepare("INSERT INTO g_accounts (id, email, auth, connected_at, error, found) VALUES (?, 'me@x.com', ?, 1, '', ?)")
    .run(uid, await seal(SECRET, { refresh: 'r1', scope }), JSON.stringify({ props: [{ id: '111', name: 'A', account: 'Main', host: 'a.com' }], gsc: [], errors: [] }));
  db.prepare("INSERT INTO g_sites (host, ga4_property, ga4_name, ga4_acct, updated_at) VALUES ('a.com', '111', 'A', ?, 1)").run(uid);
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('int_bing', ?, 1)").run(await seal(SECRET, { key: 'bk' }));
  return { db, env, uid };
}

// 假的外部接口：Cloudflare 记下加的记录，Google 验证看记录在不在（dnsLive 控制“DNS 生效了没有”），Bing 同理
function mockAll({ dnsLive = true } = {}) {
  const real = globalThis.fetch;
  const st = { records: [], gsc: [], gSitemaps: [], bSites: [], bFeeds: [], calls: [], live: dnsLive };
  const J = (o, status = 200) => new Response(JSON.stringify(o), { status });
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url), m = init.method || 'GET', body = typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : null;
    st.calls.push(`${m} ${u}`);
    if (u.startsWith('https://oauth2.googleapis.com/token')) return J({ access_token: 'at', expires_in: 3600 });
    if (u.startsWith('https://api.cloudflare.com/client/v4/zones?')) return J({ success: true, result: [{ id: 'z1', name: 'a.com' }], result_info: { total_pages: 1 } });
    // 像真实的 Cloudflare 一样：按名字查会把 ….a.com.a.com 这种也带出来（代码要自己再精确比）
    if (u.includes('/zones/z1/dns_records') && m === 'GET') { const q = new URL(u).searchParams, n = q.get('name.exact') || q.get('name'); return J({ success: true, result: st.records.filter((r) => r.type === q.get('type') && r.name.startsWith(n)) }); }
    if (u.includes('/zones/z1/dns_records') && m === 'POST') { st.records.push({ ...body, id: `r${st.records.length}` }); return J({ success: true, result: {} }); }
    if (u.includes('/zones/z1/dns_records/') && m === 'DELETE') { const id = u.split('/dns_records/')[1]; st.records = st.records.filter((r) => r.id !== id); return J({ success: true, result: {} }); }
    if (u === 'https://www.googleapis.com/siteVerification/v1/token') return J({ token: body.verificationMethod === 'META' ? '<meta name="google-site-verification" content="gm" />' : 'google-site-verification=gt' });
    if (u.startsWith('https://www.googleapis.com/siteVerification/v1/webResource')) {
      const ok = body.site.type === 'INET_DOMAIN' ? st.live && st.records.some((r) => r.type === 'TXT' && r.content === '"google-site-verification=gt"') : st.live;
      return ok ? J({ id: 'x' }) : J({ error: { message: 'The necessary verification token could not be found on your site.' } }, 400);
    }
    if (u.startsWith('https://www.googleapis.com/webmasters/v3/sites/') && m === 'PUT') {
      if (u.includes('/sitemaps/')) st.gSitemaps.push(decodeURIComponent(u.split('/sitemaps/')[1])); else st.gsc.push(decodeURIComponent(u.split('/sites/')[1]));
      return new Response(null, { status: 204 });
    }
    if (u.startsWith('https://ssl.bing.com/webmaster/api.svc/json/')) {
      const meth = u.split('/json/')[1].split('?')[0];
      if (meth === 'GetUserSites') return J({ d: st.bSites });
      if (meth === 'AddSite') { st.bSites.push({ Url: body.siteUrl, IsVerified: false, AuthenticationCode: 'BAUTH', DnsVerificationCode: 'abc123.a.com' }); return J({ d: null }); }
      if (meth === 'VerifySite') {
        const ok = st.live && st.records.some((r) => r.type === 'CNAME' && r.name === 'abc123.a.com' && r.content === 'verify.bing.com');
        if (ok) st.bSites.forEach((s) => { s.IsVerified = true; });
        return J({ d: ok });
      }
      if (meth === 'SubmitFeed') { st.bFeeds.push(body.feedUrl); return J({ d: null }); }
      return J({ d: [] });
    }
    if (u === 'https://a.com/') return new Response('ok', { status: 200 });
    if (u === 'https://a.com/robots.txt') return new Response('User-agent: *\nSitemap: https://a.com/sitemap.xml\nSitemap: https://other.com/x.xml\n');
    return new Response('', { status: 404 });
  };
  return { st, restore: () => { globalThis.fetch = real; } };
}

test('DNS 方式：加 TXT 和 CNAME 记录、验证、加进 Search Console 和 Bing、提交站点地图', { skip }, async () => {
  const { db, env, uid } = await setup();
  const m = mockAll();
  try {
    const s = await ob.saveCfDns(env, SECRET, { token: 'cf-token-cf-token-cf-token' });
    assert.equal(s.zones, 1);
    const r = await ob.onboardRun(env, SECRET, { host: 'https://www.A.com/x', method: 'dns' });
    assert.equal(r.host, 'a.com');
    assert.equal(r.g.state, 'done', r.g.msg); assert.equal(r.b.state, 'done', r.b.msg);
    assert.deepEqual(m.st.gsc, ['sc-domain:a.com'], 'Google 加的是网域资源');
    assert.deepEqual(m.st.gSitemaps, ['https://a.com/sitemap.xml'], '只提交 robots.txt 里属于这个域名的站点地图');
    assert.deepEqual(m.st.bFeeds, ['https://a.com/sitemap.xml']);
    assert.ok(m.st.records.some((x) => x.type === 'CNAME' && x.proxied === false), 'Bing 的 CNAME 不走代理');
    assert.equal(db.prepare("SELECT gsc_site FROM g_sites WHERE host = 'a.com'").get().gsc_site, 'sc-domain:a.com', '站点直接关联上 Search Console');
    assert.equal(JSON.parse(db.prepare('SELECT found FROM g_accounts WHERE id = ?').get(uid).found).gsc[0].url, 'sc-domain:a.com');
    // 再跑一次：已接入的不重复做，也不会重复加记录
    const n = m.st.records.length;
    const again = await ob.onboardRun(env, SECRET, { host: 'a.com', method: 'dns' });
    assert.equal(again.g.state, 'done'); assert.equal(m.st.records.length, n);
  } finally { m.restore(); }
});

test('DNS 还没生效：记为验证中，定时任务再试时通过', { skip }, async () => {
  const { db, env } = await setup();
  const m = mockAll({ dnsLive: false });
  try {
    await ob.saveCfDns(env, SECRET, { token: 'cf-token-cf-token-cf-token' });
    const r = await ob.onboardRun(env, SECRET, { host: 'a.com', method: 'dns' });
    assert.equal(r.g.state, 'pending'); assert.equal(r.b.state, 'pending');
    assert.equal(m.st.records.length, 2, 'TXT 和 CNAME 各一条');
    m.st.live = true;
    db.prepare('UPDATE site_onboard SET updated_at = 0').run();
    const c = await ob.onboardCron(env, SECRET);
    assert.equal(c.done, 1);
    const row = db.prepare("SELECT * FROM site_onboard WHERE host = 'a.com'").get();
    assert.equal(row.g_state, 'done'); assert.equal(row.b_state, 'done'); assert.equal(row.tries, 1);
    assert.equal(m.st.records.length, 2, '重试时不重复加记录');
  } finally { m.restore(); }
});

test('页面标签方式：取 Google / Bing 的 meta 标签，验证后加网址前缀资源', { skip }, async () => {
  const { db, env } = await setup();
  db.prepare("INSERT INTO g_sites (host, ga4_property, ga4_created, gsc_site, updated_at) VALUES ('new.com', '222', ?, '', 1), ('old.com', '333', 1000, '', 1), ('done.com', '', 0, 'sc-domain:done.com', 1)").run(Date.now());
  db.prepare("UPDATE g_sites SET bing_site = 'https://done.com/' WHERE host = 'done.com'").run();
  const m = mockAll();
  try {
    const list = await ob.onboardList(env, SECRET, []);
    const acct = list.accounts[0].id;
    assert.equal(list.accounts[0].canVerify, true);
    assert.deepEqual(list.items.map((x) => x.host), ['new.com', 'old.com', 'a.com'], '列出还没接入的站点，GA4 接入时间新的在前，没有的排后面');
    assert.ok(list.items[0].since > 0);
    const tags = await ob.onboardMeta(env, SECRET, { host: 'a.com', acct });
    assert.match(tags.google, /google-site-verification/); assert.match(tags.bing, /msvalidate\.01.*BAUTH/);
    const r = await ob.onboardRun(env, SECRET, { host: 'a.com', method: 'meta', acct });
    assert.equal(r.g.state, 'done'); assert.deepEqual(m.st.gsc, ['https://a.com/']);
    assert.ok(!m.st.calls.some((c) => c.includes('api.cloudflare.com')), '不碰 Cloudflare');
  } finally { m.restore(); }
});

test('没有网站验证权限：提示重新授权；没填 DNS 令牌：不能用 DNS 方式', { skip }, async () => {
  const { env } = await setup({ scope: 'openid email https://www.googleapis.com/auth/webmasters' });
  const m = mockAll();
  try {
    assert.match((await ob.onboardRun(env, SECRET, { host: 'a.com', method: 'dns' })).error, /Cloudflare 令牌还不能加 DNS 记录/);
    const r = await ob.onboardRun(env, SECRET, { host: 'a.com', method: 'meta', b: false });
    assert.equal(r.g.state, 'error'); assert.equal(r.g.reauth, true);
  } finally { m.restore(); }
});

test('没单独填 DNS 令牌：“Cloudflare 用量”的令牌能看到域名就直接用它，看不到就当没有', { skip }, async () => {
  const { db, env } = await setup();
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('int_cf', ?, 1)").run(await seal(SECRET, { accountId: 'a'.repeat(32), token: 'usage-token-usage-token' }));
  const m = mockAll();
  try {
    const st = await ob.cfDnsStatus(env, SECRET);
    assert.equal(st.configured, true); assert.equal(st.shared, true); assert.equal(st.zones, 1);
    const r = await ob.onboardRun(env, SECRET, { host: 'a.com', method: 'dns' });
    assert.equal(r.g.state, 'done', r.g.msg);
  } finally { m.restore(); }
  // 只读分析令牌：列不出域名
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => (String(u).includes('api.cloudflare.com') ? new Response(JSON.stringify({ success: false, errors: [{ message: 'Authentication error' }] }), { status: 403 }) : real(u));
  try {
    const st = await ob.cfDnsStatus(env, SECRET);
    assert.equal(st.configured, false); assert.equal(st.usage, true, '告诉设置页：用量令牌在，但还读不到域名');
    assert.equal((await ob.onboardList(env, SECRET, ['a.com'])).cf.configured, false);
  } finally { globalThis.fetch = real; }
});

test('保存 DNS 令牌时分清“令牌无效”和“有效但读不到域名”', { skip }, async () => {
  const { env } = await setup();
  const real = globalThis.fetch;
  let verifyOk = true;
  globalThis.fetch = async (u) => {
    const s = String(u);
    if (s.includes('/user/tokens/verify')) return new Response(JSON.stringify(verifyOk ? { success: true, result: { status: 'active' } } : { success: false, errors: [{ message: 'Invalid API Token' }] }), { status: verifyOk ? 200 : 401 });
    if (s.includes('/zones?')) return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), { status: 403 });
    return real(u);
  };
  try {
    const a = await ob.saveCfDns(env, SECRET, { token: 'tok-tok-tok-tok-tok-tok' });
    assert.match(a.error, /令牌有效，但读不到域名.*区域资源.*Authentication error/);
    verifyOk = false;
    assert.match((await ob.saveCfDns(env, SECRET, { token: 'tok-tok-tok-tok-tok-tok' })).error, /^令牌无效/);
  } finally { globalThis.fetch = real; }
});

test('Bing 的 DNS 验证码本身带域名：记录名不再多拼一次，以前加错的那条删掉', { skip }, async () => {
  const { env } = await setup();
  const m = mockAll();
  try {
    await ob.saveCfDns(env, SECRET, { token: 'cf-token-cf-token-cf-token' });
    // 旧版本加错的记录
    m.st.records.push({ type: 'CNAME', name: 'abc123.a.com.a.com', content: 'verify.bing.com', comment: '', id: 'old' });
    const r = await ob.onboardRun(env, SECRET, { host: 'a.com', method: 'dns' });
    assert.equal(r.b.state, 'done', r.b.msg);
    const cn = m.st.records.filter((x) => x.type === 'CNAME').map((x) => x.name);
    assert.deepEqual(cn, ['abc123.a.com'], '只剩正确的那条');
  } finally { m.restore(); }
});

test('没验证的 Bing 站点不算关联：列表里照样显示成没接入，可以重新接入；同步站点时也不关联', { skip }, async () => {
  const { db, env } = await setup();
  const { rebuildSites } = await import('../src/google.js');
  // Bing 账号里有 a.com，但还没验证（接入时刚加进去、还在等 DNS）
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('bing_found', ?, 1)").run(JSON.stringify({ sites: [{ url: 'https://a.com/', host: 'a.com', verified: false }], at: 1 }));
  db.prepare("UPDATE g_sites SET bing_site = 'https://a.com/', gsc_site = 'sc-domain:a.com' WHERE host = 'a.com'").run();
  db.prepare("INSERT INTO site_onboard (host, method, g_state, b_state, b_msg, created_at, updated_at) VALUES ('a.com', 'dns', 'done', 'done', '已接入', 1, 1)").run();
  const m = mockAll();
  try {
    const list = await ob.onboardList(env, SECRET, []);
    const a = list.items.find((x) => x.host === 'a.com');
    assert.ok(a, '还在列表里');
    assert.equal(a.bingSite, ''); assert.equal(a.b.state, '', '以前误记的“已接入”不算');
    await rebuildSites(env);
    assert.equal(db.prepare("SELECT bing_site FROM g_sites WHERE host = 'a.com'").get().bing_site, '', '同步站点时不关联没验证的');
  } finally { m.restore(); }
});
