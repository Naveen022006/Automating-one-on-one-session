import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, MOCK_ACCOUNT_DOMAIN } from "./fixtures";
import { takeFault } from "./faults";
import { HttpError, addControl, randomHex, requireSameOrigin, type Ctx, type Router, type Runtime } from "./http";
import type { Grant, MockEvent } from "./state";
import { esc, renderPlainPage } from "./ui";

/**
 * Mock of the Google calls the app makes: OAuth consent, token and revoke, and Calendar events with Meet links. Response shapes
 * follow what lib/google.ts reads (see doc/11-provider-simulator.md, 3.3); each cites Google's reference:
 *   OAuth 2.0 for web server apps    https://developers.google.com/identity/protocols/oauth2/web-server
 *   Token revocation                 https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke
 *   Calendar events (insert, get, patch, delete)   https://developers.google.com/calendar/api/v3/reference/events
 *   Meet via conferenceData          https://developers.google.com/calendar/api/guides/create-events#conferencing
 * The Meet link is deliberately NOT a meet.google.com link: a random code in Meet's real format could be a stranger's live meeting.
 */

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const USERINFO_EMAIL = "https://www.googleapis.com/auth/userinfo.email";
const USERINFO_PROFILE = "https://www.googleapis.com/auth/userinfo.profile";
const IDENTITY = new Set(["openid", "email", "profile", USERINFO_EMAIL, USERINFO_PROFILE]);
const expandScope = (s: string) => (s === "email" ? USERINFO_EMAIL : s === "profile" ? USERINFO_PROFILE : s);

const CODE_TTL_MS = 10 * 60_000;
const ACCESS_TOKEN_TTL_S = 3599;
const SCOPE_LABELS: Record<string, string> = {
  [CALENDAR_SCOPE]: "View and edit events on all your calendars",
  [GMAIL_SEND_SCOPE]: "Send email on your behalf",
};

/* ---------- error bodies ---------- */

export function apiError(status: number, message: string, statusName: string, reason: string, domain = "global"): HttpError {
  return new HttpError(status, { error: { code: status, message, status: statusName, errors: [{ message, domain, reason }] } });
}
const oauthError = (status: number, error: string, description: string) => new HttpError(status, { error, error_description: description });

const unauthenticated = () =>
  apiError(401, "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.", "UNAUTHENTICATED", "authError");
const insufficientScope = () => apiError(403, "Request had insufficient authentication scopes.", "PERMISSION_DENIED", "insufficientPermissions");

/** The error a `google.calendar` / `google.gmail` fault stands for, or null for "ok". */
export function injectedApiError(value: string, api: "Calendar" | "Gmail"): HttpError | null {
  switch (value) {
    case "401":
      return unauthenticated();
    case "403_accessNotConfigured":
      return apiError(
        403,
        `Google ${api} API has not been used in project 000000000000 before or it is disabled. Enable it by visiting the Google Cloud console (MOCK) then retry. If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.`,
        "PERMISSION_DENIED",
        "accessNotConfigured",
        "usageLimits",
      );
    case "403_insufficientPermissions":
      return insufficientScope();
    case "403_rateLimitExceeded":
      return apiError(403, "Rate Limit Exceeded", "PERMISSION_DENIED", "rateLimitExceeded", "usageLimits");
    case "429":
      return apiError(429, "Too Many Requests", "RESOURCE_EXHAUSTED", "rateLimitExceeded", "usageLimits");
    case "500":
      return apiError(500, "Internal error encountered.", "INTERNAL", "backendError");
    default:
      return null;
  }
}

/* ---------- accounts, grants, tokens ---------- */

function mint(prefix: string): string {
  return `MOCK-NOT-REAL-${prefix}-${randomHex(12)}`;
}

/** The live grant for (client, account), or null. */
function liveGrant(rt: Runtime, email: string): [string, Grant] | null {
  for (const [id, g] of Object.entries(rt.state.google.grants)) if (g.clientId === GOOGLE_CLIENT_ID && g.email === email && !g.revokedAt) return [id, g];
  return null;
}

function revokeGrant(rt: Runtime, grantId: string, why: string): void {
  const g = rt.state.google.grants[grantId];
  if (!g || g.revokedAt) return;
  g.revokedAt = new Date(rt.now()).toISOString();
  rt.save();
  rt.activity(`Google: the grant of ${g.email} was revoked (${why})`, "/__mock/google");
}

/** Revoking any token of a grant revokes the whole grant (client + account), as Google does. */
function grantOfToken(rt: Runtime, token: string): string | null {
  return rt.state.google.refreshTokens[token] ?? rt.state.google.accessTokens[token]?.grantId ?? null;
}

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function idToken(rt: Runtime, email: string, sub: string, clientId: string): string {
  const iat = Math.floor(rt.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "none", typ: "JWT", kid: "mock-providers" }));
  const payload = b64url(JSON.stringify({ iss: `${rt.origin}/google`, aud: clientId, sub, email, email_verified: true, iat, exp: iat + ACCESS_TOKEN_TTL_S }));
  return `${header}.${payload}.${b64url("MOCK-NOT-REAL")}`;
}

function issueAccessToken(rt: Runtime, grantId: string): string {
  const token = mint("gat");
  rt.state.google.accessTokens[token] = { grantId, expiresAt: rt.now() + ACCESS_TOKEN_TTL_S * 1000 };
  return token;
}

function checkClient(form: URLSearchParams): void {
  if (form.get("client_id") !== GOOGLE_CLIENT_ID) throw oauthError(401, "invalid_client", "The OAuth client was not found.");
  if (form.get("client_secret") !== GOOGLE_CLIENT_SECRET) throw oauthError(401, "invalid_client", "Unauthorized");
}

async function tokenEndpoint(c: Ctx): Promise<void> {
  const rt = c.rt;
  const form = await c.readForm();
  checkClient(form);
  const grantType = form.get("grant_type");

  if (grantType === "authorization_code") {
    const codeFault = takeFault(rt, "google.code", c);
    if (codeFault === "invalid_grant") throw oauthError(400, "invalid_grant", "Bad Request");
    const code = form.get("code") ?? "";
    const rec = rt.state.google.codes[code];
    if (!rec || rec.used || rec.expiresAt <= rt.now() || rec.clientId !== GOOGLE_CLIENT_ID || rec.redirectUri !== form.get("redirect_uri")) {
      throw oauthError(400, "invalid_grant", "Bad Request");
    }
    rec.used = true;
    // One live grant per (client, account). With include_granted_scopes an earlier grant's scopes are part of the new token.
    const existing = liveGrant(rt, rec.email);
    let grantId: string;
    let scopes = rec.scopes;
    if (existing && rec.includeGranted) {
      grantId = existing[0];
      scopes = [...new Set([...existing[1].scopes, ...rec.scopes])];
      existing[1].scopes = scopes;
    } else {
      if (existing) revokeGrant(rt, existing[0], "replaced by a new consent");
      grantId = `grant-${randomHex(6)}`;
      rt.state.google.grants[grantId] = { clientId: rec.clientId, email: rec.email, scopes, createdAt: new Date(rt.now()).toISOString(), revokedAt: null };
    }
    const account = rt.state.google.accounts[rec.email];
    const body: Record<string, unknown> = {
      access_token: issueAccessToken(rt, grantId),
      expires_in: ACCESS_TOKEN_TTL_S,
      token_type: "Bearer",
      scope: scopes.join(" "),
    };
    if (rec.offline && codeFault !== "no_refresh_token") {
      const refresh = mint("grt");
      rt.state.google.refreshTokens[refresh] = grantId;
      body.refresh_token = refresh;
    }
    if (scopes.includes("openid") || scopes.includes(USERINFO_EMAIL)) body.id_token = idToken(rt, rec.email, account?.sub ?? "mock-sub", rec.clientId);
    rt.save();
    rt.activity(`Google: ${rec.email} allowed ${scopes.filter((s) => !IDENTITY.has(s)).map((s) => s.split("/").pop()).join(" + ") || "nothing but sign-in"}; the app exchanged its code`, "/__mock/google");
    return c.sendJson(200, body);
  }

  if (grantType === "refresh_token") {
    const fault = takeFault(rt, "google.refresh", c);
    if (fault === "invalid_grant") throw oauthError(400, "invalid_grant", "Token has been expired or revoked.");
    if (fault === "invalid_client") throw oauthError(401, "invalid_client", "The OAuth client was not found.");
    if (fault === "500") throw apiError(500, "Internal error encountered.", "INTERNAL", "backendError");
    const grantId = rt.state.google.refreshTokens[form.get("refresh_token") ?? ""];
    const grant = grantId ? rt.state.google.grants[grantId] : undefined;
    if (!grant || grant.revokedAt) throw oauthError(400, "invalid_grant", "Token has been expired or revoked.");
    return c.sendJson(200, { access_token: issueAccessToken(rt, grantId), expires_in: ACCESS_TOKEN_TTL_S, scope: grant.scopes.join(" "), token_type: "Bearer" });
  }

  throw oauthError(400, "unsupported_grant_type", "Invalid grant_type");
}

async function revokeEndpoint(c: Ctx): Promise<void> {
  const form = await c.readForm();
  const token = c.query.get("token") ?? form.get("token") ?? "";
  const grantId = grantOfToken(c.rt, token);
  if (!grantId) throw oauthError(400, "invalid_token", "Token expired or revoked");
  revokeGrant(c.rt, grantId, "the app disconnected");
  c.sendJson(200, {});
}

/* ---------- the consent page ---------- */

function errorPage(c: Ctx, status: number, title: string, text: string): void {
  c.sendHtml(
    status,
    renderPlainPage({
      title: `MOCK Google: ${title}`,
      banner: "MOCK GOOGLE, not Google. Nothing on this page talks to Google.",
      body: `<h1>${esc(title)}</h1><p>${esc(text)}</p><p class="muted">This is the mock's version of Google's error page. No redirect was made.</p>`,
    }),
  );
}

function consentPage(c: Ctx): void {
  const rt = c.rt;
  const q = c.query;
  const redirectUri = q.get("redirect_uri") ?? "";
  // Google shows its error pages (and does not redirect) for a wrong client or an unregistered redirect URI.
  if (q.get("client_id") !== GOOGLE_CLIENT_ID) return errorPage(c, 401, "Error 401: invalid_client", "The OAuth client was not found.");
  if (redirectUri !== `${rt.appUrl}/api/google/callback`) {
    return errorPage(c, 400, "Error 400: redirect_uri_mismatch", `The redirect URI in the request does not match the ones authorized for the OAuth client. The registered one is ${rt.appUrl}/api/google/callback; check GOOGLE_REDIRECT_URI.`);
  }
  if (q.get("response_type") !== "code") return errorPage(c, 400, "Error 400: invalid_request", "Missing or unsupported response_type (the app must ask for code).");
  const requested = (q.get("scope") ?? "").split(/\s+/).filter(Boolean).map(expandScope);
  if (requested.length === 0) return errorPage(c, 400, "Error 400: invalid_scope", "Some requested scopes were invalid.");

  // Forget consent requests nobody finished.
  for (const [id, d] of Object.entries(rt.state.google.pendingDecisions)) if (d.expiresAt <= rt.now()) delete rt.state.google.pendingDecisions[id];
  const decisionId = mint("dec");
  const hint = q.get("login_hint");
  rt.state.google.pendingDecisions[decisionId] = {
    clientId: GOOGLE_CLIENT_ID,
    redirectUri,
    state: q.get("state") ?? "",
    scopes: requested,
    accessType: q.get("access_type") ?? "online",
    includeGranted: q.get("include_granted_scopes") === "true",
    loginHint: hint,
    expiresAt: rt.now() + CODE_TTL_MS,
  };
  rt.save();

  const accounts = Object.values(rt.state.google.accounts);
  const hinted = hint && rt.state.google.accounts[hint] ? hint : null;
  const chosen = hinted ?? accounts[0]?.email;
  const radios = accounts
    .map((a) => `<label style="display:block;margin:4px 0"><input type="radio" name="account" value="${esc(a.email)}"${a.email === chosen ? " checked" : ""}> ${esc(a.name)} <span class="muted">${esc(a.email)}</span></label>`)
    .join("");
  const boxes = requested
    .filter((s) => !IDENTITY.has(s))
    .map((s) => `<label style="display:block;margin:4px 0"><input type="checkbox" name="scope" value="${esc(s)}" checked> ${esc(SCOPE_LABELS[s] ?? "Use this permission")} <span class="muted mono">${esc(s)}</span></label>`)
    .join("");

  c.sendHtml(
    200,
    renderPlainPage({
      title: "MOCK Google: choose an account",
      banner: "MOCK GOOGLE, not Google. Nothing on this page talks to Google.",
      body: `<h1>Sign in to continue to the app</h1>
${hint && !hinted ? `<p class="muted">hint: ${esc(hint)} (not a mock account)</p>` : ""}
<form method="post" action="/google/o/oauth2/v2/auth/decision">
<input type="hidden" name="decisionId" value="${esc(decisionId)}">
<h2>Choose an account</h2>${radios}
<label style="display:block;margin:4px 0"><input type="radio" name="account" value="other"> another address <input name="other_account" placeholder="name@${esc(MOCK_ACCOUNT_DOMAIN)}" size="30"></label>
<h2>The app wants to</h2><p class="muted">Untick a permission to see what the app does without it (Google's granular consent). Sign-in itself (name and email) is always shared.</p>${boxes || '<p class="muted">no extra permissions</p>'}
<p style="margin-top:16px"><button name="action" value="allow">Allow</button> <button name="action" value="cancel">Cancel</button></p>
</form>
<p class="muted">The real Google consent screen differs: it may show an "unverified app" warning, test-user restrictions and the restricted-scope verification for gmail.send. See "What this does not prove" on the control page.</p>`,
    }),
  );
}

async function decisionEndpoint(c: Ctx): Promise<void> {
  const rt = c.rt;
  requireSameOrigin(c);
  const form = await c.readForm();
  const id = form.get("decisionId") ?? "";
  const pending = rt.state.google.pendingDecisions[id];
  delete rt.state.google.pendingDecisions[id]; // single use
  if (!pending || pending.expiresAt <= rt.now()) return errorPage(c, 400, "This sign-in request expired", "Go back to the app and press Connect again.");

  const target = new URL(pending.redirectUri);
  if (form.get("action") !== "allow") {
    target.searchParams.set("error", "access_denied");
    target.searchParams.set("state", pending.state);
    rt.activity("Google: the consent screen was cancelled", "/__mock/google");
    return c.redirect(target.toString());
  }

  let email = form.get("account") ?? "";
  if (email === "other") {
    email = (form.get("other_account") ?? "").trim().toLowerCase();
    if (!new RegExp(`^[a-z0-9._+-]+@${MOCK_ACCOUNT_DOMAIN.replace(/\./g, "\\.")}$`).test(email)) {
      return errorPage(c, 400, "That is not a mock account", `Mock accounts end in @${MOCK_ACCOUNT_DOMAIN}. Go back and try again.`);
    }
  }
  if (!email.endsWith(`@${MOCK_ACCOUNT_DOMAIN}`)) return errorPage(c, 400, "Choose an account", "Pick one of the mock accounts.");
  rt.state.google.accounts[email] ??= { email, name: email.split("@")[0], sub: `mock-sub-${randomHex(4)}` };

  const ticked = new Set(form.getAll("scope"));
  const granted = pending.scopes.filter((s) => IDENTITY.has(s) || ticked.has(s));
  const code = mint("gcode");
  rt.state.google.codes[code] = {
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    email,
    scopes: granted,
    offline: pending.accessType === "offline",
    includeGranted: pending.includeGranted,
    expiresAt: rt.now() + CODE_TTL_MS,
    used: false,
  };
  rt.save();
  target.searchParams.set("code", code);
  target.searchParams.set("state", pending.state);
  target.searchParams.set("scope", granted.join(" "));
  c.redirect(target.toString());
}

/* ---------- Calendar ---------- */

const EVENT_ID = /^[a-v0-9]{5,1024}$/;
const MEET_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function meetCode(): string {
  const pick = (n: number) => Array.from({ length: n }, () => MEET_ALPHABET[Math.floor(Math.random() * MEET_ALPHABET.length)]).join("");
  return `mock-${pick(4)}-${pick(4)}`;
}

/** The account behind the request's access token, after the fault and the checks every Google API call goes through. */
export function authenticate(c: Ctx, scope: string, api: "Calendar" | "Gmail"): { grantId: string; grant: Grant; email: string } {
  const rt = c.rt;
  const injected = injectedApiError(takeFault(rt, api === "Calendar" ? "google.calendar" : "google.gmail", c), api);
  if (injected) throw injected;
  const token = c.bearer();
  const rec = token ? rt.state.google.accessTokens[token] : undefined;
  const grant = rec ? rt.state.google.grants[rec.grantId] : undefined;
  if (!rec || !grant || grant.revokedAt || rec.expiresAt <= rt.now()) throw unauthenticated();
  if (!grant.scopes.includes(scope)) throw insufficientScope();
  return { grantId: rec.grantId, grant, email: grant.email };
}

const calendarOf = (rt: Runtime, email: string): Record<string, MockEvent> => (rt.state.google.calendars[email] ??= {});

/** A pending conference becomes ready when its time has come. */
function settleConference(rt: Runtime, e: MockEvent): void {
  if (e.conference?.status === "pending" && e.conference.readyAt !== null && rt.now() >= e.conference.readyAt) {
    e.conference.status = "success";
    rt.save();
  }
}

export function eventJson(rt: Runtime, email: string, e: MockEvent): Record<string, unknown> {
  settleConference(rt, e);
  const out: Record<string, unknown> = {
    kind: "calendar#event",
    id: e.id,
    etag: `"${e.etag}"`,
    status: e.status,
    htmlLink: `${rt.origin}/__mock/google#event-${e.id}`,
    created: e.created,
    updated: e.updated,
    summary: e.summary,
    description: e.description,
    creator: { email },
    organizer: { email, self: true },
    start: e.start,
    end: e.end,
    sequence: e.seq,
    attendees: e.attendees,
    guestsCanInviteOthers: false,
    guestsCanModify: false,
    reminders: { useDefault: true },
  };
  const conf = e.conference;
  if (conf) {
    const link = conf.status === "success" && conf.code ? `${rt.origin}/meet/${conf.code}` : null;
    if (link) out.hangoutLink = link;
    out.conferenceData = {
      createRequest: { requestId: conf.requestId, conferenceSolutionKey: { type: "hangoutsMeet" }, status: { statusCode: conf.status } },
      ...(link
        ? {
            entryPoints: [{ entryPointType: "video", uri: link, label: link }],
            conferenceSolution: { key: { type: "hangoutsMeet" }, name: "Google Meet (MOCK)" },
            conferenceId: conf.code,
          }
        : {}),
    };
  }
  return out;
}

const notFound = () => apiError(404, "Not Found", "NOT_FOUND", "notFound");
const gone = () => apiError(410, "Resource has been deleted", "FAILED_PRECONDITION", "deleted");
const preconditionFailed = () => apiError(412, "Precondition Failed", "FAILED_PRECONDITION", "conditionNotMet");

function logInvites(rt: Runtime, account: string, e: MockEvent, kind: "invite" | "update" | "cancel", to: string[]): void {
  for (const addr of to) {
    rt.state.google.invites.push({ at: new Date(rt.now()).toISOString(), account, eventId: e.id, to: addr, kind });
    const verb = kind === "invite" ? "an invite" : kind === "update" ? "an update" : "a cancellation";
    rt.activity(`Google would email ${verb} to ${addr} for "${e.summary}"`, `/__mock/google#event-${e.id}`);
  }
  if (rt.state.google.invites.length > 500) rt.state.google.invites.splice(0, rt.state.google.invites.length - 500);
}

const sendsUpdates = (c: Ctx) => c.query.get("sendUpdates") === "all";
const stamp = (rt: Runtime) => new Date(rt.now()).toISOString();

interface EventBody {
  id?: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  attendees?: { email?: string; displayName?: string }[];
  conferenceData?: { createRequest?: { requestId?: string } };
}

function validTime(t: { dateTime?: string } | undefined): t is { dateTime: string; timeZone?: string } {
  return Boolean(t?.dateTime && !Number.isNaN(Date.parse(t.dateTime)));
}

const cleanAttendees = (list: EventBody["attendees"], old: MockEvent["attendees"] = []): MockEvent["attendees"] =>
  (list ?? [])
    .filter((a) => typeof a.email === "string" && a.email)
    .map((a) => {
      const prev = old.find((o) => o.email.toLowerCase() === a.email!.toLowerCase());
      return { email: a.email!, ...(a.displayName ? { displayName: a.displayName } : {}), responseStatus: prev?.responseStatus ?? "needsAction" };
    });

async function insertEvent(c: Ctx): Promise<void> {
  const rt = c.rt;
  const { email } = authenticate(c, CALENDAR_SCOPE, "Calendar");
  const body = await c.readJson<EventBody>();
  const id = body.id ?? randomHex(16);
  if (!EVENT_ID.test(id)) throw apiError(400, "Invalid resource id value.", "INVALID_ARGUMENT", "invalid");
  if (!validTime(body.start) || !validTime(body.end)) throw apiError(400, "Missing end time.", "INVALID_ARGUMENT", "required");
  const cal = calendarOf(rt, email);
  // Ids are never reusable: a live, deleted or purged event all answer 409. lib/meeting.ts relies on this for group sessions.
  if (cal[id]) throw apiError(409, "The requested identifier already exists.", "ALREADY_EXISTS", "duplicate");

  const now = stamp(rt);
  const event: MockEvent = {
    id,
    etag: 1,
    seq: 0,
    status: "confirmed",
    summary: body.summary ?? "",
    description: body.description ?? "",
    start: { dateTime: body.start.dateTime, timeZone: body.start.timeZone ?? "UTC" },
    end: { dateTime: body.end.dateTime, timeZone: body.end.timeZone ?? "UTC" },
    attendees: cleanAttendees(body.attendees),
    conference: null,
    created: now,
    updated: now,
    deletedAt: null,
    purged: false,
    history: [`${now} created`],
  };
  if (c.query.get("conferenceDataVersion") === "1" && body.conferenceData?.createRequest) {
    const mode = takeFault(rt, "google.meet", c);
    const requestId = body.conferenceData.createRequest.requestId ?? "";
    event.conference =
      mode === "failure"
        ? { requestId, status: "failure", code: null, readyAt: null }
        : mode === "pending_forever"
          ? { requestId, status: "pending", code: meetCode(), readyAt: null }
          : mode === "pending_2s"
            ? { requestId, status: "pending", code: meetCode(), readyAt: rt.now() + 2000 }
            : { requestId, status: "success", code: meetCode(), readyAt: null };
  }
  cal[id] = event;
  rt.save();
  const link = event.conference?.status === "success" ? ` · link /meet/${event.conference.code}` : event.conference ? ` · Meet ${event.conference.status}` : "";
  rt.activity(`Calendar: event created for "${event.summary}", attendee ${event.attendees.map((a) => a.email).join(", ") || "none"}${link}`, `/__mock/google#event-${id}`);
  if (sendsUpdates(c)) logInvites(rt, email, event, "invite", event.attendees.map((a) => a.email));
  c.sendJson(200, eventJson(rt, email, event));
}

function findEvent(c: Ctx, email: string): MockEvent {
  const e = calendarOf(c.rt, email)[decodeURIComponent(c.params.id)];
  if (!e) throw notFound();
  return e;
}

function getEvent(c: Ctx): void {
  const { email } = authenticate(c, CALENDAR_SCOPE, "Calendar");
  const e = findEvent(c, email);
  if (e.purged) throw gone();
  c.sendJson(200, eventJson(c.rt, email, e));
}

async function patchEvent(c: Ctx): Promise<void> {
  const rt = c.rt;
  const { email } = authenticate(c, CALENDAR_SCOPE, "Calendar");
  const e = findEvent(c, email);
  if (e.purged) throw gone();
  const body = await c.readJson<EventBody>();
  const ifMatch = c.header("if-match");
  // google.patch412: someone else edited the event between the app's read and write. The etag moves on, so the retry succeeds.
  if (ifMatch && rt.state.faults["google.patch412"]) {
    takeFault(rt, "google.patch412", c);
    e.etag++;
    e.updated = stamp(rt);
    e.history.push(`${e.updated} edited by someone else (injected)`);
    rt.save();
    throw preconditionFailed();
  }
  if (ifMatch && ifMatch !== `"${e.etag}"`) throw preconditionFailed();

  const now = stamp(rt);
  const before = e.attendees;
  const changes: string[] = [];
  let timeChanged = false;
  if (body.attendees) {
    e.attendees = cleanAttendees(body.attendees, before);
    changes.push("attendees");
  }
  if (body.start || body.end) {
    if ((body.start && !validTime(body.start)) || (body.end && !validTime(body.end))) throw apiError(400, "Invalid start or end time.", "INVALID_ARGUMENT", "invalid");
    if (body.start) e.start = { dateTime: body.start.dateTime!, timeZone: body.start.timeZone ?? "UTC" };
    if (body.end) e.end = { dateTime: body.end.dateTime!, timeZone: body.end.timeZone ?? "UTC" };
    timeChanged = true;
    e.seq++;
    changes.push(`time to ${e.start.dateTime}`);
  }
  if (typeof body.summary === "string") {
    e.summary = body.summary;
    changes.push("summary");
  }
  if (typeof body.description === "string") {
    e.description = body.description;
    changes.push("description");
  }
  if (changes.length) {
    e.etag++;
    e.updated = now;
    e.history.push(`${now} patched: ${changes.join(", ")}`);
  }
  rt.save();
  rt.activity(`Calendar: event "${e.summary}" updated (${changes.join(", ") || "no change"})`, `/__mock/google#event-${e.id}`);
  if (sendsUpdates(c) && e.status !== "cancelled") {
    const had = new Set(before.map((a) => a.email.toLowerCase()));
    const has = new Set(e.attendees.map((a) => a.email.toLowerCase()));
    logInvites(rt, email, e, "invite", e.attendees.filter((a) => !had.has(a.email.toLowerCase())).map((a) => a.email));
    logInvites(rt, email, e, "cancel", before.filter((a) => !has.has(a.email.toLowerCase())).map((a) => a.email));
    if (timeChanged) logInvites(rt, email, e, "update", e.attendees.filter((a) => had.has(a.email.toLowerCase())).map((a) => a.email));
  }
  c.sendJson(200, eventJson(rt, email, e));
}

function deleteEvent(c: Ctx): void {
  const rt = c.rt;
  const { email } = authenticate(c, CALENDAR_SCOPE, "Calendar");
  const e = findEvent(c, email);
  if (e.purged || e.status === "cancelled") throw gone();
  tombstone(rt, e, "deleted by the app");
  rt.activity(`Calendar: event "${e.summary}" deleted`, `/__mock/google#event-${e.id}`);
  if (sendsUpdates(c)) logInvites(rt, email, e, "cancel", e.attendees.map((a) => a.email));
  c.sendEmpty(204);
}

/** A deleted event stays readable as a "cancelled" tombstone until it is purged. */
function tombstone(rt: Runtime, e: MockEvent, why: string): void {
  const now = stamp(rt);
  e.status = "cancelled";
  e.deletedAt = now;
  e.etag++;
  e.updated = now;
  e.history.push(`${now} ${why}`);
  rt.save();
}

/* ---------- control actions ---------- */

export function registerGoogle(router: Router): void {
  router.add("GET", /^\/google\/o\/oauth2\/v2\/auth$/, consentPage);
  router.add("POST", /^\/google\/o\/oauth2\/v2\/auth\/decision$/, decisionEndpoint);
  router.add("POST", /^\/google\/token$/, tokenEndpoint, "google");
  router.add("POST", /^\/google\/revoke$/, revokeEndpoint, "google");
  router.add("POST", /^\/google\/calendar\/v3\/calendars\/primary\/events$/, insertEvent, "google");
  router.add("GET", /^\/google\/calendar\/v3\/calendars\/primary\/events\/(?<id>[^/]+)$/, getEvent, "google");
  router.add("PATCH", /^\/google\/calendar\/v3\/calendars\/primary\/events\/(?<id>[^/]+)$/, patchEvent, "google");
  router.add("DELETE", /^\/google\/calendar\/v3\/calendars\/primary\/events\/(?<id>[^/]+)$/, deleteEvent, "google");

  addControl(router, "/__mock/google/revoke-grant", (c, f) => {
    const grantId = String(f.grantId ?? "");
    if (!c.rt.state.google.grants[grantId]) throw new HttpError(404, { error: "no such grant" });
    revokeGrant(c.rt, grantId, "revoked on the control page, like removing access at myaccount.google.com");
    return { ok: true };
  });
  addControl(router, "/__mock/google/expire-access", (c) => {
    for (const t of Object.values(c.rt.state.google.accessTokens)) t.expiresAt = c.rt.now() - 1;
    c.rt.save();
    c.rt.activity("Google: every access token was expired (the app must refresh)", "/__mock/google");
    return { ok: true };
  });
  addControl(router, "/__mock/google/delete-event", (c, f) => {
    const e = c.rt.state.google.calendars[String(f.account ?? "")]?.[String(f.eventId ?? "")];
    if (!e) throw new HttpError(404, { error: "no such event" });
    if (e.status !== "cancelled") tombstone(c.rt, e, "deleted behind the app's back");
    c.rt.activity(`Calendar: event "${e.summary}" was deleted behind the app's back`, `/__mock/google#event-${e.id}`);
    return { ok: true };
  });
  addControl(router, "/__mock/google/purge", (c) => {
    let n = 0;
    for (const cal of Object.values(c.rt.state.google.calendars)) {
      for (const e of Object.values(cal)) {
        if (e.status === "cancelled" && !e.purged) {
          e.purged = true;
          n++;
        }
      }
    }
    c.rt.save();
    c.rt.activity(`Calendar: ${n} deleted event(s) purged (they now answer 410)`, "/__mock/google");
    return { ok: true, purged: n };
  });
}
