/**
 * An e-mail row that was never sent because there was no way to send it: no Gmail connection and a platform without e-mail
 * (EMAIL_PROVIDER=none, doc/15). The row is FAILED in the database (the enum has no "skipped"), but nothing failed: it is shown as a
 * neutral "No e-mail route", not as an error, and is not counted as a message that was not delivered (lib/failed-messages.ts).
 *
 * The text is the one lib/email.ts writes (NO_EMAIL_ROUTE_REASON); tests/email-none.test.ts asserts they are equal. It is repeated here
 * because browser code may not import lib/email.ts (the Vite guard).
 */
export const NO_EMAIL_ROUTE_TEXT = "Not sent: no Gmail connection and this site sends no e-mail. The customer is reached by WhatsApp or SMS where they allowed it.";

export function isNoEmailRouteMessage(m: { channel: string; error: string | null }): boolean {
  return m.channel === "EMAIL" && m.error === NO_EMAIL_ROUTE_TEXT;
}
