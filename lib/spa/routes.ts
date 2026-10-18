/**
 * The single route table of the React single-page app (doc/10-react-migration-plan.md, sections 1.7 and 3).
 *
 * PURE and CLIENT-SAFE on purpose: no imports, no environment, no I/O. Three different programs read it, and they must
 * never disagree about what a URL means:
 *   - proxy.ts          sends every page path to the SPA shell (the internal route app/spa-shell)
 *   - lib/spa/head.ts   decides the status code and the <head> of the shell for that path (title, robots, canonical)
 *   - web/              builds the React Router tree from it (web/src/router.tsx is typed against SpaRouteId, so
 *                       `tsc` fails when a route is added here without a page module) and builds titles from it
 *
 * Rules for editing:
 *   - A new page needs a row here AND a page module in web/src/pages (web/src/router.tsx is typed over the ids).
 *   - The title template decides the suffix ("brand" = the product name, "dashboard" and "admin" = their sections).
 *   - matchSpaRoute() decides what a URL means, including the order in which static pages win over the `/:slug`
 *     catch-all (a profile) and which paths are not pages at all.
 */

export type SpaRobots = "index" | "noindex" | "noindex,nofollow";
/** Which suffix formatTitle() puts after the title. */
export type SpaTitleTemplate = "brand" | "dashboard" | "admin" | "absolute";
/** How lib/spa/head.ts builds the head: from this table alone ("static"), or with extra logic. */
export type SpaHeadKind = "static" | "landing" | "profile" | "book" | "design";

export interface SpaRouteDef {
  /** Stable id. The web router has one lazy page module per id. */
  readonly id: string;
  /** React Router / Express style pattern. Parameter segments start with ":". */
  readonly path: string;
  readonly robots: SpaRobots;
  readonly title?: string;
  readonly template: SpaTitleTemplate;
  readonly description?: string;
  /** The canonical URL is this route's own path on APP_URL. */
  readonly canonical?: boolean;
  /** Token URLs: send `Referrer-Policy: no-referrer` so the token never leaks through a Referer header. */
  readonly noReferrer?: boolean;
  readonly head: SpaHeadKind;
}

/**
 * `as const satisfies`: the literal ids below become the SpaRouteId union while every row is still checked against
 * SpaRouteDef. `{brand}` in a title is replaced by formatTitle().
 */
export const SPA_ROUTES = [
  // --- public
  { id: "landing", path: "/", robots: "index", template: "absolute", title: "{brand}: get paid for your time, send the Meet link automatically", canonical: true, head: "landing" },
  { id: "terms", path: "/terms", robots: "index", template: "brand", title: "Terms of Service", canonical: true, head: "static" },
  { id: "privacy", path: "/privacy", robots: "index", template: "brand", title: "Privacy Policy", canonical: true, head: "static" },
  { id: "refund-policy", path: "/refund-policy", robots: "index", template: "brand", title: "Refund and Cancellation Policy", canonical: true, head: "static" },
  { id: "contact", path: "/contact", robots: "index", template: "brand", title: "Contact", canonical: true, head: "static" },
  { id: "design", path: "/design", robots: "noindex", template: "brand", title: "Design system", head: "design" },

  // --- auth
  { id: "login", path: "/login", robots: "noindex", template: "brand", title: "Log in", head: "static" },
  {
    id: "register", path: "/register", robots: "index", template: "brand", title: "Create your account",
    description: "Create a booking page for your paid 1:1 and group sessions.", head: "static",
  },
  { id: "forgot-password", path: "/forgot-password", robots: "noindex", template: "brand", title: "Reset your password", head: "static" },
  { id: "reset-password", path: "/reset-password", robots: "noindex", template: "brand", title: "Choose a new password", noReferrer: true, head: "static" },
  { id: "verify-email", path: "/verify-email", robots: "noindex", template: "brand", title: "Confirm your email", noReferrer: true, head: "static" },

  // --- booking (customer facing). pay/manage are listed before the two `:slug` routes on purpose: a static first
  // segment beats the catch-all, exactly as in Next's own routing.
  // `customer-bookings` / `customer-portal`: "find your bookings" by e-mail, then the e-mailed access link (a token page).
  { id: "customer-bookings", path: "/bookings", robots: "noindex", template: "brand", title: "Find your bookings", head: "static" },
  { id: "customer-portal", path: "/bookings/:token", robots: "noindex,nofollow", template: "brand", title: "Your bookings", noReferrer: true, head: "static" },
  { id: "pay", path: "/pay/:token", robots: "noindex,nofollow", template: "brand", title: "Complete your booking", head: "static" },
  { id: "manage", path: "/manage/:token", robots: "noindex", template: "brand", title: "Manage your booking", noReferrer: true, head: "static" },
  { id: "book", path: "/:slug/book", robots: "index", template: "brand", head: "book" },
  { id: "profile", path: "/:slug", robots: "index", template: "brand", head: "profile" },

  // --- dashboard (influencer, signed in). `onboarding` uses the brand template because it never had the dashboard layout.
  { id: "onboarding", path: "/onboarding", robots: "noindex", template: "brand", title: "Set up your booking page", head: "static" },
  { id: "dashboard", path: "/dashboard", robots: "noindex", template: "dashboard", title: "Overview", head: "static" },
  { id: "dashboard-sessions", path: "/dashboard/sessions", robots: "noindex", template: "dashboard", title: "Sessions", head: "static" },
  { id: "dashboard-services", path: "/dashboard/services", robots: "noindex", template: "dashboard", title: "Services", head: "static" },
  { id: "dashboard-availability", path: "/dashboard/availability", robots: "noindex", template: "dashboard", title: "Availability", head: "static" },
  { id: "dashboard-customers", path: "/dashboard/customers", robots: "noindex", template: "dashboard", title: "Customers", head: "static" },
  { id: "dashboard-earnings", path: "/dashboard/earnings", robots: "noindex", template: "dashboard", title: "Earnings", head: "static" },
  { id: "dashboard-payouts", path: "/dashboard/payouts", robots: "noindex", template: "dashboard", title: "Payouts", head: "static" },
  { id: "dashboard-messages", path: "/dashboard/messages", robots: "noindex", template: "dashboard", title: "Messages", head: "static" },
  { id: "dashboard-settings", path: "/dashboard/settings", robots: "noindex", template: "dashboard", title: "Settings", head: "static" },

  // --- admin console. `admin-login` sits outside the console layout, so it keeps the brand template.
  { id: "admin-login", path: "/admin/login", robots: "noindex,nofollow", template: "brand", title: "Admin sign in", head: "static" },
  { id: "admin", path: "/admin", robots: "noindex,nofollow", template: "admin", title: "Overview", head: "static" },
  { id: "admin-influencers", path: "/admin/influencers", robots: "noindex,nofollow", template: "admin", title: "Influencers", head: "static" },
  { id: "admin-influencer", path: "/admin/influencers/:id", robots: "noindex,nofollow", template: "admin", title: "Influencer", head: "static" },
  { id: "admin-payments", path: "/admin/payments", robots: "noindex,nofollow", template: "admin", title: "Payments", head: "static" },
  { id: "admin-money", path: "/admin/money", robots: "noindex,nofollow", template: "admin", title: "Money", head: "static" },
  { id: "admin-payouts", path: "/admin/payouts", robots: "noindex,nofollow", template: "admin", title: "Payouts", head: "static" },
  { id: "admin-reports", path: "/admin/reports", robots: "noindex,nofollow", template: "admin", title: "Reports", head: "static" },
  { id: "admin-bookings", path: "/admin/bookings", robots: "noindex,nofollow", template: "admin", title: "Bookings", head: "static" },
  { id: "admin-health", path: "/admin/health", robots: "noindex,nofollow", template: "admin", title: "System health", head: "static" },
  { id: "admin-audit", path: "/admin/audit", robots: "noindex,nofollow", template: "admin", title: "Audit log", head: "static" },
  { id: "admin-security", path: "/admin/security", robots: "noindex,nofollow", template: "admin", title: "Security", head: "static" },
  { id: "admin-settings", path: "/admin/settings", robots: "noindex,nofollow", template: "admin", title: "Settings", head: "static" },
] as const satisfies readonly SpaRouteDef[];

/** The id of every real page. The web router has one `lazy` module per id (typed `Record<SpaRouteId, ...>`). */
export type SpaRouteId = (typeof SPA_ROUTES)[number]["id"];

/**
 * The "Not found" screens: one for the site, one inside the dashboard frame, one inside the admin frame. They are not pages:
 * they have no lazy module, and their status is 404.
 */
export const SPA_NOT_FOUND_ROUTES = [
  { id: "not-found", path: "*", robots: "noindex", template: "brand", title: "Not found", head: "static" },
  { id: "dashboard-not-found", path: "/dashboard/*", robots: "noindex", template: "dashboard", title: "Not found", head: "static" },
  { id: "admin-not-found", path: "/admin/*", robots: "noindex,nofollow", template: "admin", title: "Not found", head: "static" },
] as const satisfies readonly SpaRouteDef[];

export type SpaNotFoundId = (typeof SPA_NOT_FOUND_ROUTES)[number]["id"];
export type SpaAnyRoute = (typeof SPA_ROUTES)[number] | (typeof SPA_NOT_FOUND_ROUTES)[number];

export interface SpaMatch {
  readonly route: SpaAnyRoute;
  /** Raw path parameters, still percent-encoded exactly as they appear in the URL (use decodeSpaParam). */
  readonly params: Readonly<Record<string, string>>;
  /** 404 for the not-found routes; 200 otherwise (lib/spa/head.ts may still turn a profile or /design into 404). */
  readonly status: 200 | 404;
}

const ROUTE_BY_ID = new Map<string, SpaAnyRoute>([...SPA_ROUTES, ...SPA_NOT_FOUND_ROUTES].map((r) => [r.id, r]));

export function spaRouteById(id: SpaRouteId | SpaNotFoundId): SpaAnyRoute {
  return ROUTE_BY_ID.get(id) as SpaAnyRoute;
}

/** Static (parameterless) pages by path. */
const STATIC_BY_PATH = new Map<string, (typeof SPA_ROUTES)[number]>(SPA_ROUTES.filter((r) => !r.path.includes(":") ).map((r) => [r.path, r]));

/**
 * A profile slug as a URL segment. Wider than SLUG_PATTERN (lib/auth/slug.ts) on purpose: the database decides whether
 * the profile exists, this only keeps obviously foreign paths (dots, spaces, percent escapes) out of the lookup.
 */
const SLUG_SEGMENT = /^[A-Za-z0-9_-]{1,60}$/;

/**
 * Paths that are never SPA pages: the JSON API, the hashed build output, Next's own internals, the internal shell
 * route, and the metadata routes that stay on the server.
 */
const EXCLUDED_DIRS = ["/api", "/assets", "/_next", "/spa-shell"] as const;
const EXCLUDED_FILES = ["/sitemap.xml", "/robots.txt", "/icon.svg", "/favicon.ico"] as const;

function isExcluded(path: string): boolean {
  for (const dir of EXCLUDED_DIRS) if (path === dir || path.startsWith(`${dir}/`)) return true;
  if ((EXCLUDED_FILES as readonly string[]).includes(path)) return true;
  // `opengraph-image` is a file route that Next may extend with a hash; `/__next*` are dev-only Next endpoints
  // (error overlay) that must keep reaching Next.
  return path.startsWith("/opengraph-image") || path.startsWith("/__next");
}

/**
 * Which SPA route serves this URL path (no query string), or null when the path is not an SPA page at all.
 * Any other path is a "Not found" route with status 404, so the browser and crawlers see a real 404.
 */
export function matchSpaRoute(pathname: string): SpaMatch | null {
  if (!pathname.startsWith("/")) return null;
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (isExcluded(path)) return null;

  const exact = STATIC_BY_PATH.get(path);
  if (exact) return { route: exact, params: {}, status: 200 };

  const parts = path.split("/").slice(1);
  const first = parts[0];

  if (first === "admin") {
    if (parts.length === 3 && parts[1] === "influencers" && parts[2]) {
      return { route: spaRouteById("admin-influencer"), params: { id: parts[2] }, status: 200 };
    }
    return { route: spaRouteById("admin-not-found"), params: {}, status: 404 };
  }
  if (first === "dashboard" || first === "onboarding") {
    return { route: spaRouteById("dashboard-not-found"), params: {}, status: 404 };
  }
  if ((first === "pay" || first === "manage") && parts.length === 2 && parts[1]) {
    return { route: spaRouteById(first), params: { token: parts[1] }, status: 200 };
  }
  // `bookings` is a reserved slug (lib/auth/slug.ts), so no profile can shadow the customer portal.
  if (first === "bookings" && parts.length === 2 && parts[1]) {
    return { route: spaRouteById("customer-portal"), params: { token: parts[1] }, status: 200 };
  }
  if (parts.length === 1 && SLUG_SEGMENT.test(first)) {
    return { route: spaRouteById("profile"), params: { slug: first }, status: 200 };
  }
  if (parts.length === 2 && parts[1] === "book" && SLUG_SEGMENT.test(first)) {
    return { route: spaRouteById("book"), params: { slug: first }, status: 200 };
  }
  return { route: spaRouteById("not-found"), params: {}, status: 404 };
}

/**
 * The match proxy.ts acts on: only safe methods count (a POST to a page URL is not a page view), so everything else falls
 * through to Next, which answers it itself.
 */
export function matchPageRequest(method: string, pathname: string): SpaMatch | null {
  if (method !== "GET" && method !== "HEAD") return null;
  return matchSpaRoute(pathname);
}

/** Percent-decodes a path parameter; a malformed escape is returned unchanged rather than throwing. */
export function decodeSpaParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The document title for a route. `{brand}` is replaced in titles that carry it. Used by the shell (server) and by
 * `<PageTitle>` (browser), so the title never changes when React takes over from the server-rendered head.
 */
export function formatTitle(title: string, template: SpaTitleTemplate, brand: string): string {
  const t = title.split("{brand}").join(brand);
  switch (template) {
    case "brand":
      return `${t} · ${brand}`;
    case "dashboard":
      return `${t} · Dashboard`;
    case "admin":
      return `${t} · Admin`;
    case "absolute":
      return t;
  }
}

/**
 * The site-wide description sentence (the head of every page that has no description of its own, lib/spa/head.ts).
 */
export const DEFAULT_DESCRIPTION =
  "Sell 1:1 and small-group sessions. Customers pick a time and pay; the Google Meet link is created and sent on WhatsApp and email automatically, with reminders.";

/** The head tags the browser keeps in step with the URL after an in-app navigation (the server writes the first page's). */
export interface ClientHead {
  description?: string;
  /** Absolute URL. */
  canonical?: string;
  robots: SpaRobots;
  /** Open Graph / Twitter title, description and url; only indexable pages with a description have one. */
  share?: { title: string; description: string; url?: string };
}

/**
 * What lib/spa/head.ts would write for `pathname`, as far as the table alone can tell (no database). Profile and booking
 * pages depend on the profile (a bio, a preview that must not be indexed), which only the server knows at first load; after
 * an in-app navigation they get the conservative head: `noindex`, no canonical, no share card. Crawlers load each URL fresh
 * and get the server's head, so this is only what a JS-rendered page view carries. `origin` is the page's own origin.
 */
export function clientHeadFor(pathname: string, origin: string, brand: string): ClientHead {
  const match = matchSpaRoute(pathname);
  if (!match || match.status === 404) return { robots: match?.route.robots ?? "noindex" };
  const route = match.route;
  if (route.head === "profile" || route.head === "book" || route.head === "design") return { robots: "noindex" };
  const canonical = "canonical" in route && route.canonical ? `${origin}${route.path === "/" ? "/" : route.path}` : undefined;
  const description =
    route.head === "landing"
      ? DEFAULT_DESCRIPTION
      : "description" in route && route.description
        ? route.description
        : route.robots === "index"
          ? DEFAULT_DESCRIPTION
          : undefined;
  const title = formatTitle(route.title ?? "", route.template, brand);
  return {
    description,
    canonical,
    robots: route.robots,
    share: route.head === "landing" || (route.robots === "index" && description) ? { title, description: description!, url: canonical } : undefined,
  };
}
