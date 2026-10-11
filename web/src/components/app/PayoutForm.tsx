import { useRouter } from "@web/lib/navigate";
import { useState } from "react";
import { useToast } from "@web/components/ui/overlays";
import { Alert, Badge, Button, Field, Input, Radio, describedBy } from "@web/components/ui/primitives";
import type { PayoutAccountData } from "@/lib/views/dashboard-types";
import { useApi } from "./ApiProvider";

export function PayoutStatusBadge({ status }: { status: PayoutAccountData["status"] }) {
  return status === "VERIFIED" ? (
    <Badge tone="success">Verified</Badge>
  ) : status === "REJECTED" ? (
    <Badge tone="danger">Needs correction</Badge>
  ) : (
    <Badge tone="warning">Awaiting review</Badge>
  );
}

export function PayoutForm({ account }: { account: PayoutAccountData | null }) {
  const api = useApi();
  const toast = useToast();
  const router = useRouter();
  const [editing, setEditing] = useState(account === null);
  const [method, setMethod] = useState<"BANK" | "UPI">(account?.method ?? "BANK");
  const [holder, setHolder] = useState(account?.accountHolderName ?? "");
  const [bankName, setBankName] = useState(account?.bankName ?? "");
  const [ifsc, setIfsc] = useState(account?.ifsc ?? "");
  const [number, setNumber] = useState("");
  const [confirmNumber, setConfirmNumber] = useState("");
  const [upi, setUpi] = useState("");
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    const body =
      method === "BANK"
        ? { method, accountHolderName: holder, bankName, ifsc, accountNumber: number, confirmAccountNumber: confirmNumber }
        : { method, accountHolderName: holder, upiId: upi };
    const r = await api<{ details?: { fieldErrors?: Record<string, string[]> } }>("/api/dashboard/payout-account", { method: "PUT", body });
    setBusy(false);
    if (!r.ok) {
      const fe: Record<string, string> = {};
      for (const [k, v] of Object.entries(r.data.details?.fieldErrors ?? {})) if (v?.[0]) fe[k] = v[0];
      setErrors(fe);
      if (!Object.keys(fe).length) toast(r.data.error ?? "Could not save your payout details.", "error");
      return;
    }
    toast("Payout details saved. We will verify them before the first payout.");
    setNumber("");
    setConfirmNumber("");
    setUpi("");
    setEditing(false);
    router.refresh();
  }

  if (account && !editing) {
    return (
      <div className="stack">
        <div className="row row--between">
          <PayoutStatusBadge status={account.status} />
          <Button size="sm" onClick={() => setEditing(true)}>
            Change details
          </Button>
        </div>
        {account.status === "REJECTED" && account.rejectionReason && <Alert tone="danger" title="We could not verify these details">{account.rejectionReason}</Alert>}
        {account.status === "PENDING_REVIEW" && (
          <Alert tone="info">Our team checks new or changed details before paying out. This usually takes one working day.</Alert>
        )}
        <dl className="kv">
          <dt>Account holder</dt>
          <dd>{account.accountHolderName}</dd>
          {account.method === "BANK" ? (
            <>
              <dt>Bank</dt>
              <dd>{account.bankName}</dd>
              <dt>IFSC</dt>
              <dd>{account.ifsc}</dd>
              <dt>Account number</dt>
              <dd className="money">{account.accountNumber}</dd>
            </>
          ) : (
            <>
              <dt>UPI ID</dt>
              <dd className="money">{account.upiId}</dd>
            </>
          )}
        </dl>
      </div>
    );
  }

  return (
    <form className="stack" onSubmit={save} noValidate>
      <Alert tone="info">
        Use an account in your own name. We send your earnings here after payments are reconciled. Details are stored
        encrypted, and changing them later pauses payouts until we re-verify.
      </Alert>
      <fieldset className="stack stack--sm" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="field__label">Receive money by</legend>
        <div className="row">
          <Radio name="payout-method" label="Bank transfer" checked={method === "BANK"} onChange={() => setMethod("BANK")} />
          <Radio name="payout-method" label="UPI" checked={method === "UPI"} onChange={() => setMethod("UPI")} />
        </div>
      </fieldset>
      <Field id="po-holder" label="Account holder name" error={errors.accountHolderName} help="Exactly as it appears on the account.">
        <Input {...describedBy("po-holder", { error: errors.accountHolderName, help: true })} value={holder} maxLength={100} autoComplete="name" onChange={(e: React.ChangeEvent<HTMLInputElement>) => setHolder(e.target.value)} />
      </Field>
      {method === "BANK" ? (
        <>
          <div className="form-grid form-grid--2">
            <Field id="po-bank" label="Bank name" error={errors.bankName}>
              <Input {...describedBy("po-bank", { error: errors.bankName })} value={bankName} maxLength={100} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBankName(e.target.value)} />
            </Field>
            <Field id="po-ifsc" label="IFSC code" error={errors.ifsc}>
              <Input {...describedBy("po-ifsc", { error: errors.ifsc })} value={ifsc} maxLength={11} autoCapitalize="characters" onChange={(e: React.ChangeEvent<HTMLInputElement>) => setIfsc(e.target.value.toUpperCase())} placeholder="HDFC0001234" />
            </Field>
          </div>
          <div className="form-grid form-grid--2">
            <Field id="po-number" label="Account number" error={errors.accountNumber}>
              <Input {...describedBy("po-number", { error: errors.accountNumber })} inputMode="numeric" autoComplete="off" value={number} maxLength={24} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNumber(e.target.value)} />
            </Field>
            <Field id="po-confirm" label="Confirm account number" error={errors.confirmAccountNumber}>
              <Input {...describedBy("po-confirm", { error: errors.confirmAccountNumber })} inputMode="numeric" autoComplete="off" value={confirmNumber} maxLength={24} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfirmNumber(e.target.value)} onPaste={(e: React.ClipboardEvent) => e.preventDefault()} />
            </Field>
          </div>
        </>
      ) : (
        <Field id="po-upi" label="UPI ID" error={errors.upiId} help="For example name@okhdfcbank.">
          <Input {...describedBy("po-upi", { error: errors.upiId, help: true })} value={upi} maxLength={100} autoComplete="off" onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUpi(e.target.value)} />
        </Field>
      )}
      <div className="form-actions">
        {account && (
          <Button onClick={() => setEditing(false)} disabled={busy}>
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" loading={busy}>
          Save payout details
        </Button>
      </div>
    </form>
  );
}
