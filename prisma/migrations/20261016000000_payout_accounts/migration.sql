-- CreateEnum
CREATE TYPE "PayoutMethod" AS ENUM ('BANK', 'UPI');

-- CreateEnum
CREATE TYPE "PayoutAccountStatus" AS ENUM ('PENDING_REVIEW', 'VERIFIED', 'REJECTED');

-- CreateTable
CREATE TABLE "payout_accounts" (
    "id" TEXT NOT NULL,
    "influencer_id" TEXT NOT NULL,
    "method" "PayoutMethod" NOT NULL DEFAULT 'BANK',
    "account_holder_name" TEXT NOT NULL,
    "bank_name" TEXT,
    "ifsc" TEXT,
    "account_number_enc" TEXT,
    "account_number_masked" TEXT,
    "upi_id_enc" TEXT,
    "upi_id_masked" TEXT,
    "status" "PayoutAccountStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "rejection_reason" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "reviewed_by_email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payout_accounts_influencer_id_key" ON "payout_accounts"("influencer_id");

-- AddForeignKey
ALTER TABLE "payout_accounts" ADD CONSTRAINT "payout_accounts_influencer_id_fkey" FOREIGN KEY ("influencer_id") REFERENCES "influencers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
