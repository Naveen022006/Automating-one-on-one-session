-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'PAID', 'CANCELLED');

-- AlterTable
ALTER TABLE "influencers" ADD COLUMN     "platform_fee_bps" INTEGER;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "payout_id" TEXT,
ADD COLUMN     "reconciled_at" TIMESTAMP(3),
ADD COLUMN     "reconciled_by_email" TEXT;

-- CreateTable
CREATE TABLE "payouts" (
    "id" TEXT NOT NULL,
    "influencer_id" TEXT NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "currency" TEXT NOT NULL,
    "gross_minor" INTEGER NOT NULL,
    "refunds_minor" INTEGER NOT NULL,
    "fee_bps" INTEGER NOT NULL,
    "fee_minor" INTEGER NOT NULL,
    "net_minor" INTEGER NOT NULL,
    "payment_count" INTEGER NOT NULL,
    "destination" TEXT NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "created_by_email" TEXT NOT NULL,
    "paid_by_email" TEXT,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payouts_influencer_id_created_at_idx" ON "payouts"("influencer_id", "created_at");

-- CreateIndex
CREATE INDEX "payouts_status_idx" ON "payouts"("status");

-- CreateIndex
CREATE INDEX "payments_payout_id_idx" ON "payments"("payout_id");

-- CreateIndex
CREATE INDEX "payments_status_reconciled_at_idx" ON "payments"("status", "reconciled_at");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "payouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_influencer_id_fkey" FOREIGN KEY ("influencer_id") REFERENCES "influencers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
