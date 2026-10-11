import type { Metadata } from "next";
import { OverviewView } from "@/components/views/admin/OverviewView";
import { requireAdminPage } from "@/lib/admin/session";
import { jsonify } from "@/lib/jsonify";
import { loadAdminOverviewView } from "@/lib/views/admin-overview";

export const metadata: Metadata = { title: "Overview" };

export default async function AdminOverviewPage() {
  await requireAdminPage("/admin");
  // The same function answers GET /api/admin/overview for the SPA; jsonify makes this page render from the JSON it receives.
  return <OverviewView data={jsonify(await loadAdminOverviewView())} />;
}
