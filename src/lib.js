// 不依赖 Workers 运行环境的纯逻辑：访客识别、24 小时统计的计数工具、Cloudflare 用量预测。
// 单独放一个文件，方便 node --test 直接测试（见 test/）。

// robots.txt：短链不需要被收录；/r/ 是给 AI 读的分析报告，要允许 AI 工具抓取（报告本身带 noindex，不会被搜索引擎收录）
// 静态首页（scripts/build-assets.mjs）和 Worker 都用这一份
export const ROBOTS_TXT = 'User-agent: *\nAllow: /r/\nDisallow: /\n';

// ---------------------------------------------------------------- 访客类型：真人 / 爬虫 / 可疑

// 云服务商 / 机房的运营商名称。Cloudflare、Akamai 不算：iCloud 私密中继、WARP 的真人用户也走它们
export const DC_RE = /collyer quay|aceville|amazon|aws|google llc|google cloud|microsoft|azure|digitalocean|linode|hetzner|ovh|vultr|choopa|alibaba|aliyun|tencent|huawei cloud|oracle|scaleway|contabo|leaseweb|m247|datacamp|zenlayer|ucloud|kingsoft cloud|hostinger|ionos|g-core|gcore|psychz|quadranet|colocrossing|hostwinds|kamatera|upcloud|netcup|racknerd|dmit|it7 networks|frantech|buyvm|clouvider|servers\.com|hosting|data ?cent(er|re)|dedicated server|vps/i;
const BOT_NAMES = [
  ['googlebot', 'Googlebot'], ['bingbot', 'Bingbot'], ['baiduspider', '百度蜘蛛'], ['yandex', 'Yandex'], ['bytespider', '字节跳动'],
  ['sogou', '搜狗蜘蛛'], ['360spider', '360 蜘蛛'], ['petalbot', '华为 Petal'], ['applebot', 'Applebot'], ['gptbot', 'GPTBot'],
  ['facebookexternalhit', 'Facebook 预览'], ['twitterbot', 'X 预览'], ['telegrambot', 'Telegram 预览'], ['whatsapp', 'WhatsApp 预览'],
  ['slackbot', 'Slack 预览'], ['discordbot', 'Discord 预览'], ['linkedinbot', 'LinkedIn 预览'], ['semrush', 'Semrush'], ['ahrefs', 'Ahrefs'],
  ['curl', 'curl'], ['wget', 'wget'], ['python', 'Python 脚本'], ['go-http', 'Go 脚本'], ['headless', '无头浏览器'], ['node-fetch', 'Node 脚本'],
];

// 常见云服务商的 ASN。运营商名称不可靠（如腾讯云新加坡登记为“6 COLLYER QUAY”），按 ASN 识别更准
export const DC_ASN = new Map([
  [132203, '腾讯云'], [45090, '腾讯云'], [133478, '腾讯云'], [45102, '阿里云'], [37963, '阿里云'], [24429, '阿里云'],
  [136907, '华为云'], [55990, '华为云'], [137718, '火山引擎'], [396986, '字节跳动'], [38365, '百度云'], [59019, '金山云'], [135377, 'UCloud'],
  [16509, 'AWS'], [14618, 'AWS'], [8987, 'AWS'], [15169, 'Google'], [396982, 'Google Cloud'], [19527, 'Google'],
  [8075, 'Microsoft Azure'], [8068, 'Microsoft'], [14061, 'DigitalOcean'], [63949, 'Linode'], [20473, 'Vultr'], [16276, 'OVH'],
  [24940, 'Hetzner'], [31898, 'Oracle Cloud'], [51167, 'Contabo'], [12876, 'Scaleway'], [60781, 'Leaseweb'], [28753, 'Leaseweb'],
  [9009, 'M247'], [21859, 'Zenlayer'], [212238, 'Datacamp'], [36352, 'ColoCrossing'], [62904, 'Eonix'],
]);

// 说中文的国家 / 地区；中文访客出现在其他地区，多半是经 VPN / 代理访问
const ZH_REGIONS = new Set(['CN', 'HK', 'MO', 'TW', 'SG', 'MY']);

/**
 * 访客类型：
 * - bot：User-Agent 自报为爬虫 / 工具
 * - suspect：强信号（缺语言信息、高频、过旧 TLS）命中一条；或弱信号两条以上；
 *   或机房 IP 再加任一机器特征
 * - human：其余。机房 IP 但浏览器特征完整的，算“真人 · 经代理”（proxy = 1），
 *   VPN、机场节点大多架在机房里
 */
export function classifyVisit({ ua, hasLang, lang, country, asnOrg, asn, recent, secFetch, tls, http }) {
  const s = (ua || '').toLowerCase();
  if (!s) return { kind: 'bot', reason: '没有 User-Agent', proxy: 0 };
  if (parseUA(ua).bot) {
    const hit = BOT_NAMES.find(([k]) => s.includes(k));
    return { kind: 'bot', reason: hit ? hit[1] : '自报为爬虫 / 工具', proxy: 0 };
  }
  let dc = '';
  if (DC_ASN.has(asn)) dc = `${DC_ASN.get(asn)}（AS${asn}）`;
  else if (asnOrg && DC_RE.test(asnOrg) && !/cloudflare|akamai/i.test(asnOrg)) dc = asnOrg;

  const strong = [], weak = [];
  if (!hasLang) strong.push('没有语言信息（Accept-Language）');
  if (recent >= 5) strong.push(`同一 IP 1 分钟内第 ${recent} 次访问`);
  if (/^TLSv1(\.[01])?$/.test(tls || '')) strong.push(`过旧的 ${tls}`);
  // 以下只有新记录才有，补算旧记录时为 undefined
  if (secFetch === false) {
    const chrome = /(?:chrome|chromium)\/(\d+)/.exec(s), ff = /firefox\/(\d+)/.exec(s);
    if ((chrome && +chrome[1] >= 80 && !/crios/.test(s)) || (ff && +ff[1] >= 90 && !/fxios/.test(s))) weak.push('自称新版浏览器，却缺少浏览器请求头');
  }
  if (/^HTTP\/1/.test(http || '')) weak.push(`使用 ${http}`);
  // 自称很旧的系统 / 浏览器版本：真实设备很少停留在这些版本，脚本却常拿来伪装
  const ios = /iphone os (\d+)[_.](\d+)(?:[_.](\d+))?/.exec(s);
  const cr = !/edg|opr|samsung/.test(s) && /chrome\/(\d+)/.exec(s);
  if (ios && +ios[1] < 15) weak.push(`自称旧版系统 iOS ${ios.slice(1).filter(Boolean).join('.')}`);
  else if (cr && +cr[1] < 100) weak.push(`自称旧版浏览器 Chrome ${cr[1]}`);

  if (dc) {
    // 机房 IP：有任一机器特征算可疑；浏览器特征完整（HTTP/2 或 3）算经代理的真人；
    // 旧记录没有协议信息，无法区分，仍按可疑处理
    if (strong.length || weak.length || !/^HTTP\/[23]/.test(http || '')) {
      return { kind: 'suspect', reason: [`机房 IP · ${dc}`, ...strong, ...weak].join('；'), proxy: 0 };
    }
    return { kind: 'human', reason: `经 VPN / 代理 · ${dc}`, proxy: 1 };
  }
  if (strong.length || weak.length >= 2) return { kind: 'suspect', reason: [...strong, ...weak].join('；'), proxy: 0 };
  // 中文访客出现在非中文地区：多半经 VPN / 代理（只作提示，不影响真人判定）
  if (/^zh\b/i.test(lang || '') && country && !ZH_REGIONS.has(country)) {
    return { kind: 'human', reason: [`可能经 VPN / 代理 · 中文访客，IP 在 ${country}`, ...weak].join('；'), proxy: 1 };
  }
  return { kind: 'human', reason: weak.join('；'), proxy: 0 };
}

export function parseUA(ua) {
  const s = ua.toLowerCase();
  const bot = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|preview|curl|wget|python|go-http|node-fetch|axios|headless|monitor|scan|lighthouse/.test(s);
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

// ---------------------------------------------------------------- 目标地址：网址或 App 地址
// App 地址：自定义协议（tg://、weixin://、snssdk1128:// 等）和安卓的 intent://；能执行脚本、读本地文件的协议一律不允许
// 另外挡掉能被拿来钓鱼、装软件或打开本机文件的 Windows / Office 系统协议
const BLOCKED_SCHEMES = new Set(['javascript', 'data', 'file', 'vbscript', 'blob', 'about', 'chrome', 'chrome-extension', 'filesystem', 'view-source', 'ws', 'wss', 'jar', 'resource', 'moz-extension',
  'search-ms', 'search', 'ms-msdt', 'ms-officecmd', 'ms-appinstaller', 'ms-cxh', 'ms-cxh-full', 'ms-word', 'ms-excel', 'ms-powerpoint', 'ms-visio', 'ms-access',
  'ms-project', 'ms-publisher', 'ms-spd', 'ms-infopath', 'shell', 'hcp', 'its', 'ms-its', 'mk']);
export const isWebUrl = (u) => /^https?:\/\//i.test(u || '');
export const isAppUrl = (u) => !!u && !isWebUrl(u);
// 像是 http / https 拼错的协议名：常见写法，或者只由 h p s t 组成、同时有 h 和 t 的短词（没有真实 App 用这种协议名）
export const isHttpTypoScheme = (sc) => sc !== 'http' && sc !== 'https'
  && (/^(h+t+p+s*|ht+ps?|ttps?|htp)s?$/.test(sc) || (/^[hpst]{3,7}$/.test(sc) && sc.includes('h') && sc.includes('t')));
// 合法的目标地址：网址返回规范化后的写法，App 地址原样返回（只去掉首尾空白）；不合法返回 null
export function normalizeTarget(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return null;
  let u;
  try { u = new URL(v); } catch { return null; }
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  // 网址：交给 URL 规范化（空格等会被编码，和以前一样）
  // 主机名是 http / https 一类的，多半是漏了冒号（https//b.com 被补成 https://https//b.com）
  if (scheme === 'http' || scheme === 'https') return u.hostname && !/^https?$/.test(u.hostname) && !isHttpTypoScheme(u.hostname) ? u.toString() : null;
  // http / https 拼错（htps:、hhttps:、ttps:、htts: 等）不能当成 App 地址收下，否则一拼错链接就悄悄失效
  if (isHttpTypoScheme(scheme)) return null;
  // App 地址原样保存，所以不能含空白和控制字符（会被拼进 Location 头），长度也限制一下
  if (v.length > 2000 || /[\s\x00-\x1f\x7f]/.test(v) || !/^[a-z][a-z0-9+.-]*$/.test(scheme) || BLOCKED_SCHEMES.has(scheme)) return null;
  return v;
}
// 会拦截跳转到其他 App 的内置浏览器（只能提示用户“在浏览器打开”）
const IN_APP = [[/micromessenger/i, 'wechat'], [/\bqq\/[\d.]+/i, 'qq'], [/weibo/i, 'weibo'], [/aweme|bytedancewebview|bytelocale/i, 'douyin'],
  [/xhsdiscover/i, 'xiaohongshu'], [/dingtalk/i, 'dingtalk']];
export function inAppBrowser(ua) {
  const hit = IN_APP.find(([re]) => re.test(ua || ''));
  return hit ? hit[1] : '';
}
// 安卓的 intent:// 地址：Chrome 拉不起 App 时会自己去 S.browser_fallback_url；没写的话补上备用网页
export function intentWithFallback(intent, web) {
  if (!web || /S\.browser_fallback_url=/i.test(intent) || !/;end\b/i.test(intent)) return intent;
  return intent.replace(/;end\b/i, `;S.browser_fallback_url=${encodeURIComponent(web)};end`);
}

// 跳转规则里的设备：ios / android / desktop（Windows、macOS、Linux 电脑），其他为 other
export const DEVICES = ['ios', 'android', 'desktop'];
export function deviceKey(p) {
  if (p.os === 'iOS') return 'ios';
  if (p.os === 'Android') return 'android';
  if (['Windows', 'macOS', 'Linux'].includes(p.os) && p.device === 'Desktop') return 'desktop';
  return 'other';
}

// 选出命中的跳转规则：同时指定国家和设备的优先，其次只指定设备，再次只指定国家；都不命中返回 null（走默认地址）
export function pickRule(rules, country, device) {
  const hit = (r) => (!r.countries.length || r.countries.includes(country)) && (!r.devices.length || r.devices.includes(device));
  const rank = (r) => (r.countries.length && r.devices.length ? 3 : r.devices.length ? 2 : 1);
  return rules.filter((r) => (r.countries.length || r.devices.length) && hit(r)).sort((a, b) => rank(b) - rank(a) || a.id - b.id)[0] || null;
}

// A/B 分流：按比例选一个地址。seed 相同（同一访客 + 同一去向）总是选中同一个，访客反复点也不会在几个页面间来回跳
export function pickArm(weights, seed) {
  const ws = weights.map((w) => Math.max(0, Number(w) || 0));
  const total = ws.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  let h = 0x811c9dc5;
  const str = String(seed);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  let x = ((h >>> 0) / 4294967296) * total;
  for (let i = 0; i < ws.length; i++) { if (x < ws[i]) return i; x -= ws[i]; }
  return ws.length - 1;
}
export const ARM_NAMES = ['A', 'B', 'C', 'D', 'E'];

// ---------------------------------------------------------------- 24 小时统计：内存计数工具

export const RAW_COLS = 'link_id, ts, ip, is_bot, kind, proxy, reason, source, referer_host, utm_source, utm_campaign, country, city, device, browser, os, asn, asn_org, rule_id';

// 计数工具：按 key 计数（可同时统计不重复 IP），排序取前 limit 个
export function tally(rows, key, limit = Infinity) {
  const m = new Map();
  for (const r of rows) { const k = key(r); m.set(k, (m.get(k) || 0) + 1); }
  return [...m].map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n).slice(0, limit);
}
export const uniq = (rows, key = (r) => r.ip) => new Set(rows.map(key)).size;
// 与 SQL 里 strftime('%Y-%m-%d %H:00', (ts + tz * 60000) / 1000, 'unixepoch') 相同
export const hourKey = (ts, tzMin) => { const s = new Date(Math.floor((ts + tzMin * 60000) / 1000) * 1000).toISOString(); return `${s.slice(0, 10)} ${s.slice(11, 13)}:00`; };
export const dateKey = (ts, tzMin) => new Date(Math.floor((ts + tzMin * 60000) / 1000) * 1000).toISOString().slice(0, 10);
// 按时间桶：n 次数、u 不重复 IP，按 k 排序
export function buckets(rows, keyOf, withUv = true) {
  const m = new Map();
  for (const r of rows) {
    const k = keyOf(r.ts);
    if (!m.has(k)) m.set(k, { k, n: 0, ips: withUv ? new Set() : null });
    const b = m.get(k); b.n++; if (withUv) b.ips.add(r.ip);
  }
  return [...m.values()].sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0)).map((b) => (withUv ? { k: b.k, n: b.n, u: b.ips.size } : { k: b.k, n: b.n }));
}

// ---------------------------------------------------------------- Cloudflare 用量预测

export const CF_LIMITS = { paid: { rowsRead: 25e9, rowsWritten: 5e7, requests: 1e7 }, free: { rowsRead: 5e6, rowsWritten: 1e5, requests: 1e5 } };
export const CF_NAMES = { rowsRead: 'D1 读取行数', rowsWritten: 'D1 写入行数', requests: 'Worker 请求' };

// 按目前速度推算到期末（付费版：本月底；免费版：今天结束，UTC）。
// 付费版用最近 7 个完整日的日均 × 剩余天数，比本月平均更能反映最近的变化；没有历史时按本月已用 ÷ 已过时间。
export function usageForecast(u, now = Date.now()) {
  const paid = u.plan === 'paid';
  const cur = paid ? u.month : (u.days || []).find((d) => d.date === u.today);
  if (!cur) return null;
  const L = CF_LIMITS[paid ? 'paid' : 'free'];
  const d = new Date(now), y = d.getUTCFullYear(), m = d.getUTCMonth();
  const start = paid ? Date.UTC(y, m, 1) : Date.UTC(y, m, d.getUTCDate());
  const end = paid ? Date.UTC(y, m + 1, 1) : start + 86400000;
  const elapsed = Math.min(1, Math.max(0, (now - start) / (end - start)));
  const recent = (u.days || []).filter((x) => x.date < u.today).slice(-7);
  const items = Object.keys(L).map((k) => {
    const used = cur[k] || 0;
    let proj, rate;   // rate：每毫秒用量
    if (paid && recent.length >= 3) {
      rate = recent.reduce((a, x) => a + (x[k] || 0), 0) / recent.length / 86400000;
      proj = used + rate * (end - now);
    } else {
      rate = now > start ? used / (now - start) : 0;
      proj = elapsed > 0.02 ? used / elapsed : used;
    }
    // 预计用完包含额度的时间（还没用完、且按目前速度会在期末前用完）
    const runOut = used < L[k] && rate > 0 && proj > L[k] ? Math.round(now + (L[k] - used) / rate) : null;
    return { k, name: CF_NAMES[k], used, limit: L[k], ratio: used / L[k], proj: Math.round(proj), projRatio: proj / L[k], runOut };
  });
  return { paid, period: paid ? u.today.slice(0, 7) : u.today, end, elapsed, items };
}


// 版本号比较：a 是否比 b 新（只比较主.次.修订，忽略 v 前缀和预发布后缀）
export function semverGt(a, b) {
  const p = (v) => String(v).replace(/^v/, '').split(/[.-]/).slice(0, 3).map((x) => Number(x) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// ---------------------------------------------------------------- 登录防暴力破解的计数键
// IPv4 按完整地址计数；IPv6 按前 64 位（/64）计数：一台 VPS 通常分到一整个 /64，
// 按完整地址计数的话，换个地址就能再试 5 次，等于没有锁定。会话和修改记录里仍显示完整 IP，这里只用于锁定
export function guardKey(ip) {
  ip = String(ip || '').trim().toLowerCase().replace(/%.*$/, '');
  if (!ip.includes(':')) return ip;
  // ::ffff:1.2.3.4 这类内嵌 IPv4 的地址，按里面的 IPv4 计数（不然所有这类地址会挤进同一个 /64）
  const v4 = ip.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) return v4[1];
  const [h, t] = ip.split('::');
  const a = h ? h.split(':') : [], b = t ? t.split(':') : [];
  const g = t === undefined ? a : [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b];
  return g.slice(0, 4).map((x) => (parseInt(x, 16) || 0).toString(16)).join(':') + '::/64';
}

// D1 出错（最常见的是免费版当天的读写额度用完）：后台接口返回能看懂的说明，访客看到提示页而不是 JSON 原文
export const isDbError = (err) => {
  const m = String(err?.message || err || '');
  return /\bD1_|\bD1\b|SQLITE_/i.test(m) || (/exceed|limit|quota/i.test(m) && /database|rows? (read|written)|storage/i.test(m));
};
