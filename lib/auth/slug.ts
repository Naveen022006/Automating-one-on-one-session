/**
 * Public booking-page slugs (`/<slug>` and `/<slug>/book`). They share the URL root with app routes, so app
 * route names and other confusing words are reserved. `assets` (the SPA's hashed build files) and `spa-shell` (the
 * internal route behind the SPA's HTML shell) are reserved because they are URL prefixes the server answers itself, and so
 * are `pay` (the pay links `/pay/<token>` would shadow the profile's `/pay/book`) and `opengraph-image` (a metadata route).
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "admin", "api", "app", "assets", "auth", "billing", "blog", "book", "booking", "bookings", "contact", "dashboard",
  "design", "docs", "error", "faq", "features", "forgot-password", "help", "home", "how-it-works", "index",
  "legal", "login", "logout", "manage", "me", "new", "null", "onboarding", "opengraph-image", "pay", "pricing", "privacy", "profile",
  "refund-policy", "refunds", "register", "reset-password", "robots", "root", "settings", "signin", "signup",
  "sitemap", "spa-shell", "static", "status", "support", "system", "terms", "undefined", "verify-email", "www", "_next",
]);

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

/** Returns a problem with the slug, or null if it can be used (uniqueness is checked against the database separately). */
export function slugProblem(slug: string): string | null {
  if (!SLUG_PATTERN.test(slug)) {
    return "Use 3-40 lowercase letters, numbers and hyphens, starting and ending with a letter or number.";
  }
  if (slug.includes("--")) return "Do not use two hyphens in a row.";
  if (RESERVED_SLUGS.has(slug)) return "This address is reserved. Please choose another.";
  return null;
}

/** "Priya Sharma" -> "priya-sharma". Falls back to "creator" when nothing usable is left. */
export function suggestSlug(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  if (base.length < 3) return "creator";
  return RESERVED_SLUGS.has(base) ? `${base}-sessions` : base;
}
