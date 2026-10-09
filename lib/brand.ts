/**
 * Product name and contact details. The brand is an open decision for the owner (doc/07 section 8), so it is
 * configurable rather than invented: set NEXT_PUBLIC_BRAND_NAME / NEXT_PUBLIC_SUPPORT_EMAIL.
 */
export const BRAND_NAME = process.env.NEXT_PUBLIC_BRAND_NAME || "Session Automation";
export const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "support@example.com";

export function appUrl(): string {
  return (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
}
