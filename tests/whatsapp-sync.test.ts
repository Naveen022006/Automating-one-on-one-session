import "dotenv/config";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { prisma } from "../lib/db";
import { WhatsAppConnectError } from "../lib/whatsapp-connection";
import { SYNC_CONCURRENCY, syncWhatsAppTemplates } from "../worker/whatsapp-sync";

// The scheduled template sync. Which connections are picked is tested with the database in whatsapp-connect.test.ts;
// these tests only exercise the loop, with the candidate list and the refresh injected.

after(() => prisma.$disconnect());

const ids = (n: number) => Array.from({ length: n }, (_, i) => `inf-${i}`);

test("every candidate is refreshed once, with a bounded number in flight", async () => {
  let inFlight = 0;
  let peak = 0;
  const seen: string[] = [];
  const r = await syncWhatsAppTemplates({
    candidates: async () => ids(10),
    refresh: async (id) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((res) => setTimeout(res, 5));
      seen.push(id);
      inFlight--;
    },
  });
  assert.deepEqual(r, { checked: 10, failed: 0 });
  assert.deepEqual(seen.sort(), ids(10).sort());
  assert.ok(peak <= SYNC_CONCURRENCY, `at most ${SYNC_CONCURRENCY} at a time, saw ${peak}`);
  assert.ok(peak > 1, "but not one after the other");
});

test("one failing connection does not stop the rest", async () => {
  const seen: string[] = [];
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
  try {
    const r = await syncWhatsAppTemplates({
      candidates: async () => ids(5),
      refresh: async (id) => {
        seen.push(id);
        if (id === "inf-1") throw new WhatsAppConnectError("Meta rejected that access token.", 400);
      },
      concurrency: 1,
    });
    assert.deepEqual(r, { checked: 5, failed: 1 });
    assert.deepEqual(seen, ids(5), "the ones after the failure were still checked");
    assert.ok(warned.some((w) => w.includes("inf-1") && w.includes("Meta rejected")), "the failure is logged, without secrets");
  } finally {
    console.warn = warn;
  }
});

test("nothing to do is not an error", async () => {
  assert.deepEqual(await syncWhatsAppTemplates({ candidates: async () => [], refresh: async () => assert.fail("nothing to refresh") }), { checked: 0, failed: 0 });
});
