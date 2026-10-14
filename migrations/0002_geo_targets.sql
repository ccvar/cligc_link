-- 按国家 / 地区跳转到不同目标地址
CREATE TABLE IF NOT EXISTS link_targets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id     INTEGER NOT NULL,
  countries   TEXT NOT NULL,              -- 逗号分隔的 ISO 国家代码，如 "HK,MO,TW"
  url         TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY (link_id) REFERENCES links(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_link_targets_link ON link_targets(link_id);

-- 每次访问命中的规则：0 = 默认地址
ALTER TABLE clicks ADD COLUMN rule_id INTEGER NOT NULL DEFAULT 0;
