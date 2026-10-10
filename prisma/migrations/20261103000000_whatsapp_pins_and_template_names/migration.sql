-- CreateTable
CREATE TABLE "whatsapp_registration_pins" (
    "phone_number_id" TEXT NOT NULL,
    "pin_enc" TEXT NOT NULL,
    "generated" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_registration_pins_pkey" PRIMARY KEY ("phone_number_id")
);

-- Data fix: the five message templates are now submitted to Meta under a prefixed name (sa_booking_confirmation,
-- sa_reschedule, ...) so they cannot clash with templates an influencer already has on their account. Whatever status is
-- stored for a template refers to the OLD plain name (reschedule, cancellation, ... ), so it says nothing about the new
-- one. Chosen over tolerant read logic because the stored keys did not change and a reset is exact: forget every stored
-- template status so each reads as not submitted, and the next sync (the worker runs one every 30 minutes, "Check
-- template status" runs one on demand) submits them under the new names. Until then those messages go by SMS.
UPDATE "whatsapp_connections"
SET "templates" = NULL, "templates_synced_at" = NULL
WHERE "templates" IS NOT NULL;

UPDATE "whatsapp_connections"
SET "last_error" = NULL
WHERE "status" = 'ACTIVE' AND "last_error" LIKE 'Could not submit:%';
