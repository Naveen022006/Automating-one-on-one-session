import assert from "node:assert/strict";
import { mock, test } from "node:test";
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
const { validateRescheduleTime } = await import("../lib/manage");

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

// --- Group cancel removes only the leaving attendee, and clears the session once the last one leaves ---

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
  meetLink: string | null;
  service: { id: string; type: "ONE_TO_ONE" | "GROUP"; durationMin: number; influencer: { id: string; name: string } };
  bookings: FakeBooking[];
}

function makeDb(sessions: FakeSession[], bookings: FakeBooking[]) {
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const bookingById = new Map(bookings.map((b) => [b.id, b]));
  return {
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
    session: {
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const s = sessionById.get(where.id)!;
        Object.assign(s, data);
        return s;
      },
    },
  };
}

const EVENT_ID = "evt-shared";

function groupFixture(remainingAfterRemove: number) {
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
  const session: FakeSession = {
    id: "sess1",
    eventId: EVENT_ID,
    meetLink: "https://meet.google.com/shared",
    service,
    bookings: [b1],
  };
  const removed: { eventId: string; email: string }[] = [];
  const deleted: string[] = [];
  const google = {
    refreshAccessToken: async () => "access-token",
    removeAttendee: async (_t: string, eventId: string, email: string) => {
      removed.push({ eventId, email });
      return { remaining: remainingAfterRemove };
    },
    deleteEvent: async (_t: string, eventId: string) => void deleted.push(eventId),
  };
  return { session, b1, google, removed, deleted };
}

async function loadManageWithMocks(session: FakeSession, bookings: FakeBooking[]) {
  mock.module("@/lib/db", { namedExports: { prisma: makeDb([session], bookings) } });
  mock.module("@/lib/queue", { namedExports: { enqueueSendMessage: async () => {} } });
  mock.module("@/lib/alerts", { namedExports: { alertInfluencer: async () => {} } });
  mock.module("@/lib/messages", { namedExports: { createMessage: async () => "m1" } });
  mock.module("@/lib/email", { namedExports: { sendBookingEmail: async () => {} } });
  mock.module("@/lib/google-tokens", {
    namedExports: { getRefreshToken: async () => ({ state: "ok", refreshToken: "refresh" }) },
  });
  return await import("../lib/manage.ts?manage-cancel=" + Math.random());
}

test("group cancel removes only the leaving attendee when others remain, keeping the shared event", async () => {
  const { session, google, removed, deleted } = groupFixture(1); // one attendee still remains
  const mod = await loadManageWithMocks(session, session.bookings);

  await mod.cancelBooking("b1", { google });

  assert.deepEqual(removed, [{ eventId: EVENT_ID, email: "a@example.com" }], "removes just this attendee");
  assert.deepEqual(deleted, [], "the shared event is NOT deleted while others remain");
  assert.equal(session.eventId, EVENT_ID, "the session keeps its shared event");
  assert.equal(session.meetLink, "https://meet.google.com/shared");
  assert.equal(session.bookings[0].status, "CANCELLED");
  mock.reset();
});

test("group cancel deletes the shared event and clears the session when the last attendee leaves", async () => {
  const { session, google, removed, deleted } = groupFixture(0); // nobody left after removal
  const mod = await loadManageWithMocks(session, session.bookings);

  await mod.cancelBooking("b1", { google });

  assert.deepEqual(removed, [{ eventId: EVENT_ID, email: "a@example.com" }]);
  assert.deepEqual(deleted, [EVENT_ID], "the shared event is deleted once the last attendee leaves");
  assert.equal(session.eventId, null, "the session's shared event id is cleared");
  assert.equal(session.meetLink, null, "the session's shared meet link is cleared");
  mock.reset();
});
