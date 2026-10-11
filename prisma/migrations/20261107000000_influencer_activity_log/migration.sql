-- Influencer activity log (append-only; the worker deletes rows older than 365 days). Additive: one new table.

-- CreateTable
CREATE TABLE "influencer_activity_logs" (
    "id" TEXT NOT NULL,
    "influencer_id" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'influencer',
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "detail" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "influencer_activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "influencer_activity_logs_influencer_id_created_at_idx" ON "influencer_activity_logs"("influencer_id", "created_at");

-- CreateIndex
CREATE INDEX "influencer_activity_logs_created_at_idx" ON "influencer_activity_logs"("created_at");

-- AddForeignKey
ALTER TABLE "influencer_activity_logs" ADD CONSTRAINT "influencer_activity_logs_influencer_id_fkey" FOREIGN KEY ("influencer_id") REFERENCES "influencers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
