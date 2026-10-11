import { useRouter } from "@web/lib/navigate";
import { useState } from "react";
import { IconTrash } from "@web/components/icons";
import { ConfirmDialog, useToast } from "@web/components/ui/overlays";
import { Button } from "@web/components/ui/primitives";
import { useApi } from "./ApiProvider";

/** "Erase data" for one customer (privacy request). Irreversible, so it is confirmed and needs a recent password. */
export function EraseCustomer({ email, name }: { email: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const api = useApi();
  const toast = useToast();
  const router = useRouter();
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} aria-label={`Erase ${name}'s data`}>
        <IconTrash size={16} /> Erase
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        danger
        busy={busy}
        title={`Erase ${name}'s personal data?`}
        description="Their name, email and phone number are removed from every past booking with you. Payment amounts are kept for your records. This cannot be undone."
        confirmLabel="Erase data"
        onConfirm={async () => {
          setBusy(true);
          const r = await api("/api/dashboard/customers/erase", { body: { email } });
          setBusy(false);
          if (!r.ok) return toast(r.data.error ?? "Could not erase the data.", "error");
          setOpen(false);
          toast(r.data.warning ? `Erased. ${r.data.warning}` : "Customer data erased.");
          router.refresh();
        }}
      />
    </>
  );
}
