-- 访客类型：真人 / 爬虫 / 可疑，以及判定所需的网络信息
-- 新版本会在首次请求时自动执行，并按已有的 IP、运营商、User-Agent 补算旧记录，无需手动运行
ALTER TABLE clicks ADD COLUMN kind TEXT NOT NULL DEFAULT '';
ALTER TABLE clicks ADD COLUMN reason TEXT NOT NULL DEFAULT '';
ALTER TABLE clicks ADD COLUMN asn INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clicks ADD COLUMN tls TEXT NOT NULL DEFAULT '';
ALTER TABLE clicks ADD COLUMN http TEXT NOT NULL DEFAULT '';
