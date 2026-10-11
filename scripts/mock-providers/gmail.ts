import { GMAIL_SEND_SCOPE, apiError, authenticate } from "./google";
import { randomHex, type Ctx, type Router } from "./http";
import type { MockMail } from "./state";

/**
 * Mock of Gmail's users.messages.send (https://developers.google.com/gmail/api/reference/rest/v1/users.messages/send): takes the
 * RFC 5322 message base64url-encoded in `raw`, records it, answers { id, threadId, labelIds }. The message is decoded here, by
 * code that shares nothing with lib/gmail.ts, so a mistake in how the app builds its MIME shows up as a wrong subject or body.
 */

export interface DecodedMail {
  headers: Record<string, string>;
  text: string;
  html: string;
}

/** RFC 2047 encoded words (=?UTF-8?B?...?= and ?Q?) decoded; whitespace between adjacent encoded words is dropped. */
export function decodeWords(value: string): string {
  const word = /=\?([A-Za-z0-9_-]+)\?([BbQq])\?([^?]*)\?=/g;
  const joined = value.replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?[^?]+\?[BbQq]\?[^?]*\?=)/g, "$1");
  return joined.replace(word, (_m, charset: string, enc: string, text: string) => {
    const bytes = enc.toUpperCase() === "B" ? Buffer.from(text, "base64") : Buffer.from(qpBytes(text.replace(/_/g, " ")));
    return decodeBytes(bytes, charset);
  });
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Quoted-printable text to bytes (=XX escapes and soft line breaks). */
function qpBytes(text: string): number[] {
  const out: number[] = [];
  const s = text.replace(/=\r?\n/g, "");
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(...Buffer.from(s[i], "utf8"));
    }
  }
  return out;
}

function splitHead(raw: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(raw);
  return m ? { head: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) } : { head: raw, body: "" };
}

function parseHeaders(head: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Unfold: a line starting with space or tab continues the previous header.
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] ??= line.slice(i + 1).trim();
  }
  return out;
}

function parameter(contentType: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(contentType);
  return m ? (m[1] ?? m[2]) : null;
}

/** Walks a MIME entity and keeps the first text/plain and text/html leaves. */
function walk(entity: string, into: { text: string; html: string; hasText: boolean; hasHtml: boolean }): void {
  const { head, body } = splitHead(entity);
  const headers = parseHeaders(head);
  const type = (headers["content-type"] ?? "text/plain").toLowerCase();
  if (type.startsWith("multipart/")) {
    const boundary = parameter(headers["content-type"] ?? "", "boundary");
    if (!boundary) return;
    const parts = body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?[ \\t]*(?:\\r?\\n|$)`));
    for (const part of parts.slice(1)) if (part.trim()) walk(part, into);
    return;
  }
  const encoding = (headers["content-transfer-encoding"] ?? "7bit").toLowerCase();
  const bytes = encoding === "base64" ? Buffer.from(body.replace(/\s+/g, ""), "base64") : encoding === "quoted-printable" ? Buffer.from(qpBytes(body)) : Buffer.from(body, "utf8");
  const content = decodeBytes(bytes, parameter(headers["content-type"] ?? "", "charset") ?? "utf-8");
  if (type.startsWith("text/plain") && !into.hasText) {
    into.text = content;
    into.hasText = true;
  } else if (type.startsWith("text/html") && !into.hasHtml) {
    into.html = content;
    into.hasHtml = true;
  }
}

export function decodeMime(raw: string): DecodedMail {
  const { head } = splitHead(raw);
  const headers = parseHeaders(head);
  const into = { text: "", html: "", hasText: false, hasHtml: false };
  walk(raw, into);
  return { headers, text: into.text, html: into.html };
}

/** `"Name" <a@b.co>`, `=?UTF-8?B?...?= <a@b.co>` or a bare address: the decoded display value and the bare address. */
export function parseAddress(headerValue: string | undefined): { display: string; address: string } {
  const decoded = decodeWords(headerValue ?? "").trim();
  const m = /<([^<>]+)>\s*$/.exec(decoded);
  return { display: decoded, address: (m ? m[1] : decoded).trim().toLowerCase() };
}

async function sendMessage(c: Ctx): Promise<void> {
  const rt = c.rt;
  const { email } = authenticate(c, GMAIL_SEND_SCOPE, "Gmail");
  const body = await c.readJson<{ raw?: unknown }>(6_000_000);
  const rawB64 = typeof body.raw === "string" ? body.raw : "";
  if (!rawB64 || !/^[A-Za-z0-9_\-+/=\r\n]+$/.test(rawB64)) throw apiError(400, "Invalid value for ByteString: the raw message must be base64url", "INVALID_ARGUMENT", "invalidArgument");
  const mail = decodeMime(Buffer.from(rawB64, "base64url").toString("utf8"));
  const from = parseAddress(mail.headers.from);
  const to = parseAddress(mail.headers.to);
  if (!mail.headers.to || !to.address) throw apiError(400, "Recipient address required", "INVALID_ARGUMENT", "invalidArgument");
  if (!mail.headers.from) throw apiError(400, "Invalid From header", "INVALID_ARGUMENT", "invalidArgument");

  const record: MockMail = {
    id: randomHex(8),
    threadId: randomHex(8),
    at: new Date(rt.now()).toISOString(),
    account: email,
    from: from.address,
    fromDisplay: from.display,
    to: to.address,
    toDisplay: to.display,
    replyTo: mail.headers["reply-to"] ? parseAddress(mail.headers["reply-to"]).address : null,
    subject: decodeWords(mail.headers.subject ?? ""),
    text: mail.text,
    html: mail.html,
    fromRewritten: from.address !== email.toLowerCase(),
  };
  (rt.state.google.sentMail[email] ??= []).push(record);
  rt.save();
  rt.activity(`Gmail: "${record.subject}" from ${email} to ${record.to}`, `/__mock/gmail#mail-${record.id}`);
  c.sendJson(200, { id: record.id, threadId: record.threadId, labelIds: ["SENT"] });
}

export function registerGmail(router: Router): void {
  router.add("POST", /^\/google\/gmail\/v1\/users\/me\/messages\/send$/, sendMessage, "google");
}
