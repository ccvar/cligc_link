// 站点内容最后更新时间：根据站点地图推测（每天刷新站点地图时算好存在 g_sitemaps 的 c_* 列，见 gindex.js refreshSite）。
//   mod：站点地图里最新的 lastmod（大部分网页不是同一天时才可信）
//   seen：我们每天读站点地图时发现新网址、或网页的 lastmod 变新的时间（精确到天，只从开始观察那天算起）
//   build：lastmod 不可信（大部分网页同一天，多半是每次构建统一改的），又没观察到变化时，只能给出这个日期作参考
// 返回 { at, src, new30, upd30, since }；完全推测不了时 at 为 null（since 有值说明从那时起一直没发现变化）

export const C_COLS = 'c_mod, c_trust, c_seen, c_since, c_new30, c_upd30';

export function contentOf(m) {
  if (!m || !m.c_since) return null;
  const mod = m.c_mod || 0, seen = m.c_seen || 0;
  let at = null, src = '';
  if (mod && m.c_trust) { at = Math.max(mod, seen); src = seen > mod ? 'seen' : 'mod'; }
  else if (seen) { at = seen; src = 'seen'; }
  else if (mod) { at = mod; src = 'build'; }
  return { at, src, new30: m.c_new30 || 0, upd30: m.c_upd30 >= 0 ? m.c_upd30 : null, since: m.c_since };
}

// lastmod 可不可信：有 lastmod 的网址里一大半是同一天（且至少 10 个）时，多半是构建时统一改的
export function modTrusted(mods, ymd) {
  if (mods.length < 10) return true;
  const top = ymd(Math.max(...mods));
  return mods.filter((t) => ymd(t) === top).length <= mods.length / 2;
}
