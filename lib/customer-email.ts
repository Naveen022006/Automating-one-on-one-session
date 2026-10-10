import { alertInfluencer } from "@/lib/alerts";
import { prisma } from "@/lib/db";
import type { RenderedEmail } from "@/lib/email/layout";
import type { EmailSendResult, OutgoingEmail } from "@/lib/email/providers";
import { GoogleReconnectError, google } from "@/lib/google";
import { getRefreshToken, markReconnectNeeded } from "@/lib/google-tokens";
import { hasGmailSendScope, sendGmail, type GmailMessage } from "@/lib/gmail";

/**
 * Sends an email that an influencer's customer receives (confirmations, receipts, booking requests...). When the
 * influencer allowed "send email" on their Google connection, it goes out through their own Gmail so it comes from
 * their address; otherwise, or if Gmail fails for any reason, it goes through the platform's email provider with the
 * influencer's address as Reply-To. A customer email is never lost because Gmail was unavailable.
 *
 * Account emails (verify, password reset, payout notices, alerts) are the platform's own and never use this.
 */

export interface InfluencerMailContext {
  name: string;
  /** Where customer replies should go when the platform sends. */
  replyTo: string;
  gmail: { refreshToken: string; fromEmail: string } | null;
}

export interface CustomerEmailDeps {
  loadContext(influencerId: string): Promise<InfluencerMailContext | null>;
  refreshAccessToken(refreshToken: string): Promise<string>;
  sendGmail(accessToken: string, msg: GmailMessage): Promise<{ id: string }>;
  platformSend(email: OutgoingEmail): Promise<EmailSendResult>;
  onReconnectNeeded(influencerId: string, reason: string): Promise<void>;
}

export type CustomerEmailResult = EmailSendResult & { via: "gmail" | "platform"; fallbackReason?: string };

const FALLBACK_LOG_EVERY_MS = 60 * 60_000;
const lastFallbackLog = new Map<string, number>();

/**
 * True at most once per influencer per hour (per process). A failing Gmail send falls back to the platform address, so
 * nothing breaks for the customer, but every email would otherwise repeat the same line. The influencer sees the
 * problem in the Google panel (lib/google-tokens.ts gmailSendingFailing); this is the operator's side of it.
 */
export function shouldLogGmailFallback(influencerId: string, now = Date.now()): boolean {
  const last = lastFallbackLog.get(influencerId);
  if (last !== undefined && now - last < FALLBACK_LOG_EVERY_MS) return false;
  lastFallbackLog.set(influencerId, now);
  return true;
}

async function loadContext(influencerId: string): Promise<InfluencerMailContext | null> {
  const row = await prisma.influencer.findUnique({
    where: { id: influencerId },
    select: { name: true, email: true, googleToken: { select: { scope: true, status: true, googleEmail: true } } },
  });
  if (!row) return null;
  const token = row.googleToken;
  let gmail: InfluencerMailContext["gmail"] = null;
  if (token && token.status === "ACTIVE" && hasGmailSendScope(token.scope) && token.googleEmail) {
    const lookup = await getRefreshToken(influencerId);
    if (lookup.state === "ok") gmail = { refreshToken: lookup.refreshToken, fromEmail: token.googleEmail };
  }
  return { name: row.name, replyTo: token?.googleEmail ?? row.email, gmail };
}

const defaultDeps: CustomerEmailDeps = {
  loadContext,
  refreshAccessToken: (t) => google.refreshAccessToken(t),
  sendGmail: (token, msg) => sendGmail(token, msg),
  // Imported lazily: lib/email.ts itself sends booking emails through this module.
  platformSend: async (email) => (await import("@/lib/email")).sendEmail(email),
  onReconnectNeeded: async (influencerId, reason) => {
    if (await markReconnectNeeded(influencerId, reason)) {
      await alertInfluencer(influencerId, { kind: "google-reconnect-needed", detail: `Google stopped accepting the connection (${reason}). Reconnect to keep creating Meet links.` });
    }
  },
};

export async function sendCustomerEmail(
  influencerId: string,
  email: OutgoingEmail,
  deps: CustomerEmailDeps = defaultDeps,
): Promise<CustomerEmailResult> {
  const ctx = await deps.loadContext(influencerId).catch(() => null);
  const replyTo = email.replyTo ?? ctx?.replyTo;

  let fallbackReason: string | undefined;
  if (ctx?.gmail) {
    try {
      const accessToken = await deps.refreshAccessToken(ctx.gmail.refreshToken);
      const { id } = await deps.sendGmail(accessToken, {
        fromName: ctx.name,
        fromEmail: ctx.gmail.fromEmail,
        to: email.to,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });
      return { providerMessageId: id ? `gmail:${id}` : null, via: "gmail" };
    } catch (e) {
      fallbackReason = e instanceof Error ? e.message.slice(0, 300) : "Gmail failed";
      // A rejected grant affects Calendar too, so flag it once and tell the influencer; the email still goes out.
      if (e instanceof GoogleReconnectError) await deps.onReconnectNeeded(influencerId, fallbackReason).catch(() => {});
      if (shouldLogGmailFallback(influencerId)) {
        console.warn(
          `[email:customer] Gmail sending is not working for influencer ${influencerId}; customer emails go out from the platform address instead (logged once an hour per influencer): ${fallbackReason}`,
        );
      }
    }
  }
  const result = await deps.platformSend({ ...email, ...(replyTo ? { replyTo } : {}) });
  return { ...result, via: "platform", ...(fallbackReason ? { fallbackReason } : {}) };
}

/** Renders-and-sends helper for emails built by lib/email/templates.ts. Best effort: returns false instead of throwing. */
export async function sendCustomerRendered(
  influencerId: string,
  to: { email: string; name?: string },
  rendered: RenderedEmail,
  tag: string,
): Promise<boolean> {
  try {
    await sendCustomerEmail(influencerId, { to, subject: rendered.subject, html: rendered.html, text: rendered.text, tag });
    return true;
  } catch (e) {
    console.error(`[email:${tag}] failed`, e instanceof Error ? e.message : e);
    return false;
  }
}
