-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "recovery_checked_at" TIMESTAMP(3),
ADD COLUMN     "recovery_error" TEXT;

-- CreateIndex
CREATE INDEX "payments_status_recovery_checked_at_idx" ON "payments"("status", "recovery_checked_at");
