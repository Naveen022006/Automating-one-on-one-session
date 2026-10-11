import type { Metadata } from "next";
import { InfluencersView } from "@/components/views/admin/InfluencersView";
import { parsePage } from "@/lib/admin/data";
import { requireAdminPage } from "@/lib/admin/session";
import { jsonify } from "@/lib/jsonify";
import { loadAdminInfluencersView } from "@/lib/views/admin-influencer";

export const metadata: Metadata = { title: "Influencers" };

export default async function AdminInfluencersPage({ searchParams }: { searchParams: Promise<{ page?: string; q?: string }> }) {
  await requireAdminPage("/admin/influencers");
  const sp = await searchParams;
  const q = sp.q?.slice(0, 80);
  return <InfluencersView data={jsonify(await loadAdminInfluencersView(parsePage(sp.page), q))} q={q} />;
}
