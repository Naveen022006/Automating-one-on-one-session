import { AppLink } from "@web/lib/link";
import { CancelBookingAction } from "@web/components/admin/CancelBookingAction";
import { ExportControls } from "@web/components/admin/ExportControls";
import { PageHead } from "@web/components/app/AppShell";
import { IconCalendar } from "@web/components/icons";
import { GetForm } from "@web/components/views/dashboard/GetForm";
import { Button, Card, EmptyState, Input, LinkTabs, Pagination, StatusPill } from "@web/components/ui/primitives";
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
 * The admin Bookings page body. Rendered by the SPA page from the endpoint's JSON. `busy` is set by the SPA
 * page while it still shows the previous filter or page and the next one is loading.
 */
export function BookingsView({ data, busy }: { data: Jsonify<AdminBookingsView>; busy?: boolean }) {
  const { status, q } = data;
  // The search text stays when a tab or a page is chosen.
  const search = q ? `&q=${encodeURIComponent(q)}` : "";
  const href = (p: number) => `/admin/bookings?status=${status}&page=${p}${search}`;
  // Tabs and pagination are links that no longer reload the page, so nothing announces the new list: this line does (a live region whose text changes).
  const found = `${LABEL[status]}${q ? ` matching "${q}"` : ""}: ${data.total === 0 ? "no bookings" : `${data.total} ${data.total === 1 ? "booking" : "bookings"}`}, page ${data.page} of ${data.pageCount}.`;

  return (
    <div className="stack stack--lg">
      <PageHead title="Bookings" description={`${data.total} booking${data.total === 1 ? "" : "s"}`} />
      <Card>
        <GetForm action="/admin/bookings" values={{ q, status }} className="row" style={{ alignItems: "flex-end" }}>
          <input type="hidden" name="status" defaultValue={status} />
          <Input name="q" placeholder="Search customer e-mail, name or booking reference" defaultValue={q} maxLength={120} aria-label="Search bookings" />
          <Button type="submit">Search</Button>
        </GetForm>
      </Card>
      <ExportControls kind="bookings" />
      <LinkTabs items={STATUSES.map((s) => ({ label: LABEL[s], href: `/admin/bookings?status=${s}${search}`, current: status === s }))} />
      <p role="status" className="sr-only">{busy ? "Loading…" : found}</p>
      <div className="stack stack--lg" aria-busy={busy || undefined}>
        {data.rows.length === 0 ? (
          <EmptyState icon={<IconCalendar />} title="No bookings here">
            {q ? "Nothing matches this search." : "Nothing matches this filter."}
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
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((b) => (
                  <tr key={b.id}>
                    <td data-label="Session">
                      {b.serviceTitle}
                      <div className="subtle">{new Date(b.startTime).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</div>
                    </td>
                    <td data-label="Influencer"><AppLink href={`/admin/influencers/${b.influencer.id}`}>{b.influencer.name}</AppLink></td>
                    <td data-label="Customer">{b.customerName}</td>
                    <td data-label="Status">
                      <StatusPill kind="booking" status={b.status} />
                      {b.lastError && <div className="subtle">{b.lastError}</div>}
                    </td>
                    <td data-label="Paid" className="num">{b.paidMinor ? formatMoney(b.paidMinor, b.currency) : "—"}</td>
                    <td data-label="Actions">
                      {b.cancel.allowed ? <CancelBookingAction bookingId={b.id} customerName={b.customerName} serviceTitle={b.serviceTitle} /> : null}
                    </td>
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
