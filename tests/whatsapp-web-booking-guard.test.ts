import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

// "Never message anyone who does not have a real booking with that influencer", against the real tables: rows of our own,
// deleted in `after`. Nothing is sent and no socket exists.

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const run = `${Date.now()}`;
const created: string[] = [];
type Db = typeof import("../lib/db")["prisma"];
let prisma: Db;
let guard: typeof import("../lib/whatsapp-web/booking-guard")["bookingAllowsMessage"];

const PHONE = "+919876500123";
let infA = "";
let infB = "";
const booking: Record<string, string> = {};

before(async () => {
  if (skip) return;
  ({ prisma } = await import("../lib/db"));
  ({ bookingAllowsMessage: guard } = await import("../lib/whatsapp-web/booking-guard"));
  try {
    const mk = async (label: string) => {
      const i = await prisma.influencer.create({ data: { slug: `wag-${label}-${run}`, name: `WAG ${label}`, email: `wag-${label}-${run}@example.com` } });
      created.push(i.id);
      return i.id;
    };
    infA = await mk("a");
    infB = await mk("b");
    const service = await prisma.service.create({ data: { influencerId: infA, title: `Guard call ${run}`, durationMin: 30, priceMinor: 5000 } });
    let n = 0;
    const make = async (name: string, data: Record<string, unknown>) => {
      const start = new Date(Date.UTC(2031, 0, 1, 10, 0) + n++ * 3_600_000);
      const session = await prisma.session.create({ data: { serviceId: service.id, startTime: start, endTime: new Date(start.getTime() + 30 * 60_000) } });
      const b = await prisma.booking.create({
        data: { sessionId: session.id, status: "SCHEDULED", customerName: "Guard Customer", customerEmail: `guard-${n}-${run}@example.com`, whatsappE164: PHONE, whatsappOptIn: true, ...data } as never,
      });
      booking[name] = b.id;
    };
    await make("scheduled", {});
    await make("paid", { status: "PAID" });
    await make("completed", { status: "COMPLETED" });
    await make("cancelled", { status: "CANCELLED" });
    await make("held", { status: "HELD" });
    await make("expired", { status: "EXPIRED" });
    await make("failed", { status: "FAILED" });
    await make("pending", { status: "PENDING_PAYMENT" });
    await make("no-optin", { whatsappOptIn: false });
    await make("erased", { redactedAt: new Date() });
  } catch (e) {
    console.error("setup failed", e instanceof Error ? e.message : e);
    throw e;
  }
});

after(async () => {
  try {
    if (prisma && created.length) await prisma.influencer.deleteMany({ where: { id: { in: created } } });
  } catch (e) {
    console.error("cleanup failed", e instanceof Error ? e.message : e);
  } finally {
    await prisma?.$disconnect();
  }
});

test("a booking of this influencer, with exactly this number, in a state a message makes sense for, is allowed", { skip }, async () => {
  for (const name of ["scheduled", "paid", "completed", "cancelled"]) {
    assert.equal(await guard(infA, { bookingId: booking[name], toE164: PHONE }), true, name);
  }
});

test("a booking that is held, expired, failed or unpaid never gets a message", { skip }, async () => {
  for (const name of ["held", "expired", "failed", "pending"]) {
    assert.equal(await guard(infA, { bookingId: booking[name], toE164: PHONE }), false, name);
  }
});

test("no WhatsApp opt-in, or erased customer data: no message", { skip }, async () => {
  assert.equal(await guard(infA, { bookingId: booking["no-optin"], toE164: PHONE }), false);
  assert.equal(await guard(infA, { bookingId: booking["erased"], toE164: PHONE }), false);
});

test("another influencer's booking, another number, or an invented id: no message", { skip }, async () => {
  assert.equal(await guard(infB, { bookingId: booking["scheduled"], toE164: PHONE }), false, "belongs to someone else");
  assert.equal(await guard(infA, { bookingId: booking["scheduled"], toE164: "+919876500124" }), false, "not the number on the booking");
  assert.equal(await guard(infA, { bookingId: "no-such-booking", toE164: PHONE }), false);
  assert.equal(await guard(infA, { bookingId: "", toE164: PHONE }), false);
  assert.equal(await guard("no-such-influencer", { bookingId: booking["scheduled"], toE164: PHONE }), false);
});
