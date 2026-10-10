-- AlterTable
ALTER TABLE "admin_users" ADD COLUMN     "totp_enabled_at" TIMESTAMP(3),
ADD COLUMN     "totp_last_step" INTEGER,
ADD COLUMN     "totp_secret_enc" TEXT;

-- AlterTable
ALTER TABLE "admin_sessions" ADD COLUMN     "mfa_verified_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "payouts" ADD COLUMN     "approved_at" TIMESTAMP(3),
ADD COLUMN     "approved_by_email" TEXT;

-- CreateTable
CREATE TABLE "admin_recovery_codes" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_recovery_codes_admin_id_code_hash_key" ON "admin_recovery_codes"("admin_id", "code_hash");

-- AddForeignKey
ALTER TABLE "admin_recovery_codes" ADD CONSTRAINT "admin_recovery_codes_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
