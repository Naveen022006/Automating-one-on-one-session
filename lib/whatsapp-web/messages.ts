import { describeWait, type MessageContext } from "@/lib/message-templates";

/**
 * The text of the booking messages when they go out from an influencer's QR-linked WhatsApp (plain, free-form text: this route
 * has no approved templates). Pure, so it is tested without a database.
 *
 * Nine messages exist: the five booking events (confirmation, reminder 24 h, reminder 15 min, reschedule, cancellation) and the four
 * booking-request messages (received, accepted with the payment link, declined, expired: doc/16-request-whatsapp-flow.md). Any other
 * template name has no text and is never sent this way. The time string is the one the SMS and e-mail texts show (already formatted in
 * Indian Standard Time by lib/format.ts, which this file does not touch). Customers' replies are never read, so the text makes no
 * promise about replying or stopping; it ends with the influencer's name, who the message is from.
 */

/** The values a text can show. The manage link is the customer's signed reschedule-or-cancel / status page, when one could be built. */
export type WhatsAppWebTextInput = MessageContext;

/** The messages that may be sent through a linked number. */
export const WHATSAPP_WEB_TEMPLATES = [
  "booking-confirmation",
  "reminder-24h",
  "reminder-15m",
  "reschedule",
  "cancellation",
  "request-received",
  "request-approved",
  "request-declined",
  "request-expired",
] as const;
export type WhatsAppWebTemplate = (typeof WHATSAPP_WEB_TEMPLATES)[number];

export function isWhatsAppWebTemplate(template: string): template is WhatsAppWebTemplate {
  return (WHATSAPP_WEB_TEMPLATES as readonly string[]).includes(template);
}

/** One line only: no line breaks, tabs or runs of spaces from a title or name can reshape the message. */
function line(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/ {2,}/g, " ").trim();
}

/** The message for `template`, or null when this event is not one that goes out this way. */
export function whatsAppWebText(template: string, input: WhatsAppWebTextInput): string | null {
  if (!isWhatsAppWebTemplate(template)) return null;
  const service = line(input.serviceTitle) || "your session";
  const host = line(input.influencerName) || "your host";
  const when = line(input.when);
  const link = input.link ? line(input.link) : "";
  const manage = input.manageUrl ? line(input.manageUrl) : "";
  const payUrl = input.payUrl ? line(input.payUrl) : "";
  const payBy = input.payBy ? line(input.payBy) : "";
  const amount = input.amount ? line(input.amount) : "";
  const bookingPage = input.bookingPageUrl ? line(input.bookingPageUrl) : "";
  const note = input.reason ? line(input.reason).slice(0, 300) : "";
  const wait = input.decideWithinHours ? describeWait(input.decideWithinHours) : "a couple of days";
  const signature = `- ${host}`;

  const parts: string[] = [];
  switch (template) {
    case "booking-confirmation":
      parts.push("Your booking is confirmed.", `Session: ${service} with ${host}`, `When: ${when}`);
      parts.push(link ? `Join link: ${link}` : "The join link will be sent to you shortly.");
      if (manage) parts.push(`To reschedule or cancel: ${manage}`);
      break;
    case "reminder-24h":
      parts.push("Reminder: your session is tomorrow.", `Session: ${service} with ${host}`, `When: ${when}`);
      if (link) parts.push(`Join link: ${link}`);
      if (manage) parts.push(`To reschedule or cancel: ${manage}`);
      break;
    case "reminder-15m":
      parts.push("Your session starts in 15 minutes.", `Session: ${service} with ${host}`, `When: ${when}`);
      if (link) parts.push(`Join link: ${link}`);
      break;
    case "reschedule":
      parts.push("Your session was rescheduled.", `Session: ${service} with ${host}`, `New time: ${when}`);
      if (link) parts.push(`Join link: ${link}`);
      if (manage) parts.push(`To reschedule or cancel: ${manage}`);
      break;
    case "cancellation":
      parts.push("Your session was cancelled.", `Session: ${service} with ${host}`, `Was on: ${when}`, "Any refund follows the cancellation policy.");
      break;
    case "request-received":
      parts.push("Your booking request was received.", `Session: ${service} with ${host}`, `Requested time: ${when}`);
      parts.push(`${host} has ${wait} to answer. Nothing has been charged and there is nothing to pay yet.`);
      parts.push("If the request is accepted, the payment link will be sent to you here. If it is not answered in time, it lapses and you pay nothing.");
      if (manage) parts.push(`Your booking: ${manage}`);
      break;
    case "request-approved":
      parts.push("Good news: your booking request was accepted.", `Session: ${service} with ${host}`, `When: ${when}`);
      if (amount) parts.push(`Amount to pay: ${amount}`);
      if (payBy) parts.push(`Pay by: ${payBy}. If it is not paid by then, the time is released.`);
      parts.push(payUrl ? `Pay here: ${payUrl}` : "The payment link will be sent to you shortly.");
      if (manage) parts.push(`Your booking: ${manage}`);
      break;
    case "request-declined":
      parts.push("Your booking request was not accepted.", `Session: ${service} with ${host}`, `Requested time: ${when}`);
      if (note) parts.push(`Note from ${host}: ${note}`);
      parts.push("You were not charged anything.");
      if (bookingPage) parts.push(`To pick another time: ${bookingPage}`);
      break;
    case "request-expired":
      parts.push("Your booking request was not confirmed in time.", `Session: ${service} with ${host}`, `Requested time: ${when}`);
      parts.push("The request lapsed before it was answered, so the time was released. You were not charged anything.");
      if (bookingPage) parts.push(`To request a time again: ${bookingPage}`);
      break;
  }
  // Paragraph breaks only between the headline, the details and the signature.
  const [headline, ...rest] = parts;
  return `${headline}\n\n${rest.join("\n")}\n\n${signature}`;
}

/** The test message the "send a test" button sends to the influencer's own number. Contains no customer data. */
export function whatsAppWebTestText(brand: string): string {
  const name = line(brand) || "Your booking page";
  return `This is a test message from ${name}. Your WhatsApp is linked, so booking messages to your customers can be sent from this number. You do not need to reply.`;
}
