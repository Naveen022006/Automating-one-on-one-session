/**
 * The words the browser shows around the booking-request flow (doc/16-request-whatsapp-flow.md). Pure, so they are tested without a
 * browser. Nothing here promises more than the server knows: "on its way" is said only when the server reports that the WhatsApp message is
 * on the queue (`whatsappQueued`), which is not the same as delivered.
 */

/** What POST /api/dashboard/bookings/:id/decision answers (the fields this file reads). */
export interface DecisionReply {
  /** The customer was sent the payment link by e-mail. */
  emailed?: unknown;
  /** The customer opted in, has a number, and the WhatsApp message is on the queue. */
  whatsappQueued?: unknown;
  /** The payment link, handed to the host only when the customer could not be e-mailed. */
  payLink?: unknown;
  /** A problem worth saying after the main sentence. */
  warning?: unknown;
}

export interface DecisionNotice {
  text: string;
  /** `error` is the red toast: something the host has to do. */
  tone: "success" | "error";
  /** The payment link to show the host (they send it themselves, or keep it as a backup), or null. */
  payLink: string | null;
  /** What the "payment link" dialog says; only meaningful when `payLink` is set. */
  payLinkDialog: string;
}

const NO_EMAIL_DIALOG = "The customer was not e-mailed: this site sends no e-mail, and Gmail is not connected. Send them this link, for example on WhatsApp. It is the only copy shown.";
const BACKUP_DIALOG =
  "The customer could not be e-mailed, but the payment link is on its way to their WhatsApp. Keep this copy in case that message does not arrive, and send it yourself if they ask. It is the only copy shown.";

/** After "Approve request". */
export function approveNotice(reply: DecisionReply): DecisionNotice {
  const emailed = reply.emailed !== false; // an older server does not say: it e-mailed
  const whatsappQueued = reply.whatsappQueued === true;
  const payLink = typeof reply.payLink === "string" && reply.payLink !== "" ? reply.payLink : null;
  const warning = typeof reply.warning === "string" && reply.warning !== "" ? ` ${reply.warning}` : "";
  if (emailed) {
    const text = whatsappQueued ? "Approved. The customer was e-mailed a link to pay, and it is on its way to their WhatsApp." : "Approved. The customer was e-mailed a link to pay.";
    return { text: `${text}${warning}`, tone: "success", payLink: null, payLinkDialog: "" };
  }
  // Nothing was e-mailed. The link is handed to the host either way: with WhatsApp on its way it is a backup, without it it is the only route.
  if (whatsappQueued) {
    return { text: `Approved. The payment link is on its way to the customer's WhatsApp. They could not be e-mailed.${warning}`, tone: "success", payLink, payLinkDialog: BACKUP_DIALOG };
  }
  return { text: "Approved, but the customer could not be e-mailed. Send them the payment link yourself.", tone: "error", payLink, payLinkDialog: NO_EMAIL_DIALOG };
}

/** After "Decline request". */
export function declineNotice(reply: DecisionReply): { text: string; tone: "success" } {
  const warning = typeof reply.warning === "string" && reply.warning !== "" ? ` ${reply.warning}` : "";
  return { text: `${reply.whatsappQueued === true ? "Request declined. The customer is being told on WhatsApp." : "Request declined."}${warning}`, tone: "success" };
}

/** The question in the decline dialog: who is told, and how. */
export function declineDialogText(customerName: string): string {
  return `${customerName} is told that the request was not accepted, by e-mail and on WhatsApp where they allowed it. They have not been charged.`;
}

/**
 * The line the customer's manage page shows while the booking is not (yet) a confirmed session. A booking that is paid or scheduled has its
 * own page content; a cancelled one has its own sentence. Null for those.
 */
export function manageStatusNotice(status: string, hostName: string): { tone: "info" | "warning"; text: string } | null {
  switch (status) {
    case "REQUESTED":
      return { tone: "info", text: `${hostName} has your request and has not answered yet. Nothing has been charged. You will be told on WhatsApp and by e-mail as soon as they answer.` };
    case "HELD":
    case "PENDING_PAYMENT":
      return { tone: "info", text: `${hostName} accepted your request. To confirm the session, pay with the payment link we sent you on WhatsApp or by e-mail. If it is not paid in time, the time is released.` };
    case "EXPIRED":
      return { tone: "warning", text: `This booking was not confirmed in time, so the time was released. Nothing was charged. To book again, visit ${hostName}'s booking page.` };
    default:
      return null;
  }
}
