-- The Reports page and the admin Money ledger (doc/12) read payments and refunds by the day they were created and payouts by the day they
-- were marked as sent. Additive: three plain indexes (the tables are small, and `prisma migrate deploy` runs a migration in a
-- transaction, so not CONCURRENTLY). Generated with `prisma migrate diff`; nothing else changes.

-- CreateIndex
CREATE INDEX "payments_created_at_idx" ON "payments"("created_at");

-- CreateIndex
CREATE INDEX "payouts_status_paid_at_idx" ON "payouts"("status", "paid_at");

-- CreateIndex
CREATE INDEX "refunds_created_at_idx" ON "refunds"("created_at");
