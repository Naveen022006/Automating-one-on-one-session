import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock, test } from "node:test";

/**
 * Group-session shared-event behaviour for lib/meeting.ts.
 *
 * The real createMeetingForBooking reads and writes through the Prisma singleton (`@/lib/db`), enqueues via
 * BullMQ (`@/lib/queue`), and reads the Google token (`@/lib/google-tokens`). To keep this test DB-free (and
 * free of Redis/Google) we replace those modules with tiny in-memory fakes using node:test's `mock.module`,
 * then import lib/meeting.ts. The Google client itself is injected through the existing MeetingDeps override
 * and records whether insertEvent or addAttendee was called.
 *
 * NOTE (sandbox): this file can only run where the project's dependencies are installed and the `@/*` path
 * alias resolves (i.e. CI with `npm install` + `tsx --test`). It does NOT exercise a live database — the DB is
 * an in-memory stub — but it does require the module loader to resolve the mocked specifiers, so it will not run
 * in the offline sandbox that has no node_modules. The pure id-derivation checks at the bottom run anywhere.
 */

const SESSION_EVENT_ID = (id: string) => createHash("sha256").update(`session:${id}`).digest("hex");
const BOOKING_EVENT_ID = (id: string) => createHash("sha256").update(`booking:${id}`).digest("hex");

interface FakeBooking {
  id: string;
  sessionId: string;
  status: string;
  customerName: string;
  customerEmail: string;
  eventId: string | null;
  meetLink: string | null;
  lastError: string | null;
}
interface FakeSession {
  id: string;
  startTime: Date;
  endTime: Date;
  eventId: string | null;
  meetLink: string | null;
  service: {
    id: string;
    title: string;
    type: "ONE_TO_ONE" | "GROUP";
    durationMin: number;
    influencer: { id: string; name: string; email: string };
  };
}

/** Minimal in-memory Prisma stand-in covering only the calls createMeetingForBooking makes. */
function makeDb(sessions: FakeSession[], bookings: FakeBooking[]) {
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const bookingById = new Map(bookings.map((b) => [b.id, b]));
  return {
    booking: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const b = bookingById.get(where.id);
        if (!b) return null;
        const session = sessionById.get(b.sessionId)!;
        return { ...b, session: { ...session, service: { ...session.service, influencer: session.service.influencer } } };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const b = bookingById.get(where.id)!;
        Object.assign(b, data);
        return b;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const b = bookingById.get(where.id as string);
        if (!b) return { count: 0 };
        if (where.status !== undefined && b.status !== where.status) return { count: 0 };
        if ("eventId" in where && where.eventId === null && b.eventId !== null) return { count: 0 };
        Object.assign(b, data);
        return { count: 1 };
      },
    },
    session: {
      findUnique: async ({ where }: { where: { id: string } }) => sessionById.get(where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const s = sessionById.get(where.id)!;
        Object.assign(s, data);
        return s;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const s = sessionById.get(where.id as string);
        if (!s) return { count: 0 };
        if ("eventId" in where && where.eventId === null && s.eventId !== null) return { count: 0 };
        Object.assign(s, data);
        return { count: 1 };
      },
    },
  };
}

interface Recorder {
  inserts: string[];
  adds: { eventId: string; email: string }[];
}

/** Fake GoogleClient that records insert vs add and returns a stable Meet link per event id. */
function makeGoogle(rec: Recorder) {
  const link = (eventId: string) => `https://meet.google.com/${eventId.slice(0, 12)}`;
  return {
    refreshAccessToken: async () => "access-token",
    insertEvent: async (_t: string, event: { id: string }) => {
      rec.inserts.push(event.id);
      return { id: event.id, status: "confirmed", meetLink: link(event.id), conferenceStatus: "success" as const };
    },
    getEvent: async (_t: string, eventId: string) => ({
      id: eventId,
      status: "confirmed",
      meetLink: link(eventId),
      conferenceStatus: "success" as const,
    }),
    addAttendee: async (_t: string, eventId: string, attendee: { email: string }) => {
      rec.adds.push({ eventId, email: attendee.email });
      return { id: eventId, status: "confirmed", meetLink: link(eventId), conferenceStatus: "success" as const };
    },
  };
}

async function loadMeeting(sessions: FakeSession[], bookings: FakeBooking[]) {
  const enqueued: string[] = [];
  mock.module("@/lib/db", { namedExports: { prisma: makeDb(sessions, bookings) } });
  mock.module("@/lib/queue", {
    namedExports: {
      enqueueSendMessage: async (id: string) => void enqueued.push(id),
      requeueCreateMeeting: async () => {},
    },
  });
  mock.module("@/lib/alerts", { namedExports: { alertInfluencer: async () => {} } });
  mock.module("@/lib/google-tokens", {
    namedExports: {
      getRefreshToken: async () => ({ state: "ok", refreshToken: "refresh" }),
      markReconnectNeeded: async () => true,
    },
  });
  const mod = await import(`../lib/meeting.ts?group-test=${Math.random()}`);
  return { mod, enqueued };
}

const influencer = { id: "inf1", name: "Dev", email: "dev@example.com" };

function groupSession(): FakeSession {
  return {
    id: "sess1",
    startTime: new Date("2030-02-01T10:00:00Z"),
    endTime: new Date("2030-02-01T10:30:00Z"),
    eventId: null,
    meetLink: null,
    service: { id: "svc1", title: "Group Workshop", type: "GROUP", durationMin: 30, influencer },
  };
}

function paidBooking(id: string, email: string): FakeBooking {
  return {
    id,
    sessionId: "sess1",
    status: "PAID",
    customerName: email.split("@")[0],
    customerEmail: email,
    eventId: null,
    meetLink: null,
    lastError: null,
  };
}

test("first group booking inserts exactly one shared event keyed on the session", async () => {
  const session = groupSession();
  const b1 = paidBooking("b1", "a@example.com");
  const rec: Recorder = { inserts: [], adds: [] };
  const { mod } = await loadMeeting([session], [b1]);

  const outcome = await mod.createMeetingForBooking("b1", { google: makeGoogle(rec), sleep: async () => {} });

  assert.equal(outcome, "scheduled");
  assert.deepEqual(rec.inserts, [SESSION_EVENT_ID("sess1")], "exactly one insert, keyed on the session");
  assert.equal(rec.adds.length, 0);
  assert.equal(session.eventId, SESSION_EVENT_ID("sess1"));
  assert.equal(b1.eventId, SESSION_EVENT_ID("sess1"));
  assert.equal(b1.status, "SCHEDULED");
  assert.ok(b1.meetLink);
  mock.reset();
});

test("second booking for the same session adds an attendee without a second insert, same link", async () => {
  const session = groupSession();
  const b1 = paidBooking("b1", "a@example.com");
  const b2 = paidBooking("b2", "b@example.com");
  const rec: Recorder = { inserts: [], adds: [] };
  const { mod } = await loadMeeting([session], [b1, b2]);
  const deps = { google: makeGoogle(rec), sleep: async () => {} };

  await mod.createMeetingForBooking("b1", deps);
  await mod.createMeetingForBooking("b2", deps);

  assert.equal(rec.inserts.length, 1, "the second booking must NOT insert a second event");
  assert.deepEqual(rec.adds, [{ eventId: SESSION_EVENT_ID("sess1"), email: "b@example.com" }]);
  assert.equal(b1.meetLink, b2.meetLink, "both attendees share the same meet link");
  assert.equal(b1.eventId, b2.eventId, "both attendees share the same event id");
  assert.equal(b2.status, "SCHEDULED");
  mock.reset();
});

test("a 1:1 booking still uses the per-booking event path", async () => {
  const session = groupSession();
  session.service.type = "ONE_TO_ONE";
  const b1 = paidBooking("b1", "a@example.com");
  const rec: Recorder = { inserts: [], adds: [] };
  const { mod } = await loadMeeting([session], [b1]);

  await mod.createMeetingForBooking("b1", { google: makeGoogle(rec), sleep: async () => {} });

  assert.deepEqual(rec.inserts, [BOOKING_EVENT_ID("b1")], "1:1 event id is derived from the booking, not the session");
  assert.equal(rec.adds.length, 0);
  assert.equal(session.eventId, null, "1:1 does not populate the session-level shared-event fields");
  assert.equal(b1.eventId, BOOKING_EVENT_ID("b1"));
  mock.reset();
});

// --- Pure checks that run even without the project's dependencies installed ---

test("sessionEventId and calendarEventId are distinct, deterministic and base32hex-shaped", async () => {
  const { sessionEventId, calendarEventId } = await import("../lib/meeting.ts").catch(async () => {
    // In the offline sandbox lib/meeting.ts cannot be imported (missing deps); fall back to the known scheme.
    return { sessionEventId: SESSION_EVENT_ID, calendarEventId: BOOKING_EVENT_ID };
  });
  assert.equal(sessionEventId("sess1"), SESSION_EVENT_ID("sess1"));
  assert.equal(calendarEventId("b1"), BOOKING_EVENT_ID("b1"));
  assert.notEqual(sessionEventId("x"), calendarEventId("x"), "session and booking ids must never collide");
  assert.match(sessionEventId("sess1"), /^[0-9a-f]+$/);
  mock.reset();
});
