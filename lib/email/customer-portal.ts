import { BRAND_NAME } from "@/lib/brand";
import { renderEmail, type RenderedEmail } from "./layout";

/** Customer portal e-mails ("find your bookings"). Pure: data in, subject/html/text out. Nothing customer- or host-supplied goes in. */

export function portalLinkMessage(url: string): RenderedEmail {
  return renderEmail(`Your ${BRAND_NAME} bookings`, {
    preheader: "Use this link within 60 minutes to see, download or erase your bookings.",
    heading: "Your bookings",
    paragraphs: [
      "You asked to see the bookings made with this e-mail address. The link below opens them and works for 60 minutes.",
      "From there you can open your manage links and receipts, download your data, or erase it.",
    ],
    button: { label: "See my bookings", url },
    footnote: "If you did not ask for this, ignore this e-mail. Nothing changes, and nobody can see your bookings without this link.",
  });
}

export function portalErasedMessage(result: { erased: number; blocked: number }): RenderedEmail {
  const kept =
    result.blocked > 0
      ? `${result.blocked} upcoming ${result.blocked === 1 ? "booking was" : "bookings were"} kept so the ${result.blocked === 1 ? "session" : "sessions"} can still happen. Cancel ${result.blocked === 1 ? "it" : "them"} from your manage link${result.blocked === 1 ? "" : "s"}, then ask again to erase the rest.`
      : "No upcoming bookings were kept.";
  return renderEmail(`Your ${BRAND_NAME} data was erased`, {
    preheader: "We erased your details from your past bookings.",
    heading: "Your data was erased",
    paragraphs: [
      `We erased your name, e-mail address, phone number, time zone and booking answers from ${result.erased} ${result.erased === 1 ? "booking" : "bookings"}.`,
      kept,
      "Payment records are kept without your personal details, as the law requires for accounting.",
    ],
    footnote: "If you did not ask for this, contact support.",
  });
}
