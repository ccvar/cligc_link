// ---------------------------------------------------------------- 访问汇总
// 统计页面不再每次扫描全部访问明细，而是读汇总表：
//   agg_h  每小时 · 每个短链 · 真人 / 机器 的访问次数（趋势、今日、活跃时段）
//   agg_d  每天 · 每个短链 · 真人 / 机器 · 维度值 的访问次数（来源、国家、设备……）
//   agg_uv 每天 · 每个短链（0 = 全部短链）· 真人 / 机器 的独立访客（HyperLogLog 估算，误差约 4%）
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

  const h = new Map(), d = new Map(), uv = new Map();
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
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return rows.length;
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
  ]);
  await setSetting(env, 'agg_mark', fromTs);
}

export async function dropLinkAgg(env, id) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM agg_h WHERE link_id = ?').bind(id),
    env.DB.prepare('DELETE FROM agg_d WHERE link_id = ?').bind(id),
    env.DB.prepare('DELETE FROM agg_uv WHERE link_id = ?').bind(id),
  ]);
}

// 按保留天数删除过期明细；尚未汇总的明细不删
export async function pruneClicks(env) {
  const days = Number(await getSetting(env, 'retention_days')) || 0;
  if (!days) return 0;
  const { mark } = await aggState(env);
  const cutoff = Math.min(Date.now() - days * DAY, mark);
  if (!cutoff) return 0;
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const r = await env.DB.prepare('DELETE FROM clicks WHERE id IN (SELECT id FROM clicks WHERE ts < ? ORDER BY ts LIMIT 2000)').bind(cutoff).run();
    total += r.meta.changes || 0;
    if ((r.meta.changes || 0) < 2000) break;
  }
  return total;
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
    const rows = await all(
      `SELECT k, SUM(n) AS n FROM agg_d WHERE dim = ? AND day >= ? AND day <= ? ${clause} ${lf} GROUP BY k ORDER BY n DESC LIMIT ${limit + 20}`,
      dim, firstDay, today, ...lb,
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
    const rows = await all(
      `SELECT day AS k, SUM(n) AS n FROM agg_d WHERE dim = '' AND day >= ? AND day <= ? ${mc} ${lf} GROUP BY day`,
      from, to, ...lb,
    );
    const m = new Map(rows.map((r) => [r.k, r.n]));
    for (const r of tailIn(fromTs, toTs)) { const k = dayKey(r.ts, tz); m.set(k, (m.get(k) || 0) + 1); }
    return [...m].map(([k, n]) => ({ k: shift ? addDays(k, shift) : k, n })).sort((a, b) => (a.k < b.k ? -1 : 1));
  }

  // 独立访客：按天合并估算
  async function uvByDay(from, to, lids = [linkId]) {
    const rows = await all(
      `SELECT day, link_id, hll FROM agg_uv WHERE day >= ? AND day <= ? ${mc} AND link_id IN (${lids.map(() => '?').join(',')})`,
      from, to, ...lids,
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
    const [n, uvs] = await Promise.all([
      env.DB.prepare(`SELECT SUM(n) AS n FROM agg_d WHERE dim = '' AND day >= ? AND day <= ? ${mc} ${lf}`).bind(from, to, ...lb).first('n'),
      uvByDay(from, to),
    ]);
    const reg = hllNew();
    for (const r of uvs.values()) hllMerge(reg, r);
    addTailIps(reg, fromTs, toTs);
    return { total: (n || 0) + tailIn(fromTs, toTs).length, unique_ips: hllCount(reg) };
  }

  // 按小时的访问次数（用于今日、活跃时段、时段分布）
  async function hours(fromTs, toTs) {
    const rows = await all(
      `SELECT hour, SUM(n) AS n FROM agg_h WHERE hour >= ? AND hour < ? ${mc} ${lf} GROUP BY hour`,
      Math.floor(fromTs / HOUR), Math.ceil(Math.min(toTs, mark) / HOUR), ...lb,
    );
    const out = rows.map((r) => ({ ts: r.hour * HOUR, n: r.n }));
    for (const r of tailIn(Math.max(fromTs, mark), toTs)) out.push({ ts: r.ts, n: 1 });
    return out;
  }

  return {
    days, tz, bots, now, dayStart, start, prevStart, today, firstDay, prevFirst, prevLast, mark,
    tail, tailIn, top, daily, uvByDay, addTailIps, total, hours, all,
    // 维度 key 的转换
    kinds: async () => (await top('kind', 20, { who: 'all', key: (r) => (r.kind || 'human') + (r.proxy ? ':p' : '') }))
      .map((x) => { const [k, p] = x.k.split(':'); return { k, p: p ? 1 : 0, n: x.n }; }),
  };
}

export { HOUR, DAY, addDays };
