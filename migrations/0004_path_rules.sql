-- 二级路径规则：/a/b 按路径 b 跳到单独的地址；访问记录里记下二级路径
-- 新版本会在首次请求时自动执行，无需手动运行
ALTER TABLE link_targets ADD COLUMN path TEXT NOT NULL DEFAULT '';
ALTER TABLE clicks ADD COLUMN sub TEXT NOT NULL DEFAULT '';
