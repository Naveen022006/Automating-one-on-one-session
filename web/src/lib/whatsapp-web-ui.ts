import type { WhatsAppWebTestAnswer } from "@/lib/whatsapp-web/api-types";
import type { WhatsAppWebRequest, WhatsAppWebStatus, WhatsAppWebView } from "@/lib/whatsapp-web/types";

/**
 * The rules of the "link WhatsApp by QR code" screens (components/app/WhatsAppQrLink.tsx, WhatsAppModePicker.tsx and
 * components/admin/InfluencerWhatsAppWebPanel.tsx) as pure functions, so they can be tested without a DOM or timers.
 * Types only come from lib/whatsapp-web/types.ts (`import type`); nothing else under lib/whatsapp-web/ may reach the browser.
 */

/** How the Messages screens name the message channel of a QR-linked number (the `channel` column's value is WHATSAPP_WEB). */
export const QR_CHANNEL_LABEL = "WhatsApp (QR link)";

/**
 * A message row of the linked number whose send got no answer in time (the same text as QR_UNKNOWN_DELIVERY in lib/messaging.ts).
 * It may still have arrived, so it is shown as "Not confirmed" instead of "Sent", and it was not sent another way.
 */
export function isUnconfirmedMessage(m: { channel: string; error: string | null }): boolean {
  return m.channel === "WHATSAPP_WEB" && m.error === "unknown-delivery";
}

export const UNCONFIRMED_MESSAGE_TEXT = "WhatsApp did not answer in time. The message may still have arrived. It was not sent another way, so the customer does not get it twice.";

/** How often the page asks for a fresh status while a code is on screen (the server may have replaced it). */
export const QR_POLL_MS = 2000;
/** While the link is reconnecting nothing needs to be fast; it only keeps the screen from showing an old state for ever. */
export const RECONNECT_POLL_MS = 10_000;
/** The longest wait between two requests after failures (a rate limit or an outage), so polling never hammers the server. */
export const MAX_POLL_BACKOFF_MS = 30_000;
/** After "Show QR code" the worker needs a moment to open the session; give up waiting for the first code after this long. */
export const STARTING_TIMEOUT_MS = 90_000;

/** Whether a "start" request was sent and nothing has come of it yet (the status is still "not-linked": the worker is working). */
export function isStarting(startedAt: number | null, view: Pick<WhatsAppWebView, "status" | "lastError"> | null, now: number): boolean {
  if (startedAt === null || view === null) return false;
  if (view.status !== "not-linked" || view.lastError !== null) return false;
  return now - startedAt < STARTING_TIMEOUT_MS;
}

/**
 * The delay before the next status request, or null for "do not poll".
 *  - waiting for a scan (or waiting for the first code after pressing start): every 2 seconds
 *  - reconnecting: every 10 seconds
 *  - any other state, or the tab is hidden: never (a hidden tab asks again when it becomes visible)
 * Each failure doubles the wait, up to 30 seconds.
 */
export function pollDelayMs(input: { status: WhatsAppWebStatus | null; starting: boolean; hidden: boolean; failures: number }): number | null {
  if (input.hidden || input.status === null) return null;
  const base = input.status === "waiting-for-scan" || input.starting ? QR_POLL_MS : input.status === "reconnecting" ? RECONNECT_POLL_MS : null;
  if (base === null) return null;
  return Math.min(MAX_POLL_BACKOFF_MS, base * 2 ** Math.max(0, Math.min(input.failures, 10)));
}

/** Whole seconds until `expiresAt` (never negative), or null when there is no valid time. */
export function secondsLeft(expiresAt: string | null, nowMs: number): number | null {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.ceil((t - nowMs) / 1000));
}

/** "0:07" */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Whether the "Show QR code" / "Link again" button may be pressed: the risk statement was ticked and no request is running. */
export function canStartLink(consent: boolean, busy: boolean): boolean {
  return consent && !busy;
}

/**
 * The body of a "start" request, or null while the risk statement is not ticked. It carries the version of the statement the server
 * showed (`view.consentVersion`), so the server can refuse a consent given to older wording.
 */
export function startRequest(view: Pick<WhatsAppWebView, "consentVersion">, consent: boolean): Extract<WhatsAppWebRequest, { action: "start" }> | null {
  return consent ? { action: "start", consent: true, consentVersion: view.consentVersion } : null;
}

/**
 * What to tell the influencer about the test message, from the `test` part of the answer (the endpoint reports how the message went:
 * handed to WhatsApp, not answered yet, or failed). An answer without it (an older server) is taken as "queued".
 */
export function testOutcome(answer: unknown): { ok: boolean; text: string } {
  const test = (answer as Partial<WhatsAppWebTestAnswer> | null)?.test;
  if (test?.state === "failed") return { ok: false, text: test.message?.trim() || "The test message could not be sent." };
  if (test?.state === "sent") return { ok: true, text: "Test message sent to your own WhatsApp. Check your phone." };
  return { ok: true, text: "Test message queued. It has not been confirmed yet; check your own WhatsApp in a moment." };
}

/** Where messages go while the QR link is not working. The wording depends on whether the official connection is active. */
export function fallbackText(officialConnected: boolean): string {
  return officialConnected
    ? "Meanwhile messages go through your official WhatsApp Business connection, or by SMS or e-mail."
    : "Meanwhile messages go by SMS or e-mail.";
}

/** The sentence for the screen-reader live region. It changes only when the situation changes, never every second. */
export function statusAnnouncement(view: Pick<WhatsAppWebView, "status" | "qrSvg" | "suspendedReason" | "officialConnected">, starting: boolean): string {
  switch (view.status) {
    case "not-linked":
      return starting ? "Getting your QR code ready." : "WhatsApp is not linked by QR code.";
    case "waiting-for-scan":
      return view.qrSvg ? "Your QR code is ready. Scan it with your phone." : "Getting your QR code ready.";
    case "linked":
      return "WhatsApp is linked.";
    case "reconnecting":
      return "The WhatsApp link was lost. Reconnecting.";
    case "suspended":
      return "Sending from the linked WhatsApp number is paused.";
    case "logged-out":
      return "The linked device was removed from your phone. Link it again to use it.";
  }
}

/** "12 of 40 messages sent today" */
export function sentTodayText(sent: number, cap: number): string {
  return `${sent} of ${cap} sent today`;
}

/** Where the status is read and the commands are sent. */
export const WHATSAPP_WEB_URL = "/api/dashboard/whatsapp-web";

/** Whether an answer from the endpoint has the shape of the view (a refusal is `{ error }`). Checks only what the screen relies on. */
export function isWhatsAppWebView(data: unknown): data is WhatsAppWebView {
  const d = data as Partial<WhatsAppWebView> | null;
  return (
    typeof d === "object" &&
    d !== null &&
    typeof d.enabled === "boolean" &&
    typeof d.status === "string" &&
    typeof d.riskText === "string" &&
    typeof d.consentVersion === "string" &&
    typeof d.dailyCap === "number" &&
    typeof d.sentToday === "number"
  );
}

/**
 * Whether a change of state may move the keyboard focus to the panel heading: only when focus is already inside the panel or
 * nowhere (the button that was pressed has gone), never while the person is typing somewhere else on the page.
 */
export function shouldMoveFocus(activeInsidePanel: boolean, activeIsBody: boolean): boolean {
  return activeInsidePanel || activeIsBody;
}

/* ---------- the QR image ---------- */

const SVG_MAX_LENGTH = 200_000;
const SVG_ELEMENTS = new Set(["svg", "rect", "path", "g", "title", "desc"]);
const SVG_ATTRIBUTES = new Set(["xmlns", "viewbox", "width", "height", "role", "aria-label", "fill", "stroke", "d", "x", "y", "transform", "shape-rendering", "fill-rule", "preserveaspectratio", "stroke-width"]);
const TAG = /<(\/?)([^\s>/]*)([^>]*)>/g;
const ATTRIBUTE = /\s+([^\s=/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;

/**
 * Turns the server's QR SVG string into an `<img src>` value, or null when the string is anything but plain QR geometry.
 *
 * The string comes from our own server (lib/whatsapp-web/qr-svg.ts renders a rect and a path), but it is still never put into the
 * page as markup: it is shown through an `<img>` with a `data:` URL, where a browser runs no script, loads nothing and follows no
 * link. This check is a second wall: only <svg>, <rect>, <path>, <g>, <title> and <desc> with a short list of plain attributes are
 * accepted; scripts, event handlers, `<foreignObject>`, `href`s, `style`, `url(...)`, comments, CDATA and entity declarations
 * all return null (the screen then shows "could not show the code" instead of the image).
 */
export function safeQrImageSrc(svg: string | null | undefined): string | null {
  if (typeof svg !== "string" || svg.length === 0 || svg.length > SVG_MAX_LENGTH) return null;
  const text = svg.trim();
  if (!/^<svg[\s>]/.test(text) || !/<\/svg>$/.test(text)) return null;
  // No comments, doctype, CDATA, processing instructions or entities of any kind.
  if (text.includes("<!") || text.includes("<?") || text.includes("&")) return null;
  const open: string[] = [];
  let last = 0;
  TAG.lastIndex = 0;
  for (let m = TAG.exec(text); m; m = TAG.exec(text)) {
    // Text between tags is allowed only inside <title> and <desc>.
    const between = text.slice(last, m.index);
    const inText = open[open.length - 1] === "title" || open[open.length - 1] === "desc";
    if (between.trim() !== "" && !inText) return null;
    last = m.index + m[0].length;
    const name = m[2].toLowerCase();
    if (!SVG_ELEMENTS.has(name)) return null;
    if (m[1] === "/") {
      if (m[3].trim() !== "" || open.pop() !== name) return null;
      continue;
    }
    let rest = m[3];
    const selfClosing = /\/\s*$/.test(rest);
    if (selfClosing) rest = rest.replace(/\/\s*$/, "");
    ATTRIBUTE.lastIndex = 0;
    let consumed = 0;
    for (let a = ATTRIBUTE.exec(rest); a; a = ATTRIBUTE.exec(rest)) {
      consumed = ATTRIBUTE.lastIndex;
      const value = a[2] ?? a[3] ?? "";
      if (!SVG_ATTRIBUTES.has(a[1].toLowerCase()) || /[<>]|url\s*\(|javascript:|data:/i.test(value)) return null;
    }
    if (rest.slice(consumed).trim() !== "") return null;
    if ((open.length === 0) !== (name === "svg")) return null; // one root <svg>, everything else inside it
    if (!selfClosing) open.push(name);
  }
  if (open.length !== 0 || text.slice(last).trim() !== "") return null;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
}

/* ---------- the administrator's "force disconnect" ---------- */

export const DISCONNECT_REASON_MIN = 5;
export const DISCONNECT_REASON_MAX = 300;

/** The error to show under the reason field, or null when the (trimmed) reason is acceptable. */
export function disconnectReasonError(reason: string): string | null {
  const n = reason.trim().length;
  if (n < DISCONNECT_REASON_MIN) return `Write a reason of at least ${DISCONNECT_REASON_MIN} characters.`;
  if (n > DISCONNECT_REASON_MAX) return `Keep the reason to ${DISCONNECT_REASON_MAX} characters or fewer.`;
  return null;
}
