"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { IconCalendar, IconCheckCircle } from "@/components/icons";
import { ConfirmDialog, useToast } from "@/components/ui/overlays";
import { Alert, Badge, Button } from "@/components/ui/primitives";
import { useApi } from "./ApiProvider";

export type GoogleStatusView =
  | { state: "not-connected" }
  | { state: "connected"; email: string | null; connectedAt: string; gmailSend: boolean }
  | { state: "reconnect-needed"; email: string | null; reason: string | null };

const OUTCOME: Record<string, { tone: "success" | "danger" | "warning"; text: string }> = {
  connected: { tone: "success", text: "Google connected. New bookings get a Meet link automatically." },
  "connected-no-gmail": {
    tone: "warning",
    text: "Google Calendar connected, but sending email from your Gmail was not allowed. Customer emails will come from our address with your email as Reply-To.",
  },
  denied: { tone: "warning", text: "Google access was not granted, so Meet links cannot be created yet." },
  "missing-permission": { tone: "warning", text: "Calendar permission was unticked. Connect again and leave every permission ticked." },
  expired: { tone: "warning", text: "The connection step expired. Please try again." },
  failed: { tone: "danger", text: "Google did not complete the connection. Please try again in a moment." },
  "not-configured": { tone: "danger", text: "Google sign-in is not configured on this server (GOOGLE_CLIENT_ID / SECRET / REDIRECT_URI)." },
};

/** "Connect Google Calendar" with live state: Connected as <email> / Reconnect needed (reason) / Disconnect. */
export function GoogleConnect({ status, returnTo, outcome }: { status: GoogleStatusView; returnTo: string; outcome?: string | null }) {
  const api = useApi();
  const toast = useToast();
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const href = `/api/google/connect?returnTo=${encodeURIComponent(returnTo)}`;
  const banner = outcome ? OUTCOME[outcome] : null;

  return (
    <div className="stack">
      {banner && <Alert tone={banner.tone}>{banner.text}</Alert>}
      {status.state === "connected" ? (
        <div className="row row--between">
          <div className="row row--nowrap">
            <span style={{ color: "var(--success)" }}>
              <IconCheckCircle />
            </span>
            <div>
              <p style={{ fontWeight: 600 }}>Connected{status.email ? ` as ${status.email}` : ""}</p>
              <p className="subtle">Meet links are created on this account&rsquo;s calendar.</p>
              <p className="subtle" style={{ marginTop: 4 }}>
                {status.gmailSend ? (
                  <>
                    <Badge tone="success">Gmail on</Badge> Customer emails are sent from {status.email ?? "your Gmail"}.
                  </>
                ) : (
                  <>
                    <Badge>Gmail off</Badge> Customer emails come from our address, with your email as Reply-To.{" "}
                    <a href={`${href}&gmail=1`}>Send from my Gmail instead</a>
                  </>
                )}
              </p>
            </div>
          </div>
          <div className="row">
            <a className="btn btn--sm" href={href}>
              Switch account
            </a>
            <Button size="sm" variant="danger" onClick={() => setConfirm(true)}>
              Disconnect
            </Button>
          </div>
        </div>
      ) : status.state === "reconnect-needed" ? (
        <Alert
          tone="danger"
          title="Reconnect needed"
          action={
            <a className="btn btn--primary btn--sm" href={href}>
              Reconnect
            </a>
          }
        >
          Google stopped accepting the connection{status.email ? ` for ${status.email}` : ""}
          {status.reason ? ` (${status.reason})` : ""}. Paid bookings wait for their Meet link and are processed automatically once you reconnect.
        </Alert>
      ) : (
        <div className="row row--between">
          <div className="row row--nowrap">
            <span style={{ color: "var(--text-muted)" }}>
              <IconCalendar />
            </span>
            <div>
              <p style={{ fontWeight: 600 }}>
                Not connected <Badge tone="warning">Required</Badge>
              </p>
              <p className="subtle">We only ask for permission to create and update events.</p>
            </div>
          </div>
          <a className="btn btn--primary" href={href}>
            Connect Google Calendar
          </a>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        danger
        busy={busy}
        title="Disconnect Google Calendar?"
        description="New paid bookings will wait without a Meet link until you connect again. Existing events stay on your calendar."
        confirmLabel="Disconnect"
        onConfirm={async () => {
          setBusy(true);
          const r = await api("/api/dashboard/google", { method: "DELETE" });
          setBusy(false);
          setConfirm(false);
          if (!r.ok) return toast(r.data.error ?? "Could not disconnect.", "error");
          toast("Google Calendar disconnected.");
          router.refresh();
        }}
      />
    </div>
  );
}
