import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { GoogleReconnectError, GoogleRequestError, GoogleTransientError, buildAuthUrl, createGoogleClient, exchangeCode, revokeToken } from "../lib/google";
import { GMAIL_SEND_SCOPE, sendGmail } from "../lib/gmail";
import { control, raw, setFault, startMock, useMockEnv, type TestMock } from "./helpers/mock-server";

// The REAL Google clients of the app (lib/google.ts, lib/gmail.ts) driven against the mock server over HTTP: the same fetch, URL
// building and error classification the app runs in production, with only the host different (doc/11-provider-simulator.md, 6.4).

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
let t: TestMock;
let restoreEnv: () => void;
const google = () => createGoogleClient();
const when = { start: new Date("2030-03-01T10:00:00Z"), end: new Date("2030-03-01T10:30:00Z") };
let counter = 0;
const nextId = () => `testevent${String(++counter).padStart(4, "0")}`;

before(async () => {
  t = await startMock();
  restoreEnv = useMockEnv(t.mock);
});
after(async () => {
  restoreEnv();
  await t.stop();
});
afterEach(async () => {
  await control(t.mock, "/__mock/faults/clear");
});

const sameOrigin = () => ({ "content-type": "application/x-www-form-urlencoded", origin: t.mock.url, "sec-fetch-site": "same-origin" });

/** Walks the consent screen like a browser: GET the auth URL the app builds, POST the decision. Returns the redirect the app gets. */
async function consent(opts: { email?: string; other?: string; untick?: string[]; cancel?: boolean; access?: string; gmail?: boolean } = {}) {
  const authUrl = new URL(buildAuthUrl("app-state", undefined, { gmail: opts.gmail ?? true }));
  if (opts.access) authUrl.searchParams.set("access_type", opts.access);
  const page = await raw(t.mock, "GET", authUrl.pathname + authUrl.search);
  assert.equal(page.status, 200, page.text.slice(0, 300));
  const decisionId = /name="decisionId" value="([^"]+)"/.exec(page.text)?.[1];
  assert.ok(decisionId);
  const form = new URLSearchParams({ decisionId, account: opts.other ? "other" : (opts.email ?? "creator@mock-google.invalid"), action: opts.cancel ? "cancel" : "allow" });
  if (opts.other) form.set("other_account", opts.other);
  for (const s of [CALENDAR_SCOPE, GMAIL_SEND_SCOPE]) if (!opts.untick?.includes(s)) form.append("scope", s);
  const res = await raw(t.mock, "POST", "/google/o/oauth2/v2/auth/decision", sameOrigin(), form.toString());
  assert.equal(res.status, 302);
  return { page, redirect: new URL(String(res.headers.location)) };
}

/** A connected account: the refresh token the app would store, and a fresh access token. */
async function connect(email = "creator@mock-google.invalid", untick: string[] = []) {
  const { redirect } = await consent({ other: email, untick });
  const exchanged = await exchangeCode(redirect.searchParams.get("code")!);
  const accessToken = await google().refreshAccessToken(exchanged.refreshToken);
  return { ...exchanged, accessToken };
}

test("consent screen: the app's auth URL opens a page that says it is not Google, with both permissions ticked", async () => {
  const authUrl = new URL(buildAuthUrl("s1"));
  assert.equal(authUrl.origin, t.mock.url, "the app builds the URL from MOCK_PROVIDERS_URL");
  const page = await raw(t.mock, "GET", authUrl.pathname + authUrl.search);
  assert.equal(page.status, 200);
  assert.match(page.text, /MOCK GOOGLE, not Google/);
  assert.match(page.text, /creator@mock-google\.invalid/);
  assert.match(page.text, /calendar\.events/);
  assert.match(page.text, /gmail\.send/);
  assert.equal((page.text.match(/type="checkbox"[^>]*checked/g) ?? []).length, 2);
  assert.match(String(page.headers["content-security-policy"]), /form-action 'self' http:\/\/localhost:3000/);
});

test("consent: Allow redirects to the app with a single-use code, the state and the granted scopes; the code exchanges once", async () => {
  const { redirect } = await consent();
  assert.equal(redirect.origin + redirect.pathname, "http://localhost:3000/api/google/callback");
  assert.equal(redirect.searchParams.get("state"), "app-state");
  const code = redirect.searchParams.get("code")!;
  assert.match(code, /^MOCK-NOT-REAL-/);
  assert.match(redirect.searchParams.get("scope")!, /calendar\.events/);

  const r = await exchangeCode(code);
  assert.match(r.refreshToken, /^MOCK-NOT-REAL-grt-/);
  assert.ok(r.scope.split(" ").includes(CALENDAR_SCOPE) && r.scope.split(" ").includes(GMAIL_SEND_SCOPE));
  assert.ok(r.scope.split(" ").includes("openid") && r.scope.includes("userinfo.email"));
  assert.equal(r.email, "creator@mock-google.invalid");
  await assert.rejects(exchangeCode(code), (e: unknown) => e instanceof GoogleRequestError && /invalid_grant/.test(e.message));
});

test("consent: unticking a permission leaves it out of the scope (Google's granular consent)", async () => {
  const noGmail = await exchangeCode((await consent({ other: "no-gmail@mock-google.invalid", untick: [GMAIL_SEND_SCOPE] })).redirect.searchParams.get("code")!);
  assert.ok(noGmail.scope.includes(CALENDAR_SCOPE) && !noGmail.scope.includes(GMAIL_SEND_SCOPE));
  assert.equal(noGmail.email, "no-gmail@mock-google.invalid");
  const noCal = await exchangeCode((await consent({ other: "no-calendar@mock-google.invalid", untick: [CALENDAR_SCOPE] })).redirect.searchParams.get("code")!);
  assert.ok(!noCal.scope.includes(CALENDAR_SCOPE) && noCal.scope.includes(GMAIL_SEND_SCOPE));
});

test("consent: Cancel redirects with error=access_denied; online access gives no refresh token; a second consent adds to the grant", async () => {
  const { redirect } = await consent({ cancel: true });
  assert.equal(redirect.searchParams.get("error"), "access_denied");
  assert.equal(redirect.searchParams.get("state"), "app-state");
  assert.equal(redirect.searchParams.get("code"), null);

  const online = await consent({ access: "online" });
  await assert.rejects(exchangeCode(online.redirect.searchParams.get("code")!), (e: unknown) => e instanceof GoogleRequestError && /did not return a refresh token/.test(e.message));

  // include_granted_scopes: adding Gmail later keeps the Calendar permission granted earlier (incremental consent).
  const a = await exchangeCode((await consent({ other: "incremental@mock-google.invalid", untick: [GMAIL_SEND_SCOPE], gmail: false })).redirect.searchParams.get("code")!);
  assert.ok(!a.scope.includes(GMAIL_SEND_SCOPE));
  const b = await exchangeCode((await consent({ other: "incremental@mock-google.invalid", untick: [CALENDAR_SCOPE] })).redirect.searchParams.get("code")!);
  assert.ok(b.scope.includes(CALENDAR_SCOPE) && b.scope.includes(GMAIL_SEND_SCOPE));
  assert.notEqual(a.refreshToken, b.refreshToken, "a new refresh token on every consent");
  assert.equal(Object.values(t.mock.state().google.grants).filter((g) => g.email === "incremental@mock-google.invalid" && !g.revokedAt).length, 1, "one live grant per account");
});

test("consent: a wrong redirect_uri or client shows an error page and never redirects; a decision needs the same origin and works once", async () => {
  const good = new URL(buildAuthUrl("s2"));
  const bad = new URL(good);
  bad.searchParams.set("redirect_uri", "http://localhost:3999/api/google/callback");
  const mismatch = await raw(t.mock, "GET", bad.pathname + bad.search);
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.text, /redirect_uri_mismatch/);
  assert.equal(mismatch.headers.location, undefined);
  const wrongClient = new URL(good);
  wrongClient.searchParams.set("client_id", "someone-else");
  const unknown = await raw(t.mock, "GET", wrongClient.pathname + wrongClient.search);
  assert.equal(unknown.status, 401);
  assert.match(unknown.text, /invalid_client/);

  const page = await raw(t.mock, "GET", good.pathname + good.search);
  const decisionId = /name="decisionId" value="([^"]+)"/.exec(page.text)![1];
  const body = new URLSearchParams({ decisionId, account: "creator@mock-google.invalid", action: "allow" }).toString();
  assert.equal((await raw(t.mock, "POST", "/google/o/oauth2/v2/auth/decision", { ...sameOrigin(), "sec-fetch-site": "cross-site" }, body)).status, 403);
  assert.equal((await raw(t.mock, "POST", "/google/o/oauth2/v2/auth/decision", { ...sameOrigin(), origin: "http://evil.example" }, body)).status, 403);
  assert.equal((await raw(t.mock, "POST", "/google/o/oauth2/v2/auth/decision", sameOrigin(), body)).status, 302);
  const again = await raw(t.mock, "POST", "/google/o/oauth2/v2/auth/decision", sameOrigin(), body);
  assert.equal(again.status, 400, "a consent request can be answered once");
  assert.equal(again.headers.location, undefined);
  const notMock = new URLSearchParams({ decisionId: /name="decisionId" value="([^"]+)"/.exec((await raw(t.mock, "GET", good.pathname + good.search)).text)![1], account: "other", other_account: "real@gmail.com", action: "allow" });
  assert.equal((await raw(t.mock, "POST", "/google/o/oauth2/v2/auth/decision", sameOrigin(), notMock.toString())).status, 400, "only @mock-google.invalid accounts exist here");
});

test("the token endpoint checks the client id and secret", async () => {
  const bad = await raw(t.mock, "POST", "/google/token", { "content-type": "application/x-www-form-urlencoded" }, new URLSearchParams({ grant_type: "refresh_token", refresh_token: "x", client_id: "mock-client-id.apps.mock-google.invalid", client_secret: "wrong" }).toString());
  assert.equal(bad.status, 401);
  assert.equal(bad.json().error, "invalid_client");
  assert.ok(!bad.text.includes("MOCK-NOT-REAL-google-client-secret"));
});

test("calendar: insert gives a Meet link on the mock, the same id again is 'exists', get reads it back", async () => {
  const { accessToken } = await connect("cal1@mock-google.invalid");
  const id = nextId();
  const created = await google().insertEvent(accessToken, { id, summary: "1:1 Career Call with Demo Creator", description: "d", ...when, attendee: { email: "asha@example.com", displayName: "Asha" }, conferenceRequestId: "req-1" });
  assert.notEqual(created, "exists");
  const event = created as Exclude<typeof created, "exists">;
  assert.equal(event.id, id);
  assert.equal(event.status, "confirmed");
  assert.equal(event.conferenceStatus, "success");
  assert.match(event.meetLink!, new RegExp(`^${t.mock.url}/meet/mock-[a-z0-9]{4}-[a-z0-9]{4}$`));
  assert.ok(!event.meetLink!.includes("meet.google.com"));
  assert.equal(await google().insertEvent(accessToken, { id, summary: "again", description: "", ...when, attendee: { email: "a@b.co", displayName: "A" }, conferenceRequestId: "req-1" }), "exists");
  assert.deepEqual((await google().getEvent(accessToken, id))?.meetLink, event.meetLink);
  assert.equal(await google().getEvent(accessToken, "doesnotexist1"), null);
  await assert.rejects(google().insertEvent(accessToken, { id: "BAD_ID!", summary: "s", description: "", ...when, attendee: { email: "a@b.co", displayName: "A" }, conferenceRequestId: "r" }), GoogleRequestError);
  const invites = t.mock.state().google.invites.filter((i) => i.eventId === id);
  assert.deepEqual(invites.map((i) => [i.to, i.kind]), [["asha@example.com", "invite"]], "sendUpdates=all: Google would email an invite");
});

test("calendar: attendee changes carry If-Match; an injected 412 makes the app read again and retry", async () => {
  const { accessToken } = await connect("cal2@mock-google.invalid");
  const id = nextId();
  await google().insertEvent(accessToken, { id, summary: "Group", description: "", ...when, attendee: { email: "one@example.com", displayName: "One" }, conferenceRequestId: "r2" });
  await setFault(t.mock, "google.patch412", "once");
  await google().addAttendee(accessToken, id, { email: "two@example.com", displayName: "Two" });
  const patches = t.mock.state().requests.filter((r) => r.method === "PATCH" && r.path.includes(id));
  assert.deepEqual(patches.map((r) => r.status), [412, 200], "a 412, then the retry");
  assert.ok(patches.every((r) => r.ifMatch), "both writes carried If-Match");
  assert.equal(t.mock.state().faults["google.patch412"], undefined, "the fault applied once");
  const e = t.mock.state().google.calendars["cal2@mock-google.invalid"][id];
  assert.deepEqual(e.attendees.map((a) => a.email), ["one@example.com", "two@example.com"]);
  // Adding the same attendee again is a no-op; removing works; removing someone absent is a no-op.
  await google().addAttendee(accessToken, id, { email: "TWO@example.com", displayName: "Two" });
  assert.equal(e.attendees.length, 2);
  assert.deepEqual(await google().removeAttendee(accessToken, id, "one@example.com"), { remaining: 1 });
  assert.deepEqual(await google().removeAttendee(accessToken, id, "nobody@example.com"), { remaining: 1 });
  assert.deepEqual(e.attendees.map((a) => a.email), ["two@example.com"]);
  assert.ok(t.mock.state().google.invites.some((i) => i.eventId === id && i.to === "one@example.com" && i.kind === "cancel"));
});

test("calendar: updateEvent moves the time (sequence +1, an update is logged); delete leaves a tombstone, purge makes it 410", async () => {
  const { accessToken } = await connect("cal3@mock-google.invalid");
  const id = nextId();
  await google().insertEvent(accessToken, { id, summary: "Move me", description: "", ...when, attendee: { email: "m@example.com", displayName: "M" }, conferenceRequestId: "r3" });
  const e = t.mock.state().google.calendars["cal3@mock-google.invalid"][id];
  const etag = e.etag;
  await google().updateEvent(accessToken, id, { start: new Date("2030-03-02T10:00:00Z"), end: new Date("2030-03-02T10:30:00Z") });
  assert.equal(e.seq, 1);
  assert.ok(e.etag > etag);
  assert.equal(e.start.dateTime, "2030-03-02T10:00:00.000Z");
  assert.ok(t.mock.state().google.invites.some((i) => i.eventId === id && i.kind === "update"));
  await assert.rejects(google().updateEvent(accessToken, "doesnotexist2", when), (e2: unknown) => e2 instanceof GoogleRequestError && /no longer exists/.test((e2 as Error).message));

  await google().deleteEvent(accessToken, id);
  assert.equal((await google().getEvent(accessToken, id))?.status, "cancelled", "a deleted event is readable as a cancelled tombstone");
  assert.equal(await google().insertEvent(accessToken, { id, summary: "again", description: "", ...when, attendee: { email: "a@b.co", displayName: "A" }, conferenceRequestId: "r3" }), "exists", "an id is never reusable");
  await assert.rejects(google().addAttendee(accessToken, id, { email: "late@example.com", displayName: "L" }), /deleted/);
  await control(t.mock, "/__mock/google/purge");
  assert.equal(await google().getEvent(accessToken, id), null, "purged: 410, which the app reads as gone");
  assert.equal(await google().insertEvent(accessToken, { id, summary: "again", description: "", ...when, attendee: { email: "a@b.co", displayName: "A" }, conferenceRequestId: "r3" }), "exists", "even a purged id is taken");
  await google().deleteEvent(accessToken, id); // deleting again resolves
  await google().deleteEvent(accessToken, "neverexisted01");
});

test("calendar: 'delete behind the app's back' leaves a tombstone the app treats as gone", async () => {
  const { accessToken } = await connect("cal4@mock-google.invalid");
  const id = nextId();
  await google().insertEvent(accessToken, { id, summary: "Doomed", description: "", ...when, attendee: { email: "d@example.com", displayName: "D" }, conferenceRequestId: "r4" });
  await control(t.mock, "/__mock/google/delete-event", { account: "cal4@mock-google.invalid", eventId: id });
  assert.equal((await google().getEvent(accessToken, id))?.status, "cancelled");
  await assert.rejects(google().addAttendee(accessToken, id, { email: "x@example.com", displayName: "X" }), /deleted/);
});

test("google.meet=pending_2s: the insert is pending, and a read 2 s later has the link", async () => {
  const { accessToken } = await connect("cal5@mock-google.invalid");
  await setFault(t.mock, "google.meet", "pending_2s");
  const id = nextId();
  const created = (await google().insertEvent(accessToken, { id, summary: "Slow", description: "", ...when, attendee: { email: "s@example.com", displayName: "S" }, conferenceRequestId: "r5" })) as { conferenceStatus: string; meetLink: string | null };
  assert.equal(created.conferenceStatus, "pending");
  assert.equal(created.meetLink, null);
  assert.equal((await google().getEvent(accessToken, id))?.conferenceStatus, "pending");
  await new Promise((r) => setTimeout(r, 2100));
  assert.match((await google().getEvent(accessToken, id))!.meetLink!, /\/meet\/mock-/);
  await setFault(t.mock, "google.meet", "pending_forever");
  const id2 = nextId();
  await google().insertEvent(accessToken, { id: id2, summary: "Never", description: "", ...when, attendee: { email: "s@example.com", displayName: "S" }, conferenceRequestId: "r6" });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await google().getEvent(accessToken, id2))?.conferenceStatus, "pending");
  await setFault(t.mock, "google.meet", "failure");
  const id3 = nextId();
  const failed = (await google().insertEvent(accessToken, { id: id3, summary: "Broken", description: "", ...when, attendee: { email: "s@example.com", displayName: "S" }, conferenceRequestId: "r7" })) as { conferenceStatus: string };
  assert.equal(failed.conferenceStatus, "failure");
});

test("faults are classified by the app's real error handling", async () => {
  const { accessToken, refreshToken } = await connect("faults@mock-google.invalid");
  const refresh = (value: string) => setFault(t.mock, "google.refresh", value);
  await refresh("invalid_grant");
  await assert.rejects(google().refreshAccessToken(refreshToken), GoogleReconnectError);
  await refresh("invalid_client");
  await assert.rejects(google().refreshAccessToken(refreshToken), GoogleTransientError);
  await refresh("500");
  await assert.rejects(google().refreshAccessToken(refreshToken), GoogleTransientError);
  await refresh("ok");
  assert.ok(await google().refreshAccessToken(refreshToken));

  const cases: [string, new (...a: never[]) => Error][] = [
    ["401", GoogleReconnectError],
    ["403_accessNotConfigured", GoogleTransientError],
    ["403_insufficientPermissions", GoogleReconnectError],
    ["403_rateLimitExceeded", GoogleTransientError],
    ["429", GoogleTransientError],
    ["500", GoogleTransientError],
  ];
  for (const [value, kind] of cases) {
    await setFault(t.mock, "google.calendar", value);
    await assert.rejects(google().getEvent(accessToken, "whatever1234"), kind, `google.calendar=${value}`);
  }
  await setFault(t.mock, "google.calendar", "ok");
  assert.equal(await google().getEvent(accessToken, "whatever1234"), null);

  await setFault(t.mock, "google.code", "invalid_grant");
  const { redirect } = await consent({ other: "faults2@mock-google.invalid" });
  await assert.rejects(exchangeCode(redirect.searchParams.get("code")!), (e: unknown) => e instanceof GoogleRequestError && /invalid_grant/.test((e as Error).message));
  await setFault(t.mock, "google.code", "no_refresh_token");
  const second = await consent({ other: "faults3@mock-google.invalid" });
  await assert.rejects(exchangeCode(second.redirect.searchParams.get("code")!), /did not return a refresh token/);
});

test("revoking: a revoked grant is a dead grant for every token, whether the user or the app revoked it", async () => {
  const a = await connect("revoke1@mock-google.invalid");
  const grantId = Object.entries(t.mock.state().google.grants).find(([, g]) => g.email === "revoke1@mock-google.invalid")![0];
  await control(t.mock, "/__mock/google/revoke-grant", { grantId });
  await assert.rejects(google().refreshAccessToken(a.refreshToken), (e: unknown) => e instanceof GoogleReconnectError && /Token has been expired or revoked/.test((e as Error).message));
  await assert.rejects(google().getEvent(a.accessToken, "whatever1234"), GoogleReconnectError, "its access token is dead too");

  // The app's own revokeToken ends the whole grant: another refresh token of the same grant stops working as well.
  const first = await connect("revoke2@mock-google.invalid");
  const secondConsent = await exchangeCode((await consent({ other: "revoke2@mock-google.invalid" })).redirect.searchParams.get("code")!);
  assert.notEqual(first.refreshToken, secondConsent.refreshToken);
  assert.ok(await google().refreshAccessToken(secondConsent.refreshToken));
  await revokeToken(first.refreshToken);
  await assert.rejects(google().refreshAccessToken(secondConsent.refreshToken), GoogleReconnectError);
  await revokeToken("MOCK-NOT-REAL-grt-unknown"); // best effort: an unknown token does not throw

  const c = await connect("expire@mock-google.invalid");
  await control(t.mock, "/__mock/google/expire-access");
  await assert.rejects(google().getEvent(c.accessToken, "whatever1234"), GoogleReconnectError, "an expired access token is 401");
  assert.ok(await google().refreshAccessToken(c.refreshToken), "and a refresh gets a new one");
});

test("gmail: a sent message is decoded and recorded with its subject, text, html and sender; non-ASCII round-trips", async () => {
  const { accessToken } = await connect("mailer@mock-google.invalid");
  const sent = await sendGmail(accessToken, {
    fromName: "Séance Créatrice",
    fromEmail: "mailer@mock-google.invalid",
    to: { email: "asha@example.com", name: "Asha Rao" },
    subject: "Réservation confirmée — 5 € ✓",
    html: "<p>Hello <b>Asha</b></p>",
    text: "Hello Asha, joignez: http://x.test/manage",
    replyTo: "mailer@mock-google.invalid",
  });
  assert.match(sent.id, /^[0-9a-f]{16}$/);
  const mail = t.mock.state().google.sentMail["mailer@mock-google.invalid"].at(-1)!;
  assert.equal(mail.id, sent.id);
  assert.equal(mail.subject, "Réservation confirmée — 5 € ✓");
  assert.equal(mail.text, "Hello Asha, joignez: http://x.test/manage");
  assert.equal(mail.html, "<p>Hello <b>Asha</b></p>");
  assert.equal(mail.from, "mailer@mock-google.invalid");
  assert.match(mail.fromDisplay, /Séance Créatrice/);
  assert.equal(mail.to, "asha@example.com");
  assert.equal(mail.replyTo, "mailer@mock-google.invalid");
  assert.equal(mail.fromRewritten, false);

  await sendGmail(accessToken, { fromName: "Someone", fromEmail: "other@elsewhere.test", to: { email: "b@example.com" }, subject: "Plain", html: "<p>x</p>", text: "x" });
  assert.equal(t.mock.state().google.sentMail["mailer@mock-google.invalid"].at(-1)!.fromRewritten, true, "a From that is not the connected account is flagged");
});

test("gmail: faults and missing permission reach the app as request errors it falls back from", async () => {
  const { accessToken } = await connect("mailer2@mock-google.invalid");
  const msg = { fromName: "F", fromEmail: "mailer2@mock-google.invalid", to: { email: "c@example.com" }, subject: "s", html: "<p>h</p>", text: "t" };
  await setFault(t.mock, "google.gmail", "403_accessNotConfigured");
  await assert.rejects(sendGmail(accessToken, msg), (e: unknown) => e instanceof GoogleRequestError && /Gmail API/.test((e as Error).message));
  await setFault(t.mock, "google.gmail", "401");
  await assert.rejects(sendGmail(accessToken, msg), GoogleReconnectError);
  await setFault(t.mock, "google.gmail", "429");
  await assert.rejects(sendGmail(accessToken, msg), GoogleTransientError);
  await control(t.mock, "/__mock/faults/clear");

  const noGmail = await connect("nogmail@mock-google.invalid", [GMAIL_SEND_SCOPE]);
  await assert.rejects(sendGmail(noGmail.accessToken, msg), (e: unknown) => e instanceof GoogleRequestError && /insufficientPermissions/.test((e as Error).message));
  await assert.rejects(sendGmail("MOCK-NOT-REAL-unknown", msg), GoogleReconnectError);
  const noCalendar = await connect("nocal@mock-google.invalid", [CALENDAR_SCOPE]);
  await assert.rejects(google().getEvent(noCalendar.accessToken, "whatever1234"), GoogleReconnectError, "a missing Calendar scope is a reconnect (as in classifyCalendarError)");
});

test("latency.google delays every Google answer, and 'reset' drops the connection as a transient error", async () => {
  const { accessToken } = await connect("slow@mock-google.invalid");
  await setFault(t.mock, "latency.google", "300");
  const started = Date.now();
  await google().getEvent(accessToken, "whatever1234");
  assert.ok(Date.now() - started >= 290, `took ${Date.now() - started} ms`);
  await setFault(t.mock, "latency.google", "reset", true);
  await assert.rejects(google().getEvent(accessToken, "whatever1234"), GoogleTransientError);
  assert.equal(await google().getEvent(accessToken, "whatever1234"), null, "'once' applied to one request only");
});
