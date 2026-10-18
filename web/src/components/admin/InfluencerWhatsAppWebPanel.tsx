import { useRouter } from "@web/lib/navigate";
import { useState } from "react";
import { Alert, Badge, Button, Card, Field, Textarea, describedBy } from "@web/components/ui/primitives";
import { Dialog, useToast } from "@web/components/ui/overlays";
import { DISCONNECT_REASON_MAX, disconnectReasonError } from "@web/lib/whatsapp-web-ui";
import type { Tone } from "@web/components/ui/primitives";
import type { AdminWhatsAppWebView } from "@/lib/whatsapp-web/api-types";
import type { WhatsAppWebStatus } from "@/lib/whatsapp-web/types";
import { useApiQuery } from "../../lib/api";
import { queryKeys } from "../../lib/query";

const STATUS_BADGE: Record<WhatsAppWebStatus, { label: string; tone: Tone }> = {
  "not-linked": { label: "Not linked", tone: "neutral" },
  "waiting-for-scan": { label: "Waiting for scan", tone: "info" },
  linked: { label: "Linked", tone: "success" },
  reconnecting: { label: "Reconnecting", tone: "warning" },
  suspended: { label: "Suspended", tone: "danger" },
  "logged-out": { label: "Logged out by phone", tone: "warning" },
};

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

/** What the card shows, given the data. Separate from the fetching so every state can be drawn without a server. */
export function WhatsAppWebPanelBody({
  view,
  onDisconnect,
}: {
  view: AdminWhatsAppWebView;
  /** Opens the reason dialog. */
  onDisconnect: () => void;
}) {
  const badge = STATUS_BADGE[view.status];
  return (
    <div className="stack">
      <div className="row row--between">
        <div className="row">
          <Badge tone={badge.tone}>{badge.label}</Badge>
          <Badge tone="warning">Unofficial</Badge>
        </div>
        {view.canForceDisconnect && (
          <Button variant="danger" onClick={onDisconnect}>
            Force disconnect
          </Button>
        )}
      </div>
      <dl className="kv">
        <dt>Phone</dt>
        <dd>{view.phoneMasked ?? "Not linked"}</dd>
        {view.deviceLabel && (
          <>
            <dt>Device</dt>
            <dd>{view.deviceLabel}</dd>
          </>
        )}
        <dt>Last connected</dt>
        <dd>{view.lastConnectedAt ? when(view.lastConnectedAt) : "Never"}</dd>
        <dt>Sent today</dt>
        <dd>
          {view.sentToday} of {view.dailyCap}
        </dd>
        <dt>Sent in total</dt>
        <dd>{view.sentTotal}</dd>
        <dt>Last error</dt>
        <dd>{view.lastError ? view.lastError.text : "None"}</dd>
        {view.suspendedReason && (
          <>
            <dt>Suspended because</dt>
            <dd>{view.suspendedReason}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/** The reason form inside the Force disconnect dialog. The reason is required: 5 to 300 characters once trimmed. */
export function ForceDisconnectForm({
  reason,
  onReason,
  attempted,
  error,
  busy,
  onCancel,
  onSubmit,
}: {
  reason: string;
  onReason: (reason: string) => void;
  /** The person pressed the button at least once: show what is wrong with the reason. */
  attempted: boolean;
  /** The server's own refusal, if any. */
  error: string | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (e: React.FormEvent) => void;
}) {
  const reasonError = attempted ? disconnectReasonError(reason) : null;
  return (
    <form className="stack" onSubmit={onSubmit} noValidate>
      <Field id="wa-web-reason" label="Reason" help={`5 to ${DISCONNECT_REASON_MAX} characters.`} error={reasonError}>
        <Textarea
          {...describedBy("wa-web-reason", { error: reasonError, help: true })}
          value={reason}
          maxLength={DISCONNECT_REASON_MAX + 50}
          required
          autoFocus
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onReason(e.target.value)}
        />
      </Field>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="form-actions">
        <Button onClick={onCancel} disabled={busy}>
          Back
        </Button>
        <Button type="submit" variant="danger-solid" loading={busy}>
          Force disconnect
        </Button>
      </div>
    </form>
  );
}

/**
 * The "WhatsApp by QR code" card on the admin Influencer page: the state of the influencer's linked device, and a Force disconnect that
 * asks for a reason (5 to 300 characters, kept in the audit log). Drawn only while the platform has the mode switched on; otherwise
 * nothing (no card, no empty box). Reads GET /api/admin/whatsapp-web?influencerId=, writes POST /api/admin/whatsapp-web/:influencerId.
 */
export function InfluencerWhatsAppWebPanel({ influencerId }: { influencerId: string }) {
  const toast = useToast();
  const router = useRouter();
  const query = useApiQuery<AdminWhatsAppWebView>(
    queryKeys.admin("influencer-whatsapp-web", { id: influencerId }),
    `/api/admin/whatsapp-web?influencerId=${encodeURIComponent(influencerId)}`,
  );
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (query.data === undefined) {
    return query.isError ? <Alert tone="danger">Could not load the WhatsApp QR-code status. Reload the page to try again.</Alert> : null;
  }
  const view = query.data;
  if (!view.enabled) return null;

  function close() {
    if (busy) return;
    setOpen(false);
    setReason("");
    setAttempted(false);
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setAttempted(true);
    if (disconnectReasonError(reason)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/whatsapp-web/${encodeURIComponent(influencerId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "disconnect", reason: reason.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Could not disconnect.");
        // A 409 means the state moved under us; show the current one.
        if (res.status === 409) router.refresh();
        return;
      }
      toast("Disconnected. The saved login was deleted.");
      setOpen(false);
      setReason("");
      setAttempted(false);
      router.refresh();
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="WhatsApp by QR code" aria-label="WhatsApp by QR code">
      <WhatsAppWebPanelBody view={view} onDisconnect={() => setOpen(true)} />
      <Dialog
        open={open}
        onClose={close}
        title="Force disconnect this number"
        description="The linked device is logged out and its saved login is deleted. Customer messages go through the official connection, SMS or e-mail. The influencer is not emailed, but sees an entry in their account activity. Your reason goes in the audit log."
      >
        <ForceDisconnectForm
          reason={reason}
          onReason={setReason}
          attempted={attempted}
          error={error}
          busy={busy}
          onCancel={close}
          onSubmit={(e) => void submit(e)}
        />
      </Dialog>
    </Card>
  );
}
