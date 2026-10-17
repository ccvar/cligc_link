// ---------------------------------------------------------------- 访问汇总
// 统计页面不再每次扫描全部访问明细，而是读汇总表：
//   agg_h  每小时 · 每个短链 · 真人 / 机器 的访问次数（趋势、今日、活跃时段）
//   agg_d  每天 · 每个短链 · 真人 / 机器 · 维度值 的访问次数（来源、国家、设备……）
//   agg_uv 每天 · 每个短链（0 = 全部短链）· 真人 / 机器 的独立访客（HyperLogLog 估算，误差约 5%）
//   agg_suv 每天 · 每个短链 · 每个来源 的真人独立访客（同样是 HyperLogLog；访客少时用稀疏格式省空间），用于“从站点点出的短链”去重
// 汇总进度记在 settings.agg_mark（整点毫秒），之后的访问直接读原始明细，统计始终实时。
// “天”按 settings.agg_tz（分钟偏移）划分，取自首次统计请求的浏览器时区。

const HOUR = 3600000, DAY = 86400000;

// 原始列 → 维度名
const COLS = {
  source: 'source', referer_host: 'referer_host', utm_source: 'utm_source', utm_campaign: 'utm_campaign',
  country: 'country', city: 'city', device: 'device', browser: 'browser', os: 'os', rule: 'rule_id',
};

export const dayKey = (ts, tz) => new Date(ts + tz * 60000).toISOString().slice(0, 10);
const addDays = (key, n) => new Date(Date.parse(key + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);

// ---------------------------------------------------------------- HyperLogLog（p = 9，512 个寄存器）
const P = 9, M = 1 << P;
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}
export const hllNew = () => new Uint8Array(M);
export function hllAdd(reg, s) {
  const h = hash(String(s));
  const w = (h << P) >>> 0;
  const rho = w === 0 ? 32 - P + 1 : Math.clz32(w) + 1;
  const i = h >>> (32 - P);
  if (rho > reg[i]) reg[i] = rho;
}
export function hllMerge(a, b) { for (let i = 0; i < M; i++) if (b[i] > a[i]) a[i] = b[i]; return a; }
export function hllCount(reg) {
  let sum = 0, zeros = 0;
  for (let i = 0; i < M; i++) { sum += 2 ** -reg[i]; if (!reg[i]) zeros++; }
  const e = (0.7213 / (1 + 1.079 / M)) * M * M / sum;
  return Math.round(zeros && e <= 2.5 * M ? M * Math.log(M / zeros) : e);
}
const hllDecode = (s) => (s ? Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) : hllNew());
const hllEncode = (r) => btoa(String.fromCharCode(...r));
// 稀疏格式：只记非零寄存器“序号.值”，以 s 开头；非零的多了就用完整格式
export function hllParse(s) {
  if (!s) return hllNew();
  if (s[0] !== 's') return hllDecode(s);
  const reg = hllNew();
  for (const p of s.slice(1).split(',')) { if (!p) continue; const [i, v] = p.split('.'); reg[Number(i)] = Number(v); }
  return reg;
}
export function hllPack(reg) {
  const nz = [];
  for (let i = 0; i < M; i++) if (reg[i]) nz.push(`${i}.${reg[i]}`);
  return nz.length <= 60 ? 's' + nz.join(',') : hllEncode(reg);
}

// ---------------------------------------------------------------- 写入汇总

async function getSetting(env, key) {
  return (await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first('value')) ?? null;
}
async function setSetting(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, String(value), Date.now()).run();
}

export async function aggState(env) {
  const [mark, tz] = await Promise.all([getSetting(env, 'agg_mark'), getSetting(env, 'agg_tz')]);
  return { mark: Number(mark) || 0, tz: tz === null ? null : Number(tz) };
}

// 把已结束的整点内的访问汇总进来。用租约防止多个请求同时汇总造成重复计数。
export async function aggregate(env, tz) {
  const target = Math.floor(Date.now() / HOUR) * HOUR;
  let st = await aggState(env);
  if (st.tz === null) {
    if (tz === undefined || tz === null) return st;
    await setSetting(env, 'agg_tz', tz);
    st.tz = tz;
  }
  if (st.mark >= target) return st;

  const now = Date.now();
  await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('agg_lock', '', 0)").run();
  const lock = await env.DB.prepare(
    "UPDATE settings SET value = '1', updated_at = ? WHERE key = 'agg_lock' AND (value = '' OR updated_at < ?)"
  ).bind(now, now - 120000).run();
  if (!lock.meta.changes) return st;
  try {
    st = await aggState(env);
    if (!st.mark) {
      const first = await env.DB.prepare('SELECT MIN(ts) AS t FROM clicks').first('t');
      st.mark = first ? Math.floor(first / HOUR) * HOUR : target;
    }
    let done = 0;
    while (st.mark < target && done < 40000) {
      const end = Math.min(target, st.mark + DAY);
      done += await aggregateRange(env, st.mark, end, st.tz);
      st.mark = end;
      await setSetting(env, 'agg_mark', st.mark);
    }
    if (!(await getSetting(env, 'agg_mark'))) await setSetting(env, 'agg_mark', st.mark);
  } finally {
    await env.DB.prepare("UPDATE settings SET value = '' WHERE key = 'agg_lock'").run();
  }
  return st;
}

async function aggregateRange(env, from, to, tz) {
  const rows = (await env.DB.prepare(
    `SELECT link_id, ts, is_bot, ip, source, referer_host, utm_source, utm_campaign, country, city, device, browser, os,
       rule_id, kind, proxy, reason, asn, asn_org FROM clicks WHERE ts >= ? AND ts < ?`
  ).bind(from, to).all()).results;
  if (!rows.length) return 0;

  const h = new Map(), d = new Map(), uv = new Map(), suv = new Map();
  const inc = (m, key, n = 1) => m.set(key, (m.get(key) || 0) + n);
  for (const r of rows) {
    const mc = r.is_bot ? 1 : 0, day = dayKey(r.ts, tz);
    inc(h, `${Math.floor(r.ts / HOUR)}|${r.link_id}|${mc}`);
    const put = (dim, k) => inc(d, `${dim}\u0001${day}\u0001${r.link_id}\u0001${mc}\u0001${k ?? ''}`);
    put('', '');
    for (const [dim, col] of Object.entries(COLS)) put(dim, r[col]);
    put('kind', (r.kind || 'human') + (r.proxy ? ':p' : ''));
    if (mc) {
      put('asn', `${r.kind || ''}\t${r.asn || 0}\t${r.asn_org || ''}`);
      if (r.reason) put('reason', r.reason);
    }
    for (const lid of [r.link_id, 0]) {
      const key = `${day}|${lid}|${mc}`;
      if (!uv.has(key)) uv.set(key, new Set());
      uv.get(key).add(r.ip || '');
    }
    addSource(suv, r, day);
  }

  const stmts = [];
  for (const [key, n] of h) {
    const [hour, lid, mc] = key.split('|').map(Number);
    stmts.push(env.DB.prepare(
      'INSERT INTO agg_h (hour, link_id, machine, n) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET n = n + excluded.n'
    ).bind(hour, lid, mc, n));
  }
  for (const [key, n] of d) {
    const [dim, day, lid, mc, k] = key.split('\u0001');
    stmts.push(env.DB.prepare(
      'INSERT INTO agg_d (dim, day, link_id, machine, k, n) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET n = n + excluded.n'
    ).bind(dim, day, Number(lid), Number(mc), k, n));
  }
  // 独立访客：读出已有的估算，合并新 IP 后写回
  const keys = [...uv.keys()].map((k) => k.split('|'));
  const old = new Map();
  for (let i = 0; i < keys.length; i += 30) {
    const part = keys.slice(i, i + 30);
    const res = await env.DB.prepare(
      `SELECT day, link_id, machine, hll FROM agg_uv WHERE ${part.map(() => '(day = ? AND link_id = ? AND machine = ?)').join(' OR ')}`
    ).bind(...part.flatMap(([day, lid, mc]) => [day, Number(lid), Number(mc)])).all();
    for (const r of res.results) old.set(`${r.day}|${r.link_id}|${r.machine}`, r.hll);
  }
  for (const [key, ips] of uv) {
    const reg = hllDecode(old.get(key));
    for (const ip of ips) hllAdd(reg, ip);
    const [day, lid, mc] = key.split('|');
    stmts.push(env.DB.prepare(
      'INSERT INTO agg_uv (day, link_id, machine, hll) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET hll = excluded.hll'
    ).bind(day, Number(lid), Number(mc), hllEncode(reg)));
  }
  stmts.push(...(await suvStatements(env, suv)));
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return rows.length;
}

// 按来源的独立访客：只统计真人访问、有来源的
function addSource(suv, r, day) {
  if (r.is_bot || !r.source || r.source === '(direct)') return;
  const key = `${day}\u0001${r.link_id}\u0001${r.source}`;
  if (!suv.has(key)) suv.set(key, new Set());
  suv.get(key).add(r.ip || '');
}
// 读出已有的估算，合并新 IP 后写回（同一个 IP 重复加入不影响结果，所以重复处理也不会多算）
async function suvStatements(env, suv) {
  const keys = [...suv.keys()].map((k) => k.split('\u0001'));
  const old = new Map();
  for (let i = 0; i < keys.length; i += 30) {
    const part = keys.slice(i, i + 30);
    const res = await env.DB.prepare(
      `SELECT day, link_id, k, hll FROM agg_suv WHERE ${part.map(() => '(day = ? AND link_id = ? AND k = ?)').join(' OR ')}`
    ).bind(...part.flatMap(([day, lid, k]) => [day, Number(lid), k])).all();
    for (const r of res.results) old.set(`${r.day}\u0001${r.link_id}\u0001${r.k}`, r.hll);
  }
  const stmts = [];
  for (const [key, ips] of suv) {
    const reg = hllParse(old.get(key));
    for (const ip of ips) hllAdd(reg, ip);
    const [day, lid, k] = key.split('\u0001');
    stmts.push(env.DB.prepare('INSERT INTO agg_suv (day, link_id, k, hll) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET hll = excluded.hll')
      .bind(day, Number(lid), k, hllPack(reg)));
  }
  return stmts;
}

// 一次性回填：按来源的独立访客是后加的，已汇总过的旧明细从头补一遍（每次最多 2 万条，进度记在 settings.suv_mark）
export async function backfillSourceUv(env) {
  const st = await aggState(env);
  if (st.tz === null || !st.mark) return { done: true };
  const done = await getSetting(env, 'suv_mark');
  if (done === 'done') return { done: true };
  let from = Number(done) || 0;
  if (!from) from = (await env.DB.prepare('SELECT MIN(ts) AS t FROM clicks').first('t')) || st.mark;
  if (from >= st.mark) { await setSetting(env, 'suv_mark', 'done'); return { done: true }; }
  const rows = (await env.DB.prepare(
    "SELECT link_id, ts, is_bot, ip, source FROM clicks WHERE ts >= ? AND ts < ? AND is_bot = 0 AND source != '' AND source != '(direct)' ORDER BY ts LIMIT 20000"
  ).bind(from, st.mark).all()).results;
  const suv = new Map();
  for (const r of rows) addSource(suv, r, dayKey(r.ts, st.tz));
  const stmts = await suvStatements(env, suv);
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  const next = rows.length < 20000 ? st.mark : rows[rows.length - 1].ts + 1;
  await setSetting(env, 'suv_mark', next >= st.mark ? 'done' : next);
  return { done: next >= st.mark, rows: rows.length };
}

// 读取：区间内每个（短链, 来源）的独立访客寄存器（按天合并好）
export async function sourceUv(env, fromDay, toDay) {
  const rows = (await env.DB.prepare('SELECT link_id, k, hll FROM agg_suv WHERE day >= ? AND day <= ?').bind(fromDay, toDay).all()).results;
  const m = new Map();
  for (const r of rows) {
    const key = `${r.link_id}\u0001${r.k}`;
    m.set(key, m.has(key) ? hllMerge(m.get(key), hllParse(r.hll)) : hllParse(r.hll));
  }
  return [...m].map(([key, reg]) => { const [lid, k] = key.split('\u0001'); return { link_id: Number(lid), k, reg }; });
}

// 访客类型重新判定后，汇总里的真人 / 机器划分已过期：从仍保留明细的第二天起重建
export async function rebuildAgg(env) {
  const st = await aggState(env);
  if (st.tz === null || !st.mark) return;
  const first = await env.DB.prepare('SELECT MIN(ts) AS t FROM clicks').first('t');
  if (!first) return;
  const fromDay = addDays(dayKey(first, st.tz), 1);
  const fromTs = Date.parse(fromDay + 'T00:00:00Z') - st.tz * 60000;
  if (fromTs >= st.mark) return;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM agg_h WHERE hour >= ?').bind(Math.floor(fromTs / HOUR)),
    env.DB.prepare('DELETE FROM agg_d WHERE day >= ?').bind(fromDay),
    env.DB.prepare('DELETE FROM agg_uv WHERE day >= ?').bind(fromDay),
    env.DB.prepare('DELETE FROM agg_suv WHERE day >= ?').bind(fromDay),
  ]);
  await setSetting(env, 'agg_mark', fromTs);
}

// 删除短链时清掉它们的汇总。ids 可以是一组（批量删除时每张表只扫一遍，不是每条短链各扫一遍）；
// since = 这些短链里最早的创建时间：按小时 / 按天排序的表只从那天往后找（往前多留一天，照顾时区）
// 返回语句，调用方和删短链的语句放进同一个 batch（同一个事务：要么一起删掉，要么都不删，不会留下删不掉的统计）
export function dropLinkAggStmts(env, ids, since = 0) {
  ids = [].concat(ids).map(Number).filter(Boolean);
  if (!ids.length) return [];
  const j = JSON.stringify(ids), from = Math.max(0, since - DAY);
  const inIds = 'link_id IN (SELECT value FROM json_each(?))';
  return [
    env.DB.prepare(`DELETE FROM agg_h WHERE hour >= ? AND ${inIds}`).bind(Math.floor(from / HOUR), j),
    env.DB.prepare(`DELETE FROM agg_d WHERE ${inIds}`).bind(j),
    env.DB.prepare(`DELETE FROM agg_uv WHERE day >= ? AND ${inIds}`).bind(dayKey(from, 0), j),
    env.DB.prepare(`DELETE FROM agg_suv WHERE day >= ? AND ${inIds}`).bind(dayKey(from, 0), j),
  ];
}
export async function dropLinkAgg(env, ids, since = 0) {
  const stmts = dropLinkAggStmts(env, ids, since);
  if (stmts.length) await env.DB.batch(stmts);
}

// 按保留天数删除过期明细；尚未汇总的明细不删。
// D1 免费版每天只有 10 万行写入，删一行明细也算写入（表本身加 3 个索引，约 4 行）：免费版每次整点任务最多删 PRUNE_PER_RUN 条
// （一天最多约 1.2 万条），第一次开启保留、积压了很多旧明细时分几天慢慢删完，不会一两次就用光当天的写入额度。
// 付费版（在“Cloudflare 用量”里选了付费版，或自动识别为付费版）额度大得多，每次最多删 PRUNE_PAID 条，访问多的站点也追得上
export const PRUNE_PER_RUN = 500, PRUNE_PAID = 20000;
export async function prunePerRun(env) {
  const plan = (await getSetting(env, 'cf_plan')) || 'auto';
  if (plan === 'paid') return PRUNE_PAID;
  if (plan !== 'auto') return PRUNE_PER_RUN;
  try { return JSON.parse((await getSetting(env, 'usage_cache')) || '{}').detected === 'paid' ? PRUNE_PAID : PRUNE_PER_RUN; } catch { return PRUNE_PER_RUN; }
}
export async function pruneClicks(env) {
  const days = Number(await getSetting(env, 'retention_days')) || 0;
  if (!days) return 0;
  const { mark } = await aggState(env);
  const cutoff = Math.min(Date.now() - days * DAY, mark);
  if (!cutoff) return 0;
  // 每条语句最多删 2000 条，付费版分几批删
  const limit = await prunePerRun(env);
  let n = 0;
  while (n < limit) {
    const r = await env.DB.prepare('DELETE FROM clicks WHERE id IN (SELECT id FROM clicks WHERE ts < ? ORDER BY ts LIMIT ?)').bind(cutoff, Math.min(2000, limit - n)).run();
    const c = r.meta.changes || 0;
    n += c;
    if (c < Math.min(2000, limit - n + c)) break;
  }
  return n;
}

// ---------------------------------------------------------------- 读取汇总（7 天及以上的范围）

/**
 * 统计查询上下文：范围 = 今天及之前 days-1 天（按浏览器时区的自然日），上一周期 = 再往前 days 天。
 * 已汇总部分读汇总表，mark 之后的访问读原始明细（tail）。
 */
export async function aggQuery(env, { days, tz, bots, linkId = 0 }) {
  const st = await aggregate(env, tz).catch((e) => { console.error('aggregate failed', e); return aggState(env); });
  const atz = st.tz ?? tz, mark = st.mark;
  const now = Date.now();
  const dayStart = Math.floor((now + tz * 60000) / DAY) * DAY - tz * 60000;
  const start = dayStart - (days - 1) * DAY, prevStart = start - days * DAY;
  const today = dayKey(now, atz), firstDay = addDays(today, -(days - 1)), prevFirst = addDays(firstDay, -days), prevLast = addDays(firstDay, -1);
  const mc = bots ? '' : 'AND machine = 0';
  const lf = linkId ? 'AND link_id = ?' : '';
  const lb = linkId ? [linkId] : [];
  // 日期条件。汇总表的主键是 (dim, day, link_id, …) / (day, link_id, …)：day 用范围条件时 link_id 用不上索引，
  // 查一条短链也要把这段时间全部短链的汇总行读一遍（读取量跟着全站流量涨）。
  // 查单条短链时改成逐天精确查找（日期列表只占一个绑定参数），只读这条短链自己的行；概览（全部短链）仍用范围
  const dayList = (from, to) => { const out = []; for (let d = from; d <= to && out.length < 1000; d = addDays(d, 1)) out.push(d); return out; };
  const dayIn = (from, to, exact = !!linkId) => (exact
    ? ['day IN (SELECT value FROM json_each(?))', [JSON.stringify(dayList(from, to))]]
    : ['day >= ? AND day <= ?', [from, to]]);

  // 原始明细尾巴：mark 之后的访问（通常不到一小时）
  const tail = mark < now ? (await env.DB.prepare(
    `SELECT link_id, ts, is_bot, ip, source, referer_host, utm_source, utm_campaign, country, city, device, browser, os,
       rule_id, kind, proxy, reason, asn, asn_org FROM clicks WHERE ts >= ? ${linkId ? 'AND link_id = ?' : ''} ORDER BY ts LIMIT 50000`
  ).bind(Math.max(mark, prevStart), ...lb).all()).results : [];
  const tailIn = (from, to, withBots = bots) => tail.filter((r) => r.ts >= from && r.ts < to && (withBots || !r.is_bot));

  const all = (sql, ...args) => env.DB.prepare(sql).bind(...args).all().then((r) => r.results);

  // 某维度的排行。who：'auto' 跟随“含机器访问”开关，'all' 全部，'machine' 只看机器访问
  async function top(dim, limit = 10, { who = 'auto', key } = {}) {
    const mode = who === 'auto' ? (bots ? 'all' : 'human') : who;
    const clause = mode === 'all' ? '' : mode === 'human' ? 'AND machine = 0' : 'AND machine = 1';
    const [dc, da] = dayIn(firstDay, today);
    const rows = await all(
      `SELECT k, SUM(n) AS n FROM agg_d WHERE dim = ? AND ${dc} ${clause} ${lf} GROUP BY k ORDER BY n DESC LIMIT ${limit + 20}`,
      dim, ...da, ...lb,
    );
    const m = new Map(rows.map((r) => [r.k, r.n]));
    for (const r of tail) {
      if (r.ts < start || (mode === 'human' && r.is_bot) || (mode === 'machine' && !r.is_bot)) continue;
      const k = key ? key(r) : String(r[COLS[dim]] ?? '');
      if (k === null) continue;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m].map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n).slice(0, limit);
  }

  // 访问次数：按天
  async function daily(from, to, fromTs, toTs, shift = 0) {
    const [dc, da] = dayIn(from, to);
    const rows = await all(
      `SELECT day AS k, SUM(n) AS n FROM agg_d WHERE dim = '' AND ${dc} ${mc} ${lf} GROUP BY day`,
      ...da, ...lb,
    );
    const m = new Map(rows.map((r) => [r.k, r.n]));
    for (const r of tailIn(fromTs, toTs)) { const k = dayKey(r.ts, tz); m.set(k, (m.get(k) || 0) + 1); }
    return [...m].map(([k, n]) => ({ k: shift ? addDays(k, shift) : k, n })).sort((a, b) => (a.k < b.k ? -1 : 1));
  }

  // 独立访客：按天合并估算。这里总是按短链（0 = 全部短链）取，所以概览也逐天精确查找
  async function uvByDay(from, to, lids = [linkId]) {
    const [dc, da] = dayIn(from, to, true);
    const rows = await all(
      `SELECT day, link_id, hll FROM agg_uv WHERE ${dc} ${mc} AND link_id IN (${lids.map(() => '?').join(',')})`,
      ...da, ...lids,
    );
    const m = new Map();
    for (const r of rows) {
      const key = `${r.link_id}|${r.day}`;
      m.set(key, m.has(key) ? hllMerge(m.get(key), hllDecode(r.hll)) : hllDecode(r.hll));
    }
    return m;
  }
  function addTailIps(reg, from, to, lid = linkId) {
    for (const r of tailIn(from, to)) if (!lid || r.link_id === lid) hllAdd(reg, r.ip || '');
    return reg;
  }

  async function total(from, to, fromTs, toTs) {
    const [dc, da] = dayIn(from, to);
    const [n, uvs] = await Promise.all([
      env.DB.prepare(`SELECT SUM(n) AS n FROM agg_d WHERE dim = '' AND ${dc} ${mc} ${lf}`).bind(...da, ...lb).first('n'),
      uvByDay(from, to),
    ]);
    const reg = hllNew();
    for (const r of uvs.values()) hllMerge(reg, r);
    addTailIps(reg, fromTs, toTs);
    // 独立访客是估算值（误差约 5%），访客几乎都不重复时估算可能比访问次数还大，封顶为访问次数
    const tot = (n || 0) + tailIn(fromTs, toTs).length;
    return { total: tot, unique_ips: Math.min(hllCount(reg), tot) };
  }

  // 按小时的访问次数（用于今日、活跃时段、时段分布）
  // 单条短链同样逐小时精确查找（主键 (hour, link_id, machine)，理由同 dayIn）
  async function hours(fromTs, toTs) {
    const lo = Math.floor(fromTs / HOUR), hi = Math.ceil(Math.min(toTs, mark) / HOUR);
    const hourList = () => { const out = []; for (let h = lo; h < hi; h++) out.push(h); return JSON.stringify(out); };
    const rows = await all(
      `SELECT hour, SUM(n) AS n FROM agg_h WHERE ${linkId ? 'hour IN (SELECT value FROM json_each(?))' : 'hour >= ? AND hour < ?'} ${mc} ${lf} GROUP BY hour`,
      ...(linkId ? [hourList()] : [lo, hi]), ...lb,
    );
    const out = rows.map((r) => ({ ts: r.hour * HOUR, n: r.n }));
    for (const r of tailIn(Math.max(fromTs, mark), toTs)) out.push({ ts: r.ts, n: 1 });
    return out;
  }

  return {
    days, tz, bots, now, dayStart, start, prevStart, today, firstDay, prevFirst, prevLast, mark,
    tail, tailIn, top, daily, uvByDay, addTailIps, total, hours, all, dayIn,
    // 维度 key 的转换
    kinds: async () => (await top('kind', 20, { who: 'all', key: (r) => (r.kind || 'human') + (r.proxy ? ':p' : '') }))
      .map((x) => { const [k, p] = x.k.split(':'); return { k, p: p ? 1 : 0, n: x.n }; }),
  };
}

export { HOUR, DAY, addDays };
