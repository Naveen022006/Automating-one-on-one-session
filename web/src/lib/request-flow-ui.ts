/**
 * The words the browser shows around the booking-request flow (doc/16-request-whatsapp-flow.md). Pure, so they are tested without a
 * browser. Nothing here promises more than the server knows: "on its way" is said only when the server reports a route to the customer
 * AND a message on the queue (`messageRoute`, `messageQueued`), which is not the same as delivered.
 */

/** How a message can reach the customer (the server's DeliveryRoute, lib/message-kinds.ts). */
export type MessageRoute = "whatsapp-linked" | "whatsapp-official" | "sms" | "none";

/** What POST /api/dashboard/bookings/:id/decision answers (the fields this file reads). */
export interface DecisionReply {
  /** The customer was sent the payment link by e-mail. */
  emailed?: unknown;
  /** How a message can reach the customer right now. */
  messageRoute?: unknown;
  /** The message is really on the queue (false when there is no route, the customer cannot be messaged, or the queue was down). */
  messageQueued?: unknown;
  /** The payment link, handed to the host only when the customer was not e-mailed AND no message is on its way. */
  payLink?: unknown;
  /** A problem worth saying after the main sentence. */
  warning?: unknown;
}

export interface DecisionNotice {
  text: string;
  /** `error` is the red toast: something the host has to do. */
  tone: "success" | "error";
  /** The payment link to show the host (they send it themselves), or null. */
  payLink: string | null;
  /** What the "payment link" dialog says; only meaningful when `payLink` is set. */
  payLinkDialog: string;
}

const NO_ROUTE_DIALOG = "The customer could not be reached: this site sends no e-mail, Gmail is not connected, and there is no WhatsApp or SMS route for this message. Send them this link yourself. It is the only copy shown.";

/** Which way a queued message goes, in the words the toast uses; null when nothing is on its way. */
function channelOf(reply: DecisionReply): "whatsapp" | "sms" | null {
  if (reply.messageQueued !== true) return null;
  switch (reply.messageRoute) {
    case "whatsapp-linked":
    case "whatsapp-official":
      return "whatsapp";
    case "sms":
      return "sms";
    default:
      return null; // "none", something this file does not know, or nothing: not "on its way"
  }
}

/** After "Approve request". */
export function approveNotice(reply: DecisionReply): DecisionNotice {
  const emailed = reply.emailed !== false; // an older server does not say: it e-mailed
  const channel = channelOf(reply);
  const payLink = typeof reply.payLink === "string" && reply.payLink !== "" ? reply.payLink : null;
  const warning = typeof reply.warning === "string" && reply.warning !== "" ? ` ${reply.warning}` : "";
  if (emailed) {
    const text =
      channel === "whatsapp"
        ? "Approved. The customer was e-mailed a link to pay, and it is on its way to their WhatsApp."
        : channel === "sms"
          ? "Approved. The customer was e-mailed a link to pay, and it is on its way to their phone by SMS."
          : "Approved. The customer was e-mailed a link to pay.";
    return { text: `${text}${warning}`, tone: "success", payLink: null, payLinkDialog: "" };
  }
  // Not e-mailed. With a message on its way that is the customer's link; without one the host has to send it.
  if (channel === "whatsapp") {
    return { text: `Approved. The payment link is on its way to the customer's WhatsApp. They could not be e-mailed.${warning}`, tone: "success", payLink: null, payLinkDialog: "" };
  }
  if (channel === "sms") {
    return { text: `Approved. The payment link is on its way to the customer's phone by SMS. They could not be e-mailed.${warning}`, tone: "success", payLink: null, payLinkDialog: "" };
  }
  return { text: "Approved, but the customer could not be e-mailed. Send them the payment link yourself.", tone: "error", payLink, payLinkDialog: NO_ROUTE_DIALOG };
}

/** After "Decline request". */
export function declineNotice(reply: DecisionReply): { text: string; tone: "success" } {
  const warning = typeof reply.warning === "string" && reply.warning !== "" ? ` ${reply.warning}` : "";
  const channel = channelOf(reply);
  const text = channel === "whatsapp" ? "Request declined. The customer is being told on WhatsApp." : channel === "sms" ? "Request declined. The customer is being told by SMS." : "Request declined.";
  return { text: `${text}${warning}`, tone: "success" };
}

/** The question in the decline dialog: who is told, and how. */
export function declineDialogText(customerName: string): string {
  return `${customerName} is told that the request was not accepted, by e-mail and by WhatsApp or SMS where this site can send it and they allowed it. They have not been charged.`;
}

/**
 * The line the customer's manage page shows while the booking is not (yet) a confirmed session. A booking that is paid or scheduled has its
 * own page content; a cancelled one has its own sentence. Null for those.
 */
export function manageStatusNotice(status: string, hostName: string): { tone: "info" | "warning"; text: string } | null {
  switch (status) {
    case "REQUESTED":
      return { tone: "info", text: `${hostName} has your request and has not answered yet. Nothing has been charged. You will be told as soon as they answer.` };
    case "HELD":
    case "PENDING_PAYMENT":
      return { tone: "info", text: `${hostName} accepted your request. To confirm the session, pay with the payment link you were sent. If it is not paid in time, the time is released.` };
    case "EXPIRED":
      return { tone: "warning", text: `This booking was not confirmed in time, so the time was released. Nothing was charged. To book again, visit ${hostName}'s booking page.` };
    default:
      return null;
  }
}
