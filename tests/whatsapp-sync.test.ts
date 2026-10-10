import "dotenv/config";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { encryptSecret } from "../lib/crypto";
import { prisma } from "../lib/db";
import { setErrorReporter } from "../lib/observability";
import { WhatsAppGraphError } from "../lib/whatsapp-connect";
import { WhatsAppConnectError, refreshTemplates, whatsappTokenAad, type ConnectDeps } from "../lib/whatsapp-connection";
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
test("only an unexpected failure is reported as an error; a Meta refusal is just logged", async () => {
  const reported: { where?: unknown; influencerId?: unknown }[] = [];
  setErrorReporter((_e, context) => void reported.push(context));
  const warn = console.warn;
  console.warn = () => {};
  try {
    const r = await syncWhatsAppTemplates({
      candidates: async () => ["meta-said-no", "our-bug"],
      refresh: async (id) => {
        throw id === "our-bug" ? new Error("The stored token cannot be decrypted") : new WhatsAppConnectError("Meta rejected that access token.", 400);
      },
      concurrency: 1,
    });
    assert.deepEqual(r, { checked: 2, failed: 2 });
  } finally {
    console.warn = warn;
  }
  assert.equal(reported.length, 1);
  assert.equal(reported[0].where, "worker:whatsapp-template-sync");
  assert.equal(reported[0].influencerId, "our-bug");
});

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY not set";

test("a stored token that no longer decrypts is not turned into 'could not reach WhatsApp': it reaches the worker's error report", { skip }, async () => {
  const run = Date.now();
  const inf = await prisma.influencer.create({ data: { slug: `wa-s-${run}`, name: "Sync", email: `wa-s-${run}@example.com` } });
  try {
    await prisma.whatsAppConnection.create({ data: { influencerId: inf.id, wabaId: "123456", phoneNumberId: `4${run}`, tokenEnc: "v1.not.a.token" } });
    await assert.rejects(refreshTemplates(inf.id), (e: unknown) => !(e instanceof WhatsAppConnectError) && !/Could not reach WhatsApp/.test((e as Error).message));

    // Meta being unreachable is still what it says; a plain bug is passed on as it is.
    const deps = (ensure: () => Promise<never>) => ({ ensureTemplates: ensure }) as unknown as ConnectDeps;
    const good = encryptSecret("EAAG-a-token-that-decrypts-1234567890", whatsappTokenAad(inf.id));
    await prisma.whatsAppConnection.update({ where: { influencerId: inf.id }, data: { tokenEnc: good } });
    await assert.rejects(
      refreshTemplates(inf.id, deps(async () => { throw new WhatsAppGraphError("Meta is down", 503); })),
      (e: unknown) => e instanceof WhatsAppConnectError && /WhatsApp said: Meta is down/.test(e.message) && e.status === 502,
    );
    await assert.rejects(
      refreshTemplates(inf.id, deps(async () => { throw new TypeError("x is not a function"); })),
      (e: unknown) => e instanceof TypeError,
    );

    // And through the worker's loop, the plain failure is reported (the Meta one is not).
    const reported: unknown[] = [];
    setErrorReporter((e) => void reported.push(e));
    const warn = console.warn;
    console.warn = () => {};
    try {
      const outcomes = [new TypeError("x is not a function"), new WhatsAppGraphError("Meta is down", 503)];
      for (const err of outcomes) {
        await syncWhatsAppTemplates({ candidates: async () => [inf.id], refresh: (id) => refreshTemplates(id, deps(async () => { throw err; })) });
      }
    } finally {
      console.warn = warn;
    }
    assert.equal(reported.length, 1);
    assert.ok(reported[0] instanceof TypeError);
  } finally {
    await prisma.influencer.delete({ where: { id: inf.id } });
  }
});
