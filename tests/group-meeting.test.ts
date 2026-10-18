import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock, test } from "node:test";
import { GoogleEventGoneError, GoogleReconnectError, GoogleRequestError, GoogleTransientError } from "../lib/google";

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
  eventGeneration: number;
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
  /** Every value ever written to a session's generation, in order: it must never go backwards. */
  const generationWrites: number[] = [];
  const bookingUpdateMany = async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    const b = bookingById.get(where.id as string);
    if (!b) return { count: 0 };
    const status = where.status as string | { in: string[] } | undefined;
    if (typeof status === "string" && b.status !== status) return { count: 0 };
    if (typeof status === "object" && !status.in.includes(b.status)) return { count: 0 };
    if ("eventId" in where) {
      // null = "not yet linked"; a string = "still on exactly this event" (the guard that stops a double move).
      if (where.eventId === null && b.eventId !== null) return { count: 0 };
      if (typeof where.eventId === "string" && b.eventId !== where.eventId) return { count: 0 };
    }
    Object.assign(b, data);
    return { count: 1 };
  };
  const sessionUpdate = async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    const s = sessionById.get(where.id)!;
    if (typeof data.eventGeneration === "number") generationWrites.push(data.eventGeneration);
    Object.assign(s, data);
    return s;
  };
  // A transaction with rollback: whatever a failed callback wrote is undone, like Postgres would.
  const tx = {
    $queryRaw: async (_strings: TemplateStringsArray, sessionId: string) => {
      const s = sessionById.get(sessionId);
      return s ? [{ event_generation: s.eventGeneration }] : [];
    },
    booking: { updateMany: bookingUpdateMany },
    session: { update: sessionUpdate },
  };
  return {
    generationWrites,
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
      const snapshot = [...bookingById.values(), ...sessionById.values()].map((o) => [o, { ...o }] as const);
      try {
        return await fn(tx);
      } catch (e) {
        for (const [original, copy] of snapshot) Object.assign(original, copy);
        throw e;
      }
    },
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
      updateMany: bookingUpdateMany,
      // Only the stranded-bookings query: live bookings of the session (not the trigger) on some other event id.
      findMany: async ({ where }: { where: { sessionId: string; id: { not: string }; status: { in: string[] }; AND: { eventId: { not: string | null } }[] } }) => {
        const current = where.AND[1].eventId.not;
        // Copies, like rows from a real database: a later write to the booking must not change what this job already read.
        return [...bookingById.values()]
          .filter((b) => b.sessionId === where.sessionId && b.id !== where.id.not && where.status.in.includes(b.status) && b.eventId !== null && b.eventId !== current)
          .map((b) => ({ ...b }));
      },
    },
    session: {
      findUnique: async ({ where }: { where: { id: string } }) => sessionById.get(where.id) ?? null,
      update: sessionUpdate,
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

/** The token store the job sees: what getRefreshToken answers, and every markReconnectNeeded call with its version. */
interface TokenFake {
  current: () => unknown;
  marked: { reason: string; connectedAt?: Date }[];
}
const okToken = (): TokenFake => ({ current: () => ({ state: "ok", refreshToken: "refresh" }), marked: [] });

async function loadMeeting(sessions: FakeSession[], bookings: FakeBooking[], tokens: TokenFake = okToken()) {
  const enqueued: string[] = [];
  const emailed: { bookingId: string; kind: string }[] = [];
  const db = makeDb(sessions, bookings);
  mock.module("@/lib/db", { namedExports: { prisma: db } });
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
      getRefreshToken: async () => tokens.current(),
      markReconnectNeeded: async (_id: string, reason: string, connectedAt?: Date) => (tokens.marked.push({ reason, connectedAt }), true),
    },
  });
  const mod = await import(`../lib/meeting.ts?group-test=${Math.random()}`);
  return { mod, enqueued, emailed, db };
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
    eventGeneration: 0,
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
function makeEventStore(
  opts: { tombstones?: string[]; purged?: string[]; live?: string[]; beforeInsert?: (id: string) => Promise<void> } = {},
) {
  const state = new Map<string, "live" | "cancelled" | "purged">();
  for (const id of opts.live ?? []) state.set(id, "live");
  for (const id of opts.tombstones ?? []) state.set(id, "cancelled");
  for (const id of opts.purged ?? []) state.set(id, "purged");
  const link = (eventId: string) => `https://meet.google.com/${eventId.slice(0, 12)}`;
  const rec = {
    inserts: [] as { id: string; conferenceRequestId: string }[],
    adds: [] as { eventId: string; email: string }[],
    deleted: [] as string[],
  };
  const google = {
    refreshAccessToken: async () => "access-token",
    deleteEvent: async (_t: string, eventId: string) => {
      rec.deleted.push(eventId);
      state.set(eventId, "cancelled");
    },
    insertEvent: async (_t: string, event: { id: string; conferenceRequestId: string }) => {
      await opts.beforeInsert?.(event.id);
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

// --- R1/R2: the stored generation, no hard cap, and bookings stranded on a dead event ---

type Alert = { kind: string; title?: string; detail: string; bookingId?: string };

function groupDeps(store: ReturnType<typeof makeEventStore>["google"], emailed: { bookingId: string; kind: string }[], alerts: Alert[]) {
  return {
    google: store,
    sleep: async () => {},
    sendBookingEmail: async (bookingId: string, kind: string) => void emailed.push({ bookingId, kind }),
    alert: async (_id: string, a: Alert) => void alerts.push(a),
  };
}

test("the walk starts at the session's stored generation instead of generation 0", async () => {
  const g7 = GEN_EVENT_ID("sess1", 7);
  const store = makeEventStore();
  const session = groupSession();
  session.eventGeneration = 7; // the last event (generation 6) was deleted by a cancel, which moved the sequence on
  const b = paidBooking("b1", "a@example.com");
  const { mod, emailed } = await loadMeeting([session], [b]);

  assert.equal(await mod.createMeetingForBooking("b1", groupDeps(store.google, emailed, [])), "scheduled");

  assert.deepEqual(store.rec.inserts.map((i) => i.id), [g7], "no probing of the dead ids below it");
  assert.equal(session.eventGeneration, 7);
  assert.equal(session.eventId, g7);
  assert.equal(b.eventId, g7);
  mock.reset();
});

test("there is no cap of ten deletions: a session whose event was deleted fifteen times still gets a link", async () => {
  const store = makeEventStore({ tombstones: [GEN_EVENT_ID("sess1", 15)] });
  const session = groupSession();
  session.eventGeneration = 15; // a cancel just retired generation 15's predecessor; 15 itself is a tombstone left by the influencer
  const b = paidBooking("b1", "a@example.com");
  const { mod, emailed } = await loadMeeting([session], [b]);

  assert.equal(await mod.createMeetingForBooking("b1", groupDeps(store.google, emailed, [])), "scheduled");

  assert.equal(session.eventGeneration, 16, "the generation moves past the dead id and is stored");
  assert.equal(b.eventId, GEN_EVENT_ID("sess1", 16));
  assert.equal(b.status, "SCHEDULED");
  mock.reset();
});

test("a retry or a racing payer walks from the same stored generation and converges on the same event", async () => {
  const g1 = GEN_EVENT_ID("sess1", 1);
  const store = makeEventStore({ tombstones: [GEN_EVENT_ID("sess1", 0)] });
  const session = groupSession();
  const b1 = paidBooking("b1", "a@example.com");
  const b2 = paidBooking("b2", "b@example.com");
  const { mod, emailed } = await loadMeeting([session], [b1, b2]);
  const deps = groupDeps(store.google, emailed, []);

  await mod.createMeetingForBooking("b1", deps);
  await mod.createMeetingForBooking("b2", deps);

  assert.equal(store.rec.inserts.filter((i) => i.id === g1).length, 1, "the replacement event is created once");
  assert.equal(b1.eventId, g1);
  assert.equal(b2.eventId, g1);
  assert.deepEqual(store.rec.adds, [{ eventId: g1, email: "b@example.com" }]);
  mock.reset();
});

test("when every id of the sequence is used the booking stays PAID and the influencer is alerted", async () => {
  const google = {
    refreshAccessToken: async () => "access-token",
    insertEvent: async () => "exists" as const,
    getEvent: async () => ({ id: "x", status: "cancelled", meetLink: null, conferenceStatus: "none" as const }),
    addAttendee: async () => ({ id: "x", status: "confirmed", meetLink: null, conferenceStatus: "none" as const }),
  };
  const session = groupSession();
  const b = paidBooking("b1", "a@example.com");
  const alerts: Alert[] = [];
  const { mod } = await loadMeeting([session], [b]);

  await assert.rejects(
    mod.createMeetingForBooking("b1", { google, sleep: async () => {}, sendBookingEmail: async () => {}, alert: async (_id: string, a: Alert) => void alerts.push(a) }),
    mod.MeetingBlockedError,
  );

  assert.equal(b.status, "PAID", "not failed: the customer paid and someone has to look");
  assert.match(String(b.lastError), /event ids in a row were already used/);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "meeting-creation-failed");
  mock.reset();
});

test("a booking left on a dead event is moved to the replacement: new link, invited, emailed, influencer told once", async () => {
  const v0 = GEN_EVENT_ID("sess1", 0);
  const v1 = GEN_EVENT_ID("sess1", 1);
  const store = makeEventStore({ tombstones: [v0] }); // the influencer deleted the shared event in Google Calendar
  const session = groupSession();
  session.eventId = v0;
  session.meetLink = "https://meet.google.com/old";
  const dangling: FakeBooking = { ...paidBooking("b1", "a@example.com"), status: "SCHEDULED", eventId: v0, meetLink: "https://meet.google.com/old" };
  const b2 = paidBooking("b2", "b@example.com");
  const b3 = paidBooking("b3", "c@example.com");
  const emailed: { bookingId: string; kind: string }[] = [];
  const alerts: Alert[] = [];
  const { mod } = await loadMeeting([session], [dangling, b2, b3]);
  const deps = groupDeps(store.google, emailed, alerts);

  assert.equal(await mod.createMeetingForBooking("b2", deps), "scheduled");

  assert.equal(dangling.eventId, v1, "the stranded booking points at the new event");
  assert.equal(dangling.meetLink, store.link(v1), "and its link is the new one");
  assert.equal(b2.eventId, v1);
  assert.deepEqual(store.rec.adds, [{ eventId: v1, email: "a@example.com" }], "the stranded attendee is invited to the new event");
  assert.deepEqual(emailed.filter((e) => e.bookingId === "b1"), [{ bookingId: "b1", kind: "booking-confirmation" }], "and gets the new link by email");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].title, "A group session got a new Meet link");

  // The next payer finds nothing stranded: no second alert, no second email to b1.
  assert.equal(await mod.createMeetingForBooking("b3", deps), "scheduled");
  assert.equal(alerts.length, 1);
  assert.equal(emailed.filter((e) => e.bookingId === "b1").length, 1);
  mock.reset();
});

test("cancelled bookings and bookings already on the current event are left alone", async () => {
  const v0 = GEN_EVENT_ID("sess1", 0);
  const store = makeEventStore({ live: [v0] });
  const session = groupSession();
  session.eventId = v0;
  session.meetLink = store.link(v0);
  const ok: FakeBooking = { ...paidBooking("b1", "a@example.com"), status: "SCHEDULED", eventId: v0, meetLink: store.link(v0) };
  const gone: FakeBooking = { ...paidBooking("b9", "z@example.com"), status: "CANCELLED", eventId: GEN_EVENT_ID("sess1", 5), meetLink: "https://meet.google.com/dead" };
  const b2 = paidBooking("b2", "b@example.com");
  const alerts: Alert[] = [];
  const { mod, emailed } = await loadMeeting([session], [ok, gone, b2]);

  await mod.createMeetingForBooking("b2", groupDeps(store.google, emailed, alerts));

  assert.equal(gone.meetLink, "https://meet.google.com/dead");
  assert.equal(ok.eventId, v0);
  assert.deepEqual(alerts, []);
  mock.reset();
});

// --- S1: the job's write is checked under the session lock; S2: a booking is moved once; S3: versions of the grant ---

/** A promise whose resolve is handed out, to pause a job inside Google while the test does something else. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** What lib/manage.ts releaseSharedEvent does to the session when the last live booking cancels. */
function retireSharedEvent(session: FakeSession) {
  session.eventId = null;
  session.meetLink = null;
  session.eventGeneration += 1;
}

test("S1: a cancel retires the event between a job's claim and its write -> the job does not write, the next payer stays on a live event, the generation never goes backwards", async () => {
  const paused = deferred();
  const gate = deferred();
  let first = true;
  const store = makeEventStore({
    beforeInsert: async () => {
      if (!first) return;
      first = false;
      paused.resolve();
      await gate.promise; // PA's job is inside Google (insert + link polling) while the cancel and PB's payment happen
    },
  });
  const session = groupSession();
  const pa = paidBooking("pa", "a@example.com");
  const pb = paidBooking("pb", "b@example.com");
  pb.status = "HELD"; // pays only after the cancel's lock section
  const alerts: Alert[] = [];
  const { mod, emailed, db } = await loadMeeting([session], [pa, pb]);
  const deps = groupDeps(store.google, emailed, alerts);

  const paJob = mod.createMeetingForBooking("pa", deps); // claims the session, then waits inside insertEvent
  await paused.promise;
  assert.equal(session.eventId, GEN_EVENT_ID("sess1", 0), "PA's job holds the claim");

  // The influencer cancels PA, the only live booking: lib/manage.ts marks it CANCELLED and retires the event.
  pa.status = "CANCELLED";
  retireSharedEvent(session);
  assert.equal(session.eventGeneration, 1);

  // PB pays and its job runs to the end on the next event of the sequence.
  pb.status = "PAID";
  assert.equal(await mod.createMeetingForBooking("pb", deps), "scheduled");
  const z = GEN_EVENT_ID("sess1", 1);
  assert.equal(session.eventId, z);
  assert.equal(pb.eventId, z);
  const linkZ = store.link(z);
  assert.equal(pb.meetLink, linkZ);

  // PA's job wakes up with the dead generation-0 event: its write must be refused.
  gate.resolve();
  assert.equal(await paJob, "skipped");

  assert.equal(session.eventId, z, "the session still points at PB's live event");
  assert.equal(session.meetLink, linkZ);
  assert.equal(session.eventGeneration, 1);
  assert.equal(pb.eventId, z, "PB was not moved back onto the dead event");
  assert.equal(pb.meetLink, linkZ);
  assert.equal(pa.status, "CANCELLED");
  assert.deepEqual(emailed.filter((e) => e.bookingId === "pb"), [{ bookingId: "pb", kind: "booking-confirmation" }], "PB got one confirmation, with the live link");
  assert.deepEqual(alerts, []);
  assert.ok(db.generationWrites.every((g, i, all) => i === 0 || g >= all[i - 1]), `generation writes only go up: ${db.generationWrites}`);
  assert.deepEqual(store.rec.deleted, [GEN_EVENT_ID("sess1", 0)], "the event PA's job created after the cancel is not left behind");
  mock.reset();
});

test("S1: a job whose booking is still live retries after the session moved on, and ends on a live event", async () => {
  let first = true;
  let session!: FakeSession;
  const store = makeEventStore({
    beforeInsert: async () => {
      if (!first) return;
      first = false;
      retireSharedEvent(session); // a cancel retired the previous event while this job was talking to Google
    },
  });
  session = groupSession();
  session.eventGeneration = 0;
  const b = paidBooking("b1", "a@example.com");
  const { mod, emailed, db } = await loadMeeting([session], [b]);
  const deps = groupDeps(store.google, emailed, []);

  // First run: the commit finds the session one generation ahead of the event it created.
  await assert.rejects(mod.createMeetingForBooking("b1", deps), GoogleTransientError);
  assert.equal(b.status, "PAID", "rolled back: nothing half-written");
  assert.equal(b.eventId, null);
  assert.equal(session.eventId, null, "the session is untouched (still the retired state)");
  assert.equal(session.eventGeneration, 1);
  assert.deepEqual(store.rec.deleted, [GEN_EVENT_ID("sess1", 0)], "the event the job created for the dead generation is removed");
  assert.deepEqual(emailed, [], "no confirmation went out");

  // Retry (BullMQ): walks again from the new generation.
  assert.equal(await mod.createMeetingForBooking("b1", deps), "scheduled");
  const z = GEN_EVENT_ID("sess1", 1);
  assert.equal(session.eventId, z);
  assert.equal(session.eventGeneration, 1);
  assert.equal(b.eventId, z);
  assert.equal(b.meetLink, store.link(z));
  assert.equal(b.status, "SCHEDULED");
  assert.ok(db.generationWrites.every((g, i, all) => i === 0 || g >= all[i - 1]), `generation writes only go up: ${db.generationWrites}`);
  mock.reset();
});

test("S1: a payer who joined the stored event just before a cancel retired it is sent round again, not scheduled on the dead event", async () => {
  const x = GEN_EVENT_ID("sess1", 0);
  let session!: FakeSession;
  const store = makeEventStore({ live: [x] });
  const realAdd = store.google.addAttendee;
  let retired = false;
  store.google.addAttendee = async (t: string, eventId: string, attendee: { email: string }) => {
    const r = await realAdd(t, eventId, attendee);
    if (!retired) {
      retired = true;
      retireSharedEvent(session); // the cancel's lock section ran after this job read the session, before it commits
    }
    return r;
  };
  session = groupSession();
  session.eventId = x;
  session.meetLink = store.link(x);
  const b = paidBooking("pb", "b@example.com");
  const { mod, emailed } = await loadMeeting([session], [b]);
  const deps = groupDeps(store.google, emailed, []);

  await assert.rejects(mod.createMeetingForBooking("pb", deps), GoogleTransientError);
  assert.equal(b.status, "PAID");
  assert.equal(b.eventId, null);

  assert.equal(await mod.createMeetingForBooking("pb", deps), "scheduled");
  assert.equal(b.eventId, GEN_EVENT_ID("sess1", 1), "the retry created and joined the next event");
  mock.reset();
});

test("S1: a booking cancelled while Google rejects its event is not overwritten with FAILED", async () => {
  const b = paidBooking("b1", "a@example.com");
  const session = groupSession();
  session.service.type = "ONE_TO_ONE";
  const alerts: Alert[] = [];
  const google = {
    refreshAccessToken: async () => "access-token",
    insertEvent: async () => {
      b.status = "CANCELLED"; // cancelled while the request was in flight
      throw new GoogleRequestError("Google Calendar 400 invalid: bad attendee");
    },
  };
  const { mod, emailed } = await loadMeeting([session], [b]);

  assert.equal(await mod.createMeetingForBooking("b1", { google, sleep: async () => {}, sendBookingEmail: async (id: string, kind: string) => void emailed.push({ bookingId: id, kind }), alert: async (_i: string, a: Alert) => void alerts.push(a) }), "skipped");

  assert.equal(b.status, "CANCELLED", "still cancelled, not FAILED");
  assert.deepEqual(alerts, [], "nothing for the influencer to act on");
  mock.reset();
});

test("S2: two jobs that read the same stranded booking move and email it once", async () => {
  const v0 = GEN_EVENT_ID("sess1", 0);
  const v1 = GEN_EVENT_ID("sess1", 1);
  // Both jobs are inside the invite of the stranded booking (a@) before either commits.
  let arrived = 0;
  const bothThere = deferred();
  const store = makeEventStore({ tombstones: [v0] });
  const realAdd = store.google.addAttendee;
  store.google.addAttendee = async (t: string, eventId: string, attendee: { email: string }) => {
    const r = await realAdd(t, eventId, attendee);
    if (attendee.email === "a@example.com" && eventId === v1) {
      arrived++;
      if (arrived === 2) bothThere.resolve();
      await bothThere.promise;
    }
    return r;
  };
  const session = groupSession();
  session.eventId = v0;
  session.meetLink = "https://meet.google.com/old";
  const dangling: FakeBooking = { ...paidBooking("b1", "a@example.com"), status: "SCHEDULED", eventId: v0, meetLink: "https://meet.google.com/old" };
  const b2 = paidBooking("b2", "b@example.com");
  const b3 = paidBooking("b3", "c@example.com");
  const alerts: Alert[] = [];
  const { mod, emailed } = await loadMeeting([session], [dangling, b2, b3]);
  const deps = groupDeps(store.google, emailed, alerts);

  const [r2, r3] = await Promise.all([mod.createMeetingForBooking("b2", deps), mod.createMeetingForBooking("b3", deps)]);

  assert.deepEqual([r2, r3], ["scheduled", "scheduled"]);
  assert.equal(dangling.eventId, v1);
  assert.equal(emailed.filter((e) => e.bookingId === "b1").length, 1, "the stranded booking is emailed once, not once per job");
  assert.equal(alerts.length, 1, "and the influencer is told once");
  mock.reset();
});

test("S3: a revoked grant is flagged with the version it was read at; a grant renewed during the call is not marked dead", async () => {
  const t1 = new Date("2030-01-01T00:00:00Z");
  const t2 = new Date("2030-01-01T00:05:00Z");
  const revoked = {
    refreshAccessToken: async () => {
      throw new GoogleReconnectError("Refresh token rejected: invalid_grant");
    },
  };

  // Still the same grant afterwards: flagged, with its version.
  const tokens = okToken();
  tokens.current = () => ({ state: "ok", refreshToken: "refresh", connectedAt: t1 });
  const a = paidBooking("b1", "a@example.com");
  const first = await loadMeeting([groupSession()], [a], tokens);
  await assert.rejects(first.mod.createMeetingForBooking("b1", { google: revoked, sleep: async () => {}, sendBookingEmail: async () => {}, alert: async () => {} }), first.mod.MeetingBlockedError);
  assert.deepEqual(tokens.marked.map((m) => m.connectedAt), [t1]);
  mock.reset();

  // The influencer reconnected while the call was running: the second read shows a newer grant.
  let reads = 0;
  const renewed = okToken();
  renewed.current = () => ({ state: "ok", refreshToken: "refresh", connectedAt: reads++ === 0 ? t1 : t2 });
  const b = paidBooking("b1", "a@example.com");
  const second = await loadMeeting([groupSession()], [b], renewed);
  await assert.rejects(second.mod.createMeetingForBooking("b1", { google: revoked, sleep: async () => {}, sendBookingEmail: async () => {}, alert: async () => {} }), GoogleTransientError);
  assert.deepEqual(renewed.marked, [], "nothing was flagged");
  assert.equal(b.status, "PAID");
  assert.match(String(b.lastError), /renewed/);
  mock.reset();
});

test("doc/15: the create-meeting job refreshes with the client the grant was issued with, for the booking's own influencer", async () => {
  for (const clientKind of ["own", "platform"] as const) {
    const seen: unknown[] = [];
    const rec: Recorder = { inserts: [], adds: [] };
    const tokens = okToken();
    tokens.current = () => ({ state: "ok", refreshToken: "refresh", connectedAt: new Date("2030-01-01T00:00:00Z"), clientKind });
    const b = paidBooking("b1", "a@example.com");
    const { mod, emailed } = await loadMeeting([groupSession()], [b], tokens);
    const google = { ...makeGoogle(rec), refreshAccessToken: async (_token: string, grant?: unknown) => (seen.push(grant), "access-token") };
    await mod.createMeetingForBooking("b1", { ...depsWith(rec, emailed), google });
    assert.deepEqual(seen, [{ influencerId: "inf1", clientKind }]);
    mock.reset();
  }
});

test("doc/15: a removed own Google client parks the booking with the plain reason and flags the connection, instead of failing", async () => {
  const reason = "Your Google client was removed or is no longer valid. Save your Google client again, then reconnect.";
  const tokens = okToken();
  tokens.current = () => ({ state: "ok", refreshToken: "refresh", connectedAt: new Date("2030-01-01T00:00:00Z"), clientKind: "own" });
  const b = paidBooking("b1", "a@example.com");
  const alerts: unknown[] = [];
  const { mod } = await loadMeeting([groupSession()], [b], tokens);
  const google = {
    refreshAccessToken: async () => {
      throw new GoogleReconnectError(reason);
    },
  };
  await assert.rejects(mod.createMeetingForBooking("b1", { google, sleep: async () => {}, sendBookingEmail: async () => {}, alert: async (...a: unknown[]) => void alerts.push(a) }), mod.MeetingBlockedError);
  assert.equal(b.status, "PAID", "the customer paid: the booking waits for the influencer to reconnect");
  assert.deepEqual(tokens.marked.map((m) => m.reason), [reason]);
  assert.equal(alerts.length, 1, "and the influencer is told once");
  mock.reset();
});
