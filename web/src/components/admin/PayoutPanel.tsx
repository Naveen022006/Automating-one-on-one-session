import { useRouter } from "@web/lib/navigate";
import { useState } from "react";
import { PayoutStatusBadge } from "@web/components/app/PayoutForm";
import type { PayoutAccountData } from "@/lib/views/dashboard-types";
import { Dialog, useToast } from "@web/components/ui/overlays";
import { Alert, Button, Field, Textarea } from "@web/components/ui/primitives";

interface Revealed {
  method: "BANK" | "UPI";
  accountHolderName: string;
  bankName: string | null;
  ifsc: string | null;
  accountNumber: string | null;
  upiId: string | null;
}

async function act(influencerId: string, body: unknown) {
  const res = await fetch(`/api/admin/influencers/${influencerId}/payout-account`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, data: (await res.json().catch(() => ({}))) as { error?: string; details?: Revealed } };
}

export function PayoutPanel({ influencerId, account }: { influencerId: string; account: PayoutAccountData | null }) {
  const toast = useToast();
  const router = useRouter();
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  if (!account) return <p className="muted">The influencer has not added payout details yet.</p>;

  async function reveal() {
    setBusy(true);
    const r = await act(influencerId, { action: "reveal" });
    setBusy(false);
    if (!r.ok || !r.data.details) return toast(r.data.error ?? "Could not reveal the details.", "error");
    setRevealed(r.data.details);
  }

  async function verify() {
    setBusy(true);
    const r = await act(influencerId, { action: "verify" });
    setBusy(false);
    if (!r.ok) return toast(r.data.error ?? "Could not verify.", "error");
    toast("Payout details verified. The influencer was notified.");
    setRevealed(null);
    router.refresh();
  }

  async function reject(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await act(influencerId, { action: "reject", reason });
    setBusy(false);
    if (!r.ok) return toast(r.data.error ?? "Could not reject.", "error");
    toast("Marked as needing correction. The influencer was notified.");
    setRejecting(false);
    setReason("");
    setRevealed(null);
    router.refresh();
  }

  return (
    <div className="stack">
      <div className="row row--between">
        <PayoutStatusBadge status={account.status} />
        <div className="row">
          <Button size="sm" onClick={reveal} loading={busy && !revealed}>
            Reveal full details
          </Button>
          {account.status !== "VERIFIED" && (
            <Button size="sm" variant="primary" onClick={verify} loading={busy}>
              Mark verified
            </Button>
          )}
          <Button size="sm" variant="danger" onClick={() => setRejecting(true)}>
            Needs correction
          </Button>
        </div>
      </div>
      {account.rejectionReason && account.status === "REJECTED" && <Alert tone="danger">{account.rejectionReason}</Alert>}
      <dl className="kv">
        <dt>Account holder</dt>
        <dd>{revealed?.accountHolderName ?? account.accountHolderName}</dd>
        {account.method === "BANK" ? (
          <>
            <dt>Bank</dt>
            <dd>{account.bankName}</dd>
            <dt>IFSC</dt>
            <dd>{account.ifsc}</dd>
            <dt>Account number</dt>
            <dd className="money">{revealed?.accountNumber ?? account.accountNumber}</dd>
          </>
        ) : (
          <>
            <dt>UPI ID</dt>
            <dd className="money">{revealed?.upiId ?? account.upiId}</dd>
          </>
        )}
      </dl>
      {revealed && <p className="subtle">Revealing details is recorded in the audit log. Hide them again by reloading the page.</p>}

      <Dialog open={rejecting} onClose={() => setRejecting(false)} title="Ask the influencer to fix their details" description="This message is emailed to them.">
        <form className="stack" onSubmit={reject}>
          <Field id="reject-reason" label="What needs fixing?">
            <Textarea id="reject-reason" value={reason} maxLength={300} required onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setReason(e.target.value)} />
          </Field>
          <div className="form-actions">
            <Button onClick={() => setRejecting(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant="danger-solid" loading={busy}>
              Send
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
