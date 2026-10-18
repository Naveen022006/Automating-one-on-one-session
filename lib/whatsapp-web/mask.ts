/**
 * "+919876543210" -> "+91 ••••••• 210": enough to recognise the influencer's own number, not enough to copy it. The same text as
 * `maskPhone` in commands.ts (pinned equal by a test); it lives here, with no imports, so the worker and the admin view can use it
 * without pulling in the QR renderer that commands.ts needs.
 */
export function maskE164(e164: string | null | undefined): string | null {
  const digits = e164?.replace(/\D/g, "");
  if (!digits || digits.length < 6) return null;
  return `+${digits.slice(0, 2)} ${"•".repeat(Math.max(3, digits.length - 5))} ${digits.slice(-3)}`;
}
