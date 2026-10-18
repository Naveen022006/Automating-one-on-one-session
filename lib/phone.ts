import { parsePhoneNumberFromString } from "libphonenumber-js";
import { APP_COUNTRY, INDIAN_MOBILE_ERROR, parseIndianMobile } from "@/lib/india";

export { INDIAN_MOBILE_ERROR };

/**
 * The E.164 form (`+91XXXXXXXXXX`) of an Indian mobile number, or null. The product is for India only (doc/14-india-localisation.md):
 * numbers of any other country, landlines and malformed input are null. Accepted spellings: `9876543210`, `09876543210`,
 * `+91 98765 43210`, `919876543210`, `0091 98765 43210`.
 *
 * Two checks: our own rule (lib/india.ts: ten digits, the first 6-9, which the booking form applies too) and then libphonenumber-js,
 * which must agree that the number is valid AND belongs to India.
 */
export function toE164(input: string): string | null {
  const e164 = parseIndianMobile(input);
  if (!e164) return null;
  const parsed = parsePhoneNumberFromString(e164);
  return parsed?.isValid() && parsed.country === APP_COUNTRY ? parsed.number : null;
}
