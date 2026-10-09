/**
 * Email delivery providers over plain fetch (no SDK dependency). Selected by EMAIL_PROVIDER:
 *   - "resend"   RESEND_API_KEY            https://resend.com/docs/api-reference/emails/send-email
 *   - "postmark" POSTMARK_SERVER_TOKEN     https://postmarkapp.com/developer/api/email-api
 *   - "log"      (default) writes a structured log line; use for local development only.
 * EMAIL_FROM is the sender, e.g. "Bookings <bookings@yourdomain.com>". Configure SPF and DKIM for that domain
 * with the provider before going live, or messages will land in spam.
 */

export interface OutgoingEmail {
  to: { email: string; name?: string };
  subject: string;
  html: string;
  text: string;
  /** Provider tag/category for analytics, e.g. "booking-confirmation". */
  tag?: string;
  replyTo?: string;
}

export interface EmailSendResult {
  providerMessageId: string | null;
}

export type EmailTransport = (email: OutgoingEmail) => Promise<EmailSendResult>;
type FetchFn = typeof fetch;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function formatAddress(to: { email: string; name?: string }): string {
  if (!to.name) return to.email;
  // Quote the display name and strip characters that could break the header.
  return `"${to.name.replace(/["\\\r\n<>]/g, "")}" <${to.email}>`;
}

export function resendTransport(fetchFn: FetchFn = fetch): EmailTransport {
  return async (email) => {
    const res = await fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env("EMAIL_FROM"),
        to: [formatAddress(email.to)],
        subject: email.subject,
        html: email.html,
        text: email.text,
        ...(email.replyTo ? { reply_to: email.replyTo } : {}),
        ...(email.tag ? { tags: [{ name: "category", value: email.tag.replace(/[^a-zA-Z0-9_-]/g, "_") }] } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Resend send failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { providerMessageId: data.id ?? null };
  };
}

export function postmarkTransport(fetchFn: FetchFn = fetch): EmailTransport {
  return async (email) => {
    const res = await fetchFn("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "X-Postmark-Server-Token": env("POSTMARK_SERVER_TOKEN"),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        From: env("EMAIL_FROM"),
        To: formatAddress(email.to),
        Subject: email.subject,
        HtmlBody: email.html,
        TextBody: email.text,
        MessageStream: process.env.POSTMARK_MESSAGE_STREAM || "outbound",
        ...(email.replyTo ? { ReplyTo: email.replyTo } : {}),
        ...(email.tag ? { Tag: email.tag } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Postmark send failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const data = (await res.json().catch(() => ({}))) as { MessageID?: string };
    return { providerMessageId: data.MessageID ?? null };
  };
}

/**
 * Development transport: logs the recipient and subject, and outside production also the plain-text body so
 * verification/reset links can be clicked locally. In production the body (which can contain single-use tokens)
 * is never logged.
 */
export const logTransport: EmailTransport = async (email) => {
  const meta = JSON.stringify({ to: email.to.email, subject: email.subject, tag: email.tag });
  if (process.env.NODE_ENV === "production") console.log("[email]", meta);
  else console.log("[email]", meta, `\n${email.text}\n`);
  return { providerMessageId: null };
};

export function transportFromEnv(): EmailTransport {
  const provider = (process.env.EMAIL_PROVIDER || "log").toLowerCase();
  if (provider === "resend") return resendTransport();
  if (provider === "postmark") return postmarkTransport();
  if (provider !== "log") console.warn(`[email] unknown EMAIL_PROVIDER "${provider}", falling back to log`);
  if (process.env.NODE_ENV === "production") {
    console.warn("[email] EMAIL_PROVIDER is not configured: emails are only logged, customers will not receive them");
  }
  return logTransport;
}
