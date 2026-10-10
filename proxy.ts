import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { isCsrfExempt, isSameOriginRequest } from "@/lib/auth/csrf";
import { rateLimitHeaders, type RateLimitResult } from "@/lib/rate-limit/core";
import { clientIp, GLOBAL_API_RULE, hit, matchRouteRule } from "@/lib/rate-limit";

/**
 * Next.js 16 proxy (formerly middleware; runs on the Node.js runtime). The single request boundary for:
 *
 *  1. Rate limiting EVERY /api route: a global per-IP ceiling plus the matching route rule from
 *     lib/rate-limit/policies.ts, counted in Redis (falling back to Postgres). 429 + Retry-After when exceeded;
 *     RateLimit-* headers on every API response.
 *  2. CSRF: state-changing API requests must come from our own origin (provider webhooks are exempt; they are
 *     authenticated by signature).
 *  3. Page security: a per-request CSP nonce (strict-dynamic) and the login redirect for /dashboard and
 *     /onboarding. The redirect only checks that a session cookie exists; pages validate it against the database.
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
    console.warn(`[rate-limit] 429 ${method} ${pathname} rule=${route && !route.allowed ? rule?.name : "api"} key=${routeId}`);
    return NextResponse.json(
      { error: "Too many requests. Please wait a moment and try again.", retryAfterSec: result.retryAfterSec },
      { status: 429, headers: rateLimitHeaders(result) },
    );
  }

  const res = NextResponse.next();
  if (result) for (const [k, v] of Object.entries(rateLimitHeaders(result))) res.headers.set(k, v);
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

  // The admin console is a separate plane with its own cookie. Pages re-validate it against the database; this
  // only saves a render for visitors who obviously have no admin session.
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
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp);

  // Rolling 30-day session: every page visit pushes the browser-side expiry forward (the server-side expiry is
  // slid in lib/auth/session.ts). The value is unchanged; an invalid cookie is still rejected by the page.
  if (cookie && req.method === "GET") {
    const name = SESSION_COOKIES.find((n) => req.cookies.get(n)?.value) ?? "sa_session";
    res.cookies.set(name, cookie, {
      httpOnly: true,
      sameSite: "lax",
      secure: name.startsWith("__Host-"),
      path: "/",
      maxAge: SESSION_MAX_AGE_SEC,
    });
  }
  return res;
}

export async function proxy(req: NextRequest): Promise<NextResponse> {
  if (req.nextUrl.pathname.startsWith("/api/")) return handleApi(req);
  return handlePage(req);
}

export const config = {
  matcher: [
    // Everything except static assets and image optimisation. Prefetches still get the API/page handling.
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt|sitemap.xml|opengraph-image).*)",
  ],
};
