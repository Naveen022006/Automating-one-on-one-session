import type { MetadataRoute } from "next";
import { appUrl } from "@/lib/brand";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/dashboard", "/admin", "/onboarding", "/manage/", "/pay/", "/design", "/reset-password", "/verify-email"] }],
    sitemap: `${appUrl()}/sitemap.xml`,
  };
}
