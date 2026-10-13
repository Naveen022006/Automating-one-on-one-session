import { useEffect, useState } from "react";
import { IconDownload, IconVideo } from "@web/components/icons";
import { Alert, Button } from "@web/components/ui/primitives";

interface CheckoutResult {
  keyId: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  customer: { name: string; email: string; contact: string };
}
interface RazorpayInstance {
  open(): void;
  on(event: "payment.failed", cb: (r: { error: { description: string } }) => void): void;
}
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

function loadRazorpay(): Promise<boolean> {
  if (window.Razorpay) return Promise.resolve(true);
  return new Promise((resolve) => {
    const el = document.createElement("script");
    el.src = "https://checkout.razorpay.com/v1/checkout.js";
    el.onload = () => resolve(true);
    el.onerror = () => resolve(false);
    document.body.appendChild(el);
  });
}

/**
 * Payment for an approved booking request. The same rules as the normal booking page: the amount comes from the
 * server, and the booking only counts as paid when the verified webhook says so; this page just waits for that.
 */
export function PayNow({
  bookingId,
  pollToken,
  hostName,
  serviceTitle,
  amountText,
  payByText,
}: {
  bookingId: string;
  pollToken: string;
  hostName: string;
  serviceTitle: string;
  amountText: string;
  payByText: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "confirming" | "confirmed" | "failed">("idle");
  const [meetLink, setMeetLink] = useState<string | null>(null);
  const [manageUrl, setManageUrl] = useState<string | null>(null);

  useEffect(() => {
    if (state !== "confirming" && state !== "confirmed") return;
    if (state === "confirmed" && meetLink) return;
    let stopped = false;
    const started = Date.now();
    const poll = async () => {
      try {
        const r = await fetch(`/api/bookings/${encodeURIComponent(bookingId)}?t=${encodeURIComponent(pollToken)}`);
        const data = await r.json();
        if (stopped) return;
        if (data.meetLink) setMeetLink(data.meetLink);
        if (data.manageUrl) setManageUrl(data.manageUrl);
        if (["PAID", "SCHEDULED", "COMPLETED"].includes(data.status)) {
          if (state !== "confirmed") setState("confirmed");
          if (data.meetLink) return;
        } else if (data.status === "FAILED") {
          return setState("failed");
        }
      } catch {
        /* keep polling */
      }
      if (Date.now() - started > 150_000) {
        if (state === "confirming") setState("failed");
        return;
      }
      setTimeout(poll, 2500);
    };
    void poll();
    return () => {
      stopped = true;
    };
  }, [state, bookingId, pollToken, meetLink]);

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      if (!(await loadRazorpay()) || !window.Razorpay) throw new Error("The payment window could not load. Check your connection and try again.");
      const res = await fetch("/api/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookingId, token: pollToken }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not start payment");
      const c = data as CheckoutResult;
      const rzp = new window.Razorpay({
        key: c.keyId,
        order_id: c.orderId,
        amount: c.amountMinor,
        currency: c.currency,
        name: hostName,
        description: serviceTitle,
        prefill: c.customer,
        theme: { color: "#17694f" },
        handler: () => setState("confirming"),
        modal: { ondismiss: () => setBusy(false) },
      });
      rzp.on("payment.failed", (r) => {
        setError(`${r.error.description} You can try again; your time is still held.`);
        setBusy(false);
      });
      rzp.open();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  if (state === "confirmed") {
    return (
      <div className="stack" aria-live="polite">
        <Alert tone="success" title="You're booked">
          Payment received. A confirmation is on its way to your email and WhatsApp.
        </Alert>
        {meetLink ? (
          <a className="btn btn--primary btn--lg" href={meetLink} target="_blank" rel="noopener noreferrer">
            <IconVideo /> Join Google Meet
          </a>
        ) : (
          <p className="row muted">
            <span className="btn__spinner" aria-hidden="true" /> Creating your Google Meet link. It will appear here and be sent to you.
          </p>
        )}
        <div className="row">
          <a className="btn" href={`/api/bookings/${encodeURIComponent(bookingId)}/ics`}>
            <IconDownload size={16} /> Add to calendar (.ics)
          </a>
          {manageUrl && (
            <a className="btn" href={manageUrl}>
              Reschedule or cancel
            </a>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      {state === "failed" && (
        <Alert tone="danger" title="We could not confirm your payment">
          If money was taken it will be returned automatically. Contact the host with reference {bookingId}.
        </Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <p className="muted text-sm">Pay by {payByText} to keep your time. Payments are processed securely by Razorpay.</p>
      <Button variant="primary" size="lg" block onClick={pay} loading={busy || state === "confirming"}>
        {state === "confirming" ? "Confirming your payment…" : `Pay ${amountText}`}
      </Button>
    </div>
  );
}
