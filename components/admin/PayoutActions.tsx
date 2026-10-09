"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Dialog, useToast } from "@/components/ui/overlays";
import { Button, Field, Input, Textarea } from "@/components/ui/primitives";

async function call(url: string, method: "POST" | "PATCH", body?: unknown) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ok: res.ok, data: (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string } };
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

export function PayoutRowActions({ payoutId, status }: { payoutId: string; status: string }) {
  const toast = useToast();
  const router = useRouter();
  const [open, setOpen] = useState<"paid" | "cancel" | null>(null);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  if (status !== "PENDING") return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await call(`/api/admin/payouts/${payoutId}`, "POST", open === "paid" ? { action: "paid", reference } : { action: "cancel", note: note || undefined });
    setBusy(false);
    if (!r.ok) return toast(r.data.error ?? "Could not update the payout.", "error");
    toast(open === "paid" ? "Marked as paid. The influencer was notified." : "Payout cancelled. Its payments are payable again.");
    setOpen(null);
    router.refresh();
  }

  return (
    <div className="row">
      <Button size="sm" variant="primary" onClick={() => setOpen("paid")}>
        Mark as paid
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen("cancel")}>
        Cancel
      </Button>
      <Dialog
        open={open !== null}
        onClose={() => setOpen(null)}
        title={open === "paid" ? "Record the transfer" : "Cancel this payout"}
        description={
          open === "paid"
            ? "Only do this after you have sent the money. The influencer is emailed the amount and reference."
            : "The payments in it go back to being payable. Nothing was sent."
        }
      >
        <form className="stack" onSubmit={submit}>
          {open === "paid" ? (
            <Field id="po-ref" label="Bank reference (UTR)" help="From your bank or UPI app, so the transfer can be traced.">
              <Input id="po-ref" value={reference} maxLength={60} required autoFocus onChange={(e: React.ChangeEvent<HTMLInputElement>) => setReference(e.target.value)} />
            </Field>
          ) : (
            <Field id="po-note" label="Reason" optional>
              <Textarea id="po-note" value={note} maxLength={300} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setNote(e.target.value)} />
            </Field>
          )}
          <div className="form-actions">
            <Button onClick={() => setOpen(null)} disabled={busy}>
              Back
            </Button>
            <Button type="submit" variant={open === "paid" ? "primary" : "danger-solid"} loading={busy}>
              {open === "paid" ? "Mark as paid" : "Cancel payout"}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
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
