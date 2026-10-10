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
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
