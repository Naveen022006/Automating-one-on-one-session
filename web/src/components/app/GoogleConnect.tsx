import { useRouter } from "@web/lib/navigate";
import { useEffect, useId, useRef, useState } from "react";
import { IconCalendar, IconCheckCircle, IconCopy } from "@web/components/icons";
import { focusFirstInvalid } from "@web/components/ui/focus";
import { ConfirmDialog, useToast } from "@web/components/ui/overlays";
import { Alert, Badge, Button, Checkbox, Field, Input, describedBy } from "@web/components/ui/primitives";
import type { GoogleClientView, GoogleStatusView } from "@/lib/views/dashboard-types";
import { useApi } from "./ApiProvider";

type Tone = "success" | "danger" | "warning";

/** What the banner above the card says after Google's return trip (?google=<outcome>). `emailEnabled`: whether the site sends email itself. */
function outcomeBanner(outcome: string, emailEnabled: boolean): { tone: Tone; text: string } | null {
  switch (outcome) {
    case "connected":
      return { tone: "success", text: "Google connected. New bookings get a Meet link automatically." };
    case "connected-no-gmail":
      return {
        tone: "warning",
        text: emailEnabled
          ? "Google Calendar connected, but sending email from your Gmail was not allowed. Customer emails come from our address with your email as Reply-To."
          : "Google Calendar connected, but sending email from your Gmail was not allowed. Customers will get WhatsApp or SMS only, and no email. Connect again and leave the Gmail permission ticked to change that.",
      };
    case "denied":
      return { tone: "warning", text: "Google access was not granted, so Meet links cannot be created yet." };
    case "missing-permission":
      return { tone: "warning", text: "Calendar permission was unticked. Connect again and leave every permission ticked." };
    case "expired":
      return { tone: "warning", text: "The connection step expired. Please try again." };
    case "failed":
      return { tone: "danger", text: "Google did not complete the connection. Please try again in a moment." };
    case "not-configured":
      return { tone: "danger", text: "Google sign-in is not set up on this site yet. Ask the administrator." };
    case "no-client":
      return { tone: "warning", text: "Save your own Google client first (steps 1 and 2 below), then connect." };
    case "client-rejected":
      return {
        tone: "danger",
        text: "Google did not accept your saved Google client. Check that it still exists in Google Cloud and that its secret has not changed, then save it again in step 2.",
      };
    case "confirm-switch":
      return {
        tone: "warning",
        text: "Switching account was not started: some upcoming bookings have their calendar events on your current Google account. Choose Switch account again and confirm to go ahead.",
      };
    case "switch-unconfirmed":
      return {
        tone: "warning",
        text: "That was a different Google account from the one your upcoming bookings are on, so nothing was changed. To move to another account on purpose, choose Switch account and confirm.",
      };
    default:
      return null;
  }
}

/** What a switch or disconnect strands: events that already exist stay on the old Google account. */
function strandedNote(n: number, email: string | null): string {
  return `You have ${n} upcoming booking${n === 1 ? "" : "s"} with a calendar invite on ${email ?? "this account"}. We can no longer move or cancel ${n === 1 ? "that event" : "those events"}, so a rescheduled or cancelled session leaves the old invite on the customer's calendar.`;
}

const SCOPE_NOTES: Record<string, string> = {
  "https://www.googleapis.com/auth/calendar.events": "needed: creates the Meet link on your calendar",
  "https://www.googleapis.com/auth/gmail.send": "optional: sends customer emails from your Gmail",
  openid: "needed: shows which Google account is connected",
  email: "needed: shows which Google account is connected",
};

/** A value to copy into Google Cloud, shown in full (wrapping, never cut off) next to its Copy button. */
function CopyValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="stack stack--sm">
      <span className="field__label">{label}</span>
      <div className="copy">
        <code title={value} style={{ whiteSpace: "normal", overflowWrap: "anywhere", textOverflow: "clip" }}>
          {value}
        </code>
        <Button
          size="sm"
          aria-label={`Copy ${label}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              /* clipboard blocked: the value is on screen and selectable */
            }
          }}
        >
          <IconCopy size={16} /> {copied ? "Copied" : "Copy"}
        </Button>
        <span className="sr-only" aria-live="polite">
          {copied ? `${label} copied` : ""}
        </span>
      </div>
    </div>
  );
}

/** Step 1: the guide. Open until a client is saved, then folded away. */
function CreateClientGuide({ client }: { client: GoogleClientView }) {
  return (
    <details open={!client.hasOwnClient} className="stack">
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>How to create it (about 10 minutes, once)</summary>
      <ol className="stack" style={{ paddingLeft: 20, margin: "12px 0 0" }}>
        <li>
          Open <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener noreferrer">Google Cloud Console</a> and create a project. Any name will do.
        </li>
        <li>
          Go to <strong>APIs &amp; Services, Library</strong> and enable <strong>Google Calendar API</strong>. Also enable <strong>Gmail API</strong> if you want customer emails to come from your Gmail.
        </li>
        <li>
          Go to <strong>OAuth consent screen</strong> (Google calls it Google Auth Platform). Choose <strong>External</strong>, type an app name, and use your own email as the support and developer contact.
        </li>
        <li>
          Under <strong>Scopes</strong>, add these:
          <ul className="stack stack--sm" style={{ paddingLeft: 18, margin: "6px 0" }}>
            {client.requiredScopes.map((scope) => (
              <li key={scope}>
                <code style={{ overflowWrap: "anywhere" }}>{scope}</code> <span className="subtle">({SCOPE_NOTES[scope] ?? "needed"})</span>
              </li>
            ))}
          </ul>
        </li>
        <li>
          Under <strong>Test users</strong>, add your own Google account.
        </li>
        <li>
          Press <strong>Publish app</strong> so it says <strong>In production</strong>. For your own use you do not need Google&rsquo;s verification. You will see an &ldquo;unverified app&rdquo; warning once when you connect (choose Advanced, then continue), and the connection no longer expires every week the way it does while the app is in Testing.
        </li>
        <li>
          Go to <strong>Credentials, Create credentials, OAuth client ID</strong> and choose <strong>Web application</strong>.
        </li>
        <li className="stack stack--sm">
          <span>
            Under <strong>Authorized JavaScript origins</strong> add:
          </span>
          <CopyValue label="Authorized JavaScript origin" value={client.origin} />
        </li>
        <li className="stack stack--sm">
          <span>
            Under <strong>Authorized redirect URIs</strong> add exactly:
          </span>
          <CopyValue label="Authorized redirect URI" value={client.redirectUri} />
        </li>
        <li>
          Press <strong>Create</strong>, then copy the <strong>Client ID</strong> and <strong>Client secret</strong> into step 2.
        </li>
      </ol>
    </details>
  );
}

/** Step 2: paste the pair (or show the saved one, with Replace and Remove). */
function ClientStep({ client, connected, liveEvents, email }: { client: GoogleClientView; connected: boolean; liveEvents: number; email: string | null }) {
  const api = useApi();
  const toast = useToast();
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const [editing, setEditing] = useState(!client.hasOwnClient);
  const [clientId, setClientId] = useState(client.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<{ field: "clientId" | "clientSecret" | null; message: string } | null>(null);
  const [okMessage, setOkMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<"replace" | "remove" | null>(null);
  const [tick, setTick] = useState(0);
  const idFieldId = useId();
  const secretFieldId = useId();

  // Back to "no client" (it was removed): show the empty form again.
  useEffect(() => {
    if (!client.hasOwnClient) setEditing(true);
  }, [client.hasOwnClient]);

  // After a failed save the first invalid field gets focus, so the failure is never silent below the fold.
  useEffect(() => {
    if (tick > 0) focusFirstInvalid(formRef.current);
  }, [tick]);
  useEffect(() => {
    if (okMessage) statusRef.current?.focus();
  }, [okMessage]);

  const connectedWithOwn = connected && client.grantClient === "own";

  async function save() {
    setBusy(true);
    setError(null);
    setOkMessage(null);
    const r = await api<{ replacedConnection?: boolean }>("/api/dashboard/google-client", {
      body: { action: "save-client", clientId: clientId.trim(), clientSecret: secret.trim() },
    });
    setBusy(false);
    setDialog(null);
    if (!r.ok) {
      const field = r.data.field === "clientSecret" ? "clientSecret" : r.data.field === "clientId" ? "clientId" : null;
      setError({ field, message: r.data.error ?? "Could not save your Google client. Please try again." });
      setTick((n) => n + 1);
      return;
    }
    setSecret("");
    setEditing(false);
    setOkMessage(
      r.data.replacedConnection
        ? "Google accepted these and they are saved. Because the client changed, connect Google again in step 3."
        : "Google accepted these and they are saved. Now connect Google in step 3.",
    );
    router.refresh();
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    // A different client ID cannot keep the old connection: say so before it happens. The same ID with a new secret keeps it.
    if (client.hasOwnClient && connected && clientId.trim() !== client.clientId) setDialog("replace");
    else void save();
  }

  async function remove() {
    setBusy(true);
    const r = await api("/api/dashboard/google-client", { body: { action: "remove-client", ...(liveEvents > 0 ? { confirm: true } : {}) } });
    setBusy(false);
    setDialog(null);
    if (!r.ok) {
      toast(r.data.error ?? "Could not remove your Google client.", "error");
      if (r.status === 409) router.refresh();
      return;
    }
    setClientId("");
    setSecret("");
    setOkMessage(null);
    toast("Your Google client was removed.");
    router.refresh();
  }

  return (
    <div className="stack">
      <p ref={statusRef} tabIndex={-1} role="status" style={{ outline: "none" }} className={okMessage ? "" : "sr-only"}>
        {okMessage ?? ""}
      </p>
      {client.hasOwnClient && !editing ? (
        <div className="row row--between">
          <div className="stack stack--sm">
            <p>
              <span className="field__label">Client ID</span>
              <br />
              <code style={{ overflowWrap: "anywhere" }}>{client.clientId}</code>
            </p>
            <p className="subtle">
              <Badge tone="success">Secret saved</Badge> Stored encrypted and never shown again.
              {client.checkedAt ? ` Checked with Google on ${new Date(client.checkedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}.` : ""}
            </p>
          </div>
          <div className="row">
            <Button size="sm" onClick={() => setEditing(true)}>
              Replace
            </Button>
            <Button size="sm" variant="danger" onClick={() => setDialog("remove")}>
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <form className="stack" onSubmit={submit} ref={formRef} noValidate>
          {client.hasOwnClient && (
            <Alert tone="warning" title="Replacing your Google client">
              {connected
                ? "If you enter a different Client ID, your current Google connection stops working and your booking page goes offline until you connect again in step 3. The same Client ID with a new secret keeps it working."
                : "Enter the new Client ID and Client Secret."}
            </Alert>
          )}
          {error && error.field === null && <Alert tone="danger">{error.message}</Alert>}
          <Field id={idFieldId} label="Client ID" error={error?.field === "clientId" ? error.message : null} help="Ends in .apps.googleusercontent.com">
            <Input
              {...describedBy(idFieldId, { error: error?.field === "clientId" ? error.message : null, help: true })}
              name="clientId"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              required
              maxLength={300}
              value={clientId}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setClientId(e.target.value)}
            />
          </Field>
          <Field
            id={secretFieldId}
            label="Client Secret"
            error={error?.field === "clientSecret" ? error.message : null}
            help="Stored encrypted and never shown again. Usually starts with GOCSPX-"
          >
            <Input
              {...describedBy(secretFieldId, { error: error?.field === "clientSecret" ? error.message : null, help: true })}
              name="clientSecret"
              type="password"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              required
              maxLength={300}
              value={secret}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSecret(e.target.value)}
            />
          </Field>
          <div className="row">
            <Button type="submit" variant="primary" loading={busy} disabled={clientId.trim() === "" || secret.trim() === ""}>
              Save and check
            </Button>
            {client.hasOwnClient && (
              <Button
                onClick={() => {
                  setEditing(false);
                  setError(null);
                  setSecret("");
                  setClientId(client.clientId ?? "");
                }}
                disabled={busy}
              >
                Cancel
              </Button>
            )}
          </div>
          <p className="subtle">We send these to Google once to check they belong together. Nothing is saved unless Google accepts them.</p>
        </form>
      )}

      <ConfirmDialog
        open={dialog === "replace"}
        onClose={() => setDialog(null)}
        onConfirm={() => void save()}
        busy={busy}
        danger
        title="Replace your Google client?"
        description={`A different Client ID means your current Google connection stops working: your booking page goes offline and paid bookings wait for their Meet link until you connect again in step 3.${liveEvents > 0 ? ` ${strandedNote(liveEvents, email)}` : ""}`}
        confirmLabel="Replace it"
        cancelLabel="Keep the old one"
      />
      <ConfirmDialog
        open={dialog === "remove"}
        onClose={() => setDialog(null)}
        onConfirm={() => void remove()}
        busy={busy}
        danger
        title="Remove your Google client?"
        description={`${connectedWithOwn ? "This also disconnects Google, because the connection was made with this client. " : ""}Your saved Client ID and encrypted secret are deleted. Your booking page goes offline until you save a client and connect again.${connectedWithOwn && liveEvents > 0 ? ` ${strandedNote(liveEvents, email)}` : ""}`}
        confirmLabel="Remove"
        cancelLabel="Keep it"
      />
    </div>
  );
}

/** Step 3: connect (or the state of the connection), with the Gmail permission choice. */
function ConnectStep({
  status,
  client,
  returnTo,
  emailEnabled,
}: {
  status: GoogleStatusView;
  client: GoogleClientView;
  returnTo: string;
  emailEnabled: boolean;
}) {
  const api = useApi();
  const toast = useToast();
  const router = useRouter();
  const [dialog, setDialog] = useState<"disconnect" | "switch" | null>(null);
  const [busy, setBusy] = useState(false);
  const wantsGmailByDefault = status.state === "not-connected" ? status.requestsGmail !== false : true;
  const [gmail, setGmail] = useState(wantsGmailByDefault);
  const base = `/api/google/connect?returnTo=${encodeURIComponent(returnTo)}`;
  const href = `${base}&gmail=${gmail ? 1 : 0}`;
  // The account the calendar events are on: the connected one, or after a disconnect the one remembered then.
  const email = status.state === "not-connected" ? (status.previousEmail ?? null) : status.email;
  const liveEvents = status.liveEvents ?? 0;
  const noGmailNote = emailEnabled
    ? "Without it, customer emails come from our address with your email as Reply-To."
    : "Without it, customers get WhatsApp or SMS only and no email.";

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

  const needsClientFix = status.state === "reconnect-needed" && /google client was removed or is no longer valid/i.test(status.reason ?? "");

  return (
    <div className="stack">
      {status.state === "not-connected" && !client.canConnect ? (
        <p className="subtle">Finish step 2 first. Connecting is possible once Google has accepted your Client ID and Client Secret.</p>
      ) : status.state === "connected" ? (
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
                    <Badge tone="danger">Gmail not working</Badge> Sending from your Gmail is not working right now.{" "}
                    {emailEnabled ? "Customer emails go out from our address with your email as Reply-To." : "Customers get WhatsApp or SMS only, and no email."} Check that the Gmail API is enabled in your Google Cloud project (step 1), or{" "}
                    <a href={`${base}&gmail=1`}>reconnect Gmail</a>.
                  </>
                ) : status.gmailSend ? (
                  <>
                    <Badge tone="success">Gmail on</Badge> Customer emails are sent from {status.email ?? "your Gmail"}.
                  </>
                ) : (
                  <>
                    <Badge>Gmail off</Badge> {noGmailNote} <a href={`${base}&gmail=1`}>Allow sending from my Gmail</a>
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
            // No client to reconnect with (it was removed): the way forward is step 2, not a link that would only bounce back.
            client.canConnect ? (
              <div className="row">
                <a className="btn btn--primary btn--sm" href={href}>
                  Reconnect
                </a>
                {switchAccount("Switch account")}
              </div>
            ) : undefined
          }
        >
          Google stopped accepting the connection{status.email ? ` for ${status.email}` : ""}
          {status.reason ? ` (${status.reason})` : ""}. Your booking page is offline until you reconnect. Paid bookings wait for their Meet link and are processed automatically once you reconnect.
          {needsClientFix || !client.canConnect ? " Fix your Google client in step 2 first." : ""}
        </Alert>
      ) : (
        <div className="stack">
          <div className="row row--between">
            <div className="row row--nowrap">
              <span style={{ color: "var(--text-muted)" }}>
                <IconCalendar />
              </span>
              <div>
                <p style={{ fontWeight: 600 }}>
                  Not connected <Badge tone="warning">Required</Badge>
                </p>
                <p className="subtle">We ask Google for permission to create and update Calendar events on your calendar.</p>
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
          <Checkbox
            checked={gmail}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setGmail(e.target.checked)}
            label={`Also allow sending customers' emails from my Gmail. ${noGmailNote}`}
          />
        </div>
      )}
      {status.state === "connected" && client.grantClient === "platform" && client.mode !== "platform" && (
        <Alert tone="info">This connection was made with the site&rsquo;s shared Google app. Save your own Google client above, then connect again to move to it.</Alert>
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

function StepHeading({ n, title, done, state }: { n: number; title: string; done: boolean; state?: string }) {
  return (
    <h3 style={{ fontSize: "1rem", margin: 0 }} className="row row--nowrap">
      <span aria-hidden="true" className="subtle">
        {n}.
      </span>
      <span>
        <span className="sr-only">Step {n}: </span>
        {title}
      </span>
      {done ? <Badge tone="success">{state ?? "Done"}</Badge> : null}
    </h3>
  );
}

/**
 * The three-step Google card (doc/15): 1. create your own Google client, 2. paste its Client ID and Secret, 3. connect Calendar (and
 * optionally Gmail) with it. The steps stay visible whatever the state, so an influencer can always see what is missing or replace
 * what is there; step 3 only works once Google has accepted step 2. In a deployment that uses the site's shared Google app
 * (GOOGLE_CLIENT_MODE=platform) steps 1 and 2 are not shown.
 */
export function GoogleConnect({
  status,
  client,
  returnTo,
  outcome,
  emailEnabled = true,
}: {
  status: GoogleStatusView;
  client: GoogleClientView;
  returnTo: string;
  outcome?: string | null;
  emailEnabled?: boolean;
}) {
  const banner = outcome ? outcomeBanner(outcome, emailEnabled) : null;
  const connected = status.state === "connected";
  const liveEvents = status.liveEvents ?? 0;
  const email = status.state === "not-connected" ? (status.previousEmail ?? null) : status.email;
  const ownSteps = client.mode !== "platform";

  return (
    <div className="stack">
      {banner && <Alert tone={banner.tone}>{banner.text}</Alert>}
      {ownSteps && (
        <>
          <section className="stack" aria-label="Step 1: create your own Google client">
            <StepHeading n={1} title="Create your own Google client" done={client.hasOwnClient} />
            <p className="subtle">
              Your Meet links and (if you allow it) your customers&rsquo; emails go through a Google client that belongs to you, not to us. You set it up once.
            </p>
            <CreateClientGuide client={client} />
          </section>
          <section className="stack" aria-label="Step 2: paste your Client ID and Client Secret" style={{ borderTop: "1px solid var(--border)", paddingTop: 16 }}>
            <StepHeading n={2} title="Paste your Client ID and Client Secret" done={client.hasOwnClient} state="Saved" />
            <ClientStep client={client} connected={connected} liveEvents={liveEvents} email={email} />
          </section>
        </>
      )}
      <section className="stack" aria-label="Step 3: connect Google" style={ownSteps ? { borderTop: "1px solid var(--border)", paddingTop: 16 } : undefined}>
        <StepHeading n={ownSteps ? 3 : 1} title="Connect Google Calendar" done={connected} state="Connected" />
        <ConnectStep status={status} client={client} returnTo={returnTo} emailEnabled={emailEnabled} />
      </section>
    </div>
  );
}
