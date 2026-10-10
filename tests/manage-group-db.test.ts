// Integration tests of the group cancel and of the meeting job's write against a migrated Postgres (skipped without
// DATABASE_URL / TOKEN_ENCRYPTION_KEY): the real FOR UPDATE queries, column names and row-lock behaviour of
// lib/manage.ts releaseSharedEvent and lib/meeting.ts commitGroupAttachment, which in-memory fakes cannot check.
// Google and every side effect are injected; only the database is real.
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prisma } from "../lib/db";
import type { GoogleClient } from "../lib/google";
import { saveGoogleToken } from "../lib/google-tokens";
import { cancelBooking } from "../lib/manage";
import { createMeetingForBooking, sessionEventId } from "../lib/meeting";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY not set";
const run = Date.now();
const later = (ms: number) => new Promise((r) => setTimeout(r, ms));
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const newBooking = (sessionId: string, status: "SCHEDULED" | "PAID" | "HELD", eventId: string | null, link: string | null, i: number) =>
  prisma.booking.create({
    data: { sessionId, status, customerName: `C${i}`, customerEmail: `c${i}-${n}-${run}@example.com`, whatsappE164: "+919876543210", eventId, meetLink: link },
  });

const futureStart = () => new Date(Date.now() + (7 + n++) * 86_400_000);

/** A future group session that already has its shared event (generation 2), with one booking per given status. */
async function groupSession(statuses: ("SCHEDULED" | "PAID")[]) {
  const start = futureStart();
  const session = await prisma.session.create({
    data: { serviceId, startTime: start, endTime: new Date(start.getTime() + 1_800_000), eventId: "evt-live", meetLink: "https://meet.google.com/live", eventGeneration: 2 },
  });
  const bookings = [];
  for (const [i, status] of statuses.entries()) {
    bookings.push(await newBooking(session.id, status, status === "SCHEDULED" ? "evt-live" : null, status === "SCHEDULED" ? "https://meet.google.com/live" : null, i));
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

test("two bookings cancelled at the same moment: the event ends up deleted and the sequence moves on once", { skip }, async () => {
  // Each cancel marks its own booking CANCELLED first, so at least one of them sees the session empty; the retire only
  // applies to the event that was read, so a second "last" cannot bump the generation again.
  const { session, bookings } = await groupSession(["SCHEDULED", "SCHEDULED"]);
  const a = effects();
  const b = effects();

  await Promise.all([cancelBooking(bookings[0].id, { actor: "influencer" }, a.deps), cancelBooking(bookings[1].id, { actor: "influencer" }, b.deps)]);

  const s = await sessionRow(session.id);
  assert.equal(s.eventId, null);
  assert.equal(s.eventGeneration, 3);
  assert.ok(a.calls.deleted.length + b.calls.deleted.length >= 1, "the event was deleted at Google");
});

test("the session lock: a cancel waits for a payer who is committing, then counts that payer and keeps the event", { skip }, async () => {
  // What the lock is for. A payer's capture commits while another transaction holds the session lock; the cancel must not
  // take its count (and retire the event) before that, or the payer would be left on a deleted event.
  const { session, bookings } = await groupSession(["SCHEDULED"]);
  const payer = await newBooking(session.id, "HELD", null, null, 9);
  const locked = deferred();
  const release = deferred();
  const holder = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM sessions WHERE id = ${session.id} FOR UPDATE`;
      locked.resolve();
      await release.promise;
      await tx.booking.update({ where: { id: payer.id }, data: { status: "PAID" } }); // the payment lands before the lock is let go
    },
    { timeout: 30_000 },
  );
  await locked.promise;

  const { calls, deps } = effects();
  let cancelDone = false;
  const cancel = cancelBooking(bookings[0].id, { actor: "influencer" }, deps).then(() => void (cancelDone = true));
  await later(1500);
  assert.equal(cancelDone, false, "the cancel is blocked on the session row lock");

  release.resolve();
  await Promise.all([holder, cancel]);

  assert.deepEqual(calls.deleted, [], "the payer committed first, so the cancel saw a live booking and kept the event");
  const s = await sessionRow(session.id);
  assert.equal(s.eventId, "evt-live");
  assert.equal(s.eventGeneration, 2);
});

/** A calendar that behaves like Google for ids: an id is never reusable; deleting an unknown id is a no-op. */
function calendar(beforeFirstInsert?: () => Promise<void>) {
  const state = new Map<string, "live" | "cancelled">();
  const link = (id: string) => `https://meet.google.com/${id.slice(0, 12)}`;
  const rec = { deleted: [] as string[], inserts: [] as string[] };
  let first = true;
  const google = {
    refreshAccessToken: async () => "access",
    insertEvent: async (_t: string, ev: { id: string }) => {
      if (first && beforeFirstInsert) {
        first = false;
        await beforeFirstInsert();
      }
      rec.inserts.push(ev.id);
      if (state.has(ev.id)) return "exists" as const;
      state.set(ev.id, "live");
      return { id: ev.id, status: "confirmed", meetLink: link(ev.id), conferenceStatus: "success" as const };
    },
    getEvent: async (_t: string, id: string) =>
      state.has(id) ? { id, status: state.get(id) === "live" ? "confirmed" : "cancelled", meetLink: link(id), conferenceStatus: "success" as const } : null,
    addAttendee: async (_t: string, id: string) => ({ id, status: "confirmed", meetLink: link(id), conferenceStatus: "success" as const }),
    deleteEvent: async (_t: string, id: string) => {
      rec.deleted.push(id);
      if (state.has(id)) state.set(id, "cancelled");
    },
  };
  return { google: google as unknown as GoogleClient, state, link, rec };
}

test("S1 against Postgres: a cancel retires the event while a job is inside Google; the next payer ends on a live event and the stale job writes nothing", { skip }, async () => {
  const start = futureStart();
  const session = await prisma.session.create({ data: { serviceId, startTime: start, endTime: new Date(start.getTime() + 1_800_000) } });
  const pa = await newBooking(session.id, "PAID", null, null, 1);
  const pb = await newBooking(session.id, "HELD", null, null, 2);

  const paused = deferred();
  const gate = deferred();
  const cal = calendar(async () => {
    paused.resolve();
    await gate.promise; // PA's job is between its claim and its write, inside Google
  });
  const emailed: string[] = [];
  const alerts: string[] = [];
  const jobDeps = {
    google: cal.google,
    sleep: async () => {},
    sendBookingEmail: async (id: string) => void emailed.push(id),
    enqueueSendMessage: async () => {},
    enqueueReminders: async () => {},
    alert: async (_i: string, a: { kind: string }) => void alerts.push(a.kind),
  };
  const generations: number[] = [];
  const sample = async () => void generations.push((await sessionRow(session.id)).eventGeneration);

  const paJob = createMeetingForBooking(pa.id, jobDeps); // claims the session, then waits inside insertEvent
  await paused.promise;
  await sample(); // 0

  // The influencer cancels PA, the only live booking: the event is retired and the sequence moves on.
  await cancelBooking(pa.id, { actor: "influencer" }, { ...effects().deps, google: cal.google });
  await sample(); // 1
  assert.equal((await sessionRow(session.id)).eventId, null);

  // PB pays and its job runs to the end on the next event of the sequence.
  await prisma.booking.update({ where: { id: pb.id }, data: { status: "PAID" } });
  assert.equal(await createMeetingForBooking(pb.id, jobDeps), "scheduled");
  const z = sessionEventId(session.id, 1);
  await sample(); // 1

  // PA's job wakes up holding the dead generation-0 event.
  gate.resolve();
  assert.equal(await paJob, "skipped");
  await sample(); // 1

  const s = await sessionRow(session.id);
  const pbNow = await prisma.booking.findUniqueOrThrow({ where: { id: pb.id } });
  assert.equal(s.eventId, z, "the session still points at PB's live event");
  assert.equal(s.meetLink, cal.link(z));
  assert.equal(s.eventGeneration, 1);
  assert.equal(pbNow.status, "SCHEDULED");
  assert.equal(pbNow.eventId, z, "PB was not moved back onto the dead event");
  assert.equal(pbNow.meetLink, cal.link(z));
  assert.equal(cal.state.get(z), "live");
  assert.equal(cal.state.get(sessionEventId(session.id, 0)), "cancelled", "the event PA's job created for the dead generation was removed");
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: pa.id } })).status, "CANCELLED");
  assert.deepEqual(emailed.filter((id) => id === pb.id), [pb.id], "PB got exactly one confirmation, with the live link");
  assert.deepEqual(alerts, []);
  assert.deepEqual(generations, [0, 1, 1, 1], "the generation never went backwards");
});
