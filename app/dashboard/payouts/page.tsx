import type { Metadata } from "next";
import { PageHead } from "@/components/app/AppShell";
import { PayoutForm } from "@/components/app/PayoutForm";
import { IconWallet } from "@/components/icons";
import { Alert, Badge, Card, EmptyState, Stat } from "@/components/ui/primitives";
import { requirePageAuth } from "@/lib/auth/guards";
import { formatMoney } from "@/lib/format";
import { getPayoutAccountView } from "@/lib/payout-account";
import { formatFeePercent, influencerPayoutSummary } from "@/lib/payouts";

export const metadata: Metadata = { title: "Payouts" };

export default async function PayoutsPage() {
  const auth = await requirePageAuth("/dashboard/payouts");
  const [account, summary] = await Promise.all([getPayoutAccountView(auth.influencerId), influencerPayoutSummary(auth.influencerId)]);

  return (
    <div className="stack stack--lg">
      <PageHead title="Payouts" description="Customers pay the platform. After each payment is checked, we send your earnings to the account below." />

      {!account && <Alert tone="warning" title="Add your payout details">We cannot send you money until you add where to pay you.</Alert>}
      {account?.status === "PENDING_REVIEW" && <Alert tone="info">Your payout details are being verified. This usually takes one working day.</Alert>}

      {summary.currencies.length > 0 && (
        <div className="grid grid--3">
          {summary.currencies.flatMap((c) => [
            <Card key={`${c.currency}-ready`}>
              <Stat label={`Ready to send (${c.currency})`} value={<span className="money">{formatMoney(c.readyMinor, c.currency)}</span>} hint="After the platform fee" />
            </Card>,
            <Card key={`${c.currency}-wait`}>
              <Stat label="Being checked" value={<span className="money">{formatMoney(c.waitingMinor + c.pendingMinor, c.currency)}</span>} hint="Sessions not finished yet, or payments awaiting checks" />
            </Card>,
            <Card key={`${c.currency}-paid`}>
              <Stat label="Paid out so far" value={<span className="money">{formatMoney(c.paidOutMinor, c.currency)}</span>} />
            </Card>,
          ])}
        </div>
      )}
      <p className="subtle">
        Platform fee: {formatFeePercent(summary.feeBps)} of what customers pay after refunds. Money becomes payable once the payment is
        verified and the session has finished.
      </p>

      <Card title="Payout details">
        <PayoutForm account={account} />
      </Card>

      <Card title="Payout history">
        {summary.history.length === 0 ? (
          <EmptyState icon={<IconWallet />} title="No payouts yet">
            Your first payout appears here after a session is completed and its payment is verified.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table table--stack">
              <caption className="sr-only">Payout history</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Sent to</th>
                  <th scope="col" className="num">Sessions</th>
                  <th scope="col" className="num">Fee</th>
                  <th scope="col" className="num">Amount</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {summary.history.map((h) => (
                  <tr key={h.id}>
                    <td data-label="Date">{(h.paidAt ?? h.createdAt).toLocaleDateString("en-IN", { dateStyle: "medium" })}</td>
                    <td data-label="Sent to">{h.destination}</td>
                    <td data-label="Sessions" className="num">{h.paymentCount}</td>
                    <td data-label="Fee" className="num">{formatMoney(h.feeMinor, h.currency)}</td>
                    <td data-label="Amount" className="num"><strong>{formatMoney(h.netMinor, h.currency)}</strong></td>
                    <td data-label="Status">
                      {h.status === "PAID" ? <Badge tone="success">Paid</Badge> : h.status === "PENDING" ? <Badge tone="warning">Being sent</Badge> : <Badge>Cancelled</Badge>}
                      {h.reference && <div className="subtle">Ref {h.reference}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
