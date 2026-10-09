-- AlterTable
ALTER TABLE "services" ADD COLUMN     "intake_questions" JSONB,
ADD COLUMN     "max_advance_days" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "min_notice_hours" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "prep_notes" TEXT;

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "intake_answers" JSONB;
