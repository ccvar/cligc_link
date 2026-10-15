-- 二级短链：/a/b 继承 /a 的推广地址和地区规则；未创建的二级路径按 /a 跳转并记录路径
-- 新版本会在首次请求时自动执行，无需手动运行
ALTER TABLE links ADD COLUMN parent_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clicks ADD COLUMN sub TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_links_parent ON links(parent_id);
