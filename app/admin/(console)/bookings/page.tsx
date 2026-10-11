import type { Metadata } from "next";
import { BookingsView } from "@/components/views/admin/BookingsView";
import { requireAdminPage } from "@/lib/admin/session";
import { jsonify } from "@/lib/jsonify";
import { loadAdminBookingsView } from "@/lib/views/admin-bookings";

export const metadata: Metadata = { title: "Bookings" };

export default async function AdminBookingsPage({ searchParams }: { searchParams: Promise<{ page?: string; status?: string }> }) {
  await requireAdminPage("/admin/bookings");
  const sp = await searchParams;
  return <BookingsView data={jsonify(await loadAdminBookingsView({ status: sp.status, page: sp.page }))} />;
}
