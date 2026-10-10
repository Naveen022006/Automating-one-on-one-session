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

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The Docker image (Dockerfile) builds a self-contained server in .next/standalone. It is opt-in, so `next build` /
  // `next start` and Vercel builds behave exactly as before.
  ...(process.env.BUILD_STANDALONE === "1" ? { output: "standalone" as const } : {}),
  // The SPA shell template is read from disk at run time (lib/spa/shell.ts), which the file tracer cannot see through the
  // dynamic path, so a standalone/Vercel bundle would not contain it. The key is the ROUTE (picomatch against the route
  // path, brackets escaped as the Next docs require); the value is resolved from the project root. The Dockerfile also
  // copies the file explicitly, and the production start-up check (lib/env.ts) refuses to boot without it.
  outputFileTracingIncludes: {
    "/spa-shell/\\[\\[\\.\\.\\.path\\]\\]": ["./web/dist/index.html"],
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Vite names every file in /assets by content hash, so a URL never changes meaning and can be cached for good. Only
      // paths that look like a file (`<name>.<ext>`): `/assets/book` is a page (the booking page of a profile with the slug
      // "assets") and must never be cached as immutable, it can be a private owner preview.
      { source: "/assets/:file([^/]+\\.[A-Za-z0-9]+)", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
    ];
  },
};

export default nextConfig;
