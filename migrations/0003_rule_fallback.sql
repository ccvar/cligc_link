-- 地区规则：打不开时回退到默认地址（新版本会在首次请求时自动执行，无需手动运行）
ALTER TABLE link_targets ADD COLUMN fallback INTEGER NOT NULL DEFAULT 0;
ALTER TABLE link_targets ADD COLUMN fallbacks INTEGER NOT NULL DEFAULT 0;
