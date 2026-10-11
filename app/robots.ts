import type { MetadataRoute } from "next";
import { appUrl } from "@/lib/brand";

// Rendered per request, like app/sitemap.ts: APP_URL is a RUNTIME value (the Docker image is built without it), and a statically
// generated robots.txt froze the build machine's value, so a deployed site told crawlers `Sitemap: http://localhost:3000/sitemap.xml`.
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  return {
    // /api/public/ is allowed on purpose: a profile page's content is loaded from /api/public/profiles/<slug>, and Google's
    // renderer obeys robots.txt for the requests a page makes (the longer, more specific Allow wins over Disallow: /api/).
    // /assets/ is deliberately not disallowed: crawlers need the SPA's JavaScript and CSS to render any page.
    rules: [{ userAgent: "*", allow: ["/", "/api/public/"], disallow: ["/api/", "/dashboard", "/admin", "/onboarding", "/manage/", "/pay/", "/design", "/reset-password", "/verify-email"] }],
    sitemap: `${appUrl()}/sitemap.xml`,
  };
}
