import { useRouter } from "@web/lib/navigate";
import { useState } from "react";
import { ConfirmDialog, useToast } from "@web/components/ui/overlays";
import { Alert, Button, Field, Textarea } from "@web/components/ui/primitives";
import { formatMoney } from "@/lib/format";

/**
 * "Refund..." on a payment the server says can be refunded. The amount is not typed: it is what is left of the payment, shown here only so
 * the administrator knows what they are confirming (the server works it out again and never reads an amount from this request).
 * `inPayout` is set when the payment is already in a PAID payout: the refund goes through, and the payouts page then shows the amount
 * as money to recover from the influencer.
 */
export function RefundAction({
  paymentId,
  remainingMinor,
  currency,
  customerName,
  influencerName,
  inPayout,
}: {
  paymentId: string;
  remainingMinor: number;
  currency: string;
  customerName: string;
  influencerName: string;
  inPayout: boolean;
}) {
  const toast = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amount = formatMoney(remainingMinor, currency);

  function close() {
    if (busy) return;
    setOpen(false);
    setError(null);
  }

  async function run() {
    const text = reason.trim();
    if (text.length < 5) return setError("Enter a reason of at least 5 characters.");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/payments/${encodeURIComponent(paymentId)}/refund`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: text, confirm: true }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; status?: string; amountMinor?: number };
      if (!res.ok) {
        setError(data.error ?? "The refund did not go through.");
        // A 409 means the page was out of date (someone else refunded, the booking changed): show the truth behind the dialog.
        if (res.status === 409) router.refresh();
        return;
      }
      toast(
        res.status === 202
          ? "Razorpay has not confirmed the refund yet. It may still go through; this page updates when Razorpay reports back."
          : `Refund of ${formatMoney(data.amountMinor ?? remainingMinor, currency)} sent to Razorpay.`,
      );
      setOpen(false);
      setReason("");
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection, then look at this payment before trying again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} data-refund={paymentId}>
        Refund…
      </Button>
      <ConfirmDialog
        open={open}
        onClose={close}
        onConfirm={run}
        busy={busy}
        danger
        title={`Refund ${amount}`}
        description={`To ${customerName}, for a session with ${influencerName}. The money goes back to the customer's original payment method.`}
        confirmLabel={`Refund ${amount}`}
        cancelLabel="Back"
      >
        <div className="stack">
          <p>
            The whole amount not yet refunded ({amount}) is refunded. This cannot be undone, and it is recorded in the audit log with your name.
          </p>
          {inPayout && (
            <Alert tone="warning">
              This payment is already in a payout that was sent to the influencer. After the refund the Payouts page lists the amount as money to recover.
            </Alert>
          )}
          <Field id={`refund-reason-${paymentId}`} label="Reason" help="At least 5 characters. Kept in the audit log.">
            <Textarea
              id={`refund-reason-${paymentId}`}
              value={reason}
              maxLength={300}
              required
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setReason(e.target.value)}
            />
          </Field>
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      </ConfirmDialog>
    </>
  );
}
