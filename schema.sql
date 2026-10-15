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
  sub          TEXT NOT NULL DEFAULT '',  -- 访问的二级路径，如 /a/b 记为 "b"
  FOREIGN KEY (link_id) REFERENCES links(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_clicks_link_ts ON clicks(link_id, ts);
CREATE INDEX IF NOT EXISTS idx_clicks_ts ON clicks(ts);

-- 按国家 / 地区跳转到不同目标地址
CREATE TABLE IF NOT EXISTS link_targets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id     INTEGER NOT NULL,
  path        TEXT NOT NULL DEFAULT '',   -- 二级路径，如 "b" 表示 /a/b；空 = 地区规则
  countries   TEXT NOT NULL,              -- 逗号分隔的 ISO 国家代码，如 "HK,MO,TW"；二级路径规则可为空，表示所有地区
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
