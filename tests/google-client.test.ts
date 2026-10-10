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
