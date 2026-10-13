// Integration test: needs a migrated Postgres at DATABASE_URL (skipped otherwise).
// The booking id is a reference printed on receipts and quoted to support. On its own it gives the status of a booking,
// never its Meet link, its calendar file or a resend; those need a token issued for that booking.
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prisma } from "../lib/db";
import { buildSelfServiceUrl, buildPayUrl, signBookingCalendarToken, signBookingPollToken } from "../lib/self-service";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const run = Date.now();
const MEET = `https://meet.google.com/tok-${run}`;
let influencerId: string;
let bookingId: string;
let otherId: string;
let statusGet: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let icsGet: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let resendPost: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let calendarFileUrl: (id: string, end: Date) => string | null;

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const manageToken = (id: string) => decodeURIComponent(new URL(buildSelfServiceUrl(id)).pathname.split("/").pop()!);
const payToken = (id: string) => decodeURIComponent(new URL(buildPayUrl(id, 3600)).pathname.split("/").pop()!);

async function status(id: string, t?: string) {
  const res = await statusGet(new Request(`http://localhost/api/bookings/${id}${t ? `?t=${encodeURIComponent(t)}` : ""}`), ctx(id));
  return (await res.json()) as { status: string; meetLink: string | null; manageUrl: string | null };
}
const ics = (id: string, t?: string) => icsGet(new Request(`http://localhost/api/bookings/${id}/ics${t ? `?t=${encodeURIComponent(t)}` : ""}`), ctx(id));

before(async () => {
  process.env.APP_URL ??= "http://localhost:3000";
  process.env.APP_SECRET ??= "test-only-app-secret-0123456789";
  // Nothing here may reach a queue: without the fix a resend would try to, and an open BullMQ connection keeps the run alive.
  delete process.env.REDIS_URL;
  process.env.MESSAGING_DRY_RUN = "true";
  statusGet = (await import("../app/api/bookings/[id]/route")).GET;
  icsGet = (await import("../app/api/bookings/[id]/ics/route")).GET;
  resendPost = (await import("../app/api/bookings/[id]/resend/route")).POST;
  calendarFileUrl = (await import("../lib/email")).calendarFileUrl;
  if (skip) return;
  influencerId = (await prisma.influencer.create({ data: { slug: `linktok-${run}`, name: "Link Host", email: `linktok${run}@example.com` } })).id;
  const service = await prisma.service.create({ data: { influencerId, title: "Call", durationMin: 30, priceMinor: 49900 } });
  const make = async (offsetDays: number, email: string) => {
    const start = new Date(Date.now() + offsetDays * 86_400_000);
    start.setUTCMinutes(0, 0, 0);
    const session = await prisma.session.create({ data: { serviceId: service.id, startTime: start, endTime: new Date(start.getTime() + 30 * 60_000) } });
    return (
      await prisma.booking.create({
        data: { sessionId: session.id, status: "SCHEDULED", customerName: "Link Guest", customerEmail: email, whatsappE164: "+919876543210", whatsappOptIn: true, meetLink: MEET },
      })
    ).id;
  };
  bookingId = await make(4, `linktok${run}@example.com`);
  otherId = await make(5, `linktok${run}b@example.com`);
});

after(async () => {
  if (!skip && influencerId) await prisma.influencer.delete({ where: { id: influencerId } });
  await prisma.$disconnect();
});

test("the status poll: the id alone gives the status, the Meet link needs a token for that booking", { skip }, async () => {
  const bare = await status(bookingId);
  assert.equal(bare.status, "SCHEDULED");
  assert.equal(bare.meetLink, null, "no Meet link for the id alone");
  assert.equal(bare.manageUrl, null);
  assert.equal((await status(bookingId, signBookingPollToken(otherId))).meetLink, null, "another booking's token");
  assert.equal((await status(bookingId, payToken(bookingId))).meetLink, null, "a pay-link token is not one of them");
  const polled = await status(bookingId, signBookingPollToken(bookingId));
  assert.equal(polled.meetLink, MEET);
  assert.ok(polled.manageUrl, "the browser that made the hold still gets its manage link");
  assert.equal((await status(bookingId, manageToken(bookingId))).meetLink, MEET);
  assert.equal((await status(bookingId, manageToken(bookingId))).manageUrl, null, "the manage link is still for the poll token only");
});

test("the calendar file needs a token; the e-mailed link carries one that works", { skip }, async () => {
  assert.equal((await ics(bookingId)).status, 404);
  assert.equal((await ics(bookingId, "garbage")).status, 404);
  assert.equal((await ics(bookingId, signBookingCalendarToken(otherId, 3600))).status, 404, "another booking's token");
  for (const t of [signBookingCalendarToken(bookingId, 3600), signBookingPollToken(bookingId), manageToken(bookingId)]) {
    const res = await ics(bookingId, t);
    assert.equal(res.status, 200);
    assert.match(await res.text(), new RegExp(MEET.replace(/[.]/g, "\\.")));
  }
  const emailed = new URL(calendarFileUrl(bookingId, new Date(Date.now() + 86_400_000))!);
  assert.equal(emailed.pathname, `/api/bookings/${bookingId}/ics`);
  assert.equal((await ics(bookingId, emailed.searchParams.get("t")!)).status, 200, "the link in the e-mail opens the file");
});

test("resend needs the page's token", { skip }, async () => {
  const res = await resendPost(new Request(`http://localhost/api/bookings/${bookingId}/resend`, { method: "POST" }), ctx(bookingId));
  assert.equal(res.status, 404);
  const foreign = await resendPost(
    new Request(`http://localhost/api/bookings/${bookingId}/resend?t=${encodeURIComponent(signBookingPollToken(otherId))}`, { method: "POST" }),
    ctx(bookingId),
  );
  assert.equal(foreign.status, 404);
  assert.equal(await prisma.message.count({ where: { bookingId } }), 0, "nothing was sent");
});
