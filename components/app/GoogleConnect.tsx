"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { IconCalendar, IconCheckCircle } from "@/components/icons";
import { ConfirmDialog, useToast } from "@/components/ui/overlays";
import { Alert, Badge, Button } from "@/components/ui/primitives";
import { useApi } from "./ApiProvider";

export type GoogleStatusView =
  | { state: "not-connected"; requestsGmail?: boolean; liveEvents?: number; previousEmail?: string | null }
  | { state: "connected"; email: string | null; connectedAt: string; gmailSend: boolean; liveEvents?: number; gmailFailing?: boolean }
  | { state: "reconnect-needed"; email: string | null; reason: string | null; liveEvents?: number };

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
  "confirm-switch": {
    tone: "warning",
    text: "Switching account was not started: some upcoming bookings have their calendar events on your current Google account. Choose Switch account again and confirm to go ahead.",
  },
  "switch-unconfirmed": {
    tone: "warning",
    text: "That was a different Google account from the one your upcoming bookings are on, so nothing was changed. To move to another account on purpose, choose Switch account and confirm.",
  },
};

/** What a switch or disconnect strands: events that already exist stay on the old Google account. */
function strandedNote(n: number, email: string | null): string {
  return `You have ${n} upcoming booking${n === 1 ? "" : "s"} with a calendar invite on ${email ?? "this account"}. We can no longer move or cancel ${n === 1 ? "that event" : "those events"}, so a rescheduled or cancelled session leaves the old invite on the customer's calendar.`;
}

/** "Connect Google Calendar" with live state: Connected as <email> / Reconnect needed (reason) / Disconnect. */
export function GoogleConnect({ status, returnTo, outcome }: { status: GoogleStatusView; returnTo: string; outcome?: string | null }) {
  const api = useApi();
  const toast = useToast();
  const router = useRouter();
  const [dialog, setDialog] = useState<"disconnect" | "switch" | null>(null);
  const [busy, setBusy] = useState(false);
  const href = `/api/google/connect?returnTo=${encodeURIComponent(returnTo)}`;
  const banner = outcome ? OUTCOME[outcome] : null;
  // The account the calendar events are on: the connected one, or after a disconnect the one remembered then.
  const email = status.state === "not-connected" ? (status.previousEmail ?? null) : status.email;
  const liveEvents = status.liveEvents ?? 0;

  // "Switch account" replaces the connection. With upcoming bookings it asks first, and the server refuses a switch
  // without ?confirm=1 anyway (app/api/google/connect), so this dialog is the explanation, not the safeguard.
  const switchAccount = (label: string) =>
    liveEvents > 0 ? (
      <Button size="sm" onClick={() => setDialog("switch")}>
        {label}
      </Button>
    ) : (
      <a className="btn btn--sm" href={`${href}&switch=1`}>
        {label}
      </a>
    );

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
                {status.gmailSend && status.gmailFailing ? (
                  <>
                    <Badge tone="danger">Gmail not working</Badge> Gmail sending is not working right now, so customer emails go out from our
                    address with your email as Reply-To. If it keeps happening, the platform owner needs to enable the Gmail API for the Google
                    project (see the setup guide), or you can{" "}
                    <a href={`${href}&gmail=1`}>reconnect Gmail</a>.
                  </>
                ) : status.gmailSend ? (
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
            {switchAccount("Switch account")}
            <Button size="sm" variant="danger" onClick={() => setDialog("disconnect")}>
              Disconnect
            </Button>
          </div>
        </div>
      ) : status.state === "reconnect-needed" ? (
        <Alert
          tone="danger"
          title="Reconnect needed"
          action={
            <div className="row">
              <a className="btn btn--primary btn--sm" href={href}>
                Reconnect
              </a>
              {switchAccount("Switch account")}
            </div>
          }
        >
          Google stopped accepting the connection{status.email ? ` for ${status.email}` : ""}
          {status.reason ? ` (${status.reason})` : ""}. Your booking page is offline until you reconnect. Paid bookings wait for their Meet link and are processed automatically once you reconnect.
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
              <p className="subtle">
                {status.requestsGmail === false
                  ? "We only ask for permission to create and update Calendar events."
                  : "We ask for permission to create and update Calendar events, and to send your customers’ booking emails from your Gmail. You can untick the email permission on Google’s screen."}
              </p>
              {liveEvents > 0 && email && (
                <p className="subtle" style={{ marginTop: 4 }}>
                  Your {liveEvents} upcoming booking{liveEvents === 1 ? "" : "s"} {liveEvents === 1 ? "has its" : "have their"} calendar event on {email}. Connect that
                  account again to keep them working, or use a different one.
                </p>
              )}
            </div>
          </div>
          <div className="row">
            {liveEvents > 0 && email && switchAccount("Use a different account")}
            <a className="btn btn--primary" href={href}>
              Connect Google Calendar
            </a>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={dialog === "switch"}
        onClose={() => setDialog(null)}
        danger
        title="Switch Google account?"
        description={`${strandedNote(liveEvents, email)} People already booked into group sessions are not moved to the new calendar: they keep the old Meet link, and a later booking of the same session starts a different Meet on the new calendar. Wait until those sessions are over, or switch anyway.`}
        confirmLabel="Switch anyway"
        cancelLabel={status.state === "not-connected" ? "Cancel" : "Keep this account"}
        onConfirm={() => {
          window.location.href = `${href}&switch=1&confirm=1`;
        }}
      />
      <ConfirmDialog
        open={dialog === "disconnect"}
        onClose={() => setDialog(null)}
        danger
        busy={busy}
        title="Disconnect Google Calendar?"
        description={`Your booking page goes offline while Google is not connected, and new paid bookings will wait without a Meet link until you connect again. Existing events stay on your calendar.${liveEvents > 0 ? ` ${strandedNote(liveEvents, email)}` : ""}`}
        confirmLabel="Disconnect"
        onConfirm={async () => {
          setBusy(true);
          // The server wants the confirmation whenever upcoming bookings have events; the dialog above is what warned them.
          const r = await api("/api/dashboard/google", { method: "DELETE", body: liveEvents > 0 ? { confirm: true } : undefined });
          setBusy(false);
          setDialog(null);
          if (!r.ok) {
            toast(r.data.error ?? "Could not disconnect.", "error");
            if (r.status === 409) router.refresh(); // bookings came in since this page loaded: show the warning with the new count
            return;
          }
          toast("Google Calendar disconnected.");
          router.refresh();
        }}
      />
    </div>
  );
}
