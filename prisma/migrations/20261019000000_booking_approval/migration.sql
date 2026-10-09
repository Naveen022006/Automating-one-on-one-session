-- AlterEnum
ALTER TYPE "BookingStatus" ADD VALUE 'REQUESTED';

-- AlterTable
ALTER TABLE "services" ADD COLUMN     "requires_approval" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "decided_at" TIMESTAMP(3),
ADD COLUMN     "decline_reason" TEXT;
