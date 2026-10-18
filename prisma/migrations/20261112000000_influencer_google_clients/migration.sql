-- AlterTable
ALTER TABLE "google_tokens" ADD COLUMN     "client_kind" TEXT NOT NULL DEFAULT 'platform';

-- CreateTable
CREATE TABLE "influencer_google_clients" (
    "id" TEXT NOT NULL,
    "influencer_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret_enc" TEXT NOT NULL,
    "checked_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "influencer_google_clients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "influencer_google_clients_influencer_id_key" ON "influencer_google_clients"("influencer_id");

-- AddForeignKey
ALTER TABLE "influencer_google_clients" ADD CONSTRAINT "influencer_google_clients_influencer_id_fkey" FOREIGN KEY ("influencer_id") REFERENCES "influencers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
