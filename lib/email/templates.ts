import { BRAND_NAME } from "@/lib/brand";
import { formatDuration, formatMoney, formatSessionTime } from "@/lib/format";
import { renderEmail, type RenderedEmail } from "./layout";

/** Customer booking emails. Pure: data in, subject/html/text out (unit-testable, no DB). */
export type BookingEmailKind = "booking-confirmation" | "receipt" | "booking-rescheduled" | "booking-cancelled";

export interface BookingEmailData {
  customerName: string;
  serviceTitle: string;
  influencerName: string;
  durationMin: number;
  startTime: Date;
  meetLink: string | null;
  manageUrl: string | null;
  icsUrl: string | null;
  payment: { amountMinor: number; currency: string; reference: string | null } | null;
  /** Cancellation only: what happens to the money. */
  refundNote?: string | null;
  /** The service's "what to prepare" note, shown in the confirmation. */
  prepNotes?: string | null;
}

export function bookingEmail(kind: BookingEmailKind, d: BookingEmailData): RenderedEmail {
  const when = formatSessionTime(d.startTime);
  const first = d.customerName.split(" ")[0] || d.customerName;
  const baseDetails: [string, string][] = [
    ["Session", d.serviceTitle],
    ["With", d.influencerName],
    ["When", when],
    ["Length", formatDuration(d.durationMin)],
  ];
  const manageLinks = [
    ...(d.icsUrl ? [{ label: "Add to calendar", url: d.icsUrl }] : []),
    ...(d.manageUrl ? [{ label: "Reschedule or cancel", url: d.manageUrl }] : []),
  ];

  switch (kind) {
    case "booking-confirmation":
      return renderEmail(`Confirmed: ${d.serviceTitle} on ${when}`, {
        preheader: `Your session with ${d.influencerName} is booked. ${d.meetLink ? "Your Google Meet link is inside." : ""}`,
        heading: "Your session is confirmed",
        paragraphs: [
          `Hi ${first}, thank you for booking. Everything you need is below.`,
          d.meetLink
            ? "Join with the button at the session time. The same link was sent to your WhatsApp."
            : "Your Google Meet link is being created and will follow in a separate message shortly.",
          ...(d.prepNotes ? [`Before your session: ${d.prepNotes}`] : []),
        ],
        // The confirmation doubles as the receipt: amount and payment reference are included.
        details: [
          ...baseDetails,
          ...(d.payment
            ? ([
                ["Paid", formatMoney(d.payment.amountMinor, d.payment.currency)],
                ...(d.payment.reference ? [["Payment reference", d.payment.reference]] : []),
              ] as [string, string][])
            : []),
        ],
        button: d.meetLink ? { label: "Join Google Meet", url: d.meetLink } : undefined,
        links: manageLinks,
        footnote: `You received this email because you booked a session with ${d.influencerName} through ${BRAND_NAME}.`,
      });

    case "receipt":
      return renderEmail(`Receipt for ${d.serviceTitle}`, {
        preheader: `Payment received for your session with ${d.influencerName}.`,
        heading: "Payment receipt",
        paragraphs: [`Hi ${first}, we received your payment. Keep this email for your records.`],
        details: [
          ...baseDetails,
          ...(d.payment
            ? ([
                ["Amount", formatMoney(d.payment.amountMinor, d.payment.currency)],
                ...(d.payment.reference ? [["Payment reference", d.payment.reference]] : []),
              ] as [string, string][])
            : []),
        ],
        links: manageLinks,
        footnote: "Payments are processed by Razorpay.",
      });

    case "booking-rescheduled":
      return renderEmail(`Rescheduled: ${d.serviceTitle} is now ${when}`, {
        preheader: `New time: ${when}.`,
        heading: "Your session has a new time",
        paragraphs: [
          `Hi ${first}, your session with ${d.influencerName} was moved. Your calendar invite has been updated.`,
          d.meetLink ? "Your join link stays the same." : "Your join link will follow shortly.",
        ],
        details: baseDetails,
        button: d.meetLink ? { label: "Join Google Meet", url: d.meetLink } : undefined,
        links: manageLinks,
      });

    case "booking-cancelled":
      return renderEmail(`Cancelled: ${d.serviceTitle} on ${when}`, {
        preheader: `Your session with ${d.influencerName} was cancelled.`,
        heading: "Your session was cancelled",
        paragraphs: [
          `Hi ${first}, your session with ${d.influencerName} on ${when} has been cancelled and removed from your calendar.`,
          d.refundNote ?? "Any refund follows the cancellation policy shown when you booked.",
        ],
        details: [["Session", d.serviceTitle], ["Was scheduled for", when]],
      });
  }
}

/** Account emails for influencers. */
export function verifyEmailMessage(name: string, url: string): RenderedEmail {
  return renderEmail(`Confirm your email for ${BRAND_NAME}`, {
    preheader: "Confirm your email address to finish setting up your account.",
    heading: "Confirm your email",
    paragraphs: [`Hi ${name.split(" ")[0] || name}, please confirm this is your email address. The link works for 24 hours.`],
    button: { label: "Confirm email", url },
    footnote: "If you did not create an account, you can ignore this email.",
  });
}

export function passwordResetMessage(name: string, url: string): RenderedEmail {
  return renderEmail(`Reset your ${BRAND_NAME} password`, {
    preheader: "Use this link within an hour to choose a new password.",
    heading: "Reset your password",
    paragraphs: [
      `Hi ${name.split(" ")[0] || name}, we received a request to reset your password. The link works once, for 1 hour.`,
    ],
    button: { label: "Choose a new password", url },
    footnote: "If you did not ask for this, ignore this email. Your password will not change.",
  });
}

export function passwordChangedMessage(name: string): RenderedEmail {
  return renderEmail(`Your ${BRAND_NAME} password was changed`, {
    preheader: "Your password was changed and other sessions were signed out.",
    heading: "Password changed",
    paragraphs: [
      `Hi ${name.split(" ")[0] || name}, the password for your account was just changed and every other signed-in device was logged out.`,
      "If this was not you, reset your password immediately and contact support.",
    ],
  });
}

export function influencerAlertMessage(
  name: string,
  alert: { title: string; detail: string; actionLabel?: string; actionUrl?: string },
): RenderedEmail {
  return renderEmail(`Action needed: ${alert.title}`, {
    preheader: alert.detail.slice(0, 120),
    heading: alert.title,
    paragraphs: [`Hi ${name.split(" ")[0] || name},`, alert.detail],
    button: alert.actionUrl ? { label: alert.actionLabel ?? "Open dashboard", url: alert.actionUrl } : undefined,
    footnote: "You can change notification preferences in Settings.",
  });
}

/**
 * Platform-owner notice from the system health monitor (sent to ADMIN_ALERT_EMAILS): something crossed its threshold,
 * or conditions raised earlier have cleared. Several conditions found in one monitor run share one email.
 */
export function systemHealthMessage(d: {
  recovered: boolean;
  items: { label: string; detail: string; hint?: string }[];
  healthUrl: string;
}): RenderedEmail {
  const first = d.items[0]?.label ?? "System health";
  const more = d.items.length > 1 ? ` and ${d.items.length - 1} more` : "";
  return renderEmail(`${BRAND_NAME} ${d.recovered ? "recovered" : "alert"}: ${first}${more}`, {
    preheader: (d.items[0]?.detail ?? "").slice(0, 120),
    heading: d.recovered ? "Back to normal" : "Something needs attention",
    paragraphs: [
      d.recovered
        ? "The following problems raised earlier have cleared."
        : "The system health monitor found the following. The same alert is not repeated within the hour.",
    ],
    details: d.items.map((i) => [i.label, i.hint ? `${i.detail} ${i.hint}` : i.detail] as [string, string]),
    button: { label: "Open system health", url: d.healthUrl },
    footnote: "You receive this because your address is listed in ADMIN_ALERT_EMAILS.",
  });
}

/** Security notice: payout details were saved or changed. Sent regardless of notification preferences. */
export function payoutDetailsSavedMessage(name: string, summary: string): RenderedEmail {
  return renderEmail(`Your ${BRAND_NAME} payout details were updated`, {
    preheader: "Your payout details were saved and are waiting for review.",
    heading: "Payout details updated",
    paragraphs: [
      `Hi ${name.split(" ")[0] || name}, the payout details on your account were just saved: ${summary}.`,
      "They need to be verified by our team before we can send you money. If you did not make this change, reset your password immediately and contact support.",
    ],
  });
}

export function payoutDetailsReviewedMessage(name: string, outcome: { verified: true } | { verified: false; reason: string }): RenderedEmail {
  const first = name.split(" ")[0] || name;
  return outcome.verified
    ? renderEmail(`Your ${BRAND_NAME} payout details are verified`, {
        preheader: "You are set up to receive payouts.",
        heading: "Payout details verified",
        paragraphs: [`Hi ${first}, your payout details have been verified. Your earnings will be paid out to this account.`],
      })
    : renderEmail(`Action needed: fix your ${BRAND_NAME} payout details`, {
        preheader: outcome.reason.slice(0, 120),
        heading: "We could not verify your payout details",
        paragraphs: [`Hi ${first}, we could not verify your payout details.`, outcome.reason, "Please correct them in your dashboard under Payouts."],
      });
}

export function payoutSentMessage(
  name: string,
  d: { netMinor: number; currency: string; destination: string; reference: string; paymentCount: number; feeMinor: number },
): RenderedEmail {
  return renderEmail(`${formatMoney(d.netMinor, d.currency)} is on its way to you`, {
    preheader: `Payout sent to ${d.destination}.`,
    heading: "Your payout was sent",
    paragraphs: [
      `Hi ${name.split(" ")[0] || name}, we have sent your payout. It usually reaches your account within one working day.`,
    ],
    details: [
      ["Amount", formatMoney(d.netMinor, d.currency)],
      ["Sent to", d.destination],
      ["Bank reference", d.reference],
      ["Sessions", String(d.paymentCount)],
      ...(d.feeMinor > 0 ? ([["Platform fee deducted", formatMoney(d.feeMinor, d.currency)]] as [string, string][]) : []),
    ],
  });
}

/** Booking-request emails to the customer (services that need the influencer's approval). */
export type RequestEmailKind = "request-received" | "request-approved" | "request-declined";

export interface RequestEmailData {
  customerName: string;
  serviceTitle: string;
  influencerName: string;
  startTime: Date;
  /** Approved: the signed payment link and the deadline, and the amount to pay. */
  payUrl?: string;
  payBy?: Date;
  amount?: { amountMinor: number; currency: string };
  /** Declined: the reason the influencer gave, if any. */
  reason?: string | null;
  /** How long a request waits for an answer, in hours (received only). */
  decideWithinHours?: number;
}

export function requestEmail(kind: RequestEmailKind, d: RequestEmailData): RenderedEmail {
  const when = formatSessionTime(d.startTime);
  const first = d.customerName.split(" ")[0] || d.customerName;
  const details: [string, string][] = [
    ["Session", d.serviceTitle],
    ["With", d.influencerName],
    ["Requested time", when],
  ];
  switch (kind) {
    case "request-received":
      return renderEmail(`Request sent: ${d.serviceTitle} with ${d.influencerName}`, {
        preheader: `${d.influencerName} will review your request. Nothing has been charged.`,
        heading: "Your request is with " + d.influencerName,
        paragraphs: [
          `Hi ${first}, thanks for your request. ${d.influencerName} reviews each booking personally${d.decideWithinHours ? ` and usually replies within ${Math.round(d.decideWithinHours / 24) >= 2 ? `${Math.round(d.decideWithinHours / 24)} days` : `${d.decideWithinHours} hours`}` : ""}.`,
          "Nothing has been charged. If they approve, we will email you a link to pay and confirm your session. The time is held for you until they decide.",
        ],
        details,
        footnote: `You received this email because you requested a session through ${BRAND_NAME}.`,
      });
    case "request-approved":
      return renderEmail(`Approved: pay to confirm ${d.serviceTitle}`, {
        preheader: `${d.influencerName} approved your request. Pay to confirm your session.`,
        heading: "Your request was approved",
        paragraphs: [
          `Hi ${first}, ${d.influencerName} approved your request. To confirm your session, complete the payment${d.payBy ? ` by ${formatSessionTime(d.payBy)}` : ""}. Your time is held until then.`,
        ],
        details: [...details, ...(d.amount ? ([["Amount", formatMoney(d.amount.amountMinor, d.amount.currency)]] as [string, string][]) : [])],
        button: d.payUrl ? { label: "Pay and confirm", url: d.payUrl } : undefined,
        footnote: "If you do not pay in time the held slot is released.",
      });
    case "request-declined":
      return renderEmail(`Your request for ${d.serviceTitle} was not accepted`, {
        preheader: `${d.influencerName} could not accept this request. You were not charged.`,
        heading: "Your request was not accepted",
        paragraphs: [
          `Hi ${first}, unfortunately ${d.influencerName} could not accept your request for ${when}. You have not been charged.`,
          ...(d.reason ? [`Their note: ${d.reason}`] : []),
          "You are welcome to choose another time on their booking page.",
        ],
        details,
      });
  }
}

/** Security notices to an administrator about their own account. Pure; every field is HTML-escaped by renderEmail. */
export type AdminSecurityEvent = "2fa-enabled" | "2fa-disabled" | "recovery-regenerated" | "mfa-locked";

export function adminSecurityMessage(
  name: string,
  event: AdminSecurityEvent,
  d: { at: Date; ip?: string | null; lockedUntil?: Date | null },
): RenderedEmail {
  const first = name.split(" ")[0] || name;
  const details: [string, string][] = [["When", formatSessionTime(d.at)], ...(d.ip ? ([["From IP address", d.ip]] as [string, string][]) : [])];
  const notYou = "If this was not you, someone has your password and a signed-in session. Change your password now and ask the platform owner to review the audit log.";
  switch (event) {
    case "2fa-enabled":
      return renderEmail(`Two-factor authentication was turned on for your ${BRAND_NAME} admin account`, {
        preheader: "Your administrator sign-in now asks for a code.",
        heading: "Two-factor authentication is on",
        paragraphs: [`Hi ${first}, two-factor authentication was just turned on for your administrator account. Your other sessions were signed out.`, notYou],
        details,
      });
    case "2fa-disabled":
      return renderEmail(`Two-factor authentication was turned off for your ${BRAND_NAME} admin account`, {
        preheader: "Your administrator sign-in no longer asks for a code.",
        heading: "Two-factor authentication is off",
        paragraphs: [`Hi ${first}, two-factor authentication was just turned off for your administrator account. Your other sessions were signed out.`, notYou],
        details,
      });
    case "recovery-regenerated":
      return renderEmail(`New recovery codes for your ${BRAND_NAME} admin account`, {
        preheader: "Your previous recovery codes no longer work.",
        heading: "New recovery codes were generated",
        paragraphs: [`Hi ${first}, a new set of recovery codes was just generated for your administrator account. The previous codes no longer work.`, notYou],
        details,
      });
    case "mfa-locked":
      return renderEmail(`Authenticator sign-in is locked for your ${BRAND_NAME} admin account`, {
        preheader: "Too many incorrect codes were entered.",
        heading: "Authenticator codes are locked for now",
        paragraphs: [
          `Hi ${first}, too many incorrect authentication codes were entered for your administrator account, so authenticator codes are refused${d.lockedUntil ? ` until ${formatSessionTime(d.lockedUntil)}` : " for a while"}. You can still sign in with a recovery code.`,
          "If you did not try to sign in, someone knows your password. Change it now and tell the platform owner.",
        ],
        details,
      });
  }
}
