import { useState } from "react";
import { AppLink } from "@web/lib/link";
import { FocusedLayout } from "@web/components/site/SiteChrome";
import { Alert, Button, Field, Input } from "@web/components/ui/primitives";

/**
 * `/bookings`: "find your bookings". One field. Whatever the address, the answer on screen is the same sentence: the server does not
 * say whether it has bookings for it (and e-mails a link only if it does). The link opens `/bookings/<token>` and works for an hour.
 */
export function FindBookingsView() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/customer/access", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email.trim() }) });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 202) setSent(true);
      else if (res.status === 429) setError(data.error ?? "Too many requests. Please wait a while and try again.");
      else if (res.status === 400) setError("Please enter a valid e-mail address.");
      else setError("Something went wrong. Please try again.");
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <FocusedLayout>
      <div className="stack stack--lg">
        <div className="stack stack--sm">
          <h1 className="focused__title">Find your bookings</h1>
          <p className="muted">Enter the e-mail address you booked with. We will send a link to see your bookings, manage upcoming sessions and get your receipts.</p>
        </div>
        {sent ? (
          <div className="stack">
            <Alert tone="success" title="Check your e-mail">
              If we have bookings for that address, we have e-mailed a link. It works for 60 minutes. If nothing arrives, check your spam folder or try the address you used when you booked.
            </Alert>
            <div>
              <Button
                variant="ghost"
                onClick={() => {
                  setSent(false);
                  setEmail("");
                }}
              >
                Use another address
              </Button>
            </div>
          </div>
        ) : (
          <form className="stack" onSubmit={submit} noValidate>
            {error && <Alert tone="danger">{error}</Alert>}
            <Field id="find-email" label="E-mail address">
              <Input
                id="find-email"
                type="email"
                autoComplete="email"
                inputMode="email"
                required
                maxLength={200}
                value={email}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
              />
            </Field>
            <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={email.trim() === ""}>
              E-mail me a link
            </Button>
          </form>
        )}
        <p className="muted text-sm">
          The link lets whoever opens it see these bookings, download the data we hold or erase it, so keep it to yourself. See our <AppLink href="/privacy">privacy policy</AppLink>.
        </p>
      </div>
    </FocusedLayout>
  );
}
