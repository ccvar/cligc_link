-- 标记经 VPN / 代理访问的真人
-- 新版本会在首次请求时自动执行并重新判定旧记录，无需手动运行
ALTER TABLE clicks ADD COLUMN proxy INTEGER NOT NULL DEFAULT 0;
