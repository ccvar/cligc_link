CREATE TABLE IF NOT EXISTS links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  target_url  TEXT NOT NULL DEFAULT '',   -- 默认目标地址；为空时未命中地区规则的访问返回"未配置"
  title       TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1,
  pass_query  INTEGER NOT NULL DEFAULT 0,  -- 是否把短链上的查询参数透传给目标地址
  expires_at  INTEGER,                     -- 过期时间（毫秒时间戳），NULL 为永久
  clicks      INTEGER NOT NULL DEFAULT 0,
  last_click  INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clicks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id      INTEGER NOT NULL,
  ts           INTEGER NOT NULL,        -- 毫秒时间戳
  source       TEXT NOT NULL DEFAULT '', -- 来源：?src= / utm_source 优先，否则 Referer 域名，否则 (direct)
  referer      TEXT NOT NULL DEFAULT '',
  referer_host TEXT NOT NULL DEFAULT '',
  utm_source   TEXT NOT NULL DEFAULT '',
  utm_medium   TEXT NOT NULL DEFAULT '',
  utm_campaign TEXT NOT NULL DEFAULT '',
  ip           TEXT NOT NULL DEFAULT '',
  country      TEXT NOT NULL DEFAULT '',
  region       TEXT NOT NULL DEFAULT '',
  city         TEXT NOT NULL DEFAULT '',
  asn_org      TEXT NOT NULL DEFAULT '',
  ua           TEXT NOT NULL DEFAULT '',
  browser      TEXT NOT NULL DEFAULT '',
  os           TEXT NOT NULL DEFAULT '',
  device       TEXT NOT NULL DEFAULT '',
  is_bot       INTEGER NOT NULL DEFAULT 0,
  lang         TEXT NOT NULL DEFAULT '',
  rule_id      INTEGER NOT NULL DEFAULT 0, -- 命中的跳转规则，0 = 默认地址
  kind         TEXT NOT NULL DEFAULT '',  -- 访客类型：human 真人 / bot 爬虫 / suspect 可疑（bot 和 suspect 的 is_bot 都为 1）
  reason       TEXT NOT NULL DEFAULT '',  -- 判定原因，多条用“；”分隔
  asn          INTEGER NOT NULL DEFAULT 0,
  tls          TEXT NOT NULL DEFAULT '',  -- TLS 版本，如 TLSv1.3
  http         TEXT NOT NULL DEFAULT '',  -- HTTP 协议，如 HTTP/2
  proxy        INTEGER NOT NULL DEFAULT 0, -- 1 = 真人经 VPN / 代理访问（机房 IP 但浏览器特征完整，或中文访客出现在非中文地区）
  FOREIGN KEY (link_id) REFERENCES links(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_clicks_link_ts ON clicks(link_id, ts);
CREATE INDEX IF NOT EXISTS idx_clicks_ts ON clicks(ts);

-- 按国家 / 地区跳转到不同目标地址
CREATE TABLE IF NOT EXISTS link_targets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id     INTEGER NOT NULL,
  countries   TEXT NOT NULL,              -- 逗号分隔的 ISO 国家代码，如 "HK,MO,TW"
  url         TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  fallback    INTEGER NOT NULL DEFAULT 0, -- 1 = 访客打不开该地址时回退到默认地址
  fallbacks   INTEGER NOT NULL DEFAULT 0, -- 累计回退次数
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY (link_id) REFERENCES links(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_link_targets_link ON link_targets(link_id);

-- 系统设置：后台修改过的管理员密码（加盐哈希）、自动生成的会话密钥等
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- 访问汇总：统计页面读这些表，避免每次扫描全部访问明细（见 src/agg.js）
CREATE TABLE IF NOT EXISTS agg_h (
  hour     INTEGER NOT NULL,            -- UTC 小时序号（ts / 3600000）
  link_id  INTEGER NOT NULL,
  machine  INTEGER NOT NULL,            -- 1 = 机器访问（爬虫 / 可疑）
  n        INTEGER NOT NULL,
  PRIMARY KEY (hour, link_id, machine)
);
CREATE TABLE IF NOT EXISTS agg_d (
  dim      TEXT NOT NULL,               -- 维度：'' 为总数，source / country / device / kind / asn ……
  day      TEXT NOT NULL,               -- 日期（按 settings.agg_tz）
  link_id  INTEGER NOT NULL,
  machine  INTEGER NOT NULL,
  k        TEXT NOT NULL,
  n        INTEGER NOT NULL,
  PRIMARY KEY (dim, day, link_id, machine, k)
);
CREATE TABLE IF NOT EXISTS agg_uv (
  day      TEXT NOT NULL,
  link_id  INTEGER NOT NULL,            -- 0 = 全部短链
  machine  INTEGER NOT NULL,
  hll      TEXT NOT NULL,               -- 独立访客 HyperLogLog 寄存器（base64）
  PRIMARY KEY (day, link_id, machine)
);

-- 登录防暴力破解：按 IP 记录连续失败次数和锁定时间
CREATE TABLE IF NOT EXISTS login_guard (
  ip     TEXT PRIMARY KEY,
  n      INTEGER NOT NULL DEFAULT 0,    -- 当前连续失败次数
  locks  INTEGER NOT NULL DEFAULT 0,    -- 已被锁定的次数（锁定时长逐次加倍）
  until  INTEGER NOT NULL DEFAULT 0,    -- 锁定到期时间
  at     INTEGER NOT NULL DEFAULT 0     -- 最近一次失败时间
);

-- Google：GA4 + Search Console（见 src/google.js）
CREATE TABLE IF NOT EXISTS g_accounts (
  id            TEXT PRIMARY KEY,           -- Google 账号 ID（id_token 的 sub）
  email         TEXT NOT NULL DEFAULT '',
  auth          TEXT NOT NULL DEFAULT '',   -- 加密的刷新令牌
  connected_at  INTEGER NOT NULL DEFAULT 0,
  error         TEXT NOT NULL DEFAULT '',   -- 授权失效等
  found         TEXT NOT NULL DEFAULT '',   -- 上次发现的 GA4 媒体资源 / GSC 站点 JSON
  found_at      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS g_sites (
  host          TEXT PRIMARY KEY,           -- 主域名（GA4 网站数据流地址或 GSC 资源）
  ga4_property  TEXT NOT NULL DEFAULT '',   -- GA4 媒体资源 ID
  ga4_name      TEXT NOT NULL DEFAULT '',
  ga4_account   TEXT NOT NULL DEFAULT '',
  gsc_site      TEXT NOT NULL DEFAULT '',   -- GSC 资源，如 sc-domain:example.com
  ga4_acct      TEXT NOT NULL DEFAULT '',   -- GA4 数据来自哪个 Google 账号（g_accounts.id）
  gsc_acct      TEXT NOT NULL DEFAULT '',   -- GSC 数据来自哪个 Google 账号
  users         TEXT NOT NULL DEFAULT '',   -- 区间去重用户数 JSON（7 / 28 / 90 天）
  synced_at     INTEGER NOT NULL DEFAULT 0,
  error         TEXT NOT NULL DEFAULT '',
  updated_at    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS g_daily (
  host         TEXT NOT NULL,
  date         TEXT NOT NULL,
  users        INTEGER, sessions INTEGER, views INTEGER, key_events REAL, engagement REAL,   -- GA4
  clicks       INTEGER, impressions INTEGER, ctr REAL, position REAL,                       -- GSC
  PRIMARY KEY (host, date)
);
CREATE TABLE IF NOT EXISTS g_cache (
  k   TEXT PRIMARY KEY,
  v   TEXT NOT NULL,
  at  INTEGER NOT NULL
);
