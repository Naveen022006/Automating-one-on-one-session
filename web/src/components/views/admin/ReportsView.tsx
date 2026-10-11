import { PageHead } from "@web/components/app/AppShell";
import { IconBarChart } from "@web/components/icons";
import { Alert, Button, Card, EmptyState, Field, Input, Stat } from "@web/components/ui/primitives";
import { formatMoney } from "@/lib/format";
import type { Jsonify } from "@/lib/jsonify";
import type { AdminReportsView } from "@/lib/views/admin-reports";
import { GetForm } from "../dashboard/GetForm";

type Report = Jsonify<AdminReportsView>;

/** "2026-03" as "Mar 2026" (the month is a UTC month, so the label is formatted in UTC too). */
export function monthLabel(month: string): string {
  const d = new Date(`${month}-01T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? month : d.toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
}

const money = (minor: number, currency: string) => <span className="money">{formatMoney(minor, currency)}</span>;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What each figure means. Shown on the page, under the numbers they explain. */
export const DEFINITIONS: { term: string; text: string }[] = [
  { term: "Gross", text: "What customers paid: payments that were captured (including those since refunded), by the day checkout began, that is when the payment's order was created (UTC). A payment captured later by the recovery job stays on the day it began." },
  { term: "Refunds", text: "Refunds that are pending or processed, by the day the refund was made. A refund can belong to a payment of an earlier period, so Net is a difference of two period figures, not of the same payments." },
  { term: "Platform fees", text: "The fee kept on payouts marked as sent in the period, by the day they were marked: the amount stored on each payout when it was created, with that influencer's fee or the platform default." },
  { term: "Paid out", text: "The net amount of payouts marked as sent in the period (after the platform fee)." },
  { term: "Held for influencers", text: "Payments not flagged for refund and not in a payout that was sent, whose booking is paid, scheduled or completed (or that are in a payout still to be sent): the amount less refunds, before the platform fee." },
  { term: "In pending payouts", text: "Payouts created and not yet marked as sent, after the platform fee. Their payments are counted in Held for influencers (before the fee), or in Owed to customers when a payment in them is flagged for refund." },
  { term: "Owed to customers", text: "Payments flagged for refund that are not in a payout that was sent: the amount not yet refunded, the most a customer can still be given back. A flagged payment that is in a payout still to be sent is counted here, not in Held." },
  { term: "Flagged, already paid out", text: "Payments flagged for refund whose payout was already sent: the amount not yet refunded. The influencer has this money and a customer may still be owed it. It is part of Paid out, not of Owed to customers." },
  { term: "To recover", text: "Refunds made after an influencer's payout was marked as sent: money the influencer received that should come back. The same figure as \"Refunded since\" on the Payouts page, added up." },
  { term: "Refunds that did not complete", text: "Refunds that were counted in a sent payout (so they reduced what the influencer was sent) and have failed since. The influencer was sent that much less than the payment now leaves them." },
  { term: "Not payable", text: "Paid by customers for bookings that are requested, held, awaiting payment, expired, cancelled or failed (anything but paid, scheduled or completed), not flagged for refund and in no payout. No payout can include these payments, and a customer may still be owed part of this money (for example after a partial refund)." },
];

/** The date-range form. Without JavaScript it is a plain GET form (see GetForm). */
function RangeForm({ from, to }: { from: string; to: string }) {
  return (
    <Card>
      <GetForm className="row" style={{ alignItems: "flex-end" }} action="/admin/reports" values={{ from, to }}>
        <Field id="from" label="From">
          <Input id="from" name="from" type="date" defaultValue={from} />
        </Field>
        <Field id="to" label="To (included)">
          <Input id="to" name="to" type="date" defaultValue={to} />
        </Field>
        <Button type="submit">Show</Button>
      </GetForm>
    </Card>
  );
}

/** The range the server refused (it ends before it starts, or is too long): the form stays, with the sentence the server gave. */
export function ReportsRangeProblem({ from, to, message }: { from: string; to: string; message: string }) {
  return (
    <div className="stack stack--lg">
      <PageHead title="Reports" description="Money held, owed and paid out." />
      <RangeForm from={from} to={to} />
      <Alert tone="danger" title="That date range cannot be shown">{message}</Alert>
    </div>
  );
}

/**
 * The admin Reports page body. Rendered by the SPA page from the endpoint's JSON. `busy` is set by the SPA page while it still shows the
 * previous range and the next one is loading. Every figure is in the minor units of its own currency; currencies are never added.
 */
export function ReportsView({ data, busy }: { data: Report; busy?: boolean }) {
  const { from, to, range, monthly, balances } = data;
  const nothing = range.length === 0 && balances.length === 0 && monthly.length === 0;
  // A soft navigation to another range is not announced by the browser: this line (a live region whose text changes) does it.
  const found =
    range.length === 0
      ? `No payments, refunds or payouts from ${from} to ${to}.`
      : `From ${from} to ${to}: ${range
          .map((r) => `${r.currency} gross ${formatMoney(r.grossMinor, r.currency)}, refunds ${formatMoney(r.refundsMinor, r.currency)}, fees ${formatMoney(r.feesEarnedMinor, r.currency)}`)
          .join("; ")}.`;

  return (
    <div className="stack stack--lg">
      <PageHead title="Reports" description="Money collected, refunded, kept as fees and paid out, and what the platform holds or owes right now. Each currency is shown on its own; they are never added together." />
      <RangeForm from={from} to={to} />
      <p role="status" className="sr-only">{busy ? "Loading…" : found}</p>
      <div className="stack stack--lg" aria-busy={busy || undefined}>
        {nothing ? (
          <EmptyState icon={<IconBarChart />} title="Nothing to report">
            There are no payments, refunds or payouts in this range, and no money held or owed right now.
          </EmptyState>
        ) : (
          <>
            <section className="stack" aria-labelledby="balances-title">
              <h2 id="balances-title" className="section-title">Balances right now</h2>
              <p className="subtle">As of {new Date(data.generatedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}. These do not depend on the date range.</p>
              {balances.length === 0 ? (
                <p className="muted">Nothing is held or owed right now.</p>
              ) : (
                balances.map((b) => (
                  <Card key={b.currency} title={<h3 className="card__title">{b.currency}</h3>}>
                    <div className="grid grid--3">
                      <Stat label="Held for influencers" value={money(b.heldForInfluencersMinor, b.currency)} hint="Before the platform fee. Includes payments in payouts still to be sent." />
                      <Stat label="In pending payouts" value={money(b.inPendingPayoutsMinor, b.currency)} hint="After the fee, created and not yet sent. Counted in Held (or in Owed when flagged)." />
                      <Stat label="Owed to customers" value={money(b.owedToCustomersMinor, b.currency)} hint="Flagged payments, not in a sent payout, not yet refunded." />
                      <Stat label="To recover" value={money(b.toRecoverMinor, b.currency)} hint="Refunded after the payout was sent." />
                      {b.flaggedPaidOutMinor !== 0 && (
                        <Stat label="Flagged, already paid out" value={money(b.flaggedPaidOutMinor, b.currency)} hint="Flagged for refund but the payout was sent. A customer may still be owed it." />
                      )}
                      {b.refundsNotCompletedMinor !== 0 && (
                        <Stat label="Refunds that did not complete" value={money(b.refundsNotCompletedMinor, b.currency)} hint="Counted in a sent payout, then failed." />
                      )}
                      {b.unallocatedMinor !== 0 && (
                        <Stat label="Not payable" value={money(b.unallocatedMinor, b.currency)} hint="Bookings not paid or scheduled, in no payout. A customer may still be owed part." />
                      )}
                    </div>
                  </Card>
                ))
              )}
            </section>

            <section className="stack" aria-labelledby="period-title">
              <h2 id="period-title" className="section-title">{from} to {to}</h2>
              {range.length === 0 ? (
                <p className="muted">No payments, refunds or payouts in this range.</p>
              ) : (
                range.map((r) => (
                  <Card key={r.currency} title={<h3 className="card__title">{r.currency}</h3>}>
                    <div className="grid grid--3">
                      <Stat label="Gross" value={money(r.grossMinor, r.currency)} hint={plural(r.paymentCount, "payment", "payments")} />
                      <Stat label="Refunds" value={money(r.refundsMinor, r.currency)} hint={plural(r.refundCount, "refund", "refunds")} />
                      <Stat label="Net of refunds" value={money(r.netMinor, r.currency)} hint="Gross less refunds of the period" />
                      <Stat label="Platform fees" value={money(r.feesEarnedMinor, r.currency)} hint="On payouts sent in the period" />
                      <Stat label="Paid out" value={money(r.payoutsPaidNetMinor, r.currency)} hint={plural(r.payoutsPaidCount, "payout", "payouts")} />
                    </div>
                  </Card>
                ))
              )}
            </section>

            <section className="stack" aria-labelledby="monthly-title">
              <h2 id="monthly-title" className="section-title">By month</h2>
              {monthly.length === 0 ? (
                <p className="muted">No payments, refunds or fees in the 12 months up to {monthLabel(to.slice(0, 7))}.</p>
              ) : (
                <div className="table-wrap">
                  <table className="table table--stack">
                    <caption className="sr-only">Gross, refunds and fees by month (UTC), the 12 months up to the month of the end date</caption>
                    <thead>
                      <tr>
                        <th scope="col">Month</th>
                        <th scope="col">Currency</th>
                        <th scope="col" className="num">Payments</th>
                        <th scope="col" className="num">Gross</th>
                        <th scope="col" className="num">Refunds</th>
                        <th scope="col" className="num">Platform fees</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monthly.map((m) => (
                        <tr key={`${m.month}-${m.currency}`}>
                          <td data-label="Month">{monthLabel(m.month)}</td>
                          <td data-label="Currency">{m.currency}</td>
                          <td data-label="Payments" className="num">{m.paymentCount}</td>
                          <td data-label="Gross" className="num">{formatMoney(m.grossMinor, m.currency)}</td>
                          <td data-label="Refunds" className="num">{formatMoney(m.refundsMinor, m.currency)}</td>
                          <td data-label="Platform fees" className="num">{formatMoney(m.feesEarnedMinor, m.currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}

        <Card title={<h2 className="card__title">What the figures mean</h2>}>
          <dl className="kv">
            {DEFINITIONS.map((d) => (
              <div key={d.term} style={{ display: "contents" }}>
                <dt>{d.term}</dt>
                <dd>{d.text}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    </div>
  );
}
