import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/app/AppShell";
import { IconCalendar } from "@/components/icons";
import { EmptyState, LinkTabs, Pagination, StatusPill } from "@/components/ui/primitives";
import { listBookings, parsePage } from "@/lib/admin/data";
import { requireAdminPage } from "@/lib/admin/session";
import { formatMoney } from "@/lib/format";

export const metadata: Metadata = { title: "Bookings" };

const STATUSES = ["all", "REQUESTED", "PENDING_PAYMENT", "PAID", "SCHEDULED", "COMPLETED", "CANCELLED", "FAILED", "EXPIRED"] as const;
const LABEL: Record<string, string> = {
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

export default async function AdminBookingsPage({ searchParams }: { searchParams: Promise<{ page?: string; status?: string }> }) {
  await requireAdminPage("/admin/bookings");
  const sp = await searchParams;
  const status = (STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as string) : "all";
  const page = parsePage(sp.page);
  const data = await listBookings(page, status === "all" ? undefined : status);
  const href = (p: number) => `/admin/bookings?status=${status}&page=${p}`;

  return (
    <div className="stack stack--lg">
      <PageHead title="Bookings" description={`${data.total} booking${data.total === 1 ? "" : "s"}`} />
      <LinkTabs items={STATUSES.map((s) => ({ label: LABEL[s], href: `/admin/bookings?status=${s}`, current: status === s }))} />
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
              {data.rows.map((b) => {
                const svc = b.session.service;
                const paid = b.payments.filter((p) => p.status === "CAPTURED" || p.status === "REFUNDED").reduce((n, p) => n + p.amountMinor, 0);
                return (
                  <tr key={b.id}>
                    <td data-label="Session">
                      {svc.title}
                      <div className="subtle">{b.session.startTime.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</div>
                    </td>
                    <td data-label="Influencer"><Link href={`/admin/influencers/${svc.influencer.id}`}>{svc.influencer.name}</Link></td>
                    <td data-label="Customer">{b.customerName}</td>
                    <td data-label="Status">
                      <StatusPill kind="booking" status={b.status} />
                      {b.lastError && <div className="subtle">{b.lastError.slice(0, 80)}</div>}
                    </td>
                    <td data-label="Paid" className="num">{paid ? formatMoney(paid, svc.currency) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={data.page} pageCount={data.pageCount} hrefFor={href} />
    </div>
  );
}
