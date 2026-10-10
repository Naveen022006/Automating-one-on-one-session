// Integration test of lib/google-tokens.ts against a migrated Postgres (skipped without DATABASE_URL / TOKEN_ENCRYPTION_KEY):
// the account remembered at disconnect, the live-event count behind the switch / disconnect warnings, and the
// conditional "mark dead" that stops an in-flight check from killing a connection that was just renewed.
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prisma } from "../lib/db";
import {
  countLiveCalendarEvents,
  deleteGoogleToken,
  getActiveGrant,
  getGoogleAccountOfRecord,
  getGoogleStatus,
  googleAccountSharedWithOthers,
  markReconnectNeeded,
  saveGoogleToken,
} from "../lib/google-tokens";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY not set";
const run = Date.now();
const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

let a = ""; // remembered account + status
let b = ""; // live events
let c = ""; // conditional mark

before(async () => {
  if (skip) return;
  const make = async (tag: string) => (await prisma.influencer.create({ data: { slug: `gt-${tag}-${run}`, name: tag, email: `gt-${tag}-${run}@example.com` } })).id;
  a = await make("a");
  b = await make("b");
  c = await make("c");
});

after(async () => {
  if (!skip) await prisma.influencer.deleteMany({ where: { id: { in: [a, b, c] } } });
  await prisma.$disconnect();
});

test("disconnect remembers the Google account the events are on; the next connect clears it", { skip }, async () => {
  await saveGoogleToken(a, "rt-1", SCOPE, "old@gmail.com");
  assert.deepEqual(await getGoogleAccountOfRecord(a), { connected: true, email: "old@gmail.com" });

  assert.equal(await deleteGoogleToken(a), "rt-1", "the refresh token is handed back to be revoked");
  assert.deepEqual(await getGoogleAccountOfRecord(a), { connected: false, email: "old@gmail.com" }, "no grant row, but the account is remembered");
  assert.equal((await prisma.influencer.findUniqueOrThrow({ where: { id: a } })).disconnectedGoogleEmail, "old@gmail.com");

  await saveGoogleToken(a, "rt-2", SCOPE, "other@gmail.com");
  assert.deepEqual(await getGoogleAccountOfRecord(a), { connected: true, email: "other@gmail.com" });
  assert.equal((await prisma.influencer.findUniqueOrThrow({ where: { id: a } })).disconnectedGoogleEmail, null, "cleared by the connect");
});

test("disconnecting a grant whose account is unknown leaves nothing wrong behind", { skip }, async () => {
  await saveGoogleToken(a, "rt-3", SCOPE, null);
  await deleteGoogleToken(a);
  assert.deepEqual(await getGoogleAccountOfRecord(a), { connected: false, email: null });
  assert.equal(await deleteGoogleToken(a), null, "disconnecting twice is harmless");
});

test("only upcoming PAID/SCHEDULED bookings that have a Calendar event count", { skip }, async () => {
  const service = await prisma.service.create({ data: { influencerId: b, title: "Group", type: "GROUP", capacity: 5, durationMin: 30, priceMinor: 100 } });
  const upcoming = await prisma.session.create({
    data: { serviceId: service.id, startTime: new Date(Date.now() + 7 * 86_400_000), endTime: new Date(Date.now() + 7 * 86_400_000 + 1_800_000) },
  });
  const past = await prisma.session.create({
    data: { serviceId: service.id, startTime: new Date(Date.now() - 7 * 86_400_000), endTime: new Date(Date.now() - 7 * 86_400_000 + 1_800_000) },
  });
  const booking = (sessionId: string, status: "SCHEDULED" | "PAID" | "CANCELLED" | "HELD", eventId: string | null, i: number) =>
    prisma.booking.create({ data: { sessionId, status, eventId, customerName: `C${i}`, customerEmail: `c${i}-${run}@example.com`, whatsappE164: "+919876543210" } });
  await booking(upcoming.id, "SCHEDULED", "evt", 1); // counts
  await booking(upcoming.id, "SCHEDULED", "evt", 2); // counts: each attendee of a group event is one booking
  await booking(upcoming.id, "PAID", null, 3); // no event yet
  await booking(upcoming.id, "CANCELLED", "evt", 4); // cancelled
  await booking(upcoming.id, "HELD", null, 5); // unpaid
  await booking(past.id, "SCHEDULED", "evt", 6); // already over

  assert.equal(await countLiveCalendarEvents(b), 2);

  // The same number reaches the Google panel when asked for, including after a disconnect, with the remembered account.
  await saveGoogleToken(b, "rt-b", SCOPE, "old@gmail.com");
  const connected = await getGoogleStatus(b, { details: true });
  assert.equal(connected.state === "connected" && connected.liveEvents, 2);
  await deleteGoogleToken(b);
  const detailed = await getGoogleStatus(b, { details: true });
  assert.deepEqual(detailed.state === "not-connected" && [detailed.liveEvents, detailed.previousEmail], [2, "old@gmail.com"]);
  const plain = await getGoogleStatus(b);
  assert.equal(plain.state === "not-connected" && plain.liveEvents, undefined, "the numbers cost queries and are only worked out on request");
});

test("a session starts at generation 0 and the stored generation survives a round trip", { skip }, async () => {
  const service = await prisma.service.findFirstOrThrow({ where: { influencerId: b } });
  const s = await prisma.session.create({ data: { serviceId: service.id, startTime: new Date(Date.now() + 9 * 86_400_000), endTime: new Date(Date.now() + 9 * 86_400_000 + 1_800_000) } });
  assert.equal(s.eventGeneration, 0);
  await prisma.session.update({ where: { id: s.id }, data: { eventGeneration: { increment: 1 } } });
  assert.equal((await prisma.session.findUniqueOrThrow({ where: { id: s.id } })).eventGeneration, 1);
});

test("a check that read the old grant cannot mark a connection dead that was renewed meanwhile", { skip }, async () => {
  await saveGoogleToken(c, "rt-old", SCOPE, "c@gmail.com");
  const seen = await getActiveGrant(c); // what the health check read before it asked Google
  assert.ok(seen);
  assert.equal(seen.refreshToken, "rt-old");

  await later(15);
  await saveGoogleToken(c, "rt-new", SCOPE, "c@gmail.com"); // the influencer reconnected while the check was in flight

  assert.equal(await markReconnectNeeded(c, "Refresh token rejected: invalid_grant", seen.connectedAt), false, "stale verdict is dropped");
  assert.equal((await prisma.googleToken.findUniqueOrThrow({ where: { influencerId: c } })).status, "ACTIVE");

  const current = await getActiveGrant(c);
  assert.ok(current);
  assert.equal(current.refreshToken, "rt-new");
  assert.equal(await markReconnectNeeded(c, "Refresh token rejected: invalid_grant", current.connectedAt), true, "the current grant is flagged");
  assert.equal(await markReconnectNeeded(c, "again", current.connectedAt), false, "only the call that flips the row reports it (one alert)");
  assert.equal(await getActiveGrant(c), null, "a flagged grant is no longer active");
});

test("without a version, markReconnectNeeded keeps its old meaning (used by the booking jobs)", { skip }, async () => {
  await saveGoogleToken(c, "rt-x", SCOPE, "c@gmail.com");
  assert.equal(await markReconnectNeeded(c, "revoked"), true);
  assert.equal(await markReconnectNeeded(c, "revoked"), false);
});

test("S6: another influencer profile on the same Google account is seen (case-insensitively); itself and unknown accounts are not", { skip }, async () => {
  await saveGoogleToken(a, "rt-s1", SCOPE, "Shared@Gmail.com");
  assert.equal(await googleAccountSharedWithOthers(a, "shared@gmail.com"), false, "only this profile uses the account");

  await saveGoogleToken(c, "rt-s2", SCOPE, "shared@gmail.com");
  assert.equal(await googleAccountSharedWithOthers(a, "SHARED@gmail.com"), true);
  assert.equal(await googleAccountSharedWithOthers(c, "shared@gmail.com"), true);
  assert.equal(await googleAccountSharedWithOthers(a, "other@gmail.com"), false);
  assert.equal(await googleAccountSharedWithOthers(a, null), false, "an unknown account never matches");

  await deleteGoogleToken(c);
  assert.equal(await googleAccountSharedWithOthers(a, "shared@gmail.com"), false, "a disconnected profile no longer counts");
});

test("S3: getRefreshToken returns the connectedAt it read, and a renewed grant has a newer one", { skip }, async () => {
  const { getRefreshToken } = await import("../lib/google-tokens");
  await saveGoogleToken(a, "rt-v1", SCOPE, "v@gmail.com");
  const first = await getRefreshToken(a);
  assert.ok(first.state === "ok" && first.connectedAt instanceof Date);
  await later(15);
  await saveGoogleToken(a, "rt-v2", SCOPE, "v@gmail.com");
  const second = await getRefreshToken(a);
  assert.ok(second.state === "ok" && first.state === "ok" && second.connectedAt.getTime() > first.connectedAt.getTime());
  // A verdict about the first grant can no longer flag the second one.
  assert.equal(first.state === "ok" && (await markReconnectNeeded(a, "stale", first.connectedAt)), false);
  assert.equal((await prisma.googleToken.findUniqueOrThrow({ where: { influencerId: a } })).status, "ACTIVE");
});
