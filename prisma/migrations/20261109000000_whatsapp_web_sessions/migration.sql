-- CreateEnum
CREATE TYPE "WhatsAppWebStatus" AS ENUM ('NOT_LINKED', 'PENDING_QR', 'LINKED', 'RECONNECTING', 'SUSPENDED', 'LOGGED_OUT');

-- CreateTable
CREATE TABLE "whatsapp_web_sessions" (
    "id" TEXT NOT NULL,
    "influencer_id" TEXT NOT NULL,
    "status" "WhatsAppWebStatus" NOT NULL DEFAULT 'NOT_LINKED',
    "want_linked" BOOLEAN NOT NULL DEFAULT false,
    "phone_e164" TEXT,
    "device_label" TEXT,
    "consent_at" TIMESTAMP(3),
    "consent_version" TEXT,
    "auth_state_enc" TEXT,
    "linked_at" TIMESTAMP(3),
    "last_connected_at" TIMESTAMP(3),
    "last_error_code" TEXT,
    "last_error_text" TEXT,
    "suspended_reason" TEXT,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "sent_total" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_web_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_web_sessions_influencer_id_key" ON "whatsapp_web_sessions"("influencer_id");

-- CreateIndex
CREATE INDEX "whatsapp_web_sessions_want_linked_status_idx" ON "whatsapp_web_sessions"("want_linked", "status");

-- AddForeignKey
ALTER TABLE "whatsapp_web_sessions" ADD CONSTRAINT "whatsapp_web_sessions_influencer_id_fkey" FOREIGN KEY ("influencer_id") REFERENCES "influencers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

