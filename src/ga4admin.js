// ---------------------------------------------------------------- GA4 管理：新建媒体资源和统计代码、管理事件
// 后台（站点页“新建站点”、站点详情的“事件”卡片）和 AI 接口（src/aiapi.js）都调用这里。
// 写操作需要 Google 账号授予 analytics.edit 权限（早先连接的账号要重新授权一次）。
// 接口：Admin API v1beta（媒体资源、数据流、关键事件）、v1alpha（事件创建规则，测试版），Data API（读取事件）。

import { gfetch, canEdit, siteHost, addProp } from './google.js';

const ADMIN = 'https://analyticsadmin.googleapis.com';
const DATA = 'https://analyticsdata.googleapis.com/v1beta';

// GA4 事件名：字母开头，字母、数字、下划线，最长 40 个字符
export const EVENT_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
// 事件创建规则支持的匹配方式（GA4 的 comparisonType）
export const MATCHES = ['EQUALS', 'EQUALS_CASE_INSENSITIVE', 'CONTAINS', 'CONTAINS_CASE_INSENSITIVE', 'STARTS_WITH', 'STARTS_WITH_CASE_INSENSITIVE',
  'ENDS_WITH', 'ENDS_WITH_CASE_INSENSITIVE', 'REGULAR_EXPRESSION', 'REGULAR_EXPRESSION_CASE_INSENSITIVE'];

const fail = (message, extra = {}) => Object.assign(new Error(message), extra);

// 事件类型（按 Google 文档里的事件名对照，GA4 接口本身不区分）：
//   auto       自动收集：装了 GA4 就有
//   enhanced   增强型衡量：也是自动收集，在网站数据流设置里默认开启、可以关掉
//   recommended 推荐事件：Google 规定好的事件名，要网站代码自己发送
//   custom     自定义事件：其余的名字
const AUTO_EVENTS = new Set(['page_view', 'session_start', 'first_visit', 'user_engagement', 'first_open', 'app_remove', 'os_update', 'app_update',
  'ad_click', 'ad_exposure', 'ad_impression', 'ad_query', 'ad_reward', 'adunit_exposure', 'app_clear_data', 'app_exception', 'dynamic_link_app_open',
  'dynamic_link_app_update', 'dynamic_link_first_open', 'error', 'firebase_campaign', 'in_app_purchase', 'notification_dismiss', 'notification_foreground',
  'notification_open', 'notification_receive', 'screen_view']);
const ENHANCED_EVENTS = new Set(['scroll', 'click', 'view_search_results', 'video_start', 'video_progress', 'video_complete', 'file_download', 'form_start', 'form_submit']);
const RECOMMENDED_EVENTS = new Set(['purchase', 'refund', 'sign_up', 'login', 'search', 'share', 'select_content', 'generate_lead', 'add_payment_info',
  'add_shipping_info', 'add_to_cart', 'add_to_wishlist', 'begin_checkout', 'remove_from_cart', 'select_item', 'select_promotion', 'view_cart', 'view_item',
  'view_item_list', 'view_promotion', 'earn_virtual_currency', 'spend_virtual_currency', 'join_group', 'level_start', 'level_end', 'level_up', 'post_score',
  'tutorial_begin', 'tutorial_complete', 'unlock_achievement', 'close_convert_lead', 'close_unconvert_lead', 'disqualify_lead', 'qualify_lead', 'working_lead']);
export const eventType = (name) => (AUTO_EVENTS.has(name) ? 'auto' : ENHANCED_EVENTS.has(name) ? 'enhanced' : RECOMMENDED_EVENTS.has(name) ? 'recommended' : 'custom');
const REAUTH = '这个 Google 账号还没授予 GA4 编辑权限，请到 设置 → Google 集成 重新授权';

// 统计代码（gtag.js），贴到网站每个页面的 <head> 里
export const gtagSnippet = (mid) => `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=${mid}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${mid}');
</script>`;
// 网站代码里发送自定义事件的示例（点击按钮这类，GA4 接口改不了网站代码）
export const eventSnippet = (name = 'sign_up') => `gtag('event', '${name}', { method: 'email' });`;

// ---------------------------------------------------------------- 新建

// 每个已连接的 Google 账号能用的 GA4 账号（新建媒体资源放在哪个账号下）
export async function ga4Accounts(env, secret) {
  const accts = (await env.DB.prepare("SELECT id, email, error FROM g_accounts ORDER BY connected_at").all()).results;
  return Promise.all(accts.map(async (a) => {
    const out = { acct: a.id, email: a.email, canEdit: await canEdit(env, secret, a.id), accounts: [], error: a.error || '' };
    if (a.error) return out;
    try {
      let page = '';
      do {
        const d = await gfetch(env, secret, a.id, `${ADMIN}/v1beta/accountSummaries?pageSize=200${page ? `&pageToken=${page}` : ''}`);
        for (const s of d.accountSummaries || []) out.accounts.push({ name: s.account, displayName: s.displayName, properties: (s.propertySummaries || []).length });
        page = d.nextPageToken || '';
      } while (page);
    } catch (e) { if (e.budget) throw e; out.error = e.message; }
    return out;
  }));
}

// 新建媒体资源 + 网站数据流，返回衡量 ID 和统计代码。
// b = { acct（哪个已连接的 Google 账号）, account（accounts/123）, url, timeZone, currency, name }
export async function createProperty(env, secret, b) {
  const acct = String(b.acct || ''), account = String(b.account || '');
  let url;
  try { url = new URL(/^https?:\/\//i.test(String(b.url || '')) ? String(b.url) : `https://${b.url}`); } catch { throw fail('网站地址不对'); }
  const host = siteHost(url.href);
  if (!host || !host.includes('.')) throw fail('网站地址不对');
  if (!/^accounts\/\d+$/.test(account)) throw fail('请选择 GA4 账号');
  if (!(await env.DB.prepare('SELECT 1 FROM g_accounts WHERE id = ?').bind(acct).first())) throw fail('对应的 Google 账号已断开');
  if (!(await canEdit(env, secret, acct))) throw fail(REAUTH, { reauth: true });
  const ex = await env.DB.prepare("SELECT ga4_property FROM g_sites WHERE host = ? AND ga4_property != ''").bind(host).first();
  if (ex && !b.force) throw fail(`${host} 已经有 GA4 媒体资源（${ex.ga4_property}）`, { exists: true });
  const timeZone = /^[A-Za-z_]+(\/[A-Za-z_+-]+){0,2}$|^UTC$/.test(String(b.timeZone || '')) ? String(b.timeZone) : 'Asia/Shanghai';
  const currency = /^[A-Z]{3}$/.test(String(b.currency || '')) ? String(b.currency) : 'USD';
  const name = String(b.name || '').trim().slice(0, 100) || host;
  const p = await gfetch(env, secret, acct, `${ADMIN}/v1beta/properties`, { parent: account, displayName: name, timeZone, currencyCode: currency });
  const stream = await gfetch(env, secret, acct, `${ADMIN}/v1beta/${p.name}/dataStreams`, {
    type: 'WEB_DATA_STREAM', displayName: host, webStreamData: { defaultUri: url.origin },
  });
  const id = p.name.split('/')[1], mid = stream.webStreamData?.measurementId || '';
  const summary = (await ga4Accounts(env, secret)).find((x) => x.acct === acct)?.accounts.find((x) => x.name === account);
  await addProp(env, acct, { id, name, account: summary?.displayName || '', host, created: Date.now() });
  return { host, property: id, propertyName: name, measurementId: mid, snippet: gtagSnippet(mid) };
}

// 新建 GA4 账号：Google 要求账号所有者本人同意服务条款，接口只能生成确认链接，打开同意后账号才建好
export async function accountTicket(env, secret, b, origin) {
  const acct = String(b.acct || '');
  if (!(await canEdit(env, secret, acct))) throw fail(REAUTH, { reauth: true });
  const name = String(b.name || '').trim().slice(0, 100);
  if (!name) throw fail('请填写账号名称');
  const region = /^[A-Z]{2}$/.test(String(b.region || '')) ? String(b.region) : 'US';
  const d = await gfetch(env, secret, acct, `${ADMIN}/v1beta/accounts:provisionAccountTicket`, {
    account: { displayName: name, regionCode: region }, redirectUri: `${origin}/api/google/callback`,
  });
  return { url: `https://analytics.google.com/analytics/web/?provisioningSignup=false#/termsofservice/${d.accountTicketId}` };
}

// ---------------------------------------------------------------- 站点的媒体资源和数据流

async function siteRef(env, secret, host, write = false) {
  const s = await env.DB.prepare('SELECT host, ga4_property, ga4_acct, ga4_name FROM g_sites WHERE host = ?').bind(String(host || '')).first();
  if (!s) throw fail('站点不存在', { status: 404 });
  if (!s.ga4_property || !s.ga4_acct) throw fail('这个站点没有关联 GA4');
  if (write && !(await canEdit(env, secret, s.ga4_acct))) throw fail(REAUTH, { reauth: true });
  return s;
}
async function webStream(env, secret, s) {
  const d = await gfetch(env, secret, s.ga4_acct, `${ADMIN}/v1beta/properties/${s.ga4_property}/dataStreams`);
  const w = (d.dataStreams || []).find((x) => x.type === 'WEB_DATA_STREAM');
  if (!w) throw fail('这个 GA4 媒体资源没有网站数据流');
  return { name: w.name, measurementId: w.webStreamData?.measurementId || '', uri: w.webStreamData?.defaultUri || '' };
}

export async function siteCode(env, secret, host) {
  const s = await siteRef(env, secret, host);
  const w = await webStream(env, secret, s);
  return { host: s.host, property: s.ga4_property, measurementId: w.measurementId, uri: w.uri, snippet: gtagSnippet(w.measurementId), eventSnippet: eventSnippet() };
}

// ---------------------------------------------------------------- 事件

// 事件规则的条件 → 便于显示和给 AI 读的样子
const ruleOut = (r) => {
  const conds = r.eventConditions || [];
  const src = conds.find((c) => c.field === 'event_name' && c.comparisonType === 'EQUALS');
  const rest = conds.filter((c) => c !== src).map((c) => ({ field: c.field, match: c.comparisonType, value: c.value }));
  return { id: r.name.split('/').pop(), event: r.destinationEvent, source: src?.value || '', conditions: rest };
};

// 最近 28 天收到的事件、关键事件、事件创建规则，合在一起
export async function listEvents(env, secret, host) {
  const s = await siteRef(env, secret, host);
  const [rep, keys, stream] = await Promise.all([
    gfetch(env, secret, s.ga4_acct, `${DATA}/properties/${s.ga4_property}:runReport`, {
      dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }], dimensions: [{ name: 'eventName' }], metrics: [{ name: 'eventCount' }],
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }], limit: 200,
    }),
    gfetch(env, secret, s.ga4_acct, `${ADMIN}/v1beta/properties/${s.ga4_property}/keyEvents?pageSize=200`),
    webStream(env, secret, s).catch(() => null),
  ]);
  let rules = [], rulesError = '';
  if (stream) {
    try { rules = ((await gfetch(env, secret, s.ga4_acct, `${ADMIN}/v1alpha/${stream.name}/eventCreateRules?pageSize=200`)).eventCreateRules || []).map(ruleOut); }
    catch (e) { if (e.budget) throw e; rulesError = e.message; }
  }
  const ev = new Map();
  const get = (name) => { if (!ev.has(name)) ev.set(name, { name, type: eventType(name), count: 0, key: false, deletable: true, rules: [] }); return ev.get(name); };
  for (const r of rep.rows || []) get(r.dimensionValues[0].value).count = Number(r.metricValues[0].value) || 0;
  for (const k of keys.keyEvents || []) { const e = get(k.eventName); e.key = true; e.deletable = k.deletable !== false; e.custom = !!k.custom; }
  for (const r of rules) get(r.event).rules.push(r);
  return {
    host: s.host, property: s.ga4_property, measurementId: stream?.measurementId || '', canEdit: await canEdit(env, secret, s.ga4_acct),
    events: [...ev.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)), rules, rulesError,
  };
}

// 标记 / 取消关键事件
export async function setKeyEvent(env, secret, host, event, on) {
  event = String(event || '');
  if (!EVENT_RE.test(event)) throw fail('事件名只能用字母、数字、下划线，字母开头，最长 40 个字符');
  const s = await siteRef(env, secret, host, true);
  const base = `${ADMIN}/v1beta/properties/${s.ga4_property}/keyEvents`;
  const list = (await gfetch(env, secret, s.ga4_acct, `${base}?pageSize=200`)).keyEvents || [];
  const ex = list.find((k) => k.eventName === event);
  if (on) {
    if (!ex) await gfetch(env, secret, s.ga4_acct, base, { eventName: event, countingMethod: 'ONCE_PER_EVENT' });
  } else if (ex) {
    if (ex.deletable === false) throw fail(`${event} 是 GA4 默认的关键事件，不能取消`);
    await gfetch(env, secret, s.ga4_acct, `${ADMIN}/v1beta/${ex.name}`, undefined, 'DELETE');
  }
  return { host: s.host, event, key: !!on };
}

// 新建事件规则：source 事件（默认 page_view）满足条件时，记为一个新事件 event。
// b = { event, source, field（默认 page_location）, match（默认 CONTAINS）, value, key（同时标记为关键事件） }
export function ruleBody(b) {
  const event = String(b.event || ''), source = String(b.source || 'page_view'), field = String(b.field || 'page_location');
  const match = String(b.match || 'CONTAINS').toUpperCase(), value = String(b.value ?? '');
  if (!EVENT_RE.test(event)) throw fail('新事件名只能用字母、数字、下划线，字母开头，最长 40 个字符');
  if (!EVENT_RE.test(source)) throw fail('来源事件名不对');
  if (event === source) throw fail('新事件名不能和来源事件一样');
  if (!EVENT_RE.test(field)) throw fail('条件参数名不对');
  if (!MATCHES.includes(match)) throw fail(`匹配方式只能是 ${MATCHES.join(' / ')}`);
  if (value.length > 500) throw fail('条件的值太长');
  const conds = [{ field: 'event_name', comparisonType: 'EQUALS', value: source }];
  if (value) conds.push({ field, comparisonType: match, value });
  return { destinationEvent: event, eventConditions: conds, sourceCopyParameters: true };
}
export async function createEventRule(env, secret, host, b) {
  const body = ruleBody(b);
  const s = await siteRef(env, secret, host, true);
  const stream = await webStream(env, secret, s);
  const r = await gfetch(env, secret, s.ga4_acct, `${ADMIN}/v1alpha/${stream.name}/eventCreateRules`, body);
  if (b.key) await setKeyEvent(env, secret, host, body.destinationEvent, true);
  return { host: s.host, rule: ruleOut(r), key: !!b.key };
}

export async function deleteEventRule(env, secret, host, id) {
  id = String(id || '');
  if (!/^\d+$/.test(id)) throw fail('规则 ID 不对');
  const s = await siteRef(env, secret, host, true);
  const stream = await webStream(env, secret, s);
  await gfetch(env, secret, s.ga4_acct, `${ADMIN}/v1alpha/${stream.name}/eventCreateRules/${id}`, undefined, 'DELETE');
  return { host: s.host, deleted: id };
}
