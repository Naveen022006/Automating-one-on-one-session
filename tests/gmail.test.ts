import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { sendCustomerEmail, shouldLogGmailFallback, type CustomerEmailDeps, type InfluencerMailContext } from "../lib/customer-email";
import { buildAuthUrl, GMAIL_SEND_SCOPE, GoogleReconnectError, GoogleRequestError, GoogleTransientError, requestGmailByDefault } from "../lib/google";
import { gmailSendingFailing } from "../lib/google-tokens";
import { buildMime, encodeHeader, hasGmailSendScope, sendGmail, type GmailMessage } from "../lib/gmail";
import type { OutgoingEmail } from "../lib/email/providers";

process.env.GOOGLE_CLIENT_ID ||= "client";
process.env.GOOGLE_REDIRECT_URI ||= "http://localhost:3000/api/google/callback";

const msg: GmailMessage = {
  fromName: "Sam Rao",
  fromEmail: "sam@gmail.com",
  to: { email: "asha@example.com", name: "Asha" },
  subject: "Confirmed: Portfolio review",
  html: "<p>Hello <b>Asha</b></p>",
  text: "Hello Asha",
};

function decodeBody(mime: string, type: string): string {
  const part = mime.split(/--sa_test\r?\n/).find((p) => p.includes(`Content-Type: ${type}`)) ?? "";
  const b64 = part.split(/\r?\n\r?\n/)[1]?.split("--sa_test--")[0] ?? "";
  return Buffer.from(b64.replace(/\s+/g, ""), "base64").toString("utf8");
}

test("MIME message has the right headers and both bodies", () => {
  const mime = buildMime(msg, "sa_test");
  assert.match(mime, /^From: "Sam Rao" <sam@gmail\.com>\r\n/);
  assert.match(mime, /\r\nTo: "Asha" <asha@example\.com>\r\n/);
  assert.match(mime, /\r\nSubject: Confirmed: Portfolio review\r\n/);
  assert.match(mime, /Content-Type: multipart\/alternative; boundary="sa_test"/);
  assert.equal(decodeBody(mime, "text/plain"), "Hello Asha");
  assert.equal(decodeBody(mime, "text/html"), "<p>Hello <b>Asha</b></p>");
  assert.ok(mime.trimEnd().endsWith("--sa_test--"));
});

test("non-ASCII subjects and names are encoded, and headers cannot be injected", () => {
  assert.equal(encodeHeader("Plain subject"), "Plain subject");
  const enc = encodeHeader("Séance — confirmée ✓");
  assert.match(enc, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  assert.equal(Buffer.from(enc.slice(10, -2), "base64").toString("utf8"), "Séance — confirmée ✓");

  const evil = buildMime({ ...msg, subject: "Hi\r\nBcc: attacker@evil.test", fromName: 'Sam"\r\nBcc: x@evil.test', to: { email: "a@b.co\r\nBcc: z@evil.test", name: "N\r\nBcc: q@evil.test" } }, "sa_test");
  const headerBlock = evil.split("\r\n\r\n")[0];
  assert.equal(headerBlock.split("\r\n").filter((l) => /^Bcc:/i.test(l)).length, 0, "no injected header line");
});

test("Gmail send posts the raw message and returns its id", async () => {
  let seen: { url: string; headers: Record<string, string>; body: { raw: string } } | null = null;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
    return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await sendGmail("tok", msg, fetchImpl);
  assert.equal(r.id, "msg_1");
  assert.equal(seen!.url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
  assert.equal(seen!.headers.Authorization, "Bearer tok");
  const raw = Buffer.from(seen!.body.raw, "base64url").toString("utf8");
  assert.match(raw, /Subject: Confirmed: Portfolio review/);
});

test("Gmail errors are classified: 401 reconnect, 429/5xx transient, others request errors", async () => {
  const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  await assert.rejects(sendGmail("t", msg, respond(401, { error: { message: "Invalid Credentials" } })), GoogleReconnectError);
  await assert.rejects(sendGmail("t", msg, respond(429, { error: { message: "slow down" } })), GoogleTransientError);
  await assert.rejects(sendGmail("t", msg, respond(503, {})), GoogleTransientError);
  await assert.rejects(sendGmail("t", msg, respond(403, { error: { errors: [{ reason: "rateLimitExceeded" }], message: "limit" } })), GoogleTransientError);
  await assert.rejects(sendGmail("t", msg, respond(403, { error: { errors: [{ reason: "insufficientPermissions" }], message: "scope" } })), /insufficientPermissions/);
  await assert.rejects(sendGmail("t", msg, (async () => { throw new Error("socket hang up"); }) as unknown as typeof fetch), GoogleTransientError);
});

test("the connect URL asks for Gmail only when wanted, and keeps earlier grants", () => {
  const withGmail = new URL(buildAuthUrl("s", "me@x.co", { gmail: true }));
  assert.ok(withGmail.searchParams.get("scope")!.split(" ").includes(GMAIL_SEND_SCOPE));
  assert.equal(withGmail.searchParams.get("include_granted_scopes"), "true");
  const calendarOnly = new URL(buildAuthUrl("s", undefined, { gmail: false }));
  assert.ok(!calendarOnly.searchParams.get("scope")!.includes("gmail"));
  assert.ok(calendarOnly.searchParams.get("scope")!.includes("calendar.events"));
  assert.equal(requestGmailByDefault({ GOOGLE_REQUEST_GMAIL_SEND: "false" } as unknown as NodeJS.ProcessEnv), false);
  assert.equal(requestGmailByDefault({} as NodeJS.ProcessEnv), true);
  assert.equal(hasGmailSendScope(`openid email ${GMAIL_SEND_SCOPE}`), true);
  assert.equal(hasGmailSendScope("openid email https://www.googleapis.com/auth/calendar.events"), false);
  assert.equal(hasGmailSendScope(null), false);
});

// ---- routing between Gmail and the platform provider ----
const email: OutgoingEmail = { to: { email: "asha@example.com", name: "Asha" }, subject: "S", html: "<p>h</p>", text: "t", tag: "booking-confirmation" };

function deps(ctx: InfluencerMailContext | null, over: Partial<CustomerEmailDeps> = {}) {
  const calls = { gmail: 0, platform: [] as OutgoingEmail[], reconnect: [] as string[] };
  const d: CustomerEmailDeps = {
    loadContext: async () => ctx,
    refreshAccessToken: async () => "access",
    sendGmail: async () => (calls.gmail++, { id: "g1" }),
    platformSend: async (e) => (calls.platform.push(e), { providerMessageId: "p1" }),
    onReconnectNeeded: async (_id, reason) => void calls.reconnect.push(reason),
    ...over,
  };
  return { d, calls };
}
const withGmail: InfluencerMailContext = { name: "Sam", replyTo: "sam@gmail.com", gmail: { refreshToken: "r", fromEmail: "sam@gmail.com" } };
const noGmail: InfluencerMailContext = { name: "Sam", replyTo: "sam@example.com", gmail: null };

test("with Gmail allowed the email goes out from the influencer's Gmail only", async () => {
  const { d, calls } = deps(withGmail);
  const r = await sendCustomerEmail("inf", email, d);
  assert.equal(r.via, "gmail");
  assert.equal(r.providerMessageId, "gmail:g1");
  assert.equal(calls.gmail, 1);
  assert.equal(calls.platform.length, 0, "not sent twice");
});

test("without Gmail the platform sends, with the influencer as Reply-To", async () => {
  const { d, calls } = deps(noGmail);
  const r = await sendCustomerEmail("inf", email, d);
  assert.equal(r.via, "platform");
  assert.equal(calls.platform[0].replyTo, "sam@example.com");
  const unknown = deps(null);
  assert.equal((await sendCustomerEmail("inf", email, unknown.d)).via, "platform", "unknown influencer still sends");
  assert.equal(unknown.calls.platform[0].replyTo, undefined);
});

test("a Gmail failure falls back to the platform so the email is never lost", async () => {
  const { d, calls } = deps(withGmail, { sendGmail: async () => { throw new GoogleTransientError("Gmail 429 quota"); } });
  const r = await sendCustomerEmail("inf", email, d);
  assert.equal(r.via, "platform");
  assert.match(r.fallbackReason ?? "", /429/);
  assert.equal(calls.platform.length, 1);
  assert.equal(calls.reconnect.length, 0, "a rate limit is not a dead grant");
});

test("a rejected Google grant is flagged for reconnect and the email still goes out", async () => {
  const { d, calls } = deps(withGmail, { refreshAccessToken: async () => { throw new GoogleReconnectError("Refresh token rejected"); } });
  const r = await sendCustomerEmail("inf", email, d);
  assert.equal(r.via, "platform");
  assert.equal(calls.reconnect.length, 1);
  assert.equal(calls.platform.length, 1);
});

test("if both Gmail and the platform fail the error reaches the caller", async () => {
  const { d } = deps(withGmail, {
    sendGmail: async () => { throw new GoogleTransientError("down"); },
    platformSend: async () => { throw new Error("provider down"); },
  });
  await assert.rejects(sendCustomerEmail("inf", email, d), /provider down/);
});

// ---- A6: a Gmail API that is not enabled must be visible ----

test("a Gmail API that is not enabled is named as such instead of looking like a generic 403", async () => {
  const body = { error: { code: 403, status: "PERMISSION_DENIED", message: "Gmail API has not been used in project 1 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=1 then retry.", errors: [{ reason: "accessNotConfigured" }] } };
  const respond = (async () => new Response(JSON.stringify(body), { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(sendGmail("t", msg, respond), (e) => {
    assert.ok(e instanceof GoogleRequestError);
    assert.match((e as Error).message, /accessNotConfigured/);
    assert.match((e as Error).message, /Gmail API is not enabled/);
    return true;
  });
});

test("the fallback is logged at most once an hour per influencer", () => {
  const t0 = Date.UTC(2030, 0, 1);
  assert.equal(shouldLogGmailFallback("fallback-a", t0), true);
  assert.equal(shouldLogGmailFallback("fallback-a", t0 + 59 * 60_000), false, "same influencer within the hour");
  assert.equal(shouldLogGmailFallback("fallback-b", t0 + 59 * 60_000), true, "another influencer is independent");
  assert.equal(shouldLogGmailFallback("fallback-a", t0 + 61 * 60_000), true, "an hour later it is logged again");
});

test("a failing Gmail send warns once for many emails, and every email still goes out through the platform", async () => {
  const warnings: string[] = [];
  const spy = mock.method(console, "warn", (...args: unknown[]) => void warnings.push(args.join(" ")));
  try {
    const { d, calls } = deps(withGmail, { sendGmail: async () => { throw new GoogleRequestError("Gmail 403 accessNotConfigured: the Gmail API is not enabled"); } });
    for (let i = 0; i < 3; i++) assert.equal((await sendCustomerEmail("warn-once-inf", email, d)).via, "platform");
    assert.equal(calls.platform.length, 3, "no customer email is lost");
    const mine = warnings.filter((w) => w.includes("warn-once-inf"));
    assert.equal(mine.length, 1, "one warning, not three");
    assert.match(mine[0], /Gmail sending is not working/);
    assert.match(mine[0], /accessNotConfigured/);
  } finally {
    spy.mock.restore();
  }
});

test("the Google panel says Gmail is not working when the latest customer email went out through the platform", () => {
  assert.equal(gmailSendingFailing(null), false, "no email sent yet: nothing to say");
  assert.equal(gmailSendingFailing({ providerMessageId: "gmail:18c3" }), false);
  assert.equal(gmailSendingFailing({ providerMessageId: "re_123abc" }), true, "sent by the platform provider = Gmail failed");
  assert.equal(gmailSendingFailing({ providerMessageId: null }), true);
});

test("S3: a dead-grant verdict from a Gmail send carries the version of the grant that was used", async () => {
  const connectedAt = new Date("2030-01-01T00:00:00Z");
  const seen: (Date | undefined)[] = [];
  const ctx: InfluencerMailContext = { ...withGmail, gmail: { ...withGmail.gmail!, connectedAt } };
  const { d, calls } = deps(ctx, {
    refreshAccessToken: async () => { throw new GoogleReconnectError("Refresh token rejected"); },
    onReconnectNeeded: async (_id, _reason, at) => void seen.push(at),
  });

  const r = await sendCustomerEmail("inf", email, d);

  assert.equal(r.via, "platform", "the email still goes out");
  assert.deepEqual(seen, [connectedAt], "so a reconnect meanwhile is not marked dead by this stale error");
  assert.equal(calls.platform.length, 1);
});
