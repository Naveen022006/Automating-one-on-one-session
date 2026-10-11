import { BRAND_NAME } from "@/lib/brand";
import { renderEmail, type RenderedEmail } from "./layout";

/**
 * What an influencer is told when the platform changes the standing of their account. Pure: each function returns the
 * rendered message and nothing else. Every value goes through `renderEmail`, which escapes it, so a reason typed by an
 * administrator can never inject markup. Sent best-effort by lib/admin/moderation.ts.
 */

function firstName(name: string): string {
  return name.split(" ")[0] || name;
}

export function accountSuspendedMessage(name: string, reason: string, supportEmail: string): RenderedEmail {
  return renderEmail(`Your ${BRAND_NAME} booking page has been suspended`, {
    preheader: "Your booking page is offline until the suspension is lifted.",
    heading: "Your account has been suspended",
    paragraphs: [
      `Hi ${firstName(name)}, we have suspended your account. Your booking page is offline and new bookings and new payouts are paused.`,
      "Sessions that are already booked and paid are not cancelled. You can still sign in, deliver them, and cancel or refund them from your dashboard.",
      `Contact ${supportEmail} to resolve this.`,
    ],
    details: [["Reason", reason]],
  });
}

export function accountReinstatedMessage(name: string, pageUrl: string): RenderedEmail {
  return renderEmail(`Your ${BRAND_NAME} account has been reinstated`, {
    preheader: "Your booking page is back online.",
    heading: "Your account has been reinstated",
    paragraphs: [`Hi ${firstName(name)}, the suspension on your account has been lifted. Your booking page is live again (as long as everything on your go-live checklist is still in place).`],
    button: { label: "Open your booking page", url: pageUrl },
  });
}

export function accountApprovedMessage(name: string, pageUrl: string): RenderedEmail {
  return renderEmail(`Your ${BRAND_NAME} booking page has been approved`, {
    preheader: "We reviewed your page and approved it.",
    heading: "Your page has been approved",
    paragraphs: [`Hi ${firstName(name)}, we reviewed your booking page and approved it. It goes live as soon as everything else on your go-live checklist is done.`],
    button: { label: "Open your booking page", url: pageUrl },
  });
}
