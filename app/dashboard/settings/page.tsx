import type { Metadata } from "next";
import { SettingsView } from "@/components/views/dashboard/SettingsView";
import { requirePageAuth } from "@/lib/auth/guards";
import { jsonify } from "@/lib/jsonify";
import { loadSettingsView } from "@/lib/views/dashboard-settings";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ google?: string }> }) {
  const auth = await requirePageAuth("/dashboard/settings");
  const { google: outcome } = await searchParams;
  return <SettingsView data={jsonify(await loadSettingsView(auth))} outcome={outcome ?? null} />;
}
