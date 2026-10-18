import { APP_TIME_ZONE } from "@/lib/india";

/**
 * Minimal RFC 5545 calendar file for "Add to calendar" (Apple Calendar, Outlook, Google via import). Pure.
 */

function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Escapes TEXT values (RFC 5545 3.3.11). */
export function icsText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Folds lines longer than 75 octets (RFC 5545 3.1). */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest, "utf8") > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut), "utf8") > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join("\r\n");
}

export function buildIcs(e: {
  uid: string;
  title: string;
  description: string;
  start: Date;
  end: Date;
  url?: string | null;
  organizerName?: string;
  now?: Date;
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Session Automation//Bookings//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-TIMEZONE:${APP_TIME_ZONE}`,
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${icsText(e.uid)}`,
    `DTSTAMP:${icsDate(e.now ?? new Date())}`,
    `DTSTART:${icsDate(e.start)}`,
    `DTEND:${icsDate(e.end)}`,
    `SUMMARY:${icsText(e.title)}`,
    `DESCRIPTION:${icsText(e.description)}`,
    ...(e.url ? [`URL:${icsText(e.url)}`, `LOCATION:${icsText(e.url)}`] : []),
    ...(e.organizerName ? [`ORGANIZER;CN=${icsText(e.organizerName).replace(/:/g, "")}:mailto:noreply@invalid.invalid`] : []),
    "BEGIN:VALARM",
    "TRIGGER:-PT15M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsText(e.title)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
