// Integration test: needs a migrated Postgres at DATABASE_URL (skipped otherwise).
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prisma } from "../lib/db";
import { createHold, expireStaleHolds, SlotUnavailableError } from "../lib/holds";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const slotStart = new Date(Date.now() + 7 * 86_400_000);
slotStart.setUTCMinutes(0, 0, 0);
const slotEnd = new Date(slotStart.getTime() + 30 * 60_000);

let influencerId: string;
let oneToOneId: string;
let groupId: string;

// The group test books two hours later: one influencer is in one session at a time, so the 1:1 at slotStart would block it.
const holdFor = (serviceId: string, capacity: number, i: number, start = slotStart) =>
  createHold({
    serviceId,
    startTime: start,
    endTime: new Date(start.getTime() + (slotEnd.getTime() - slotStart.getTime())),
    capacity,
    customerName: `Customer ${i}`,
    customerEmail: `c${i}@example.com`,
    whatsappE164: "+919876543210",
    whatsappOptIn: true,
  });

before(async () => {
  if (skip) return;
  const inf = await prisma.influencer.create({
    data: { slug: `test-${Date.now()}`, name: "Test", email: `t${Date.now()}@example.com` },
  });
  influencerId = inf.id;
  const base = { influencerId, durationMin: 30, priceMinor: 100 };
  oneToOneId = (await prisma.service.create({ data: { ...base, title: "1:1", capacity: 1 } })).id;
  groupId = (await prisma.service.create({ data: { ...base, title: "Group", type: "GROUP", capacity: 3 } })).id;
});

after(async () => {
  if (!skip) await prisma.influencer.delete({ where: { id: influencerId } });
  await prisma.$disconnect();
});

test("concurrent holds on one 1:1 slot: exactly one wins", { skip }, async () => {
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => holdFor(oneToOneId, 1, i)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of results) {
    if (r.status === "rejected") assert.ok(r.reason instanceof SlotUnavailableError, String(r.reason));
  }
  assert.equal(await prisma.session.count({ where: { serviceId: oneToOneId } }), 1);
});

test("group slot never oversells", { skip }, async () => {
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => holdFor(groupId, 3, i, new Date(slotStart.getTime() + 2 * 3_600_000))));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
});

test("an expired hold frees the slot and is marked EXPIRED", { skip }, async () => {
  const session = await prisma.session.findFirstOrThrow({ where: { serviceId: oneToOneId } });
  await prisma.booking.updateMany({
    where: { sessionId: session.id },
    data: { holdExpiresAt: new Date(Date.now() - 1000) },
  });
  // Free immediately, even before the worker runs...
  await holdFor(oneToOneId, 1, 99);
  // ...and the worker tidies the status afterwards.
  assert.ok((await expireStaleHolds()) >= 1);
  assert.equal(await prisma.booking.count({ where: { sessionId: session.id, status: "EXPIRED" } }), 1);
});
