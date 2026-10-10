import assert from "node:assert/strict";
import { before, mock, test } from "node:test";
import type { Rule } from "../lib/slots";

/**
 * Reschedule time-validation (pure, DB-free) and group-cancel shared-event handling for lib/manage.ts.
 *
 * The validateRescheduleTime checks are pure (rules + blocked days passed in) and run anywhere luxon resolves
 * (CI; the sandbox has luxon as a placeholder). The cancel test replaces the DB/queue/email/token modules with
 * in-memory fakes via node:test mock.module and injects a fake GoogleClient through ManageDeps, so it needs no
 * Postgres/Redis/Google -- but it does need the @/* alias + node_modules, so it runs in CI, not the offline
 * sandbox.
 */

const IST = "Asia/Kolkata";
const monday: Rule = { weekday: 1, startTime: "10:00", endTime: "12:00", timezone: IST };

// The pure helper does not touch the DB, but importing lib/manage pulls in @/lib/db at module load, so this
// (like tests/group-meeting.test.ts) resolves only where node_modules + the @/* alias exist (CI).
// Imported lazily inside each test (no top-level await: tsx runs these tests as CommonJS).
const validateRescheduleTime: typeof import("../lib/manage").validateRescheduleTime = (args) => loaded!(args);
let loaded: typeof import("../lib/manage").validateRescheduleTime | null = null;
before(async () => {
  ({ validateRescheduleTime: loaded } = await import("../lib/manage"));
});

test("validateRescheduleTime rejects a past time", async () => {
  const reason = validateRescheduleTime({
    rules: [monday],
    durationMin: 30,
    newStart: new Date("2000-01-03T05:00:00Z"),
    blockedDates: new Set(),
    now: new Date("2030-01-01T00:00:00Z"),
  });
  assert.equal(reason, "The new time must be in the future");
  mock.reset();
});

test("validateRescheduleTime rejects a time off the availability rules", async () => {
  // 05:10Z is not a real 30-min slot start inside the Monday 10:00-12:00 IST (04:30-06:30 UTC) window.
  const reason = validateRescheduleTime({
    rules: [monday],
    durationMin: 30,
    newStart: new Date("2030-01-07T05:10:00Z"),
    blockedDates: new Set(),
    now: new Date("2030-01-01T00:00:00Z"),
  });
  assert.equal(reason, "That time is not available");
  mock.reset();
});

test("validateRescheduleTime rejects a real start that lands on a blocked day", async () => {
  const reason = validateRescheduleTime({
    rules: [monday],
    durationMin: 30,
    newStart: new Date("2030-01-07T05:00:00Z"),
    blockedDates: new Set(["2030-01-07"]),
    now: new Date("2030-01-01T00:00:00Z"),
  });
  assert.equal(reason, "That time is not available");
  mock.reset();
});

test("validateRescheduleTime accepts a real, future, unblocked slot start", async () => {
  const reason = validateRescheduleTime({
    rules: [monday],
    durationMin: 30,
    newStart: new Date("2030-01-07T05:00:00Z"),
    blockedDates: new Set(),
    now: new Date("2030-01-01T00:00:00Z"),
  });
  assert.equal(reason, null);
  mock.reset();
});

// --- Group cancel: only the leaving attendee goes; the shared event is deleted only when no other live booking is left ---
// Whether the event may be deleted is decided from the bookings in the DATABASE under the session row lock, never from
// Google's attendee list (which can miss paying customers).

interface FakeBooking {
  id: string;
  sessionId: string;
  status: string;
  customerName: string;
  customerEmail: string;
  eventId: string | null;
}
interface FakeSession {
  id: string;
  eventId: string | null;
  eventGeneration: number;
  meetLink: string | null;
  service: { id: string; type: "ONE_TO_ONE" | "GROUP"; durationMin: number; influencer: { id: string; name: string } };
  bookings: FakeBooking[];
}

function makeDb(sessions: FakeSession[], bookings: FakeBooking[]) {
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const bookingById = new Map(bookings.map((b) => [b.id, b]));
  const log = { locked: [] as string[] };
  const tx = {
    $queryRaw: async (_strings: TemplateStringsArray, sessionId: string) => {
      log.locked.push(sessionId);
      const s = sessionById.get(sessionId);
      return s ? [{ event_id: s.eventId }] : [];
    },
    booking: {
      findMany: async ({ where }: { where: { sessionId: string; id: { not: string }; status: { in: string[] } } }) =>
        bookings
          .filter((b) => b.sessionId === where.sessionId && b.id !== where.id.not && where.status.in.includes(b.status))
          .map((b) => ({ customerEmail: b.customerEmail })),
    },
    session: {
      // The retire: only if the session still has the event that was read, and the generation moves on atomically.
      updateMany: async ({ where, data }: { where: { id: string; eventId: string }; data: { eventId: null; meetLink: null; eventGeneration: { increment: number } } }) => {
        const s = sessionById.get(where.id);
        if (!s || s.eventId !== where.eventId) return { count: 0 };
        s.eventId = data.eventId;
        s.meetLink = data.meetLink;
        s.eventGeneration += data.eventGeneration.increment;
        return { count: 1 };
      },
    },
  };
  return {
    log,
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    booking: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const b = bookingById.get(where.id);
        if (!b) return null;
        const session = sessionById.get(b.sessionId)!;
        return { ...b, session, payments: [] };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const b = bookingById.get(where.id)!;
        Object.assign(b, data);
        return b;
      },
    },
    payment: { updateMany: async () => ({ count: 0 }) },
  };
}

const EVENT_ID = "evt-shared";

function groupFixture(opts: { otherLive?: "SCHEDULED" | "PAID" | "HELD" | "CANCELLED" | null; googleRemaining: number; otherEmail?: string }) {
  const influencer = { id: "inf1", name: "Dev" };
  const service = { id: "svc1", type: "GROUP" as const, durationMin: 30, influencer };
  const b1: FakeBooking = {
    id: "b1",
    sessionId: "sess1",
    status: "SCHEDULED",
    customerName: "A",
    customerEmail: "a@example.com",
    eventId: EVENT_ID,
  };
  const bookings = [b1];
  if (opts.otherLive) {
    bookings.push({ id: "b2", sessionId: "sess1", status: opts.otherLive, customerName: "B", customerEmail: opts.otherEmail ?? "b@example.com", eventId: opts.otherLive === "PAID" ? null : EVENT_ID });
  }
  const session: FakeSession = {
    id: "sess1",
    eventId: EVENT_ID,
    eventGeneration: 2,
    meetLink: "https://meet.google.com/shared",
    service,
    bookings,
  };
  const removed: { eventId: string; email: string }[] = [];
  const deleted: string[] = [];
  const google = {
    refreshAccessToken: async () => "access-token",
    // Google's attendee list is deliberately NOT what decides: it can be empty while a paying customer is still booked.
    removeAttendee: async (_t: string, eventId: string, email: string) => {
      removed.push({ eventId, email });
      return { remaining: opts.googleRemaining };
    },
    deleteEvent: async (_t: string, eventId: string) => void deleted.push(eventId),
  };
  return { session, bookings, b1, google, removed, deleted };
}

async function loadManageWithMocks(session: FakeSession, bookings: FakeBooking[]) {
  const db = makeDb([session], bookings);
  mock.module("@/lib/db", { namedExports: { prisma: db } });
  mock.module("@/lib/queue", {
    namedExports: {
      enqueueSendMessage: async () => {},
      enqueueReminders: async () => {},
      cancelReminders: async () => {},
      requeueCreateMeeting: async () => {},
    },
  });
  mock.module("@/lib/alerts", { namedExports: { alertInfluencer: async () => {} } });
  mock.module("@/lib/messages", { namedExports: { createMessage: async () => "m1" } });
  mock.module("@/lib/messaging", { namedExports: { rearmMessage: async () => {} } });
  mock.module("@/lib/email", { namedExports: { sendBookingEmail: async () => {} } });
  mock.module("@/lib/google-tokens", {
    namedExports: {
      getRefreshToken: async () => ({ state: "ok", refreshToken: "refresh" }),
      markReconnectNeeded: async () => false,
    },
  });
  const mod = await import("../lib/manage.ts?manage-cancel=" + Math.random());
  return { mod, db };
}

test("group cancel removes only the leaving attendee when another booking is live, keeping the shared event", async () => {
  const { session, bookings, google, removed, deleted } = groupFixture({ otherLive: "SCHEDULED", googleRemaining: 1 });
  const { mod, db } = await loadManageWithMocks(session, bookings);

  await mod.cancelBooking("b1", { actor: "influencer" }, { google });

  assert.deepEqual(db.log.locked, ["sess1"], "decided under the session row lock");
  assert.deepEqual(removed, [{ eventId: EVENT_ID, email: "a@example.com" }], "removes just this attendee");
  assert.deepEqual(deleted, [], "the shared event is NOT deleted while others remain");
  assert.equal(session.eventId, EVENT_ID, "the session keeps its shared event");
  assert.equal(session.meetLink, "https://meet.google.com/shared");
  assert.equal(session.eventGeneration, 2);
  assert.equal(bookings[0].status, "CANCELLED");
  mock.reset();
});

test("a paying customer missing from Google's attendee list keeps the event alive (the list is empty, the database is not)", async () => {
  // b2 is PAID and still waiting for its create-meeting job, so it was never added to the event: Google says nobody is
  // left, but deleting the event now would hand b2 a link to a deleted event.
  const { session, bookings, google, removed, deleted } = groupFixture({ otherLive: "PAID", googleRemaining: 0 });
  const { mod } = await loadManageWithMocks(session, bookings);

  await mod.cancelBooking("b1", { actor: "influencer" }, { google });

  assert.deepEqual(deleted, [], "no delete although Google's list is empty");
  assert.deepEqual(removed, [{ eventId: EVENT_ID, email: "a@example.com" }]);
  assert.equal(session.eventId, EVENT_ID);
  assert.equal(session.meetLink, "https://meet.google.com/shared");
  assert.equal(session.eventGeneration, 2, "the id sequence did not move on");
  mock.reset();
});

test("group cancel deletes the shared event and retires it when no other PAID/SCHEDULED booking is left", async () => {
  const { session, bookings, google, removed, deleted } = groupFixture({ otherLive: null, googleRemaining: 0 });
  const { mod } = await loadManageWithMocks(session, bookings);

  await mod.cancelBooking("b1", { actor: "influencer" }, { google });

  assert.deepEqual(deleted, [EVENT_ID], "the shared event is deleted at Google");
  assert.deepEqual(removed, [], "no separate attendee removal: deleting the event withdraws every invite");
  assert.equal(session.eventId, null, "the session's shared event id is cleared");
  assert.equal(session.meetLink, null, "the session's shared meet link is cleared");
  assert.equal(session.eventGeneration, 3, "the next event starts at the next id of the sequence");
  mock.reset();
});

test("unpaid, held or cancelled bookings do not keep the event alive", async () => {
  for (const other of ["HELD", "CANCELLED"] as const) {
    const { session, bookings, google, deleted } = groupFixture({ otherLive: other, googleRemaining: 1 });
    const { mod } = await loadManageWithMocks(session, bookings);
    await mod.cancelBooking("b1", { actor: "influencer" }, { google });
    assert.deepEqual(deleted, [EVENT_ID], `a ${other} booking is not a reason to keep the event`);
    mock.reset();
  }
});

// --- S4: Google's attendee list is by email ---

test("S4: another live booking on the same session under the same email (any case) keeps the attendee on the event", async () => {
  const { session, bookings, google, removed, deleted } = groupFixture({ otherLive: "SCHEDULED", googleRemaining: 1, otherEmail: "A@Example.com" });
  const { mod } = await loadManageWithMocks(session, bookings);

  await mod.cancelBooking("b1", { actor: "influencer" }, { google });

  assert.deepEqual(removed, [], "removing a@example.com would take the other booking's invite away too");
  assert.deepEqual(deleted, [], "and the event stays");
  assert.equal(session.eventId, EVENT_ID);
  mock.reset();
});

test("S4: a different email is removed as before", async () => {
  const { session, bookings, google, removed } = groupFixture({ otherLive: "SCHEDULED", googleRemaining: 1, otherEmail: "other@example.com" });
  const { mod } = await loadManageWithMocks(session, bookings);

  await mod.cancelBooking("b1", { actor: "influencer" }, { google });

  assert.deepEqual(removed, [{ eventId: EVENT_ID, email: "a@example.com" }]);
  mock.reset();
});

test("S4: the same email on a booking that is not live (cancelled or unpaid) does not block the removal or the delete", async () => {
  for (const other of ["CANCELLED", "HELD"] as const) {
    const { session, bookings, google, deleted } = groupFixture({ otherLive: other, googleRemaining: 1, otherEmail: "a@example.com" });
    const { mod } = await loadManageWithMocks(session, bookings);
    await mod.cancelBooking("b1", { actor: "influencer" }, { google });
    assert.deepEqual(deleted, [EVENT_ID], `a ${other} booking with the same email is not live`);
    mock.reset();
  }
});
