-- Phase 5 keys outbound messages on (booking, channel, template) so a retried send upserts the same row
-- (idempotent reminders/confirmations) while different channels for the same message type still coexist.
-- Clean up any pre-existing duplicates before adding the unique index so it can be created safely.
DELETE FROM "messages" a
USING "messages" b
WHERE a.ctid < b.ctid
  AND a."booking_id" = b."booking_id"
  AND a."channel" = b."channel"
  AND a."template" = b."template";

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "messages_booking_id_channel_template_key"
  ON "messages"("booking_id", "channel", "template");
