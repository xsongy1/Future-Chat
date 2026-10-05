-- 上下文管理：会话级长期记忆（Recent Window + Summary）
--
-- 只加三列，且都在 Conversation 上：
--   1. summary              —— 历史压缩摘要
--   2. summaryUpdatedAt     —— 写入时间 + 并发压缩的 CAS 版本号
--   3. summaryUpToMessageId —— 摘要覆盖到的最后一条消息（水位线）
--
-- 不新建表：摘要与会话是 1:1，且生命周期完全一致（会话删除即级联失效）。
-- 为一份 1:1 的数据单独建表，只会换来一次额外的 JOIN 和一个需要手工维护的孤儿清理逻辑。
--
-- 全部为可空列，因此对存量数据是零风险的：老会话的 summary 为 NULL，
-- 直接走"没有摘要"的路径（整段历史进上下文），行为与升级前完全一致。

ALTER TABLE "Conversation" ADD COLUMN "summary" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "summaryUpdatedAt" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN "summaryUpToMessageId" TEXT;
