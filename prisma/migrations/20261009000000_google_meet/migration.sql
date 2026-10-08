-- CreateEnum
CREATE TYPE "GoogleTokenStatus" AS ENUM ('ACTIVE', 'RECONNECT_NEEDED');

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "event_id" TEXT,
ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "meet_link" TEXT;

-- CreateTable
CREATE TABLE "google_tokens" (
    "id" TEXT NOT NULL,
    "influencer_id" TEXT NOT NULL,
    "refresh_token_enc" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "status" "GoogleTokenStatus" NOT NULL DEFAULT 'ACTIVE',
    "reconnect_reason" TEXT,
    "reconnect_needed_at" TIMESTAMP(3),
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "google_tokens_influencer_id_key" ON "google_tokens"("influencer_id");

-- AddForeignKey
ALTER TABLE "google_tokens" ADD CONSTRAINT "google_tokens_influencer_id_fkey" FOREIGN KEY ("influencer_id") REFERENCES "influencers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
