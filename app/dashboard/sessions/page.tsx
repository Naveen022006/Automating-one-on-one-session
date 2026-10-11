import type { Metadata } from "next";
import { SessionsView } from "@/components/views/dashboard/SessionsView";
import { requirePageAuth } from "@/lib/auth/guards";
import { jsonify } from "@/lib/jsonify";
import { loadSessionsView } from "@/lib/views/dashboard-sessions";

export const metadata: Metadata = { title: "Sessions" };

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; page?: string; booking?: string }>;
}) {
  const auth = await requirePageAuth("/dashboard/sessions");
  const sp = await searchParams;
  return <SessionsView data={jsonify(await loadSessionsView(auth.influencerId, { view: sp.view, page: sp.page }))} bookingId={sp.booking ?? null} />;
}
