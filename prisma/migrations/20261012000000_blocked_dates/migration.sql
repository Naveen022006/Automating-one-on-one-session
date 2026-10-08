-- CreateTable
CREATE TABLE "blocked_dates" (
    "id" TEXT NOT NULL,
    "influencer_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocked_dates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "blocked_dates_influencer_id_idx" ON "blocked_dates"("influencer_id");

-- CreateIndex
CREATE UNIQUE INDEX "blocked_dates_influencer_id_date_key" ON "blocked_dates"("influencer_id", "date");

-- AddForeignKey
ALTER TABLE "blocked_dates" ADD CONSTRAINT "blocked_dates_influencer_id_fkey" FOREIGN KEY ("influencer_id") REFERENCES "influencers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
