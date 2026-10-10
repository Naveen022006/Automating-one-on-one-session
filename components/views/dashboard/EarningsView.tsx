import { IconDownload, IconSparkline } from "@/components/icons";
import { PageHead } from "@/components/app/AppShell";
import { Button, Card, EmptyState, Field, Input, Stat } from "@/components/ui/primitives";
import { formatMoney } from "@/lib/format";
import type { Jsonify } from "@/lib/jsonify";
import type { DashboardEarningsView } from "@/lib/views/dashboard-earnings";
import { GetForm } from "./GetForm";

/** The Earnings page body. Rendered by the old Next page and by the SPA page from the same JSON. */
export function EarningsView({ data }: { data: Jsonify<DashboardEarningsView> }) {
  const { from, to, summary } = data;
  // A plain anchor on purpose: the browser downloads the file, the page and the router are not involved.
  const exportHref = `/api/dashboard/earnings/export?from=${from}&to=${to}`;

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
      <p className="subtle">Payouts follow your Razorpay settlement schedule.</p>
    </div>
  );
}
