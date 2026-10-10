// Integration test of the group cancel against a migrated Postgres (skipped without DATABASE_URL / TOKEN_ENCRYPTION_KEY):
// the real FOR UPDATE query and column names of lib/manage.ts releaseSharedEvent, which the in-memory fakes cannot check.
// Google and every side effect are injected; only the database is real.
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prisma } from "../lib/db";
import type { GoogleClient } from "../lib/google";
import { saveGoogleToken } from "../lib/google-tokens";
import { cancelBooking } from "../lib/manage";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY not set";
const run = Date.now();
let influencerId = "";
let serviceId = "";
let n = 0;

before(async () => {
  if (skip) return;
  influencerId = (await prisma.influencer.create({ data: { slug: `mg-${run}`, name: "MG", email: `mg-${run}@example.com` } })).id;
  await saveGoogleToken(influencerId, "rt", "https://www.googleapis.com/auth/calendar.events", "mg@gmail.com");
  serviceId = (await prisma.service.create({ data: { influencerId, title: "Group", type: "GROUP", capacity: 5, durationMin: 30, priceMinor: 100 } })).id;
});

after(async () => {
  if (!skip) await prisma.influencer.delete({ where: { id: influencerId } });
  await prisma.$disconnect();
});

/** A future group session that already has its shared event (generation 2), with one booking per given status. */
async function groupSession(statuses: ("SCHEDULED" | "PAID")[]) {
  const start = new Date(Date.now() + (7 + n++) * 86_400_000);
  const session = await prisma.session.create({
    data: { serviceId, startTime: start, endTime: new Date(start.getTime() + 1_800_000), eventId: "evt-live", meetLink: "https://meet.google.com/live", eventGeneration: 2 },
  });
  const bookings = [];
  for (const [i, status] of statuses.entries()) {
    bookings.push(
      await prisma.booking.create({
        data: {
          sessionId: session.id,
          status,
          customerName: `C${i}`,
          customerEmail: `c${i}-${n}-${run}@example.com`,
          whatsappE164: "+919876543210",
          eventId: status === "SCHEDULED" ? "evt-live" : null,
          meetLink: status === "SCHEDULED" ? "https://meet.google.com/live" : null,
        },
      }),
    );
  }
  return { session, bookings };
}

function effects() {
  const calls = { removed: [] as string[], deleted: [] as string[] };
  const deps = {
    google: {
      refreshAccessToken: async () => "access",
      removeAttendee: async (_t: string, _e: string, email: string) => (calls.removed.push(email), { remaining: 0 }), // Google's list says empty
      deleteEvent: async (_t: string, eventId: string) => void calls.deleted.push(eventId),
    } as unknown as GoogleClient,
    alert: async () => {},
    cancelReminders: async () => {},
    enqueueSendMessage: async () => {},
    sendBookingEmail: async () => {},
    rearmMessage: async () => {},
    refundPayment: async () => ({}),
  };
  return { calls, deps };
}

const sessionRow = (id: string) => prisma.session.findUniqueOrThrow({ where: { id } });

test("a PAID booking still waiting for its link keeps the event alive when the SCHEDULED one cancels", { skip }, async () => {
  const { session, bookings } = await groupSession(["SCHEDULED", "PAID"]);
  const { calls, deps } = effects();

  await cancelBooking(bookings[0].id, { actor: "influencer" }, deps);

  assert.deepEqual(calls.deleted, [], "Google says the list is empty, the database says someone is still booked");
  assert.deepEqual(calls.removed, [bookings[0].customerEmail]);
  const s = await sessionRow(session.id);
  assert.equal(s.eventId, "evt-live");
  assert.equal(s.meetLink, "https://meet.google.com/live");
  assert.equal(s.eventGeneration, 2);
});

test("the last live booking deletes the event and moves the id sequence on", { skip }, async () => {
  const { session, bookings } = await groupSession(["SCHEDULED"]);
  const { calls, deps } = effects();

  await cancelBooking(bookings[0].id, { actor: "influencer" }, deps);

  assert.deepEqual(calls.deleted, ["evt-live"]);
  const s = await sessionRow(session.id);
  assert.equal(s.eventId, null);
  assert.equal(s.meetLink, null);
  assert.equal(s.eventGeneration, 3);
});

test("two bookings cancelled at the same moment: the event ends up deleted and the sequence moves on exactly once", { skip }, async () => {
  const { session, bookings } = await groupSession(["SCHEDULED", "SCHEDULED"]);
  const a = effects();
  const b = effects();

  await Promise.all([
    cancelBooking(bookings[0].id, { actor: "influencer" }, a.deps),
    cancelBooking(bookings[1].id, { actor: "influencer" }, b.deps),
  ]);

  const s = await sessionRow(session.id);
  assert.equal(s.eventId, null);
  assert.equal(s.eventGeneration, 3, "the row lock serialises the two decisions: one bump, not two");
  assert.ok(a.calls.deleted.length + b.calls.deleted.length >= 1, "the event was deleted at Google");
});
