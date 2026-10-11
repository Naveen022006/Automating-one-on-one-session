import { IconDownload, IconSparkline } from "@web/components/icons";
import { PageHead } from "@web/components/app/AppShell";
import { Alert, Button, Card, EmptyState, Field, Input, Stat } from "@web/components/ui/primitives";
import { formatMoney } from "@/lib/format";
import type { Jsonify } from "@/lib/jsonify";
import type { DashboardEarningsView } from "@/lib/views/dashboard-earnings";
import { GetForm } from "./GetForm";

/**
 * The Earnings page body. Rendered by the old Next page and by the SPA page from the same JSON. `busy` is set by the SPA page
 * while it still shows the previous range and the next one is loading (the old page leaves it undefined).
 */
export function EarningsView({ data, busy }: { data: Jsonify<DashboardEarningsView>; busy?: boolean }) {
  const { from, to, summary } = data;
  // A plain anchor on purpose: the browser downloads the file, the page and the router are not involved.
  const exportHref = `/api/dashboard/earnings/export?from=${from}&to=${to}`;
  // Changing the range no longer reloads the page, so nothing announces the new result: this line does (a live region whose text changes).
  const found =
    data.paymentCount === 0
      ? `No payments from ${from} to ${to}.`
      : `${data.paymentCount} ${data.paymentCount === 1 ? "payment" : "payments"} from ${from} to ${to}. Net earnings ${summary.totalsByCurrency.map((t) => formatMoney(t.amountMinor, t.currency)).join(" + ")}.`;

  return (
    <div className="stack stack--lg">
      <PageHead
        title="Earnings"
        description="Captured payments net of refunds, by the date the payment was made (UTC)."
        actions={
          <a className="btn" href={exportHref}>
            <IconDownload size={16} /> Export CSV
          </a>
        }
      />
      <Card>
        <GetForm className="row" style={{ alignItems: "flex-end" }} action="/dashboard/earnings" values={{ from, to }}>
          <Field id="from" label="From">
            <Input id="from" name="from" type="date" defaultValue={from} />
          </Field>
          <Field id="to" label="To">
            <Input id="to" name="to" type="date" defaultValue={to} />
          </Field>
          <Button type="submit">Show</Button>
        </GetForm>
      </Card>
      <p role="status" className="sr-only">{busy ? "Loading…" : found}</p>
      <div className="stack stack--lg" aria-busy={busy || undefined}>
        {data.truncated && (
          <Alert tone="warning" title="Only part of this range is counted">
            This range has more payments than can be added up at once. The totals below cover the first {data.paymentCount.toLocaleString()} payments,
            oldest first. Choose a shorter range for exact totals.
          </Alert>
        )}
        {data.paymentCount === 0 ? (
          <EmptyState icon={<IconSparkline />} title="No payments in this period">
            Choose a wider date range, or share your booking page to get bookings.
          </EmptyState>
        ) : (
          <>
            <div className="grid grid--3">
              {summary.totalsByCurrency.map((t) => (
                <Card key={t.currency}>
                  <Stat label={`Net earnings (${t.currency})`} value={<span className="money">{formatMoney(t.amountMinor, t.currency)}</span>} />
                </Card>
              ))}
              <Card>
                <Stat label="Payments" value={data.paymentCount} hint={data.refundedCount ? `${data.refundedCount} refunded` : undefined} />
              </Card>
            </div>
            <div className="table-wrap">
              <table className="table table--stack">
                <caption className="sr-only">Earnings by service</caption>
                <thead>
                  <tr>
                    <th scope="col">Service</th>
                    <th scope="col" className="num">Payments</th>
                    <th scope="col" className="num">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.byService.map((s, i) => (
                    // The list is rebuilt from scratch for every range and has no id of its own: the position is its identity.
                    <tr key={i}>
                      <td data-label="Service">{s.serviceTitle}</td>
                      <td data-label="Payments" className="num">{s.count}</td>
                      <td data-label="Net" className="num">{formatMoney(s.amountMinor, s.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      <p className="subtle">Payouts follow your Razorpay settlement schedule.</p>
    </div>
  );
}
