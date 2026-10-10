import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GoogleEventGoneError,
  GoogleReconnectError,
  GoogleRequestError,
  GoogleTransientError,
  createGoogleClient,
} from "../lib/google";

process.env.GOOGLE_CLIENT_ID ||= "client";
process.env.GOOGLE_CLIENT_SECRET ||= "secret";

const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test("adding an attendee to a deleted event (404/410 or a cancelled tombstone) is reported as 'gone'", async () => {
  for (const f of [reply(404, {}), reply(410, {}), reply(200, { id: "e", status: "cancelled", attendees: [] })]) {
    const client = createGoogleClient(f);
    await assert.rejects(client.addAttendee("t", "e", { email: "a@b.co", displayName: "A" }), (e) => {
      assert.ok(e instanceof GoogleEventGoneError);
      assert.ok(e instanceof GoogleRequestError, "still a request error for callers that do not care");
      return true;
    });
  }
});

test("moving a deleted event is reported as 'gone' too", async () => {
  const client = createGoogleClient(reply(410, {}));
  await assert.rejects(client.updateEvent("t", "e", { start: new Date(), end: new Date() }), GoogleEventGoneError);
});

test("a live event still takes the new attendee", async () => {
  const seen: { method: string; body?: string }[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    seen.push({ method: init.method ?? "GET", body: init.body as string | undefined });
    return new Response(JSON.stringify({ id: "e", status: "confirmed", attendees: [{ email: "x@y.co" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  await createGoogleClient(f).addAttendee("t", "e", { email: "a@b.co", displayName: "A" });
  assert.deepEqual(seen.map((s) => s.method), ["GET", "PATCH"]);
  assert.match(String(seen[1].body), /a@b\.co/);
});

test("token refresh: only invalid_grant means the grant is dead; everything else is transient", async () => {
  const refresh = (f: typeof fetch) => createGoogleClient(f).refreshAccessToken("rt");
  await assert.rejects(refresh(reply(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." })), GoogleReconnectError);
  await assert.rejects(refresh(reply(401, { error: "invalid_client" })), GoogleTransientError);
  await assert.rejects(refresh(reply(503, {})), GoogleTransientError);
  await assert.rejects(refresh((async () => { throw new Error("socket hang up"); }) as unknown as typeof fetch), GoogleTransientError);
  assert.equal(await refresh(reply(200, { access_token: "at" })), "at");
});

// ---- attendee edits are optimistic writes: If-Match, and read again on 412 ----

interface Scripted {
  status: number;
  body?: unknown;
}

/** A fetch that answers from a script, in order, and records what it was asked. */
function scripted(responses: Scripted[]) {
  const calls: { method: string; ifMatch: string | undefined; body: { attendees?: { email: string }[] } | null }[] = [];
  const queue = [...responses];
  const f = (async (_url: string, init: RequestInit) => {
    const r = queue.shift();
    if (!r) throw new Error("unexpected extra request");
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ method: init.method ?? "GET", ifMatch: headers["If-Match"], body: init.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const event = (etag: string, emails: string[]) => ({ status: 200, body: { id: "e", status: "confirmed", etag, attendees: emails.map((email) => ({ email })) } });
const emails = (c: { body: { attendees?: { email: string }[] } | null }) => (c.body?.attendees ?? []).map((a) => a.email);

test("adding an attendee writes with the etag it read and, on 412, reads again and keeps the attendee who got in first", async () => {
  const { f, calls } = scripted([
    event('"e1"', ["x@y.co"]),
    { status: 412 }, // someone else edited the attendee list in between
    event('"e2"', ["x@y.co", "late@y.co"]),
    { status: 200, body: { id: "e", status: "confirmed" } },
  ]);

  await createGoogleClient(f).addAttendee("t", "e", { email: "new@y.co", displayName: "New" });

  assert.deepEqual(calls.map((c) => c.method), ["GET", "PATCH", "GET", "PATCH"]);
  assert.equal(calls[1].ifMatch, '"e1"');
  assert.equal(calls[3].ifMatch, '"e2"');
  assert.deepEqual(emails(calls[1]), ["x@y.co", "new@y.co"]);
  assert.deepEqual(emails(calls[3]), ["x@y.co", "late@y.co", "new@y.co"], "the concurrent attendee is not overwritten");
});

test("removing an attendee also retries on 412 against a fresh read", async () => {
  const { f, calls } = scripted([
    event('"e1"', ["a@y.co", "b@y.co"]),
    { status: 412 },
    event('"e2"', ["a@y.co", "b@y.co", "c@y.co"]),
    { status: 200, body: { id: "e" } },
  ]);

  const r = await createGoogleClient(f).removeAttendee("t", "e", "b@y.co");

  assert.equal(calls[3].ifMatch, '"e2"');
  assert.deepEqual(emails(calls[3]), ["a@y.co", "c@y.co"], "the attendee added in between survives");
  assert.equal(r.remaining, 2);
});

test("an event that keeps changing gives up after a bounded number of reads with a retryable error", async () => {
  const script: Scripted[] = [];
  for (let i = 0; i < 4; i++) script.push(event(`"e${i}"`, ["x@y.co"]), { status: 412 });
  const { f, calls } = scripted(script);

  await assert.rejects(createGoogleClient(f).addAttendee("t", "e", { email: "new@y.co", displayName: "New" }), GoogleTransientError);
  assert.equal(calls.length, 8, "four read-write rounds, then stop");
});

test("an event deleted between the read and the write is 'gone' for add and already-empty for remove", async () => {
  const add = scripted([event('"e1"', []), { status: 404 }]);
  await assert.rejects(createGoogleClient(add.f).addAttendee("t", "e", { email: "new@y.co", displayName: "New" }), GoogleEventGoneError);
  const remove = scripted([event('"e1"', ["a@y.co"]), { status: 410 }]);
  assert.deepEqual(await createGoogleClient(remove.f).removeAttendee("t", "e", "a@y.co"), { remaining: 0 });
});
