import { Button } from "@web/components/ui/primitives";
import { formatMoney } from "@/lib/format";
import type { ReceiptView } from "@/lib/receipts";

function when(iso: string, withTime: boolean) {
  return new Intl.DateTimeFormat(undefined, withTime ? { dateStyle: "full", timeStyle: "short" } : { dateStyle: "long" }).format(new Date(iso));
}

/**
 * A printable receipt for a paid session. Shared by the customer portal and the manage page. Everything shown comes from the
 * server's `ReceiptView` (the booking reference, the customer's own name, the host and service, the amount and the Razorpay
 * payment id), rendered as text. "Print" opens the browser's print dialog; web/src/styles/print.css hides the page around the
 * `.receipt` element, so the printout is just the receipt (and the browser's "Save as PDF" makes a PDF of it).
 */
export function ReceiptCard({ receipt, id }: { receipt: ReceiptView; id?: string }) {
  const { currency } = receipt;
  return (
    <section className="receipt" id={id} aria-label={`Receipt for ${receipt.serviceTitle}`}>
      <header className="receipt__head">
        <h3 className="receipt__title">Receipt</h3>
        <span className="receipt__seller">{receipt.seller}</span>
      </header>
      <dl className="summary">
        <dt>Receipt for</dt>
        <dd>{receipt.serviceTitle}</dd>
        <dt>With</dt>
        <dd>{receipt.hostName}</dd>
        <dt>Session</dt>
        <dd>{when(receipt.sessionStart, true)}</dd>
        <dt>Issued to</dt>
        <dd>{receipt.issuedTo}</dd>
        <dt>Paid on</dt>
        <dd>{when(receipt.paidAt, false)}</dd>
        <dt>Amount</dt>
        <dd>{formatMoney(receipt.amountMinor, currency)}</dd>
        {receipt.refundedMinor > 0 && (
          <>
            <dt>Refunded</dt>
            <dd>{formatMoney(receipt.refundedMinor, currency)}</dd>
          </>
        )}
        <dt>Status</dt>
        <dd>{receipt.statusText}</dd>
        <dt>Booking reference</dt>
        <dd>{receipt.reference}</dd>
        {receipt.paymentReference && (
          <>
            <dt>Payment reference</dt>
            <dd>{receipt.paymentReference}</dd>
          </>
        )}
      </dl>
      <p className="subtle receipt__note">Payments are processed by Razorpay and collected by {receipt.seller}.</p>
      <div className="receipt__actions no-print">
        <Button size="sm" onClick={() => window.print()}>
          Print receipt
        </Button>
      </div>
    </section>
  );
}
