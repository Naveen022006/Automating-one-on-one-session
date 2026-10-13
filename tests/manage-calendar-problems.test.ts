import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { GoogleReconnectError, GoogleRequestError } from "../lib/google";

/**
 * What lib/manage.ts does when the influencer's Google connection is broken during a cancel or a reschedule.
 *
 *  - A1: a cancel must still cancel the reminders, run the refund path and tell the customer; the calendar problem
 *        comes back as a warning (the booking is already CANCELLED, so nothing could retry those steps later).
 *  - A4: a grant Google rejects right now flags the connection (markReconnectNeeded) so the dashboard stops saying
 *        "Connected"; "not connected" / "already flagged" must not flip anything.
 *
 * Database-free: lib/db, the queue, mail, messaging and the token store are in-memory fakes (node:test mock.module),
 * and the Google client and every side effect are injected through ManageDeps.
 */

const influencer = {
  id: "inf1",
  name: "Dev",
  // Every weekday, all day, so any 30-minute UTC start is a real slot for the reschedule test.
  rules: Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, startTime: "00:00", endTime: "23:30", timezone: "UTC" })),
};

function fixture() {
  const service = {
    id: "svc1",
    title: "Intro call",
    type: "ONE_TO_ONE" as const,
    durationMin: 30,
    capacity: 1,
    refundPolicy: "FULL",
    minNoticeHours: 0,
    maxAdvanceDays: 90,
    influencer,
  };
  const booking: Record<string, unknown> = {
    id: "b1",
    sessionId: "sess1",
    status: "SCHEDULED",
    customerName: "Asha",
    customerEmail: "asha@example.com",
    eventId: "evt-1",
    meetLink: "https://meet.google.com/abc",
    lastError: null,
    refundPolicy: "FULL",
  };
  const start = new Date(Date.now() + 3 * 86_400_000);
  const session = {
    id: "sess1",
    startTime: start,
    endTime: new Date(start.getTime() + 30 * 60_000),
    eventId: null,
    meetLink: null,
    service,
    bookings: [booking],
  };
  return { booking, session };
}

type Fixture = ReturnType<typeof fixture>;

/** The token store the code under test sees, plus a log of how it was used. */
/** The version of the grant the code reads; a flag it sets must carry it (see markReconnectNeeded's onlyIfConnectedAt). */
const GRANT_VERSION = new Date("2030-01-01T00:00:00Z");

function tokenState(lookup: unknown = { state: "ok", refreshToken: "refresh", connectedAt: GRANT_VERSION }, markResult = true) {
  return { lookup, markResult, marked: [] as { influencerId: string; reason: string; connectedAt?: Date }[] };
}

async function load(f: Fixture, tokens: ReturnType<typeof tokenState>) {
  const tx = {
    session: { findFirst: async () => null, update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(f.session, data) },
    booking: { count: async () => 0 },
    $queryRaw: async () => [],
    $executeRaw: async () => 1, // the influencer's schedule lock (lib/holds.ts lockInfluencerSchedule)
  };
  const db = {
    booking: {
      findUnique: async () => ({ ...f.booking, session: f.session, payments: [{ id: "pay1" }] }),
      update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(f.booking, data),
    },
    payment: { updateMany: async () => ({ count: 1 }), findMany: async () => [] /* none of its payments is in a pending payout */ },
    blockedDate: { findMany: async () => [] },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
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
      getRefreshToken: async () => tokens.lookup,
      markReconnectNeeded: async (influencerId: string, reason: string, connectedAt?: Date) => {
        tokens.marked.push({ influencerId, reason, connectedAt });
        return tokens.markResult;
      },
    },
  });
  return await import("../lib/manage.ts?calendar-problems=" + Math.random());
}

/** Recording stand-ins for every side effect of a cancel / reschedule. */
function effects(google: Record<string, unknown>) {
  const log = {
    alerts: [] as { kind: string; detail: string }[],
    remindersCancelled: [] as string[],
    remindersEnqueued: [] as string[],
    rearmed: [] as string[],
    emails: [] as { bookingId: string; kind: string }[],
    messages: [] as { bookingId: string; template: string }[],
  };
  const deps = {
    google,
    alert: async (_id: string, a: { kind: string; detail: string }) => void log.alerts.push(a),
    cancelReminders: async (id: string) => void log.remindersCancelled.push(id),
    enqueueReminders: async (id: string) => void log.remindersEnqueued.push(id),
    sendBookingEmail: async (bookingId: string, kind: string) => void log.emails.push({ bookingId, kind }),
    enqueueSendMessage: async (bookingId: string, template?: string) => void log.messages.push({ bookingId, template: template ?? "" }),
    rearmMessage: async (bookingId: string, template: string) => void log.rearmed.push(`${bookingId}:${template}`),
    refundPayment: async () => ({}),
  };
  return { deps, log };
}

const happyGoogle = {
  refreshAccessToken: async () => "access",
  deleteEvent: async () => {},
  updateEvent: async () => ({}),
};

/** Everything a cancel promises besides the calendar, asserted once for each way Google can be broken. */
function assertCancelCarriedOn(f: Fixture, log: ReturnType<typeof effects>["log"]) {
  assert.equal(f.booking.status, "CANCELLED");
  assert.deepEqual(log.remindersCancelled, ["b1"], "reminders are cancelled");
  assert.ok(log.alerts.some((a) => a.kind === "refund-needed"), "the refund path ran (flagged for the influencer)");
  assert.deepEqual(log.emails, [{ bookingId: "b1", kind: "booking-cancelled" }], "the customer is emailed");
  assert.equal(log.messages.length, 1, "the customer's cancellation message is queued");
}

test("cancel while Google is not connected still cancels reminders, runs the refund path and tells the customer", async () => {
  const f = fixture();
  const tokens = tokenState({ state: "not-connected" });
  const mod = await load(f, tokens);
  const { deps, log } = effects(happyGoogle);

  const result = await mod.cancelBooking("b1", { actor: "influencer" }, deps);

  assertCancelCarriedOn(f, log);
  assert.match(result.warning ?? "", /not connected/);
  assert.equal(result.refund.eligible, true);
  assert.deepEqual(tokens.marked, [], "nothing to flag when there is no grant at all");
  assert.deepEqual(log.alerts.map((a) => a.kind).sort(), ["meeting-creation-failed", "refund-needed"]);
  assert.match(String(f.booking.lastError), /Could not cancel the calendar event/);
  mock.reset();
});

test("cancel with a grant Google rejects now carries on, flags the connection and raises one reconnect alert", async () => {
  const f = fixture();
  const tokens = tokenState();
  const mod = await load(f, tokens);
  const { deps, log } = effects({
    ...happyGoogle,
    refreshAccessToken: async () => {
      throw new GoogleReconnectError("Refresh token rejected: Token has been expired or revoked.");
    },
  });

  const result = await mod.cancelBooking("b1", { actor: "influencer" }, deps);

  assertCancelCarriedOn(f, log);
  assert.match(result.warning ?? "", /revoked/);
  assert.equal(tokens.marked.length, 1, "the connection is flagged so the dashboard stops saying Connected");
  assert.equal(tokens.marked[0].influencerId, "inf1");
  assert.match(tokens.marked[0].reason, /revoked/);
  assert.equal(tokens.marked[0].connectedAt, GRANT_VERSION, "S3: only the grant that was actually used can be flagged");
  assert.deepEqual(log.alerts.map((a) => a.kind).sort(), ["google-reconnect-needed", "refund-needed"], "one reconnect alert, no per-booking calendar alert");
  mock.reset();
});

test("a 401 from Calendar itself (not the token refresh) flags the connection too", async () => {
  const f = fixture();
  const tokens = tokenState();
  const mod = await load(f, tokens);
  const { deps } = effects({
    ...happyGoogle,
    deleteEvent: async () => {
      throw new GoogleReconnectError("Google Calendar 401 authError: Invalid Credentials");
    },
  });

  await mod.cancelBooking("b1", { actor: "influencer" }, deps);

  assert.equal(tokens.marked.length, 1);
  mock.reset();
});

test("when the connection was already flagged by another job there is no second reconnect alert", async () => {
  const f = fixture();
  const tokens = tokenState({ state: "ok", refreshToken: "refresh", connectedAt: GRANT_VERSION }, false); // markReconnectNeeded -> false: not the flipper
  const mod = await load(f, tokens);
  const { deps, log } = effects({
    ...happyGoogle,
    refreshAccessToken: async () => {
      throw new GoogleReconnectError("Refresh token rejected");
    },
  });

  await mod.cancelBooking("b1", { actor: "influencer" }, deps);

  assert.equal(tokens.marked.length, 1);
  assert.deepEqual(log.alerts.map((a) => a.kind).sort(), ["meeting-creation-failed", "refund-needed"]);
  mock.reset();
});

test("Google refusing the delete for good is a warning, not a failed cancel, and does not flag the connection", async () => {
  const f = fixture();
  const tokens = tokenState();
  const mod = await load(f, tokens);
  const { deps, log } = effects({
    ...happyGoogle,
    deleteEvent: async () => {
      throw new GoogleRequestError("Google Calendar 400 invalid: bad request");
    },
  });

  const result = await mod.cancelBooking("b1", { actor: "influencer" }, deps);

  assertCancelCarriedOn(f, log);
  assert.match(result.warning ?? "", /400/);
  assert.deepEqual(tokens.marked, []);
  mock.reset();
});

test("a cancel with a healthy Google has no warning and one delete", async () => {
  const f = fixture();
  const tokens = tokenState();
  const mod = await load(f, tokens);
  const deleted: string[] = [];
  const { deps, log } = effects({ ...happyGoogle, deleteEvent: async (_t: string, id: string) => void deleted.push(id) });

  const result = await mod.cancelBooking("b1", { actor: "influencer" }, deps);

  assert.equal(result.warning, undefined);
  assert.deepEqual(deleted, ["evt-1"]);
  assert.deepEqual(log.alerts.map((a) => a.kind), ["refund-needed"]);
  mock.reset();
});

test("a reschedule that finds a revoked grant flags the connection, still replaces reminders and tells the customer", async () => {
  const f = fixture();
  const tokens = tokenState();
  const mod = await load(f, tokens);
  const { deps, log } = effects({
    ...happyGoogle,
    refreshAccessToken: async () => {
      throw new GoogleReconnectError("Refresh token rejected: revoked");
    },
  });
  const newStart = new Date(Date.now() + 5 * 86_400_000);
  newStart.setUTCHours(10, 0, 0, 0);

  await assert.rejects(mod.rescheduleBooking("b1", newStart, deps), mod.ManageBlockedError);

  assert.equal(tokens.marked.length, 1, "the revoked grant is flagged");
  assert.equal(tokens.marked[0].connectedAt, GRANT_VERSION, "S3: with the version it was read at, on reschedule too");
  assert.deepEqual(log.alerts.map((a) => a.kind), ["google-reconnect-needed"]);
  assert.deepEqual(log.remindersCancelled, ["b1"]);
  assert.deepEqual(log.remindersEnqueued, ["b1"]);
  // A reminder already sent for the old time must not block the one for the new time (WP-E).
  assert.ok(log.rearmed.includes("b1:reminder-24h") && log.rearmed.includes("b1:reminder-15m"), log.rearmed.join(","));
  // ...and the booking row carries the re-arm time the repair job reads (R1: not a Message row).
  assert.ok(f.booking.updatedAt instanceof Date && Date.now() - (f.booking.updatedAt as Date).getTime() < 60_000);
  assert.deepEqual(log.emails, [{ bookingId: "b1", kind: "booking-rescheduled" }]);
  mock.reset();
});

test("a reschedule while Google is not connected does not flag anything", async () => {
  const f = fixture();
  const tokens = tokenState({ state: "reconnect-needed", reason: "revoked earlier" });
  const mod = await load(f, tokens);
  const { deps, log } = effects(happyGoogle);
  const newStart = new Date(Date.now() + 5 * 86_400_000);
  newStart.setUTCHours(10, 0, 0, 0);

  await assert.rejects(mod.rescheduleBooking("b1", newStart, deps), mod.ManageBlockedError);

  assert.deepEqual(tokens.marked, []);
  assert.deepEqual(log.alerts.map((a) => a.kind), ["meeting-creation-failed"]);
  mock.reset();
});

test("retrying a reschedule whose calendar update failed moves the Google event (the retry the alert offers is not a no-op)", async () => {
  const f = fixture();
  const mod = await load(f, tokenState());
  try {
    const newStart = new Date(Date.now() + 5 * 86_400_000);
    newStart.setUTCHours(10, 0, 0, 0);
    const first = effects({
      ...happyGoogle,
      updateEvent: async () => {
        throw new Error("Google request failed: fetch failed");
      },
    });
    // Transient: the booking moved, the customer was told, the event still shows the old time.
    await mod.rescheduleBooking("b1", newStart, first.deps);
    assert.match(String(f.booking.lastError), /Could not reschedule the calendar event/);
    assert.ok(first.log.alerts.some((a) => a.kind === "meeting-creation-failed"), "the host is told to retry");

    // The host retries the same move once Google is reachable again.
    const patched: { eventId: string; start: Date }[] = [];
    const second = effects({ ...happyGoogle, updateEvent: async (_t: string, eventId: string, t: { start: Date }) => void patched.push({ eventId, start: t.start }) });
    await mod.rescheduleBooking("b1", newStart, second.deps);

    assert.deepEqual(patched, [{ eventId: "evt-1", start: newStart }], "the Calendar event is moved to the new time");
    assert.equal(f.booking.lastError, null, "the problem is cleared");
    assert.deepEqual(second.log.emails, [], "the customer is not told about the same move twice");
    assert.deepEqual(second.log.messages, []);
  } finally {
    mock.reset();
  }
});

test("repeating a reschedule that fully succeeded does not touch Google again", async () => {
  const f = fixture();
  const mod = await load(f, tokenState());
  try {
    const newStart = new Date(Date.now() + 5 * 86_400_000);
    newStart.setUTCHours(10, 0, 0, 0);
    let updates = 0;
    const { deps } = effects({ ...happyGoogle, updateEvent: async () => void updates++ });
    await mod.rescheduleBooking("b1", newStart, deps);
    await mod.rescheduleBooking("b1", newStart, deps);
    assert.equal(updates, 1);
  } finally {
    mock.reset();
  }
});
