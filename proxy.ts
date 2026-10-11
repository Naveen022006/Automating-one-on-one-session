import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { isCsrfExempt, isSameOriginRequest } from "@/lib/auth/csrf";
import { rateLimitHeaders, type RateLimitResult } from "@/lib/rate-limit/core";
import { clientIp, GLOBAL_API_RULE, hit, matchRouteRule, tooManyRequests } from "@/lib/rate-limit";
import { loggablePath } from "@/lib/rate-limit/redact";
import { matchPageRequest } from "@/lib/spa/routes";

/**
 * Next.js 16 proxy (formerly middleware; runs on the Node.js runtime). The single request boundary for:
 *
 *  1. Rate limiting EVERY /api route: a global per-IP ceiling plus the matching route rule from
 *     lib/rate-limit/policies.ts, counted in Redis (falling back to Postgres). 429 + Retry-After when exceeded;
 *     RateLimit-* headers on every API response.
 *  2. CSRF: state-changing API requests must come from our own origin (provider webhooks are exempt; they are
 *     authenticated by signature).
 *  3. Page security: a per-request CSP nonce (strict-dynamic) and the login redirect for /dashboard, /onboarding and
 *     /admin. The redirect only checks that a cookie exists; the API validates the session against the database.
 *  4. The React SPA (doc/12-front-end.md): every page path is rewritten to the internal shell route (app/spa-shell), which
 *     returns the Vite-built index.html with this request's nonce. Next renders no page of its own. Which paths are pages
 *     comes from lib/spa/routes.ts.
 */

const DEV = process.env.NODE_ENV !== "production";
// Meta Embedded Signup (an influencer connecting their own WhatsApp number) loads the Facebook SDK and a dialog.
const META_EMBEDDED = Boolean(process.env.META_APP_ID && process.env.META_ES_CONFIG_ID);

const SESSION_COOKIES = ["__Host-sa_session", "sa_session"];
const ADMIN_COOKIES = ["__Host-sa_admin", "sa_admin"];
const SESSION_MAX_AGE_SEC = 30 * 86_400;

function sessionCookie(req: NextRequest): string | undefined {
  for (const name of SESSION_COOKIES) {
    const v = req.cookies.get(name)?.value;
    if (v) return v;
  }
  return undefined;
}

function sessionKey(token: string): string {
  return `s:${createHash("sha256").update(token).digest("hex").slice(0, 32)}`;
}

/**
 * Rolling 30-day session: pushes the browser-side expiry of an existing session cookie forward on a GET. The value is
 * unchanged (the server-side expiry is slid in lib/auth/session.ts) and an invalid cookie is still rejected by whoever
 * validates it. Page loads do this too (handlePage), but the SPA makes few of them, so GET /api/* does it as well, otherwise
 * the browser could drop the cookie while the session is still alive on the server.
 */
function refreshSessionCookie(req: NextRequest, res: NextResponse, cookie: string | undefined): void {
  if (!cookie || req.method !== "GET") return;
  const name = SESSION_COOKIES.find((n) => req.cookies.get(n)?.value) ?? "sa_session";
  res.cookies.set(name, cookie, {
    httpOnly: true,
    sameSite: "lax",
    secure: name.startsWith("__Host-"),
    path: "/",
    maxAge: SESSION_MAX_AGE_SEC,
  });
}

function strictest(results: (RateLimitResult | null)[]): RateLimitResult | null {
  let pick: RateLimitResult | null = null;
  for (const r of results) {
    if (!r) continue;
    if (!pick) pick = r;
    else if (!r.allowed && pick.allowed) pick = r;
    else if (r.allowed === pick.allowed && r.remaining < pick.remaining) pick = r;
  }
  return pick;
}

async function handleApi(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  const method = req.method.toUpperCase();

  if (!isCsrfExempt(method, pathname) && !isSameOriginRequest(req.headers, req.url)) {
    return NextResponse.json({ error: "Cross-site request blocked" }, { status: 403 });
  }

  const ip = clientIp(req.headers);
  const rule = matchRouteRule(method, pathname);
  const cookie = sessionCookie(req);
  // Signed-in users behind one shared IP (an office, a carrier NAT) get their own bucket; a cookie that is not
  // even shaped like our session token is ignored, and the IP is always part of the key, so inventing cookies
  // cannot escape the IP's limits (the global per-IP rule applies regardless).
  const routeId =
    rule?.by === "session-or-ip" && cookie && /^[A-Za-z0-9_-]{43}$/.test(cookie) ? `ip:${ip}:${sessionKey(cookie)}` : `ip:${ip}`;
  // Health probes (rule.local) have their own memory-only limit and skip the shared global ceiling, so they never
  // depend on Redis/Postgres and are never starved by other traffic from the same address.
  const [global, route] = await Promise.all([
    rule?.local ? Promise.resolve(null) : hit(GLOBAL_API_RULE, `ip:${ip}`),
    rule ? hit(rule, routeId) : Promise.resolve(null),
  ]);
  const result = strictest([global, route]);

  if (result && !result.allowed) {
    console.warn(`[rate-limit] ${result.degraded ? 503 : 429} ${method} ${loggablePath(pathname)} rule=${route && !route.allowed ? rule?.name : "api"} key=${routeId}`);
    // 429, or 503 when a fail-closed rule (administrator code checks) could not be evaluated because no store is up.
    return tooManyRequests(result, "Too many requests. Please wait a moment and try again.");
  }

  const res = NextResponse.next();
  if (result) for (const [k, v] of Object.entries(rateLimitHeaders(result))) res.headers.set(k, v);
  // Webhooks are server-to-server (no browser session); everything else a signed-in tab calls keeps the cookie rolling.
  if (!pathname.startsWith("/api/webhooks/")) refreshSessionCookie(req, res, cookie);
  return res;
}

function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    // strict-dynamic lets the Razorpay checkout script, which our nonce'd code inserts, load and run.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://checkout.razorpay.com${META_EMBEDDED ? " https://connect.facebook.net" : ""}${DEV ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' https://*.razorpay.com${META_EMBEDDED ? " https://*.facebook.com https://graph.facebook.com" : ""}`,
    `frame-src https://api.razorpay.com https://checkout.razorpay.com${META_EMBEDDED ? " https://*.facebook.com" : ""}`,
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    ...(DEV ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

function handlePage(req: NextRequest): NextResponse {
  const { pathname, search } = req.nextUrl;
  const cookie = sessionCookie(req);

  // The SPA shell route is internal: it is only reachable through the rewrite below. A direct request (which could also
  // carry a forged x-nonce) gets a plain 404 and never reaches it.
  if (pathname === "/spa-shell" || pathname.startsWith("/spa-shell/")) return new NextResponse("Not found", { status: 404 });

  // The admin console is a separate plane with its own cookie. The admin API re-validates it against the database; this
  // only saves a page load for visitors who obviously have no admin session.
  if ((pathname === "/admin" || pathname.startsWith("/admin/")) && pathname !== "/admin/login") {
    const hasAdmin = ADMIN_COOKIES.some((n) => req.cookies.get(n)?.value);
    if (!hasAdmin) {
      const url = req.nextUrl.clone();
      url.pathname = "/admin/login";
      url.search = `?next=${encodeURIComponent(pathname + search)}`;
      return NextResponse.redirect(url);
    }
  }

  if ((pathname === "/dashboard" || pathname.startsWith("/dashboard/") || pathname.startsWith("/onboarding")) && !cookie) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(req.headers);
  // Overwritten here, so a client cannot choose the nonce the shell route will use (the route also refuses a request without it).
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  // Every page path is served by the Vite-built shell. (A request with Next's RSC or prefetch headers, for example from a
  // stale tab, cannot be told apart here: Next strips its flight headers from the request the proxy sees. The shell route
  // answers such requests cheaply, see app/spa-shell/[[...path]]/route.ts.)
  const spa = matchPageRequest(req.method, pathname);

  let res: NextResponse;
  if (spa) {
    const url = req.nextUrl.clone();
    url.pathname = `/spa-shell${pathname === "/" ? "" : pathname}`;
    res = NextResponse.rewrite(url, { request: { headers: requestHeaders } });
    // Token URLs (/manage, /verify-email, /reset-password): the token must not leak through a Referer header. Set here and
    // not in the shell route, because the security headers in next.config.ts (Referrer-Policy: strict-origin-when-cross-origin)
    // replace anything a route handler sets for the same header.
    if ("noReferrer" in spa.route && spa.route.noReferrer) res.headers.set("Referrer-Policy", "no-referrer");
  } else {
    res = NextResponse.next({ request: { headers: requestHeaders } });
  }
  res.headers.set("Content-Security-Policy", csp);

  // Rolling 30-day session: every page load pushes the browser-side expiry forward (the server-side expiry is
  // slid in lib/auth/session.ts). The value is unchanged; an invalid cookie is still rejected by whoever validates it.
  refreshSessionCookie(req, res, cookie);
  return res;
}

/**
 * A path that is not valid percent-encoding (`/%E0%A4%A`), or that decodes to a NUL byte (`/api/public/profiles/%00`), is never a
 * URL of this app. Left alone, Next answers 500 for the first on every dynamic route (`/api/pay/:token`, `/api/manage/:token`,
 * `/api/public/profiles/:slug`...), and the second reaches Postgres, which refuses a NUL in text and also ends in a 500. A 400 here
 * is cheap, and keeps these probes out of the error monitoring.
 */
function isMalformedPath(pathname: string): boolean {
  try {
    return decodeURIComponent(pathname).includes("\u0000");
  } catch {
    return true;
  }
}

/** `%00` anywhere in a query string (`?serviceId=%00`, `?q=%00`) decodes to a NUL byte: the same Postgres error, the same 400. */
const NUL_IN_QUERY = /%00/i;

export async function proxy(req: NextRequest): Promise<NextResponse> {
  if (isMalformedPath(req.nextUrl.pathname) || NUL_IN_QUERY.test(req.nextUrl.search)) return new NextResponse("Bad request", { status: 400, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" } });
  if (req.nextUrl.pathname.startsWith("/api/")) return handleApi(req);
  return handlePage(req);
}

export const config = {
  matcher: [
    // Everything except static assets and image optimisation. Prefetches still get the API/page handling.
    // `assets/<name>.<ext>` is the SPA's hashed build output (public/assets): real files that skip the proxy entirely. Only
    // paths that look like a FILE are excluded: `/assets/book` is not a file (it is the booking-page shape of the reserved
    // slug "assets"), so it keeps the proxy, its CSP and its nonce.
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt|sitemap.xml|opengraph-image|assets/[^/]+\\.[A-Za-z0-9]+$).*)",
  ],
};
