-- The "messages" table and the MessageChannel/MessageStatus enums are already created by the earlier
-- 20261010000000_messaging migration (the enum-typed Phase 4 model). Phase 6 originally shipped its own
-- CREATE TABLE "messages" here, which clashed with that one. On the merged schema there is a single unified
-- Message model, so this migration is now purely additive: it extends the channel enum with the EMAIL and LOG
-- values the Phase 6 recorders (lib/email.ts, structured-log senders) use, and adds the nullable sent_at
-- column those recorders set. Enum values must be committed before they can be used, so this runs on its own.

-- Add the Phase 6 channels to the existing enum (idempotent via IF NOT EXISTS).
ALTER TYPE "MessageChannel" ADD VALUE IF NOT EXISTS 'EMAIL';
ALTER TYPE "MessageChannel" ADD VALUE IF NOT EXISTS 'LOG';

-- Record when a message was delivered (set by lib/messages.markMessageSent / createMessage(status: sent)).
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "sent_at" TIMESTAMP(3);
