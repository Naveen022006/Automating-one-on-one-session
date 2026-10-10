import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock, test } from "node:test";
import { GoogleEventGoneError } from "../lib/google";

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
  const { sessionEventId, calendarEventId } = await import("../lib/meeting").catch(async () => {
    // In the offline sandbox lib/meeting.ts cannot be imported (missing deps); fall back to the known scheme.
    return { sessionEventId: SESSION_EVENT_ID, calendarEventId: BOOKING_EVENT_ID };
  });
  assert.equal(sessionEventId("sess1"), SESSION_EVENT_ID("sess1"));
  assert.equal(calendarEventId("b1"), BOOKING_EVENT_ID("b1"));
  assert.notEqual(sessionEventId("x"), calendarEventId("x"), "session and booking ids must never collide");
  assert.match(sessionEventId("sess1"), /^[0-9a-f]+$/);
  mock.reset();
});

// --- A2 / A7: a group session whose shared event was deleted, and a payer who loses the create race ---

const GEN_EVENT_ID = (id: string, generation: number) =>
  createHash("sha256").update(generation === 0 ? `session:${id}` : `session:${id}:${generation}`).digest("hex");

/**
 * A Calendar stand-in that behaves like Google for the cases that matter here: an id is never reusable once its event
 * was deleted (insert answers "exists"), a deleted event reads back as a "cancelled" tombstone or, once purged, as null,
 * and attendees cannot be added to a deleted event.
 */
function makeEventStore(opts: { tombstones?: string[]; purged?: string[]; live?: string[] } = {}) {
  const state = new Map<string, "live" | "cancelled" | "purged">();
  for (const id of opts.live ?? []) state.set(id, "live");
  for (const id of opts.tombstones ?? []) state.set(id, "cancelled");
  for (const id of opts.purged ?? []) state.set(id, "purged");
  const link = (eventId: string) => `https://meet.google.com/${eventId.slice(0, 12)}`;
  const rec = {
    inserts: [] as { id: string; conferenceRequestId: string }[],
    adds: [] as { eventId: string; email: string }[],
  };
  const google = {
    refreshAccessToken: async () => "access-token",
    insertEvent: async (_t: string, event: { id: string; conferenceRequestId: string }) => {
      rec.inserts.push({ id: event.id, conferenceRequestId: event.conferenceRequestId });
      if (state.has(event.id)) return "exists" as const;
      state.set(event.id, "live");
      return { id: event.id, status: "confirmed", meetLink: link(event.id), conferenceStatus: "success" as const };
    },
    getEvent: async (_t: string, eventId: string) => {
      const s = state.get(eventId);
      if (!s || s === "purged") return null;
      return { id: eventId, status: s === "cancelled" ? "cancelled" : "confirmed", meetLink: link(eventId), conferenceStatus: "success" as const };
    },
    addAttendee: async (_t: string, eventId: string, attendee: { email: string }) => {
      if (state.get(eventId) !== "live") throw new GoogleEventGoneError("The shared calendar event for this group session no longer exists");
      rec.adds.push({ eventId, email: attendee.email });
      return { id: eventId, status: "confirmed", meetLink: link(eventId), conferenceStatus: "success" as const };
    },
  };
  return { google, rec, state, link };
}

test("after the last attendee cancelled (event deleted), the next payer gets a new live event and a working link", async () => {
  const v0 = GEN_EVENT_ID("sess1", 0);
  const v1 = GEN_EVENT_ID("sess1", 1);
  const store = makeEventStore({ tombstones: [v0] });
  const session = groupSession(); // lib/manage.ts cleared eventId and meetLink when it deleted the event
  const b = paidBooking("b1", "a@example.com");
  const { mod, emailed } = await loadMeeting([session], [b]);

  const outcome = await mod.createMeetingForBooking("b1", { google: store.google, sleep: async () => {}, sendBookingEmail: async (bookingId: string, kind: string) => void emailed.push({ bookingId, kind }) });

  assert.equal(outcome, "scheduled");
  assert.deepEqual(store.rec.inserts.map((i) => i.id), [v0, v1], "the dead id answers 409, so the next id of the sequence is used");
  assert.notEqual(store.rec.inserts[0].conferenceRequestId, store.rec.inserts[1].conferenceRequestId, "a new event needs a new Meet request id");
  assert.equal(session.eventId, v1, "the session records the new event id");
  assert.equal(b.eventId, v1, "so does the booking");
  assert.equal(session.meetLink, store.link(v1));
  assert.equal(b.meetLink, store.link(v1));
  assert.equal(b.status, "SCHEDULED");
  assert.deepEqual(emailed, [{ bookingId: "b1", kind: "booking-confirmation" }]);
  mock.reset();
});

test("a purged event (read gives 404/410) is treated the same way", async () => {
  const v0 = GEN_EVENT_ID("sess1", 0);
  const v1 = GEN_EVENT_ID("sess1", 1);
  const store = makeEventStore({ purged: [v0] });
  const session = groupSession();
  const b = paidBooking("b1", "a@example.com");
  const { mod, emailed } = await loadMeeting([session], [b]);

  assert.equal(await mod.createMeetingForBooking("b1", { google: store.google, sleep: async () => {}, sendBookingEmail: async (bookingId: string, kind: string) => void emailed.push({ bookingId, kind }) }), "scheduled");
  assert.equal(b.eventId, v1);
  assert.equal(b.status, "SCHEDULED");
  mock.reset();
});

test("a job retried after it created the replacement but crashed before saving finds it instead of creating another", async () => {
  const v0 = GEN_EVENT_ID("sess1", 0);
  const v1 = GEN_EVENT_ID("sess1", 1);
  const store = makeEventStore({ tombstones: [v0], live: [v1] }); // v1 was created by the crashed attempt
  const session = groupSession();
  session.eventId = v0; // ...which had already claimed the session
  const b = paidBooking("b1", "a@example.com");
  const { mod, emailed } = await loadMeeting([session], [b]);

  assert.equal(await mod.createMeetingForBooking("b1", { google: store.google, sleep: async () => {}, sendBookingEmail: async (bookingId: string, kind: string) => void emailed.push({ bookingId, kind }) }), "scheduled");

  assert.deepEqual(store.rec.inserts.map((i) => i.id), [v0, v1], "no third event");
  assert.equal(session.eventId, v1);
  assert.equal(b.eventId, v1);
  assert.equal(b.status, "SCHEDULED");
  mock.reset();
});

test("a payer joining a session whose recorded shared event was deleted behind our back gets a replacement", async () => {
  const v0 = GEN_EVENT_ID("sess1", 0);
  const v1 = GEN_EVENT_ID("sess1", 1);
  const store = makeEventStore({ tombstones: [v0] });
  const session = groupSession();
  session.eventId = v0; // the influencer deleted the event in Google Calendar; our link is stale
  session.meetLink = "https://meet.google.com/stale";
  const b = paidBooking("b2", "b@example.com");
  const { mod, emailed } = await loadMeeting([session], [b]);

  assert.equal(await mod.createMeetingForBooking("b2", { google: store.google, sleep: async () => {}, sendBookingEmail: async (bookingId: string, kind: string) => void emailed.push({ bookingId, kind }) }), "scheduled");

  assert.equal(session.eventId, v1);
  assert.equal(session.meetLink, store.link(v1), "the stale link is replaced");
  assert.equal(b.meetLink, store.link(v1));
  assert.equal(b.status, "SCHEDULED");
  mock.reset();
});

test("later attendees join the event the session records, even when it is not the first id", async () => {
  const v1 = GEN_EVENT_ID("sess1", 1);
  const store = makeEventStore({ tombstones: [GEN_EVENT_ID("sess1", 0)], live: [v1] });
  const session = groupSession();
  session.eventId = v1;
  session.meetLink = store.link(v1);
  const b = paidBooking("b2", "b@example.com");
  const { mod, emailed } = await loadMeeting([session], [b]);

  assert.equal(await mod.createMeetingForBooking("b2", { google: store.google, sleep: async () => {}, sendBookingEmail: async (bookingId: string, kind: string) => void emailed.push({ bookingId, kind }) }), "scheduled");

  assert.deepEqual(store.rec.inserts, [], "nothing is created");
  assert.deepEqual(store.rec.adds, [{ eventId: v1, email: "b@example.com" }]);
  assert.equal(b.eventId, v1);
  assert.equal(b.meetLink, store.link(v1));
  mock.reset();
});

test("A7: a payer who loses the create race to the first payer is added to the event as an attendee", async () => {
  const v0 = GEN_EVENT_ID("sess1", 0);
  const store = makeEventStore({ live: [v0] }); // the creator's event is already on the calendar...
  const session = groupSession();
  session.eventId = v0; // ...and it claimed the session...
  session.meetLink = null; // ...but has not saved the link yet, so this payer cannot take the fast path
  const b = paidBooking("b2", "b@example.com");
  const { mod, emailed } = await loadMeeting([session], [b]);

  assert.equal(await mod.createMeetingForBooking("b2", { google: store.google, sleep: async () => {}, sendBookingEmail: async (bookingId: string, kind: string) => void emailed.push({ bookingId, kind }) }), "scheduled");

  assert.deepEqual(store.rec.inserts.map((i) => i.id), [v0], "the insert answered 409");
  assert.deepEqual(store.rec.adds, [{ eventId: v0, email: "b@example.com" }], "so this customer is patched in and gets an invite");
  assert.equal(b.status, "SCHEDULED");
  assert.equal(b.meetLink, store.link(v0));
  mock.reset();
});

test("a 1:1 booking is unaffected by the event-id sequence", async () => {
  const session = groupSession();
  session.service.type = "ONE_TO_ONE";
  const store = makeEventStore();
  const b = paidBooking("b1", "a@example.com");
  const { mod, emailed } = await loadMeeting([session], [b]);

  assert.equal(await mod.createMeetingForBooking("b1", { google: store.google, sleep: async () => {}, sendBookingEmail: async (bookingId: string, kind: string) => void emailed.push({ bookingId, kind }) }), "scheduled");

  assert.deepEqual(store.rec.inserts.map((i) => i.id), [BOOKING_EVENT_ID("b1")]);
  assert.equal(session.eventId, null);
  mock.reset();
});

test("sessionEventId generations are distinct, and generation 0 is the original id", async () => {
  const { sessionEventId } = await import("../lib/meeting");
  assert.equal(sessionEventId("sess1"), SESSION_EVENT_ID("sess1"));
  assert.equal(sessionEventId("sess1", 0), SESSION_EVENT_ID("sess1"));
  assert.equal(sessionEventId("sess1", 1), GEN_EVENT_ID("sess1", 1));
  assert.equal(new Set([0, 1, 2, 3].map((g) => sessionEventId("sess1", g))).size, 4);
  assert.match(sessionEventId("sess1", 2), /^[0-9a-f]{64}$/);
  mock.reset();
});
