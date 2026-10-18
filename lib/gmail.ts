import { randomBytes } from "node:crypto";
import { GMAIL_SEND_SCOPE, GoogleReconnectError, GoogleRequestError, GoogleTransientError } from "@/lib/google";
import { googleEndpoints } from "@/lib/provider-endpoints";

export { GMAIL_SEND_SCOPE };

/**
 * Starts the `error` of an e-mail Message row that Gmail failed to send when the platform has no e-mail provider to fall back on
 * (EMAIL_PROVIDER=none, doc/15). The Google panel reads it to say "Gmail not working" (lib/google-tokens.ts).
 */
export const GMAIL_FAILED_PREFIX = "Gmail could not send:";

/**
 * Sends email as the influencer through the Gmail API (users.messages.send), so customers receive their
 * confirmations from the influencer's own address. Plain fetch, like lib/google.ts.
 *
 * `gmail.send` is a Google "restricted" scope: while the OAuth consent screen is in Testing it works for the listed
 * test users; for everyone else Google requires verification and a security assessment before launch. Every caller
 * therefore treats Gmail as optional and falls back to the platform's email provider on any failure.
 */

export function hasGmailSendScope(scope: string | null | undefined): boolean {
  return (scope ?? "").split(/\s+/).includes(GMAIL_SEND_SCOPE);
}

export interface GmailMessage {
  /** Display name shown to the customer (the influencer's name). */
  fromName: string;
  /** The authenticated Gmail address. Gmail ignores any other address, but the header should match. */
  fromEmail: string;
  to: { email: string; name?: string };
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

/** Strips anything that could end a header line or break an address (header injection). */
function clean(value: string): string {
  return value.replace(/[\r\n\u0000]/g, " ").trim();
}

/** RFC 2047 encoded-word for non-ASCII header text (subjects, display names). */
export function encodeHeader(value: string): string {
  const v = clean(value);
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

function address(name: string | undefined, email: string): string {
  const e = clean(email).replace(/[<>"]/g, "");
  if (!name) return e;
  const n = clean(name).replace(/["\\<>]/g, "");
  return `${encodeHeader(n).startsWith("=?") ? encodeHeader(n) : `"${n}"`} <${e}>`;
}

/** Wraps base64 at 76 columns as MIME requires. */
function wrap64(buf: Buffer): string {
  return (buf.toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
}

/** Builds an RFC 5322 multipart/alternative message (text + html), UTF-8, base64 bodies. */
export function buildMime(msg: GmailMessage, boundary = `sa_${randomBytes(12).toString("hex")}`): string {
  const headers = [
    `From: ${address(msg.fromName, msg.fromEmail)}`,
    `To: ${address(msg.to.name, msg.to.email)}`,
    ...(msg.replyTo ? [`Reply-To: ${clean(msg.replyTo)}`] : []),
    `Subject: ${encodeHeader(msg.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type: string, body: string) =>
    [`--${boundary}`, `Content-Type: ${type}; charset="UTF-8"`, "Content-Transfer-Encoding: base64", "", wrap64(Buffer.from(body, "utf8"))].join("\r\n");
  return [...headers, "", part("text/plain", msg.text), part("text/html", msg.html), `--${boundary}--`, ""].join("\r\n");
}

type FetchFn = typeof fetch;

/**
 * Sends one message. Errors are classified like the Calendar client: 401 means the grant is dead (reconnect),
 * rate limits / 5xx / network are transient, and anything else (bad request, scope missing) is request-specific.
 * Returns Gmail's message id.
 */
export async function sendGmail(accessToken: string, msg: GmailMessage, fetchImpl: FetchFn = fetch): Promise<{ id: string }> {
  let res: Response;
  try {
    res = await fetchImpl(googleEndpoints().gmailSend, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: Buffer.from(buildMime(msg), "utf8").toString("base64url") }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new GoogleTransientError(`Gmail request failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { id: body.id ?? "" };
  }
  const text = await res.text().catch(() => "");
  let reason = String(res.status);
  let message = text.slice(0, 200);
  try {
    const j = JSON.parse(text) as { error?: { message?: string; status?: string; errors?: { reason?: string }[] } };
    reason = j.error?.errors?.[0]?.reason ?? j.error?.status ?? reason;
    message = j.error?.message ?? message;
  } catch {
    /* non-JSON error body */
  }
  const detail = `Gmail ${res.status} ${reason}: ${message}`;
  if (res.status === 401) throw new GoogleReconnectError(detail);
  if (res.status === 429 || res.status >= 500) throw new GoogleTransientError(detail);
  if (res.status === 403 && /rate|quota|limit|backend/i.test(reason)) throw new GoogleTransientError(detail);
  // The Gmail API is a separate switch from the Calendar API: without it every send fails like this, and the email
  // silently goes out from the platform address. Say what to do (Google's own text cuts off the link we want to read).
  if (res.status === 403 && reason === "accessNotConfigured") {
    throw new GoogleRequestError(
      `Gmail 403 accessNotConfigured: the Gmail API is not enabled on the Google Cloud project. Enable "Gmail API" under APIs & Services > Library, then retry. (${message.slice(0, 120)})`,
    );
  }
  // 403 insufficientPermissions (scope not granted), 400 invalid message, etc.
  throw new GoogleRequestError(detail);
}
