import type { Metadata } from "next";
import { IconDownload, IconSparkline } from "@/components/icons";
import { PageHead } from "@/components/app/AppShell";
import { Button, Card, EmptyState, Field, Input, Stat } from "@/components/ui/primitives";
import { requirePageAuth } from "@/lib/auth/guards";
import { aggregateEarnings } from "@/lib/dashboard";
import { earningsPayments } from "@/lib/dashboard-data";
import { formatMoney } from "@/lib/format";

export const metadata: Metadata = { title: "Earnings" };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export default async function EarningsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const auth = await requirePageAuth("/dashboard/earnings");
  const sp = await searchParams;
  const now = new Date();
  const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const from = sp.from && DAY.test(sp.from) ? sp.from : defaultFrom;
  const to = sp.to && DAY.test(sp.to) ? sp.to : now.toISOString().slice(0, 10);
  const payments = await earningsPayments(
    auth.influencerId,
    new Date(`${from}T00:00:00.000Z`),
    new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86_400_000),
  );
  const summary = aggregateEarnings(payments);
  const refunded = payments.reduce((n, p) => n + (p.refundedMinor ? 1 : 0), 0);
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
        <form className="row" style={{ alignItems: "flex-end" }} action="/dashboard/earnings">
          <Field id="from" label="From">
            <Input id="from" name="from" type="date" defaultValue={from} />
          </Field>
          <Field id="to" label="To">
            <Input id="to" name="to" type="date" defaultValue={to} />
          </Field>
          <Button type="submit">Show</Button>
        </form>
      </Card>
      {payments.length === 0 ? (
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
              <Stat label="Payments" value={payments.length} hint={refunded ? `${refunded} refunded` : undefined} />
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
                {summary.byService.map((s) => (
                  <tr key={`${s.serviceId}:${s.currency}`}>
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
