import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/app/AppShell";
import { ReconcileButton, UnreconcileButton } from "@/components/admin/PayoutActions";
import { IconCard } from "@/components/icons";
import { Alert, Badge, EmptyState, LinkTabs, Pagination, StatusPill } from "@/components/ui/primitives";
import { listPayments, MISMATCH_BOOKING_STATUSES, paymentViewCounts, parsePage, type PaymentFilter } from "@/lib/admin/data";
import { requireAdminPage } from "@/lib/admin/session";
import { formatMoney } from "@/lib/format";

export const metadata: Metadata = { title: "Payments" };

type ViewKey = NonNullable<PaymentFilter["view"]> | "all";
const VIEWS: { key: ViewKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "unreconciled", label: "To reconcile" },
  { key: "captured", label: "Paid" },
  { key: "needs-refund", label: "Needs refund" },
  { key: "mismatch", label: "No paid booking" },
  { key: "unpaid", label: "Unpaid / failed" },
];

export default async function AdminPaymentsPage({ searchParams }: { searchParams: Promise<{ page?: string; view?: string }> }) {
  await requireAdminPage("/admin/payments");
  const sp = await searchParams;
  const view = VIEWS.find((v) => v.key === sp.view)?.key ?? "all";
  const page = parsePage(sp.page);
  const [data, counts] = await Promise.all([listPayments(page, { view: view === "all" ? undefined : view }), paymentViewCounts()]);
  const countFor: Record<ViewKey, number> = {
    all: counts.all,
    unreconciled: counts.unreconciled,
    captured: counts.captured,
    "needs-refund": counts.needsRefund,
    mismatch: counts.mismatch,
    unpaid: counts.unpaid,
  };
  const href = (p: number) => `/admin/payments?view=${view}&page=${p}`;
  const toReconcile = data.rows.filter((p) => p.status === "CAPTURED" && !p.reconciledAt && !p.payoutId).map((p) => p.id);

  return (
    <div className="stack stack--lg">
      <PageHead
        title="Payments"
        description="Every payment taken through the platform. Reconcile each one with Razorpay before paying influencers."
        actions={<ReconcileButton ids={toReconcile} />}
      />
      <Alert tone="info">
        Reconciling asks Razorpay for each payment and checks the id, order, amount and status match. Only reconciled
        payments are included when you create a payout.
      </Alert>
      <LinkTabs items={VIEWS.map((v) => ({ label: v.label, href: `/admin/payments?view=${v.key}`, current: view === v.key, count: countFor[v.key] }))} />

      {data.rows.length === 0 ? (
        <EmptyState icon={<IconCard />} title="No payments here">
          Nothing matches this view.
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table table--stack">
            <caption className="sr-only">Payments</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Influencer / service</th>
                <th scope="col">Customer</th>
                <th scope="col">Payment</th>
                <th scope="col">Booking</th>
                <th scope="col" className="num">Amount</th>
                <th scope="col">Reconciled</th>
                <th scope="col">Razorpay</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((p) => {
                const svc = p.booking.session.service;
                const mismatch = p.status === "CAPTURED" && (MISMATCH_BOOKING_STATUSES as readonly string[]).includes(p.booking.status);
                const paid = p.status === "CAPTURED" || p.status === "REFUNDED";
                return (
                  <tr key={p.id}>
                    <td data-label="Date">{p.createdAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</td>
                    <td data-label="Influencer / service">
                      <Link href={`/admin/influencers/${svc.influencer.id}`}>{svc.influencer.name}</Link>
                      <div className="subtle">{svc.title}</div>
                    </td>
                    <td data-label="Customer">{p.booking.customerName}</td>
                    <td data-label="Payment">
                      <StatusPill kind="payment" status={p.status} />
                      {p.needsRefund && p.status === "CAPTURED" && <> <Badge tone="warning">Needs refund</Badge></>}
                      {p.refundStatus && (
                        <div className="subtle">
                          Refund {p.refundStatus}
                          {p.refundAmountMinor ? ` · ${formatMoney(p.refundAmountMinor, p.currency)}` : ""}
                        </div>
                      )}
                    </td>
                    <td data-label="Booking">
                      <StatusPill kind="booking" status={p.booking.status} />
                      {mismatch && <> <Badge tone="danger">Mismatch</Badge></>}
                    </td>
                    <td data-label="Amount" className="num">{formatMoney(p.amountMinor, p.currency)}</td>
                    <td data-label="Reconciled">
                      {!paid ? (
                        <span className="subtle">—</span>
                      ) : p.payoutId ? (
                        <Badge tone="info">In payout</Badge>
                      ) : p.reconciledAt ? (
                        <span className="row row--nowrap">
                          <Badge tone="success">Yes</Badge>
                          <UnreconcileButton paymentId={p.id} />
                        </span>
                      ) : (
                        <Badge tone="warning">Not yet</Badge>
                      )}
                    </td>
                    <td data-label="Razorpay" className="subtle" style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12 }}>
                      {p.providerPaymentId ?? p.providerOrderId}
                    </td>
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
