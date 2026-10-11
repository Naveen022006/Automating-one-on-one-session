import { useRouter } from "@web/lib/navigate";
import { useState } from "react";
import { ConfirmDialog, useToast } from "@web/components/ui/overlays";
import { Alert, Button, Field, Textarea } from "@web/components/ui/primitives";

/**
 * "Cancel..." on a booking the server says can be cancelled on the platform's behalf. It does exactly what the influencer's own cancel does:
 * the customer is told, the Calendar event and reminders are removed, and a captured payment is flagged for a full refund (or refunded at
 * once when automatic refunds are on). A flagged payment is then refunded from Payments.
 */
export function CancelBookingAction({ bookingId, customerName, serviceTitle }: { bookingId: string; customerName: string; serviceTitle: string }) {
  const toast = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      const res = await fetch(`/api/admin/bookings/${encodeURIComponent(bookingId)}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: text, confirm: true }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; refund?: { eligible: boolean; issued: string }; warning?: string | null };
      if (!res.ok) {
        setError(data.error ?? "The booking was not cancelled.");
        if (res.status === 409) router.refresh();
        return;
      }
      const refund = data.refund;
      const note = !refund?.eligible
        ? "No payment to refund."
        : refund.issued === "yes"
          ? "Refund issued."
          : refund.issued === "pending"
            ? "Refund is being processed."
            : "Refund flagged: use Payments > Refund.";
      toast(`Cancelled. The customer was told. ${note}`);
      if (data.warning) toast(`The Google Calendar event was not updated: ${data.warning}`, "error");
      setOpen(false);
      setReason("");
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection, then look at this booking before trying again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} data-cancel={bookingId}>
        Cancel…
      </Button>
      <ConfirmDialog
        open={open}
        onClose={close}
        onConfirm={run}
        busy={busy}
        danger
        title="Cancel this booking"
        description={`${customerName}'s session: ${serviceTitle}. The customer and the influencer are told. A payment is flagged for a full refund.`}
        confirmLabel="Cancel booking"
        cancelLabel="Keep it"
      >
        <div className="stack">
          <Field id={`cancel-reason-${bookingId}`} label="Reason" help="At least 5 characters. Kept in the audit log and shown to the influencer.">
            <Textarea
              id={`cancel-reason-${bookingId}`}
              value={reason}
              maxLength={500}
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
