-- AlterTable
ALTER TABLE "influencers" ADD COLUMN     "disconnected_google_email" TEXT;

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "event_generation" INTEGER NOT NULL DEFAULT 0;
