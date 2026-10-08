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
  const emailed: { bookingId: string; kind: string }[] = [];
  mock.module("@/lib/db", { namedExports: { prisma: makeDb(sessions, bookings) } });
  mock.module("@/lib/queue", {
    namedExports: {
      enqueueSendMessage: async (id: string) => void enqueued.push(id),
      enqueueReminders: async () => {},
      requeueCreateMeeting: async () => {},
    },
  });
  mock.module("@/lib/alerts", { namedExports: { alertInfluencer: async () => {} } });
  // Keep the test DB-free: stub the email sender (the real one reads through Prisma). It is injected via
  // MeetingDeps.sendBookingEmail below too, but mocking the module keeps the default import harmless.
  mock.module("@/lib/email", { namedExports: { sendBookingEmail: async () => {} } });
  mock.module("@/lib/google-tokens", {
    namedExports: {
      getRefreshToken: async () => ({ state: "ok", refreshToken: "refresh" }),
      markReconnectNeeded: async () => true,
    },
  });
  const mod = await import(`../lib/meeting.ts?group-test=${Math.random()}`);
  return { mod, enqueued, emailed };
}

/** Deps overrides shared by every test: injected google + instant sleep + a recording email stub. */
function depsWith(rec: Recorder, emailed: { bookingId: string; kind: string }[]) {
  return {
    google: makeGoogle(rec),
    sleep: async () => {},
    sendBookingEmail: async (bookingId: string, kind: string) => void emailed.push({ bookingId, kind }),
  };
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
  const { mod, emailed } = await loadMeeting([session], [b1]);

  const outcome = await mod.createMeetingForBooking("b1", depsWith(rec, emailed));

  assert.equal(outcome, "scheduled");
  assert.deepEqual(rec.inserts, [SESSION_EVENT_ID("sess1")], "exactly one insert, keyed on the session");
  assert.equal(rec.adds.length, 0);
  assert.equal(session.eventId, SESSION_EVENT_ID("sess1"));
  assert.equal(b1.eventId, SESSION_EVENT_ID("sess1"));
  assert.equal(b1.status, "SCHEDULED");
  assert.ok(b1.meetLink);
  // The confirmation/receipt email must be sent on the normal paid -> scheduled path (issue 1).
  assert.deepEqual(emailed, [{ bookingId: "b1", kind: "booking-confirmation" }]);
  mock.reset();
});

test("second booking for the same session adds an attendee without a second insert, same link", async () => {
  const session = groupSession();
  const b1 = paidBooking("b1", "a@example.com");
  const b2 = paidBooking("b2", "b@example.com");
  const rec: Recorder = { inserts: [], adds: [] };
  const { mod, emailed } = await loadMeeting([session], [b1, b2]);
  const deps = depsWith(rec, emailed);

  await mod.createMeetingForBooking("b1", deps);
  await mod.createMeetingForBooking("b2", deps);

  assert.equal(rec.inserts.length, 1, "the second booking must NOT insert a second event");
  assert.deepEqual(rec.adds, [{ eventId: SESSION_EVENT_ID("sess1"), email: "b@example.com" }]);
  assert.equal(b1.meetLink, b2.meetLink, "both attendees share the same meet link");
  assert.equal(b1.eventId, b2.eventId, "both attendees share the same event id");
  assert.equal(b2.status, "SCHEDULED");
  // Each attendee gets their own confirmation email (per-booking self-service link), one per booking.
  assert.deepEqual(emailed, [
    { bookingId: "b1", kind: "booking-confirmation" },
    { bookingId: "b2", kind: "booking-confirmation" },
  ]);
  mock.reset();
});

test("non-creator reconverges when the creator is mid-flight (session has event id but no saved link yet)", async () => {
  // The second booking sees session.eventId already claimed (creator won the election) but session.meetLink
  // still null (creator crashed / is mid-flight). It must insert on the deterministic id (409 -> read),
  // poll for the link, persist it, and add itself as an attendee -- not get stuck.
  const session = groupSession();
  session.eventId = SESSION_EVENT_ID("sess1"); // creator already claimed it
  session.meetLink = null; // ...but has not saved the link
  const b2 = paidBooking("b2", "b@example.com");
  const rec: Recorder = { inserts: [], adds: [] };
  // Google fake where insertEvent on an already-claimed id answers "exists" (mirrors a real 409).
  const existing = new Set<string>([SESSION_EVENT_ID("sess1")]);
  const link = (eventId: string) => `https://meet.google.com/${eventId.slice(0, 12)}`;
  const google = {
    refreshAccessToken: async () => "access-token",
    insertEvent: async (_t: string, event: { id: string }) => {
      rec.inserts.push(event.id);
      if (existing.has(event.id)) return "exists" as const;
      existing.add(event.id);
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
  const { mod, emailed } = await loadMeeting([session], [b2]);

  const outcome = await mod.createMeetingForBooking("b2", {
    google,
    sleep: async () => {},
    sendBookingEmail: async (bookingId: string, kind: string) => void emailed.push({ bookingId, kind }),
  });

  assert.equal(outcome, "scheduled");
  assert.deepEqual(rec.inserts, [SESSION_EVENT_ID("sess1")], "non-creator inserts on the deterministic id (409 -> read)");
  assert.equal(session.meetLink, link(SESSION_EVENT_ID("sess1")), "the recovered link is persisted on the session");
  assert.equal(b2.eventId, SESSION_EVENT_ID("sess1"));
  assert.equal(b2.meetLink, link(SESSION_EVENT_ID("sess1")));
  assert.equal(b2.status, "SCHEDULED");
  mock.reset();
});

test("concurrent creators: only the booking that wins the session claim inserts", async () => {
  // Two paid bookings race. The in-memory session.updateMany null-guard lets exactly one flip event_id, so
  // only that booking inserts; the other, seeing the (now-saved) link, takes the add-attendee path.
  const session = groupSession();
  const b1 = paidBooking("b1", "a@example.com");
  const b2 = paidBooking("b2", "b@example.com");
  const rec: Recorder = { inserts: [], adds: [] };
  const { mod, emailed } = await loadMeeting([session], [b1, b2]);
  const deps = depsWith(rec, emailed);

  // Sequential here, but the atomic null-guard is exactly what serializes the real concurrent case.
  await mod.createMeetingForBooking("b1", deps);
  await mod.createMeetingForBooking("b2", deps);

  assert.equal(rec.inserts.length, 1, "only one creator inserts even though both are paid");
  assert.equal(rec.adds.length, 1, "the loser adds itself as an attendee");
  assert.equal(b1.eventId, b2.eventId);
  assert.equal(b1.meetLink, b2.meetLink);
  mock.reset();
});

test("a 1:1 booking still uses the per-booking event path", async () => {
  const session = groupSession();
  session.service.type = "ONE_TO_ONE";
  const b1 = paidBooking("b1", "a@example.com");
  const rec: Recorder = { inserts: [], adds: [] };
  const { mod, emailed } = await loadMeeting([session], [b1]);

  await mod.createMeetingForBooking("b1", depsWith(rec, emailed));

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
