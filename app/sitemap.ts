import type { MetadataRoute } from "next";
import { appUrl } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { publicInfluencerWhere } from "@/lib/public";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = appUrl();
  const staticPages = ["", "/register", "/login", "/terms", "/privacy", "/refund-policy", "/contact"].map((p) => ({
    url: `${base}${p}`,
    changeFrequency: "monthly" as const,
    priority: p === "" ? 1 : 0.5,
  }));
  const profiles = await prisma.influencer
    .findMany({ where: publicInfluencerWhere, select: { slug: true, createdAt: true }, take: 5000 })
    .catch(() => []);
  return [
    ...staticPages,
    ...profiles.map((p) => ({ url: `${base}/${p.slug}`, lastModified: p.createdAt, changeFrequency: "weekly" as const, priority: 0.7 })),
  ];
}
