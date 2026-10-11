import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { InfluencerDetailView } from "@/components/views/admin/InfluencerDetailView";
import { requireAdminPage } from "@/lib/admin/session";
import { jsonify } from "@/lib/jsonify";
import { loadAdminInfluencerView } from "@/lib/views/admin-influencer";

export const metadata: Metadata = { title: "Influencer" };

export default async function AdminInfluencerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const admin = await requireAdminPage(`/admin/influencers/${id}`);
  // The payout approval state is per viewer (the creator of a payout cannot approve it), hence the viewer's email.
  const view = await loadAdminInfluencerView(id, admin.email);
  if (!view) notFound();
  return <InfluencerDetailView data={jsonify(view)} />;
}
