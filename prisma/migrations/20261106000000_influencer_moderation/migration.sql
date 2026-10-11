-- Platform moderation: suspend an influencer, and (opt-in, READINESS_REQUIRED=...,approval) approve a page before it goes live.
-- Additive: five nullable columns.

-- AlterTable
ALTER TABLE "influencers" ADD COLUMN     "approved_at" TIMESTAMP(3),
ADD COLUMN     "approved_by_email" TEXT,
ADD COLUMN     "suspended_at" TIMESTAMP(3),
ADD COLUMN     "suspended_by_email" TEXT,
ADD COLUMN     "suspended_reason" TEXT;

-- Backfill: every account that had finished onboarding is grandfathered as approved, so turning the approval gate on later
-- never takes an existing live-capable page offline. Accounts still onboarding stay unapproved.
UPDATE "influencers" SET "approved_at" = "onboarded_at", "approved_by_email" = 'system:grandfathered' WHERE "onboarded_at" IS NOT NULL;
