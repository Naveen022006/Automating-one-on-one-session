-- Phase 7: influencer accounts (users, auth sessions, reset/verification tokens), refunds and refund policy,
-- Google account email, onboarding/profile fields, customer data redaction, and database-backed rate limits.

-- CreateEnum
CREATE TYPE "RefundPolicy" AS ENUM ('FULL', 'NOTICE_24H', 'NONE');

-- AlterTable: influencer profile + onboarding + notification preferences
ALTER TABLE "influencers"
  ADD COLUMN "bio" TEXT,
  ADD COLUMN "photo_url" TEXT,
  ADD COLUMN "onboarded_at" TIMESTAMP(3),
  ADD COLUMN "notify_by_email" BOOLEAN NOT NULL DEFAULT true;

-- Existing influencers were set up by hand before accounts existed; treat them as onboarded.
UPDATE "influencers" SET "onboarded_at" = "created_at" WHERE "onboarded_at" IS NULL;

-- AlterTable: per-service cancellation refund policy
ALTER TABLE "services" ADD COLUMN "refund_policy" "RefundPolicy" NOT NULL DEFAULT 'FULL';

-- AlterTable: customer data erasure marker, and the refund policy the booking was sold under
ALTER TABLE "bookings" ADD COLUMN "redacted_at" TIMESTAMP(3);
ALTER TABLE "bookings" ADD COLUMN "refund_policy" "RefundPolicy";

-- AlterTable: refund summary on payments (derived from the refunds table)
ALTER TABLE "payments"
  ADD COLUMN "refund_status" TEXT,
  ADD COLUMN "refund_amount_minor" INTEGER,
  ADD COLUMN "refunded_at" TIMESTAMP(3);

-- CreateTable: one row per Razorpay refund
CREATE TABLE "refunds" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "provider_refund_id" TEXT NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "refunds_provider_refund_id_key" ON "refunds"("provider_refund_id");
CREATE INDEX "refunds_payment_id_idx" ON "refunds"("payment_id");
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: which Google account a calendar connection belongs to
ALTER TABLE "google_tokens" ADD COLUMN "google_email" TEXT;

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "email_verified_at" TIMESTAMP(3),
    "terms_accepted_at" TIMESTAMP(3) NOT NULL,
    "password_changed_at" TIMESTAMP(3),
    "influencer_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "users_influencer_id_key" ON "users"("influencer_id");
ALTER TABLE "users" ADD CONSTRAINT "users_influencer_id_fkey"
  FOREIGN KEY ("influencer_id") REFERENCES "influencers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "authenticated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_agent" TEXT,
    "ip" TEXT,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "auth_sessions_token_hash_key" ON "auth_sessions"("token_hash");
CREATE INDEX "auth_sessions_user_id_idx" ON "auth_sessions"("user_id");
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions"("expires_at");
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "email_verification_tokens" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "email_verification_tokens_token_hash_key" ON "email_verification_tokens"("token_hash");
CREATE INDEX "email_verification_tokens_user_id_idx" ON "email_verification_tokens"("user_id");
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: database-backed rate limit counters (fallback when Redis is unavailable)
CREATE TABLE "rate_limit_buckets" (
    "key" TEXT NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("key", "window_start")
);
CREATE INDEX "rate_limit_buckets_expires_at_idx" ON "rate_limit_buckets"("expires_at");
