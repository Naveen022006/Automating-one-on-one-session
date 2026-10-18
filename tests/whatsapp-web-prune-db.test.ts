import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { kvKeys, MemoryKv, setKv } from "../lib/whatsapp-web/kv";
import { parsePruneRequests } from "../lib/whatsapp-web/prune-requests";

// Erasing a customer asks the worker to forget their contact keys in the influencer's linked WhatsApp login. Real tables, rows of our
// own deleted in `after`; the shared store is the in-memory one (Redis is never touched) and no worker or socket exists.

delete process.env.REDIS_URL;
const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const run = `${Date.now()}`;
const saved = process.env.WHATSAPP_QR_ENABLED;
const DAY = 86_400_000;

type Db = typeof import("../lib/db")["prisma"];
let prisma: Db;
let erase: typeof import("../lib/privacy")["eraseCustomerData"];
let inf = "";
let serviceId = "";
let n = 0;
let kv: MemoryKv;

before(async () => {
  if (skip) return;
  ({ prisma } = await import("../lib/db"));
  ({ eraseCustomerData: erase } = await import("../lib/privacy"));
  inf = (await prisma.influencer.create({ data: { slug: `wpd-${run}`, name: "Prune DB", email: `wpd-${run}@example.com` } })).id;
  serviceId = (await prisma.service.create({ data: { influencerId: inf, title: "Prune call", durationMin: 30, priceMinor: 1000 } })).id;
});

beforeEach(async () => {
  if (skip) return;
  process.env.WHATSAPP_QR_ENABLED = "true";
  kv = new MemoryKv();
  setKv(kv);
  await prisma.whatsAppWebSession.upsert({ where: { influencerId: inf }, create: { influencerId: inf, status: "LINKED", wantLinked: true, authStateEnc: "sealed" }, update: { authStateEnc: "sealed" } });
});

after(async () => {
  setKv(null);
  if (saved === undefined) delete process.env.WHATSAPP_QR_ENABLED;
  else process.env.WHATSAPP_QR_ENABLED = saved;
  try {
    if (prisma && inf) await prisma.influencer.deleteMany({ where: { id: inf } });
  } catch (e) {
    console.error("cleanup failed", e instanceof Error ? e.message : e);
  } finally {
    await prisma?.$disconnect();
  }
});

async function booking(email: string, phone: string, when: "past" | "upcoming") {
  const start = new Date(when === "past" ? Date.now() - 40 * DAY - ++n * 3_600_000 : Date.now() + 20 * DAY + ++n * 3_600_000);
  const session = await prisma.session.create({ data: { serviceId, startTime: start, endTime: new Date(start.getTime() + 30 * 60_000) } });
  return prisma.booking.create({
    data: { sessionId: session.id, status: when === "past" ? "COMPLETED" : "SCHEDULED", customerName: "Prune Customer", customerEmail: email, whatsappE164: phone, whatsappOptIn: true },
  });
}

const requests = async () => parsePruneRequests(await kv.drain(kvKeys.prune(inf)));

test("erasing a customer publishes ONE request with their number; the booking itself is erased as before", { skip }, async () => {
  const email = `a-${run}@example.com`;
  const b = await booking(email, "+919876500201", "past");
  const r = await erase(inf, email);
  assert.deepEqual(r, { found: 1, erased: 1, blocked: 0 });
  assert.deepEqual(await requests(), ["919876500201"]);
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).whatsappE164, "");
  // Erasing again finds nothing and asks for nothing.
  assert.deepEqual(await erase(inf, email), { found: 0, erased: 0, blocked: 0 });
  assert.deepEqual(await requests(), []);
});

test("a number that still has a live booking with this influencer is not asked for (the periodic clean-up decides later)", { skip }, async () => {
  const email = `b-${run}@example.com`;
  await booking(email, "+919876500202", "past");
  await booking(`other-${run}@example.com`, "+919876500202", "upcoming"); // another person's live booking with the same number
  const r = await erase(inf, email);
  assert.equal(r.erased, 1);
  assert.deepEqual(await requests(), []);
});

test("nothing is published when the QR mode is off, when there is no stored login, or when nothing was erased", { skip }, async () => {
  const mk = async (tag: string, phone: string) => {
    const email = `${tag}-${run}@example.com`;
    await booking(email, phone, "past");
    return email;
  };
  process.env.WHATSAPP_QR_ENABLED = "false";
  await erase(inf, await mk("off", "+919876500203"));
  assert.deepEqual(await requests(), []);

  process.env.WHATSAPP_QR_ENABLED = "true";
  await prisma.whatsAppWebSession.update({ where: { influencerId: inf }, data: { authStateEnc: null } });
  await erase(inf, await mk("nologin", "+919876500204"));
  assert.deepEqual(await requests(), []);

  await prisma.whatsAppWebSession.update({ where: { influencerId: inf }, data: { authStateEnc: "sealed" } });
  const kept = `kept-${run}@example.com`;
  await booking(kept, "+919876500205", "upcoming");
  assert.deepEqual(await erase(inf, kept), { found: 1, erased: 0, blocked: 1 });
  assert.deepEqual(await requests(), []);
});

test("a store that is down never makes the erasure fail", { skip }, async () => {
  const email = `down-${run}@example.com`;
  await booking(email, "+919876500206", "past");
  kv.rpush = async () => {
    throw new Error("redis down");
  };
  const warn = console.warn;
  const lines: string[] = [];
  console.warn = (l: string) => void lines.push(String(l));
  try {
    assert.deepEqual(await erase(inf, email), { found: 1, erased: 1, blocked: 0 });
  } finally {
    console.warn = warn;
  }
  assert.ok(lines.some((l) => /could not publish a contact clean-up request \(Error\)/.test(l)));
  assert.ok(!lines.join("\n").includes("919876500206"));
});
