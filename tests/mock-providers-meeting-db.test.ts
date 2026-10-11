// The Google connection and the create-meeting job against the mock server and a migrated Postgres (skipped without DATABASE_URL /
// TOKEN_ENCRYPTION_KEY; no Redis needed, every queue is injected). The REAL Google client and the REAL database queries run; only
// Google is the mock (doc/11-provider-simulator.md, 6.4). Each run makes its own influencer with unique names (a timestamp and random
// bytes: two runs, or the owner's own data, never share them) and deletes only that influencer, whose services, sessions, bookings and
// Google token go with it.
import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { prisma } from "../lib/db";
import { buildAuthUrl, exchangeCode } from "../lib/google";
import { saveGoogleToken } from "../lib/google-tokens";
import { MeetingBlockedError, calendarEventId, createMeetingForBooking, sessionEventId } from "../lib/meeting";
import { cleanup, control, raw, startMock, useMockEnv, type TestMock } from "./helpers/mock-server";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY not set";
const run = `${Date.now()}-${randomBytes(3).toString("hex")}`;
const account = `meeting-${run}@mock-google.invalid`;
let t: TestMock;
let restoreEnv = () => {};
let influencerId = "";
let oneToOne = "";
let group = "";
let n = 0;

const noEffects = { enqueueSendMessage: async () => {}, enqueueReminders: async () => {}, sendBookingEmail: async () => {}, alert: async () => {} };

before(async () => {
  if (skip) return;
  t = await startMock();
  restoreEnv = useMockEnv(t.mock);
  influencerId = (await prisma.influencer.create({ data: { slug: `mp-meet-${run}`, name: "Mock Meet", email: `mp-meet-${run}@example.com` } })).id;
  oneToOne = (await prisma.service.create({ data: { influencerId, title: "1:1 Career Call", type: "ONE_TO_ONE", capacity: 1, durationMin: 30, priceMinor: 100 } })).id;
  group = (await prisma.service.create({ data: { influencerId, title: "Group Workshop", type: "GROUP", capacity: 5, durationMin: 60, priceMinor: 100 } })).id;
});

after(async () => {
  if (skip) {
    await prisma.$disconnect();
    return;
  }
  await cleanup(
    [
      ["restore the environment", () => restoreEnv()],
      ["stop the mock", () => t.stop()],
      ["delete this run's influencer", () => influencerId && prisma.influencer.delete({ where: { id: influencerId } })],
    ],
    () => prisma.$disconnect(),
  );
});

/** The influencer connects Google through the mock's consent screen, exactly as the callback route stores it. */
async function connectGoogle(): Promise<void> {
  const url = new URL(buildAuthUrl("state"));
  const page = await raw(t.mock, "GET", url.pathname + url.search);
  const decisionId = /name="decisionId" value="([^"]+)"/.exec(page.text)![1];
  const form = new URLSearchParams({ decisionId, account: "other", other_account: account, action: "allow" });
  form.append("scope", "https://www.googleapis.com/auth/calendar.events");
  form.append("scope", "https://www.googleapis.com/auth/gmail.send");
  const res = await raw(t.mock, "POST", "/google/o/oauth2/v2/auth/decision", { "content-type": "application/x-www-form-urlencoded", origin: t.mock.url, "sec-fetch-site": "same-origin" }, form.toString());
  const { refreshToken, scope, email } = await exchangeCode(new URL(String(res.headers.location)).searchParams.get("code")!);
  assert.equal(email, account);
  await saveGoogleToken(influencerId, refreshToken, scope, email);
}

async function paidBooking(serviceId: string, sessionId?: string) {
  const start = new Date(Date.now() + (10 + n++) * 86_400_000);
  const session = sessionId
    ? await prisma.session.findUniqueOrThrow({ where: { id: sessionId } })
    : await prisma.session.create({ data: { serviceId, startTime: start, endTime: new Date(start.getTime() + 1_800_000) } });
  const booking = await prisma.booking.create({
    data: { sessionId: session.id, status: "PAID", customerName: `Customer ${n}`, customerEmail: `customer${n}-${run}@example.com`, whatsappE164: "+919876543210" },
  });
  return { session, booking };
}

test("a paid 1:1 booking gets an event with the customer as attendee and a Meet link on the mock", { skip }, async () => {
  await connectGoogle();
  const { booking } = await paidBooking(oneToOne);
  assert.equal(await createMeetingForBooking(booking.id, noEffects), "scheduled");

  const row = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
  assert.equal(row.status, "SCHEDULED");
  assert.ok(row.meetLink?.startsWith(`${t.mock.url}/meet/`), String(row.meetLink));
  assert.equal(row.eventId, calendarEventId(booking.id));
  const event = t.mock.state().google.calendars[account][calendarEventId(booking.id)];
  assert.ok(event, "the mock calendar holds the event under the booking's deterministic id");
  assert.deepEqual(event.attendees.map((a) => a.email), [booking.customerEmail]);
  assert.match(event.summary, /1:1 Career Call with Mock Meet/);
  assert.ok(t.mock.state().google.invites.some((i) => i.eventId === event.id && i.to === booking.customerEmail && i.kind === "invite"), "Google would email the invite");

  // Running the job again is a no-op for the calendar (idempotent), as after a crash.
  assert.equal(await createMeetingForBooking(booking.id, noEffects), "already-scheduled");
  assert.equal(Object.keys(t.mock.state().google.calendars[account]).length, 1);
});

test("a group session: every paid attendee ends up on ONE shared event", { skip }, async () => {
  const first = await paidBooking(group);
  const second = await paidBooking(group, first.session.id);
  assert.equal(await createMeetingForBooking(first.booking.id, noEffects), "scheduled");
  assert.equal(await createMeetingForBooking(second.booking.id, noEffects), "scheduled");

  const [a, b] = await Promise.all([first.booking.id, second.booking.id].map((id) => prisma.booking.findUniqueOrThrow({ where: { id } })));
  const sharedId = sessionEventId(first.session.id, 0);
  assert.equal(a.eventId, sharedId);
  assert.equal(b.eventId, sharedId);
  assert.ok(a.meetLink && a.meetLink === b.meetLink, "the same link for both");
  const event = t.mock.state().google.calendars[account][sharedId];
  assert.deepEqual(event.attendees.map((x) => x.email).sort(), [first.booking.customerEmail, second.booking.customerEmail].sort());
  assert.ok(event.etag >= 2, "the second attendee was added with an update (If-Match)");

  // The group's event survives a cancel of one attendee in the real code path; deleting it behind the app's back is answered
  // by a new generation (the id is never reusable at Google).
  await control(t.mock, "/__mock/google/delete-event", { account, eventId: sharedId });
  const third = await paidBooking(group, first.session.id);
  assert.equal(await createMeetingForBooking(third.booking.id, noEffects), "scheduled");
  const row = await prisma.booking.findUniqueOrThrow({ where: { id: third.booking.id } });
  assert.equal(row.eventId, sessionEventId(first.session.id, 1), "generation 1: the deleted event's id is taken");
  assert.notEqual(row.meetLink, a.meetLink, "and it has its own Meet link");
});

test("a revoked grant blocks the next booking and flags the connection for reconnecting", { skip }, async () => {
  const grantId = Object.entries(t.mock.state().google.grants).find(([, g]) => g.email === account && !g.revokedAt)![0];
  await control(t.mock, "/__mock/google/revoke-grant", { grantId });
  const { booking } = await paidBooking(oneToOne);
  await assert.rejects(createMeetingForBooking(booking.id, noEffects), MeetingBlockedError);

  const token = await prisma.googleToken.findUniqueOrThrow({ where: { influencerId } });
  assert.equal(token.status, "RECONNECT_NEEDED");
  assert.match(token.reconnectReason ?? "", /Token has been expired or revoked/);
  const row = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
  assert.equal(row.status, "PAID", "the customer paid: the booking waits for the reconnect");
  assert.match(row.lastError ?? "", /Waiting for Mock Meet to connect Google Calendar/);

  // Reconnecting through the mock clears the flag and the next attempt works.
  await connectGoogle();
  assert.equal((await prisma.googleToken.findUniqueOrThrow({ where: { influencerId } })).status, "ACTIVE");
  assert.equal(await createMeetingForBooking(booking.id, noEffects), "scheduled");
});
