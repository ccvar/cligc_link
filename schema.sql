CREATE TABLE IF NOT EXISTS links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  target_url  TEXT NOT NULL DEFAULT '',   -- 默认目标地址；为空时未命中地区规则的访问返回"未配置"
  title       TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1,
  pass_query  INTEGER NOT NULL DEFAULT 0,  -- 是否把短链上的查询参数透传给目标地址
  utm         INTEGER NOT NULL DEFAULT 0,  -- 转化追踪：跳转时加上 utm_source=cligc&utm_medium=shortlink&utm_campaign=<后缀>
  ab_weight   INTEGER NOT NULL DEFAULT 0,  -- 默认地址参与 A/B 分流时它自己的比例
  expires_at  INTEGER,                     -- 过期时间（毫秒时间戳），NULL 为永久
  clicks      INTEGER NOT NULL DEFAULT 0,   -- 全部访问（含机器访问和下面没记明细的高频访问）
  human       INTEGER NOT NULL DEFAULT 0,   -- 其中真人访问
  flood       INTEGER NOT NULL DEFAULT 0,   -- 同一 IP 短时间内反复访问、只计数没记明细的次数
  app_web     TEXT NOT NULL DEFAULT '',     -- 目标是 App 地址（tg:// 等）时，拉不起 App 去的网页；留空则用默认推广地址
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
-- 防刷：数“同一 IP 1 分钟内访问同一短链几次”时只读这个 IP 的记录（只按短链 + 时间查，被很多 IP 刷时会读出整分钟的全部访问）
CREATE INDEX IF NOT EXISTS idx_clicks_link_ip_ts ON clicks(link_id, ip, ts);

-- 按国家 / 地区跳转到不同目标地址
CREATE TABLE IF NOT EXISTS link_targets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id     INTEGER NOT NULL,
  countries   TEXT NOT NULL,              -- 逗号分隔的 ISO 国家代码，如 "HK,MO,TW"；为空表示不限国家
  devices     TEXT NOT NULL DEFAULT '',   -- 逗号分隔的设备：ios / android / desktop；为空表示不限设备
  url         TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  fallback    INTEGER NOT NULL DEFAULT 0, -- 1 = 访客打不开该地址时回退到默认地址
  fallbacks   INTEGER NOT NULL DEFAULT 0, -- 累计回退次数
  ab_of       INTEGER NOT NULL DEFAULT -1, -- A/B 分流：-1 = 普通规则；0 = 默认地址的分流地址；n = 规则 n 的分流地址（沿用该规则的国家 / 设备）
  weight      INTEGER NOT NULL DEFAULT 0, -- A/B 分流的比例（普通规则表示它自己的比例，分流地址表示该地址的比例）
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
CREATE TABLE IF NOT EXISTS agg_suv (
  day      TEXT NOT NULL,
  link_id  INTEGER NOT NULL,
  k        TEXT NOT NULL,               -- 访问来源（与 agg_d 的 source 维度相同）
  hll      TEXT NOT NULL,               -- 真人独立访客 HyperLogLog（s 开头为稀疏格式）
  PRIMARY KEY (day, link_id, k)
);
CREATE TABLE IF NOT EXISTS agg_uv (
  day      TEXT NOT NULL,
  link_id  INTEGER NOT NULL,            -- 0 = 全部短链
  machine  INTEGER NOT NULL,
  hll      TEXT NOT NULL,               -- 独立访客 HyperLogLog 寄存器（base64）
  PRIMARY KEY (day, link_id, machine)
);

-- 登录防暴力破解：按 IP 记录连续失败次数和锁定时间
-- 回退上报（/_fb）已用过的签名：同一次跳转只算一次，过期后由定时任务清掉
CREATE TABLE IF NOT EXISTS fb_seen (
  sig  TEXT PRIMARY KEY,
  exp  INTEGER NOT NULL
);
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
  ga4_created   INTEGER NOT NULL DEFAULT 0,   -- GA4 网站数据流的创建时间（大致是网站上线时间）
  gsc_site      TEXT NOT NULL DEFAULT '',   -- GSC 资源，如 sc-domain:example.com
  ga4_acct      TEXT NOT NULL DEFAULT '',   -- GA4 数据来自哪个 Google 账号（g_accounts.id）
  gsc_acct      TEXT NOT NULL DEFAULT '',   -- GSC 数据来自哪个 Google 账号
  users         TEXT NOT NULL DEFAULT '',   -- 区间去重用户数 JSON（7 / 28 / 90 天）
  synced_at     INTEGER NOT NULL DEFAULT 0,
  ch_at         INTEGER NOT NULL DEFAULT 0,   -- 渠道占比数据补齐的时间（0 = 还没补）
  bing_site     TEXT NOT NULL DEFAULT '',   -- Bing Webmaster 站点，如 https://example.com/
  b_synced_at   INTEGER NOT NULL DEFAULT 0,
  b_error       TEXT NOT NULL DEFAULT '',
  b_in_index    INTEGER NOT NULL DEFAULT 0,   -- Bing 抓取统计里最新的“索引中的网页数”
  -- 外链与权重（设置里开启后才查，见 src/backlinks.js）
  bl_total      INTEGER NOT NULL DEFAULT -1,  -- Bing 发现的外链总数（-1 = 还没查到）
  bl_pages      INTEGER NOT NULL DEFAULT 0,   -- 有外链的页面数
  bl_more       INTEGER NOT NULL DEFAULT 0,   -- 页面太多只查了前几页（总数是下限）
  bl_prev       INTEGER NOT NULL DEFAULT -1,  -- 上一次查到的外链总数
  bl_top        TEXT NOT NULL DEFAULT '',     -- 外链最多的页面 JSON [[网址, 外链数], …]
  bl_error      TEXT NOT NULL DEFAULT '',
  bl_at         INTEGER NOT NULL DEFAULT 0,
  opr           REAL NOT NULL DEFAULT -1,     -- Open PageRank 0–10（-1 = 没有这个域名的数据）
  opr_rank      INTEGER NOT NULL DEFAULT 0,   -- 全球排名
  opr_ref       INTEGER NOT NULL DEFAULT 0,   -- 引用域名数
  opr_hist      TEXT NOT NULL DEFAULT '',     -- 每月分数 JSON [[YYYY-MM, 分数], …]
  opr_at        INTEGER NOT NULL DEFAULT 0,
  error         TEXT NOT NULL DEFAULT '',
  updated_at    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS g_daily (
  host         TEXT NOT NULL,
  date         TEXT NOT NULL,
  users        INTEGER, sessions INTEGER, views INTEGER, key_events REAL, engagement REAL,   -- GA4
  clicks       INTEGER, impressions INTEGER, ctr REAL, position REAL,                       -- GSC
  channels     TEXT,                                                                         -- GA4 渠道分组会话数 JSON
  b_clicks     INTEGER, b_impressions INTEGER,                                               -- Bing
  PRIMARY KEY (host, date)
);
-- 网页索引：站点地图里的网址 + 在搜索结果里出现过的网址，用 URL Inspection API 逐个检查（定时任务分批，每个网址几天查一次）
CREATE TABLE IF NOT EXISTS g_urls (
  host        TEXT NOT NULL,
  url         TEXT NOT NULL,
  src         INTEGER NOT NULL DEFAULT 1,   -- 1 = 在站点地图里，2 = 只在搜索结果里出现过，3 = 两者都有
  state       TEXT NOT NULL DEFAULT '',     -- coverageState 原文，如 Submitted and indexed
  verdict     TEXT NOT NULL DEFAULT '',     -- PASS / NEUTRAL / FAIL / PARTIAL
  fetch       TEXT NOT NULL DEFAULT '',     -- pageFetchState
  robots      TEXT NOT NULL DEFAULT '',     -- robotsTxtState
  indexing    TEXT NOT NULL DEFAULT '',     -- indexingState（是否被 noindex 阻止）
  canon       TEXT NOT NULL DEFAULT '',     -- Google 选择的规范网址（和网址本身不同时）
  crawled_at  INTEGER NOT NULL DEFAULT 0,
  checked_at  INTEGER NOT NULL DEFAULT 0,
  due_at      INTEGER NOT NULL DEFAULT 0,   -- 下次检查时间
  error       TEXT NOT NULL DEFAULT '',
  b_state     TEXT NOT NULL DEFAULT '',     -- Bing：yes 已收录 / no 未收录 / err 检查出错 / 空 = 还没查
  b_crawled_at INTEGER NOT NULL DEFAULT 0,
  b_checked_at INTEGER NOT NULL DEFAULT 0,
  b_due_at    INTEGER NOT NULL DEFAULT 0,
  b_submitted_at INTEGER NOT NULL DEFAULT 0,  -- 上次提交给 Bing 的时间
  b_error     TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (host, url)
);
CREATE INDEX IF NOT EXISTS g_urls_due ON g_urls (due_at);
CREATE INDEX IF NOT EXISTS g_urls_bdue ON g_urls (b_due_at);
-- 站点列表按日期范围读每日数据；清理任务按时间删缓存和修改记录
CREATE INDEX IF NOT EXISTS g_daily_date ON g_daily (date);
-- 站点地图：Sitemaps API 的结果，每天刷新一次；同时记下当天网址检查用掉的配额（每个资源每天 2000 次）
CREATE TABLE IF NOT EXISTS g_sitemaps (
  host     TEXT PRIMARY KEY,
  list     TEXT NOT NULL DEFAULT '[]',
  urls     INTEGER NOT NULL DEFAULT 0,      -- 解析出的网址数（去重后）
  error    TEXT NOT NULL DEFAULT '',
  at       INTEGER NOT NULL DEFAULT 0,
  q_day    TEXT NOT NULL DEFAULT '',
  q_n      INTEGER NOT NULL DEFAULT 0,
  n_urls   INTEGER NOT NULL DEFAULT 0,      -- 检查列表里的网址数（站点列表显示用，检查后更新）
  n_yes    INTEGER NOT NULL DEFAULT 0,      -- 其中已编入
  n_done   INTEGER NOT NULL DEFAULT 0,      -- 其中已检查出结果
  nb_yes   INTEGER NOT NULL DEFAULT 0,      -- Bing 已收录
  nb_done  INTEGER NOT NULL DEFAULT 0,      -- Bing 已检查
  b_feeds  TEXT NOT NULL DEFAULT '[]',      -- Bing 的站点地图（GetFeeds）
  b_error  TEXT NOT NULL DEFAULT '',
  b_quota  INTEGER NOT NULL DEFAULT -1,     -- Bing 今天剩余的提交配额（-1 = 未知）
  b_quota_at INTEGER NOT NULL DEFAULT 0,
  g_on     INTEGER NOT NULL DEFAULT -1,     -- 上次刷新时是否关联了 GSC / Bing（变了才调整网址的检查排期）
  b_on     INTEGER NOT NULL DEFAULT -1,
  sc_pages INTEGER NOT NULL DEFAULT -1,     -- 近 3 个月在 Google 搜索结果里有展示的网页数（-1 = 还没取到）
  sc_at    INTEGER NOT NULL DEFAULT 0       -- 上次取这个数的时间
);
CREATE TABLE IF NOT EXISTS g_cache (
  k   TEXT PRIMARY KEY,
  v   TEXT NOT NULL,
  at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS g_cache_at ON g_cache (at);

-- AI 分析链接：只读，只能看创建时选定的站点；token 即访问凭据
CREATE TABLE IF NOT EXISTS shares (
  token       TEXT PRIMARY KEY,
  label       TEXT NOT NULL DEFAULT '',
  hosts       TEXT NOT NULL,                -- 站点 JSON 数组
  days        INTEGER NOT NULL DEFAULT 28,
  sections    TEXT NOT NULL DEFAULT '',     -- 包含的内容 JSON：search / traffic / links
  hide        INTEGER NOT NULL DEFAULT 1,   -- 1 = 隐藏账号邮箱、GA4 媒体资源 ID
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER,                      -- NULL 为永久
  views       INTEGER NOT NULL DEFAULT 0,
  last_view   INTEGER,
  hour        INTEGER NOT NULL DEFAULT 0,   -- 限流：当前小时序号和本小时访问次数
  hour_n      INTEGER NOT NULL DEFAULT 0
);
-- AI 分析链接的打开记录（每个链接保留最近 200 条）
CREATE TABLE IF NOT EXISTS share_views (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  token    TEXT NOT NULL,
  at       INTEGER NOT NULL,
  ip       TEXT NOT NULL DEFAULT '',
  country  TEXT NOT NULL DEFAULT '',
  ua       TEXT NOT NULL DEFAULT '',
  agent    TEXT NOT NULL DEFAULT '',          -- 识别出的 AI 工具，如 ChatGPT、Claude
  status   INTEGER NOT NULL DEFAULT 200
);
CREATE INDEX IF NOT EXISTS idx_share_views ON share_views(token, at);
-- 站点分组（标签）：单独存放，Google 重新发现站点时不受影响
CREATE TABLE IF NOT EXISTS site_tags (
  host  TEXT NOT NULL,
  tag   TEXT NOT NULL,
  PRIMARY KEY (host, tag)
);
-- 短链分组（标签）
CREATE TABLE IF NOT EXISTS link_tags (
  link_id  INTEGER NOT NULL,
  tag      TEXT NOT NULL,
  PRIMARY KEY (link_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_link_tags_tag ON link_tags(tag);
-- 目标页健康检查：每个目标地址一行（默认地址和跳转规则的地址）
CREATE TABLE IF NOT EXISTS url_health (
  url         TEXT PRIMARY KEY,
  state       TEXT NOT NULL DEFAULT 'unknown',   -- ok / down / blocked（对方拒绝自动访问，无法确认）/ unknown
  status      INTEGER NOT NULL DEFAULT 0,        -- 最后一次的 HTTP 状态码，0 = 连接失败 / 超时
  error       TEXT NOT NULL DEFAULT '',
  ms          INTEGER NOT NULL DEFAULT 0,
  fails       INTEGER NOT NULL DEFAULT 0,        -- 连续失败次数（连续 2 次才算打不开）
  checked_at  INTEGER NOT NULL DEFAULT 0,
  since       INTEGER NOT NULL DEFAULT 0         -- 当前状态从什么时候开始
);

-- 登录设备：每次登录一条，Cookie 里带会话 ID；删除即让该设备退出
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  seen_at     INTEGER NOT NULL,           -- 最近一次使用（最多 5 分钟更新一次）
  exp         INTEGER NOT NULL,
  ip          TEXT NOT NULL DEFAULT '',
  country     TEXT NOT NULL DEFAULT '',
  city        TEXT NOT NULL DEFAULT '',
  ua          TEXT NOT NULL DEFAULT ''
);

-- 短链修改记录：谁在什么时候改了什么，可一键撤销
CREATE TABLE IF NOT EXISTS link_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id     INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  action      TEXT NOT NULL,              -- create / update / rule.add / rule.edit / rule.del / split / replace / revert
  data        TEXT NOT NULL DEFAULT '{}', -- 修改前后的内容（JSON）
  ip          TEXT NOT NULL DEFAULT '',
  ua          TEXT NOT NULL DEFAULT '',
  reverted    INTEGER NOT NULL DEFAULT 0  -- 已撤销时为撤销记录的 id
);
CREATE INDEX IF NOT EXISTS idx_link_log_link ON link_log(link_id, at);
CREATE INDEX IF NOT EXISTS idx_link_log_at ON link_log(at);

-- 站点优化建议的忽略记录（src/advice.js）：until 之前不再显示这一类建议，永久忽略记为 9e15
CREATE TABLE IF NOT EXISTS site_ignores (
  host   TEXT NOT NULL,
  rule   TEXT NOT NULL,
  until  INTEGER NOT NULL,
  PRIMARY KEY (host, rule)
);
