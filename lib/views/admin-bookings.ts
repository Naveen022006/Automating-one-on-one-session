import { adminCancelEligibility } from "@/lib/admin/cancel";
import { BOOKING_SEARCH_MAX, listBookings, parsePage } from "@/lib/admin/data";

/**
 * The admin Bookings page's data, for GET /api/admin/bookings. The caller has already passed the admin
 * gate (`requireAdminMfa()`).
 */

/** The filter tabs; "all" is the default. Any other `?status=` is treated as "all". */
export const BOOKING_STATUS_FILTERS = ["all", "REQUESTED", "PENDING_PAYMENT", "PAID", "SCHEDULED", "COMPLETED", "CANCELLED", "FAILED", "EXPIRED"] as const;
export type BookingStatusFilter = (typeof BOOKING_STATUS_FILTERS)[number];

export function parseBookingStatus(value: string | null | undefined): BookingStatusFilter {
  return BOOKING_STATUS_FILTERS.find((s) => s === value) ?? "all";
}

export interface AdminBookingRow {
  id: string;
  serviceTitle: string;
  startTime: Date;
  influencer: { id: string; name: string };
  customerName: string;
  status: string;
  /** The page shows the first 80 characters; the rest is never sent. */
  lastError: string | null;
  /** Captured or refunded payments added up, in the service's currency; 0 when nothing was paid. */
  paidMinor: number;
  currency: string;
  /** Whether the Cancel button is offered, worked out on the server (adminCancelEligibility); `reason` says why not. */
  cancel: { allowed: boolean; reason: string | null };
}

export interface AdminBookingsView {
  /** The search text the list was filtered by (trimmed, at most 120 characters), "" for none. */
  q: string;
  status: BookingStatusFilter;
  page: number;
  pageCount: number;
  total: number;
  rows: AdminBookingRow[];
}

export async function loadAdminBookingsView(params: { status?: string | null; page?: string | null; q?: string | null }): Promise<AdminBookingsView> {
  const status = parseBookingStatus(params.status);
  const q = (params.q ?? "").trim().slice(0, BOOKING_SEARCH_MAX);
  const data = await listBookings(parsePage(params.page ?? undefined), status === "all" ? undefined : status, q || undefined);
  const now = new Date();
  return {
    q,
    status,
    page: data.page,
    pageCount: data.pageCount,
    total: data.total,
    // A booking deleted (with its session: a cascade) while the page is being read can come back without its relations. It no longer
    // exists, so it is left out, instead of the whole page failing on it.
    rows: data.rows.filter((b) => b.session?.service?.influencer).map((b) => {
      const svc = b.session.service;
      return {
        id: b.id,
        serviceTitle: svc.title,
        startTime: b.session.startTime,
        influencer: { id: svc.influencer.id, name: svc.influencer.name },
        customerName: b.customerName,
        status: b.status,
        lastError: b.lastError ? b.lastError.slice(0, 80) : null,
        paidMinor: b.payments.filter((p) => p.status === "CAPTURED" || p.status === "REFUNDED").reduce((n, p) => n + p.amountMinor, 0),
        currency: svc.currency,
        cancel: (() => {
          const e = adminCancelEligibility({ status: b.status, startTime: b.session.startTime }, now);
          return { allowed: e.allowed, reason: e.allowed ? null : e.reason };
        })(),
      };
    }),
  };
}
