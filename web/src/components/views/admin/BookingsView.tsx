import Link from "next/link";
import { PageHead } from "@/components/app/AppShell";
import { IconCalendar } from "@/components/icons";
import { EmptyState, LinkTabs, Pagination, StatusPill } from "@/components/ui/primitives";
import { formatMoney } from "@/lib/format";
import type { Jsonify } from "@/lib/jsonify";
import type { AdminBookingsView, BookingStatusFilter } from "@/lib/views/admin-bookings";

const STATUSES: BookingStatusFilter[] = ["all", "REQUESTED", "PENDING_PAYMENT", "PAID", "SCHEDULED", "COMPLETED", "CANCELLED", "FAILED", "EXPIRED"];
const LABEL: Record<BookingStatusFilter, string> = {
  all: "All",
  REQUESTED: "Awaiting approval",
  PENDING_PAYMENT: "Awaiting payment",
  PAID: "Paid, no link",
  SCHEDULED: "Scheduled",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  FAILED: "Needs attention",
  EXPIRED: "Expired",
};

/**
 * The admin Bookings page body. Rendered by the old Next page and by the SPA page from the same JSON. `busy` is set by the SPA
 * page while it still shows the previous filter or page and the next one is loading (the old page leaves it undefined).
 */
export function BookingsView({ data, busy }: { data: Jsonify<AdminBookingsView>; busy?: boolean }) {
  const { status } = data;
  const href = (p: number) => `/admin/bookings?status=${status}&page=${p}`;
  // Tabs and pagination are links that no longer reload the page, so nothing announces the new list: this line does (a live region whose text changes).
  const found = `${LABEL[status]}: ${data.total === 0 ? "no bookings" : `${data.total} ${data.total === 1 ? "booking" : "bookings"}`}, page ${data.page} of ${data.pageCount}.`;

  return (
    <div className="stack stack--lg">
      <PageHead title="Bookings" description={`${data.total} booking${data.total === 1 ? "" : "s"}`} />
      <LinkTabs items={STATUSES.map((s) => ({ label: LABEL[s], href: `/admin/bookings?status=${s}`, current: status === s }))} />
      <p role="status" className="sr-only">{busy ? "Loading…" : found}</p>
      <div className="stack stack--lg" aria-busy={busy || undefined}>
        {data.rows.length === 0 ? (
          <EmptyState icon={<IconCalendar />} title="No bookings here">
            Nothing matches this filter.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table table--stack">
              <caption className="sr-only">Bookings</caption>
              <thead>
                <tr>
                  <th scope="col">Session</th>
                  <th scope="col">Influencer</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">Paid</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((b) => (
                  <tr key={b.id}>
                    <td data-label="Session">
                      {b.serviceTitle}
                      <div className="subtle">{new Date(b.startTime).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</div>
                    </td>
                    <td data-label="Influencer"><Link href={`/admin/influencers/${b.influencer.id}`}>{b.influencer.name}</Link></td>
                    <td data-label="Customer">{b.customerName}</td>
                    <td data-label="Status">
                      <StatusPill kind="booking" status={b.status} />
                      {b.lastError && <div className="subtle">{b.lastError}</div>}
                    </td>
                    <td data-label="Paid" className="num">{b.paidMinor ? formatMoney(b.paidMinor, b.currency) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={data.page} pageCount={data.pageCount} hrefFor={href} />
      </div>
    </div>
  );
}
