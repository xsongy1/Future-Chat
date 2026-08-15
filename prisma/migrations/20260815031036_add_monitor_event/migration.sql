-- CreateTable
CREATE TABLE "MonitorEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "data" JSONB NOT NULL,
    "context" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonitorEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MonitorEvent_type_idx" ON "MonitorEvent"("type");

-- CreateIndex
CREATE INDEX "MonitorEvent_timestamp_idx" ON "MonitorEvent"("timestamp");

-- CreateIndex
CREATE INDEX "MonitorEvent_type_timestamp_idx" ON "MonitorEvent"("type", "timestamp");
