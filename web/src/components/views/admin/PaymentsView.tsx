import { AppLink } from "@web/lib/link";
import { ReconcileButton, UnreconcileButton } from "@web/components/admin/PayoutActions";
import { ExportControls } from "@web/components/admin/ExportControls";
import { RefundAction } from "@web/components/admin/RefundAction";
import { PageHead } from "@web/components/app/AppShell";
import { IconCard } from "@web/components/icons";
import { Alert, Badge, EmptyState, LinkTabs, Pagination, StatusPill } from "@web/components/ui/primitives";
import { formatMoney } from "@/lib/format";
import type { Jsonify } from "@/lib/jsonify";
import type { AdminPaymentsView, PaymentViewKey } from "@/lib/views/admin-payments";
import { formatDateTime } from "@/lib/india";

const VIEWS: { key: PaymentViewKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "unreconciled", label: "To reconcile" },
  { key: "captured", label: "Paid" },
  { key: "needs-refund", label: "Needs refund" },
  { key: "mismatch", label: "No paid booking" },
  { key: "unpaid", label: "Unpaid / failed" },
];

/**
 * The admin Payments page body. Rendered by the SPA page from the endpoint's JSON. `busy` is set by the SPA
 * page while it still shows the previous tab or page and the next one is loading.
 */
export function PaymentsView({ data, busy }: { data: Jsonify<AdminPaymentsView>; busy?: boolean }) {
  const { view, counts } = data;
  const countFor: Record<PaymentViewKey, number> = {
    all: counts.all,
    unreconciled: counts.unreconciled,
    captured: counts.captured,
    "needs-refund": counts.needsRefund,
    mismatch: counts.mismatch,
    unpaid: counts.unpaid,
  };
  const href = (p: number) => `/admin/payments?view=${view}&page=${p}`;
  const toReconcile = data.rows.filter((p) => p.status === "CAPTURED" && !p.reconciled && !p.inPayout).map((p) => p.id);
  const label = VIEWS.find((v) => v.key === view)?.label ?? "All";
  // Tabs and pagination are links that no longer reload the page, so nothing announces the new list: this line does (a live region whose text changes).
  const found = `${label}: ${data.total === 0 ? "no payments" : `${data.total} ${data.total === 1 ? "payment" : "payments"}`}, page ${data.page} of ${data.pageCount}.`;

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
      <ExportControls kind="payments" />
      <LinkTabs items={VIEWS.map((v) => ({ label: v.label, href: `/admin/payments?view=${v.key}`, current: view === v.key, count: countFor[v.key] }))} />
      <p role="status" className="sr-only">{busy ? "Loading…" : found}</p>
      <div className="stack stack--lg" aria-busy={busy || undefined}>
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
                  const paid = p.status === "CAPTURED" || p.status === "REFUNDED";
                  return (
                    <tr key={p.id}>
                      <td data-label="Date">{formatDateTime(new Date(p.createdAt), { weekday: false })}</td>
                      <td data-label="Influencer / service">
                        <AppLink href={`/admin/influencers/${p.influencer.id}`}>{p.influencer.name}</AppLink>
                        <div className="subtle">{p.service.title}</div>
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
                        {p.refund.allowed ? (
                          <div style={{ marginTop: 6 }}>
                            <RefundAction
                              paymentId={p.id}
                              remainingMinor={p.refund.remainingMinor}
                              currency={p.currency}
                              customerName={p.booking.customerName}
                              influencerName={p.influencer.name}
                              inPayout={p.inPayout}
                            />
                          </div>
                        ) : p.needsRefund && p.status === "CAPTURED" && p.refund.reason ? (
                          <div className="subtle">{p.refund.reason}</div>
                        ) : null}
                      </td>
                      <td data-label="Booking">
                        <StatusPill kind="booking" status={p.booking.status} />
                        {p.mismatch && <> <Badge tone="danger">Mismatch</Badge></>}
                      </td>
                      <td data-label="Amount" className="num">{formatMoney(p.amountMinor, p.currency)}</td>
                      <td data-label="Reconciled">
                        {!paid ? (
                          <span className="subtle">—</span>
                        ) : p.inPayout ? (
                          <Badge tone="info">In payout</Badge>
                        ) : p.reconciled ? (
                          <span className="row row--nowrap">
                            <Badge tone="success">Yes</Badge>
                            <UnreconcileButton paymentId={p.id} />
                          </span>
                        ) : (
                          <Badge tone="warning">Not yet</Badge>
                        )}
                      </td>
                      <td data-label="Razorpay" className="subtle" style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12 }}>
                        {p.razorpayId}
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
    </div>
  );
}
