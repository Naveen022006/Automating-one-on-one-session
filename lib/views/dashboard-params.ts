/**
 * Query-string rules shared by the dashboard list pages (Sessions, Messages) and their JSON endpoints, so an odd URL
 * means the same thing to the old Next page and to the SPA. Pure.
 */

/** `?page=` as a whole number from 1 to 9999; anything else (missing, 0, negative, 2.5, "abc", 1e9) is page 1. */
export function parsePageParam(value: string | null | undefined): number {
  const n = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(n) && n > 0 && n < 10_000 ? n : 1;
}
