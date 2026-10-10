-- AlterTable
ALTER TABLE "admin_users" ADD COLUMN     "mfa_failed_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "mfa_lock_level" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "mfa_locked_until" TIMESTAMP(3);
