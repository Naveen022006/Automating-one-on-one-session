import { parsePhoneNumberFromString } from "libphonenumber-js";

/** Returns the E.164 form of a valid phone number, or null. Defaults to India for national numbers. */
export function toE164(input: string, defaultCountry: "IN" | "US" | "GB" = "IN"): string | null {
  const parsed = parsePhoneNumberFromString(input.trim(), defaultCountry);
  return parsed?.isValid() ? parsed.number : null;
}
