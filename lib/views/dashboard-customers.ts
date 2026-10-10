import { listCustomers, type CustomerRow } from "@/lib/dashboard-data";

/**
 * The Customers page's data, for the old Next page and GET /api/dashboard/customers. Scoped to the influencer id from
 * the login session. Names and emails are shown here, to the influencer they booked with, exactly as the page always did.
 */

const MAX_QUERY_LENGTH = 200;

export interface DashboardCustomersView {
  /** The search text actually used (trimmed, at most 200 characters), echoed back for the search box. */
  q: string;
  customers: CustomerRow[];
}

export async function loadCustomersView(influencerId: string, rawQuery: string | null | undefined, now?: Date): Promise<DashboardCustomersView> {
  const q = (rawQuery ?? "").trim().slice(0, MAX_QUERY_LENGTH);
  return { q, customers: await listCustomers(influencerId, q || null, now) };
}
