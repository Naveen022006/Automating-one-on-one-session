import type { Metadata } from "next";
import { MessagesView } from "@/components/views/dashboard/MessagesView";
import { requirePageAuth } from "@/lib/auth/guards";
import { jsonify } from "@/lib/jsonify";
import { loadMessagesView } from "@/lib/views/dashboard-messages";

export const metadata: Metadata = { title: "Messages" };

export default async function MessagesPage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  const auth = await requirePageAuth("/dashboard/messages");
  const sp = await searchParams;
  return <MessagesView data={jsonify(await loadMessagesView(auth.influencerId, { status: sp.status, page: sp.page }))} />;
}
