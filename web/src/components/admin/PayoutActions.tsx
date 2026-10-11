import { useRouter } from "@web/lib/navigate";
import { useState } from "react";
import { Dialog, useToast } from "@web/components/ui/overlays";
import { Alert, Badge, Button, Checkbox, Field, Input, Textarea } from "@web/components/ui/primitives";
import type { PayoutApprovalView } from "@/lib/payouts";

async function call(url: string, method: "POST" | "PATCH", body?: unknown) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ok: res.ok, data: (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string; code?: string } };
}

export function ReconcileButton({ ids }: { ids: string[] }) {
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (ids.length === 0) return null;

  async function run() {
    setBusy(true);
    const r = await call("/api/admin/payments/reconcile", "POST", { paymentIds: ids });
    setBusy(false);
    if (!r.ok) return toast(r.data.error ?? "Could not reconcile.", "error");
    const failed = Number(r.data.failed ?? 0);
    const results = (r.data.results ?? []) as { ok: boolean; reason?: string }[];
    const firstReason = results.find((x) => !x.ok)?.reason;
    toast(
      failed === 0 ? `Reconciled ${r.data.reconciled} payment(s) with Razorpay.` : `Reconciled ${r.data.reconciled}; ${failed} could not be confirmed${firstReason ? `: ${firstReason}` : ""}.`,
      failed === 0 ? "success" : "error",
    );
    router.refresh();
  }

  return (
    <Button variant="primary" onClick={run} loading={busy}>
      Reconcile {ids.length} with Razorpay
    </Button>
  );
}

export function UnreconcileButton({ paymentId }: { paymentId: string }) {
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    const r = await call(`/api/admin/payments/${paymentId}/unreconcile`, "POST");
    setBusy(false);
    if (!r.ok) return toast(r.data.error ?? "Could not undo.", "error");
    router.refresh();
  }
  return (
    <Button size="sm" variant="ghost" onClick={run} loading={busy}>
      Undo
    </Button>
  );
}

export function CreatePayoutButton({ influencerId, currency, label }: { influencerId: string; currency: string; label: string }) {
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    const r = await call(`/api/admin/influencers/${influencerId}/payouts`, "POST", { currency });
    setBusy(false);
    if (!r.ok) return toast(r.data.error ?? "Could not create the payout.", "error");
    toast("Payout created. Send the money, then mark it as paid with the bank reference.");
    router.refresh();
  }
  return (
    <Button variant="primary" onClick={run} loading={busy}>
      {label}
    </Button>
  );
}

/** What the viewing administrator may do with one payout (computed on the server by payoutApprovalView). */
export type PayoutApprovalProps = Pick<PayoutApprovalView, "required" | "approved" | "approvedByEmail" | "canApprove" | "createdByViewer" | "canMarkPaid">;

export function PayoutRowActions({
  payoutId,
  status,
  approval,
  influencerSuspended = false,
}: {
  payoutId: string;
  status: string;
  approval: PayoutApprovalProps;
  /** The list already knows the influencer is suspended; elsewhere the server's `influencer-suspended` answer reveals the same prompt. */
  influencerSuspended?: boolean;
}) {
  const toast = useToast();
  const router = useRouter();
  const [open, setOpen] = useState<"paid" | "cancel" | "approve" | null>(null);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // Moving money for a suspended influencer needs an explicit "pay anyway" with a reason; the server refuses without it.
  const [suspended, setSuspended] = useState(influencerSuspended);
  const [payAnyway, setPayAnyway] = useState(false);
  const [suspendedReason, setSuspendedReason] = useState("");
  if (status !== "PENDING") return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const moves = open === "approve" || open === "paid";
    if (moves && suspended && (!payAnyway || suspendedReason.trim().length < 5)) {
      return toast("This influencer is suspended. Tick “pay anyway” and say why (at least 5 characters), or go back.", "error");
    }
    setBusy(true);
    const ack = moves && suspended ? { acknowledgeSuspended: true, suspendedReason: suspendedReason.trim() } : {};
    const body =
      open === "approve" ? { action: "approve", ...ack } : open === "paid" ? { action: "paid", reference, ...ack } : { action: "cancel", note: note || undefined };
    const r = await call(`/api/admin/payouts/${payoutId}`, "POST", body);
    setBusy(false);
    if (!r.ok) {
      if (r.data.code === "influencer-suspended") setSuspended(true); // show the "pay anyway" prompt and let the administrator decide
      return toast(r.data.error ?? "Could not update the payout.", "error");
    }
    toast(
      open === "approve"
        ? "Payout approved. It can now be marked as paid once the money is sent."
        : open === "paid"
          ? "Marked as paid. The influencer was notified."
          : "Payout cancelled. Its payments are payable again.",
    );
    setOpen(null);
    router.refresh();
  }

  const awaiting = approval.required && !approval.approved;

  return (
    <div className="stack stack--sm">
      <div className="row">
        {awaiting && approval.canApprove && (
          <Button size="sm" variant="primary" onClick={() => setOpen("approve")}>
            Approve
          </Button>
        )}
        <Button
          size="sm"
          variant={awaiting ? "secondary" : "primary"}
          onClick={() => setOpen("paid")}
          disabled={!approval.canMarkPaid}
          title={awaiting ? "A second administrator has to approve this payout first." : undefined}
        >
          Mark as paid
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen("cancel")}>
          Cancel
        </Button>
      </div>
      {awaiting && approval.createdByViewer && <p className="subtle">You created this payout. Another administrator has to approve it.</p>}
      <Dialog
        open={open !== null}
        onClose={() => setOpen(null)}
        title={open === "approve" ? "Approve this payout" : open === "paid" ? "Record the transfer" : "Cancel this payout"}
        description={
          open === "approve"
            ? "You are confirming that the amount and the destination are right. You cannot approve a payout you created."
            : open === "paid"
              ? "Only do this after you have sent the money. The influencer is emailed the amount and reference."
              : "The payments in it go back to being payable. Nothing was sent."
        }
      >
        <form className="stack" onSubmit={submit}>
          {open === "paid" ? (
            <Field id="po-ref" label="Bank reference (UTR)" help="From your bank or UPI app, so the transfer can be traced.">
              <Input id="po-ref" value={reference} maxLength={60} required autoFocus onChange={(e: React.ChangeEvent<HTMLInputElement>) => setReference(e.target.value)} />
            </Field>
          ) : open === "cancel" ? (
            <Field id="po-note" label="Reason" optional>
              <Textarea id="po-note" value={note} maxLength={300} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setNote(e.target.value)} />
            </Field>
          ) : null}
          {suspended && open !== "cancel" && (
            <Alert tone="warning" title="This influencer is suspended">
              <div className="stack stack--sm">
                <p>Paying them anyway is recorded in the audit log with your reason.</p>
                <Checkbox label="This influencer is suspended: pay anyway" checked={payAnyway} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPayAnyway(e.target.checked)} />
                <Field id="po-suspended-reason" label="Why are you paying a suspended influencer?">
                  <Textarea id="po-suspended-reason" value={suspendedReason} maxLength={300} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setSuspendedReason(e.target.value)} />
                </Field>
              </div>
            </Alert>
          )}
          <div className="form-actions">
            <Button onClick={() => setOpen(null)} disabled={busy}>
              Back
            </Button>
            <Button type="submit" variant={open === "cancel" ? "danger-solid" : "primary"} loading={busy}>
              {open === "approve" ? "Approve payout" : open === "paid" ? "Mark as paid" : "Cancel payout"}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

/** Status cell content for a payout: To send / Awaiting approval / Approved / Paid / Cancelled. */
export function PayoutStatusBadges({ status, approval }: { status: string; approval: PayoutApprovalProps }) {
  if (status === "PAID") return <Badge tone="success">Paid</Badge>;
  if (status === "CANCELLED") return <Badge>Cancelled</Badge>;
  if (approval.required && !approval.approved) return <Badge tone="warning">Awaiting approval</Badge>;
  return (
    <>
      <Badge tone="warning">To send</Badge>
      {approval.approved && <div className="subtle">Approved by {approval.approvedByEmail}</div>}
    </>
  );
}

export function FeeForm({ influencerId, feeBps, defaultBps }: { influencerId: string; feeBps: number | null; defaultBps: number }) {
  const toast = useToast();
  const router = useRouter();
  const [value, setValue] = useState(feeBps === null ? "" : String(feeBps / 100));
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    const feePercent = trimmed === "" ? null : Number(trimmed);
    if (feePercent !== null && (!Number.isFinite(feePercent) || feePercent < 0 || feePercent > 50)) return toast("Enter a percentage between 0 and 50.", "error");
    setBusy(true);
    const r = await call(`/api/admin/influencers/${influencerId}/fee`, "PATCH", { feePercent });
    setBusy(false);
    if (!r.ok) return toast(r.data.error ?? "Could not save the fee.", "error");
    toast("Platform fee saved. It applies to payouts created from now on.");
    router.refresh();
  }

  return (
    <form className="row" style={{ alignItems: "flex-end" }} onSubmit={save}>
      <Field id="fee" label="Platform fee (%)" help={`Leave empty to use the default (${defaultBps / 100}%).`}>
        <Input id="fee" inputMode="decimal" value={value} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value)} placeholder={String(defaultBps / 100)} style={{ maxWidth: 140 }} />
      </Field>
      <Button type="submit" loading={busy}>
        Save fee
      </Button>
    </form>
  );
}
