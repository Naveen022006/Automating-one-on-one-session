-- CreateEnum
CREATE TYPE "WhatsAppConnectionStatus" AS ENUM ('ACTIVE', 'ERROR');

-- CreateTable
CREATE TABLE "whatsapp_connections" (
    "id" TEXT NOT NULL,
    "influencer_id" TEXT NOT NULL,
    "waba_id" TEXT NOT NULL,
    "phone_number_id" TEXT NOT NULL,
    "display_phone" TEXT,
    "verified_name" TEXT,
    "token_enc" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "status" "WhatsAppConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_error" TEXT,
    "templates" JSONB,
    "templates_synced_at" TIMESTAMP(3),
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_connections_influencer_id_key" ON "whatsapp_connections"("influencer_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_connections_phone_number_id_key" ON "whatsapp_connections"("phone_number_id");

-- CreateIndex
CREATE INDEX "whatsapp_connections_waba_id_idx" ON "whatsapp_connections"("waba_id");

-- AddForeignKey
ALTER TABLE "whatsapp_connections" ADD CONSTRAINT "whatsapp_connections_influencer_id_fkey" FOREIGN KEY ("influencer_id") REFERENCES "influencers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
