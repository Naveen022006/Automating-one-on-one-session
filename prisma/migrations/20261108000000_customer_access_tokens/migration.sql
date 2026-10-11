-- Customer portal access tokens ("find your bookings"): one hour of access per e-mailed link, only the SHA-256 of the token
-- is stored. Additive: one new table.

-- CreateTable
CREATE TABLE "customer_access_tokens" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_access_tokens_token_hash_key" ON "customer_access_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "customer_access_tokens_email_idx" ON "customer_access_tokens"("email");

-- CreateIndex
CREATE INDEX "customer_access_tokens_expires_at_idx" ON "customer_access_tokens"("expires_at");
