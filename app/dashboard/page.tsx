import type { Metadata } from "next";
import { OverviewView } from "@/components/views/dashboard/OverviewView";
import { requirePageAuth } from "@/lib/auth/guards";
import { jsonify } from "@/lib/jsonify";
import { loadOverviewView } from "@/lib/views/dashboard-overview";

export const metadata: Metadata = { title: "Overview" };

export default async function OverviewPage() {
  const auth = await requirePageAuth("/dashboard");
  // The same function answers GET /api/dashboard/overview for the SPA, and the view gets the same JSON in both cases.
  return <OverviewView data={jsonify(await loadOverviewView(auth))} />;
}
