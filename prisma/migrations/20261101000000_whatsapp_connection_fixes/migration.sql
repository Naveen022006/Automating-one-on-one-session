-- AlterTable
ALTER TABLE "whatsapp_connections" ADD COLUMN     "registration_pin_enc" TEXT,
ADD COLUMN     "webhook_error" TEXT,
ADD COLUMN     "webhook_subscribed_at" TIMESTAMP(3);

-- Data fix: booking-confirmation, reminder-24h and reminder-15m were submitted to Meta under names it refuses (a
-- template name may only hold lowercase letters, digits and underscores), so they were never created and the
-- connection kept a "Could not submit" note. The app now sends booking_confirmation, reminder_24h and reminder_15m.
-- Our own keys in "templates" did not change, so there is nothing to rename. Drop any entry stored for the three
-- (they read as not submitted again) and clear the stale note, so the next template sync (the worker runs one every
-- 30 minutes, and "Check template status" runs one on demand) submits them under the new names.
UPDATE "whatsapp_connections"
SET "templates" = "templates" - 'booking-confirmation' - 'reminder-24h' - 'reminder-15m'
WHERE "templates" IS NOT NULL AND jsonb_typeof("templates") = 'object'
  AND (jsonb_exists("templates", 'booking-confirmation') OR jsonb_exists("templates", 'reminder-24h') OR jsonb_exists("templates", 'reminder-15m'));

UPDATE "whatsapp_connections"
SET "last_error" = NULL, "templates_synced_at" = NULL
WHERE "status" = 'ACTIVE' AND "last_error" LIKE 'Could not submit:%';
