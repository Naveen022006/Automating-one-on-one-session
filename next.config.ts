import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

/** Security headers for every response. The CSP (with a per-request nonce) is set in proxy.ts for pages. */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  {
    key: "Permissions-Policy",
    value: 'camera=(), microphone=(), geolocation=(), payment=(self "https://api.razorpay.com" "https://checkout.razorpay.com")',
  },
  ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }] : []),
];

const privateApiHeaders = [{ key: "Cache-Control", value: "private, no-store" }];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The Docker image (Dockerfile) builds a self-contained server in .next/standalone. It is opt-in, so `next build` /
  // `next start` and Vercel builds behave exactly as before.
  ...(process.env.BUILD_STANDALONE === "1" ? { output: "standalone" as const } : {}),
  // The SPA shell template is read from disk at run time (lib/spa/shell.ts), which the file tracer cannot see through the
  // dynamic path, so a standalone/Vercel bundle would not contain it. The key is the ROUTE (picomatch against the route
  // path, brackets escaped as the Next docs require); the value is resolved from the project root. The Dockerfile also
  // copies the file explicitly. The start-up hook (lib/env.ts) checks for the file too, and runs in every server bundle, so
  // it is listed for all route bundles as well ("/*": one small file; verified: every route's .nft.json has it). Next offers
  // no way to add it to the proxy and instrumentation bundles (their entries are not matched by these keys; tried
  // `middleware`, `proxy`, `instrumentation`), which is why on a serverless platform that check is only a warning (see
  // isServerlessPlatform / initEnv), and the shell route answers 500 with one log line if it cannot read the file.
  outputFileTracingIncludes: {
    "/spa-shell/\\[\\[\\.\\.\\.path\\]\\]": ["./web/dist/index.html"],
    "/*": ["./web/dist/index.html"],
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Everything under these API prefixes belongs to one signed-in person (an influencer, an administrator, a login), whatever
      // the handler is and whatever it answers (data, a 401, a 404, a CSV): no browser cache, shared cache or CDN may keep it.
      // The handlers added in the SPA migration set this themselves (lib/views/http.ts); this covers the older ones that did
      // not (google, payout-account, whatsapp, bookings/:id, auth/sessions) and the error answers.
      { source: "/api/dashboard/:path*", headers: privateApiHeaders },
      { source: "/api/admin/:path*", headers: privateApiHeaders },
      { source: "/api/auth/:path*", headers: privateApiHeaders },
      // GET /api/bookings/:id answers with the Meet link and the self-service link of one booking (the confirmation page polls
      // it): never for a shared cache or a browser to keep. The rest of the tree (hold, cancel, reschedule, resend, ics) is
      // per-booking too.
      { source: "/api/bookings/:path*", headers: privateApiHeaders },
      // The customer portal (find your bookings): an e-mailed access token opens one address's bookings, export and erasure.
      { source: "/api/customer/:path*", headers: privateApiHeaders },
      // Vite names every file in /assets by content hash, so a URL never changes meaning and can be cached for good. Only
      // paths that look like a file (`<name>.<ext>`): `/assets/book` is a page (the booking page of a profile with the slug
      // "assets") and must never be cached as immutable, it can be a private owner preview.
      { source: "/assets/:file([^/]+\\.[A-Za-z0-9]+)", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
    ];
  },
};

export default nextConfig;
