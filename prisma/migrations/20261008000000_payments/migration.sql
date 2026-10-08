-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'CAPTURED', 'FAILED', 'REFUNDED');

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'razorpay',
    "provider_order_id" TEXT NOT NULL,
    "provider_payment_id" TEXT,
    "amount_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "needs_refund" BOOLEAN NOT NULL DEFAULT false,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_order_id_key" ON "payments"("provider_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_payment_id_key" ON "payments"("provider_payment_id");

-- CreateIndex
CREATE INDEX "payments_booking_id_idx" ON "payments"("booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_event_id_key" ON "webhook_events"("provider", "event_id");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
