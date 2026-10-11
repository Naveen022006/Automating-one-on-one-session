/**
 * The robots.txt rules (app/robots.ts renders them).
 *
 * A Disallow value is a PREFIX of the path plus query string, so `/design` would also hide the profile `/design-with-asha`, and `/admin`
 * the profile `/admin-academy` (only the exact words are reserved slugs). A page (`/dashboard`) is therefore matched exactly with `$`
 * (nothing after it) or with `?` (its query string, for the pages that have one), and its sub-pages with `/`. Only `/api/`, `/manage/`
 * and `/pay/` are prefixes on purpose (they end in a slash).
 */
export const ROBOTS_ALLOW = ["/", "/api/public/"];

export const ROBOTS_DISALLOW = [
  "/api/",
  "/dashboard$", "/dashboard/", "/dashboard?",
  "/admin$", "/admin/", "/admin?",
  "/onboarding$", "/onboarding/", "/onboarding?",
  "/manage/",
  "/pay/",
  "/design$", "/design/", "/design?",
  "/reset-password$", "/reset-password?",
  "/verify-email$", "/verify-email?",
];

/**
 * Whether a crawler that follows the robots.txt standard (RFC 9309: `*` and a closing `$` are the only special characters, the longest
 * matching rule wins, Allow wins a tie) may fetch `pathWithQuery`. Used by the tests; real crawlers do this themselves.
 */
export function robotsAllows(pathWithQuery: string, allow = ROBOTS_ALLOW, disallow = ROBOTS_DISALLOW): boolean {
  const matches = (pattern: string): number => {
    const anchored = pattern.endsWith("$");
    const body = anchored ? pattern.slice(0, -1) : pattern;
    const re = new RegExp(`^${body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}${anchored ? "$" : ""}`);
    return re.test(pathWithQuery) ? body.length : -1;
  };
  const best = (patterns: string[]) => patterns.reduce((max, p) => Math.max(max, matches(p)), -1);
  const a = best(allow);
  const d = best(disallow);
  return a >= d;
}
