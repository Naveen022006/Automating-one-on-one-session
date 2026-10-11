import { useRouter } from "@web/lib/navigate";
import { useState } from "react";
import { Alert, Badge, Button, Card, Field, Textarea } from "@web/components/ui/primitives";
import { ConfirmDialog, useToast } from "@web/components/ui/overlays";
import type { AdminInfluencerStatusView } from "@/lib/views/admin-influencer-status";
import { useApiQuery } from "../../lib/api";
import type { Jsonify } from "../../lib/jsonify";
import { queryKeys } from "../../lib/query";

type StatusView = Jsonify<AdminInfluencerStatusView>;
type Action = "suspend" | "reinstate" | "approve";

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The moderation panel on the admin Influencer page: the account status and the Suspend / Reinstate / Approve actions
 * (POST /api/admin/influencers/:id/status). Reads GET .../status. After a change every query is refreshed, so the readiness
 * checklist and the payouts below it follow.
 */
export function InfluencerStatusPanel({ influencerId }: { influencerId: string }) {
  const toast = useToast();
  const router = useRouter();
  const query = useApiQuery<StatusView>(queryKeys.admin("influencer-status", { id: influencerId }), `/api/admin/influencers/${influencerId}/status`);
  const [open, setOpen] = useState<Action | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  if (query.data === undefined) {
    return query.isError ? <Alert tone="danger">Could not load the account status. Reload the page to try again.</Alert> : null;
  }
  const v = query.data;
  const reasonOk = reason.trim().length >= 5;

  function close() {
    if (busy) return;
    setOpen(null);
    setReason("");
  }

  async function submit() {
    if (!open) return;
    if (open === "suspend" && !reasonOk) return void toast("Write a reason of at least 5 characters.", "error");
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/influencers/${influencerId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(open === "suspend" ? { action: "suspend", reason: reason.trim() } : { action: open }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; emailed?: boolean };
      if (!res.ok) {
        toast(data.error ?? "Could not update the account.", "error");
        // A 409 means the state moved under us (another administrator): close the dialog and show the current state.
        if (res.status === 409) {
          setOpen(null);
          setReason("");
          router.refresh();
        }
        return;
      }
      const done = open === "suspend" ? "Account suspended." : open === "reinstate" ? "Account reinstated." : "Page approved.";
      toast(data.emailed ? `${done} The influencer was emailed.` : done);
      setOpen(null);
      setReason("");
      router.refresh();
    } catch {
      toast("Could not reach the server. Try again.", "error");
    } finally {
      setBusy(false);
    }
  }

  const { impact } = v;
  // Offered while the approval gate is off too: approving in advance keeps the page live if the gate is turned on later.
  const showApprove = v.approval.at === null;

  return (
    <Card as="section" aria-label="Account status">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div className="stack stack--sm">
          <div className="row">
            <strong>Account</strong>
            {v.status === "suspended" ? (
              <Badge tone="danger">Suspended</Badge>
            ) : v.status === "awaiting-approval" ? (
              <Badge tone="warning">Awaiting approval</Badge>
            ) : (
              <Badge tone="success">Active</Badge>
            )}
            {v.approval.required && v.approval.at !== null && <Badge tone="info">Approved</Badge>}
          </div>
          {v.suspension && (
            <p className="subtle">
              Suspended {when(v.suspension.at)} by {v.suspension.byEmail || "an administrator"}. Reason: {v.suspension.reason}
            </p>
          )}
          {v.approval.at !== null && v.approval.byEmail && (
            <p className="subtle">
              Approved {when(v.approval.at)} by {v.approval.byEmail}.
            </p>
          )}
          {v.status === "awaiting-approval" && <p className="subtle">This page finished onboarding and is offline until you approve it.</p>}
        </div>
        <div className="row">
          {showApprove && (
            <Button variant="primary" onClick={() => setOpen("approve")}>
              Approve page
            </Button>
          )}
          {v.status === "suspended" ? (
            <Button onClick={() => setOpen("reinstate")}>Reinstate</Button>
          ) : (
            <Button variant="danger" onClick={() => setOpen("suspend")}>
              Suspend
            </Button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={open === "suspend"}
        onClose={close}
        onConfirm={() => void submit()}
        title="Suspend this influencer"
        description="Their booking page goes offline, and new holds, payments, request approvals and payouts are refused. They are emailed the reason."
        confirmLabel="Suspend"
        cancelLabel="Back"
        danger
        busy={busy}
      >
        <div className="stack">
          <p className="subtle">
            {plural(impact.upcomingPaidBookings, "upcoming paid booking stays", "upcoming paid bookings stay")} booked; cancel
            {impact.upcomingPaidBookings === 1 ? " it" : " them"} from Bookings if needed. {plural(impact.pendingPayouts, "pending payout is", "pending payouts are")} not affected; cancel
            {impact.pendingPayouts === 1 ? " it" : " them"} if needed.
          </p>
          <Field id="suspend-reason" label="Reason" help="5 to 500 characters. The influencer sees this.">
            <Textarea id="suspend-reason" value={reason} maxLength={500} required autoFocus onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setReason(e.target.value)} />
          </Field>
          {!reasonOk && reason.length > 0 && <p className="subtle">Write at least 5 characters.</p>}
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={open === "reinstate"}
        onClose={close}
        onConfirm={() => void submit()}
        title="Reinstate this influencer"
        description="Their booking page goes live again if everything else on the go-live checklist is in place. They are emailed."
        confirmLabel="Reinstate"
        cancelLabel="Back"
        busy={busy}
      />
      <ConfirmDialog
        open={open === "approve"}
        onClose={close}
        onConfirm={() => void submit()}
        title="Approve this page"
        description={
          v.approval.required
            ? "The page can go live once the rest of the go-live checklist is done. The influencer is emailed (not while the account is suspended)."
            : "Approval is not required right now. Approving in advance keeps this page live if you turn the approval gate on later. No email is sent."
        }
        confirmLabel="Approve"
        cancelLabel="Back"
        busy={busy}
      />
    </Card>
  );
}
