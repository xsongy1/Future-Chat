-- 推倒重建 MonitorEvent 表（监控 SDK 全量重构）
-- 旧表：id(type/timestamp/data/context)，仅 type/timestamp 索引
-- 新表：维度字段（appId/sessionId/traceId）前置为独立列，支持按维度聚合查询

-- 清空并重建
DROP TABLE "MonitorEvent";

CREATE TABLE "MonitorEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "data" JSONB NOT NULL,
    "context" JSONB NOT NULL,
    "appId" TEXT,
    "sessionId" TEXT,
    "traceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonitorEvent_pkey" PRIMARY KEY ("id")
);

-- 查询索引：类型+时间（大盘趋势）、会话+时间（会话明细）、Trace（链路还原）、应用+时间（多应用隔离）
CREATE INDEX "MonitorEvent_type_timestamp_idx" ON "MonitorEvent"("type", "timestamp");
CREATE INDEX "MonitorEvent_sessionId_timestamp_idx" ON "MonitorEvent"("sessionId", "timestamp");
CREATE INDEX "MonitorEvent_traceId_idx" ON "MonitorEvent"("traceId");
CREATE INDEX "MonitorEvent_appId_timestamp_idx" ON "MonitorEvent"("appId", "timestamp");
