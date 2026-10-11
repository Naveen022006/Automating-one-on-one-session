"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { IconCheckCircle, IconMessage } from "@/components/icons";
import { ConfirmDialog, useToast } from "@/components/ui/overlays";
import { Alert, Badge, Button, Checkbox, Field, Input, describedBy } from "@/components/ui/primitives";
import { chooseFacebookSdkUrl } from "@/lib/facebook-sdk";
import { TEMPLATE_STATE_NOTICE, TEMPLATE_STATUS_LABELS, templateState } from "@/lib/message-templates";
import { RESET_PIN_LABEL } from "@/lib/whatsapp-copy";
import { DEFAULT_GRAPH_VERSION } from "@/lib/whatsapp-graph-version";
import { useApi } from "./ApiProvider";

export interface WhatsAppView {
  displayPhone: string | null;
  verifiedName: string | null;
  source: string;
  status: "ACTIVE" | "ERROR";
  lastError: string | null;
  templates: { name: string; status: string; reason: string | null }[];
  ready: boolean;
}

const TEMPLATE_LABEL: Record<string, string> = {
  "booking-confirmation": "Booking confirmation",
  "reminder-24h": "Reminder, 24 hours before",
  "reminder-15m": "Reminder, 15 minutes before",
  reschedule: "Session rescheduled",
  cancellation: "Session cancelled",
};

function TemplateBadge({ status }: { status: string }) {
  const known = TEMPLATE_STATUS_LABELS[status];
  if (known) return <Badge tone={known.tone}>{known.label}</Badge>;
  // A status this card does not know: say what Meta said rather than guess.
  const text = status.toLowerCase().replace(/_/g, " ");
  return <Badge>{text.charAt(0).toUpperCase() + text.slice(1)}</Badge>;
}

interface FacebookSdk {
  init(opts: Record<string, unknown>): void;
  login(cb: (r: { authResponse?: { code?: string } }) => void, opts: Record<string, unknown>): void;
}
declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

let sdkLoading: Promise<FacebookSdk> | null = null;

function loadFacebookSdk(appId: string, version: string, src: string): Promise<FacebookSdk> {
  if (window.FB) return Promise.resolve(window.FB);
  // One load at a time, so the component mounting twice (or remounting) never adds a second script.
  sdkLoading ??= new Promise<FacebookSdk>((resolve, reject) => {
    window.fbAsyncInit = () => {
      // No app-event logging: this page only needs the sign-up window, not to report visits to Facebook.
      window.FB!.init({ appId, autoLogAppEvents: false, xfbml: true, version });
      resolve(window.FB!);
    };
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.onerror = () => {
      el.remove();
      reject(new Error("Could not load the WhatsApp sign-up window. Check your connection or ad blocker."));
    };
    document.body.appendChild(el);
  }).catch((e) => {
    sdkLoading = null; // allow a retry
    throw e;
  });
  return sdkLoading;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * "Connect your WhatsApp number". Meta Embedded Signup when the platform is a configured Meta Tech Provider,
 * otherwise (or additionally) by entering the account ids and a permanent token.
 */
export function WhatsAppConnect({ connection, embedded }: { connection: WhatsAppView | null; embedded: { appId: string; configId: string; graphVersion?: string; sdkUrl?: string } | null }) {
  const api = useApi();
  const toast = useToast();
  const router = useRouter();
  const [manual, setManual] = useState(false);
  const [waba, setWaba] = useState("");
  const [phoneId, setPhoneId] = useState("");
  const [token, setToken] = useState("");
  // The number's own two-step verification PIN, only for a number that already has one. Optional everywhere.
  const [pin, setPin] = useState("");
  const [showPin, setShowPin] = useState(false);
  // Offered only after the server says the number has a PIN we do not know: the influencer can let us set a new one.
  // Never ticked for them, and never sent unless they tick it.
  const [canReset, setCanReset] = useState(false);
  const [resetPin, setResetPin] = useState(false);
  // Things the server noticed while connecting that did not stop it (a token it could not check, one that expires later).
  const [notes, setNotes] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [busy, setBusy] = useState<"manual" | "embedded" | "refresh" | "disconnect" | null>(null);
  const [confirm, setConfirm] = useState(false);
  // The connect form, opened from the error state to connect again without disconnecting first.
  const [reconnect, setReconnect] = useState(false);
  const session = useRef<{ wabaId?: string; phoneNumberId?: string; failure?: string }>({});
  const sdk = useRef<FacebookSdk | null>(null);
  const [sdkState, setSdkState] = useState<"loading" | "ready" | "failed">("loading");
  const appId = embedded?.appId;
  const version = embedded?.graphVersion ?? DEFAULT_GRAPH_VERSION;
  // Meta's SDK; the server only offers another (the local mock's) in development, and only a loopback one is accepted.
  const sdkSrc = chooseFacebookSdkUrl(embedded?.sdkUrl);

  // The connect buttons are on screen: when nothing is connected, or after Reconnect was pressed on a broken connection.
  // Facebook's script is not loaded for anyone who is connected and just looking at their settings.
  const connectVisible = !connection || (connection.status === "ERROR" && reconnect);

  // Load the Facebook SDK as soon as the connect buttons show, not on click: FB.login opens a pop-up, and a browser only
  // allows that straight from the click, so there must be nothing to wait for once the button is pressed.
  useEffect(() => {
    if (!appId || !connectVisible) return;
    let live = true;
    loadFacebookSdk(appId, version, sdkSrc).then(
      (FB) => {
        sdk.current = FB;
        if (live) setSdkState("ready");
      },
      () => live && setSdkState("failed"),
    );
    return () => {
      live = false;
    };
  }, [appId, version, sdkSrc, connectVisible]);

  // Embedded Signup reports what happened in the sign-up window as window messages, separately from the login code:
  // FINISH carries the new account's ids; CANCEL and ERROR say why there will be no account.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (typeof e.origin !== "string" || !/^https:\/\/([a-z0-9-]+\.)?facebook\.com$/.test(e.origin)) return;
      try {
        const data = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
        if (data?.type !== "WA_EMBEDDED_SIGNUP") return;
        if (data.event === "FINISH") {
          session.current = { wabaId: String(data.data?.waba_id ?? ""), phoneNumberId: String(data.data?.phone_number_id ?? "") };
        } else if (data.event === "CANCEL") {
          const step = typeof data.data?.current_step === "string" ? data.data.current_step.toLowerCase().replace(/_/g, " ") : "";
          session.current.failure = `WhatsApp sign-up was cancelled${step ? ` at the "${step}" step` : ""}.`;
        } else if (data.event === "ERROR") {
          const why = typeof data.data?.error_message === "string" ? data.data.error_message.slice(0, 200) : "";
          session.current.failure = `WhatsApp sign-up failed${why ? `: ${why}` : ""}. Please try again.`;
        }
      } catch {
        /* not our message */
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  async function saveManual(e: React.FormEvent) {
    e.preventDefault();
    setBusy("manual");
    setErrors({});
    const r = await api<{ details?: { fieldErrors?: Record<string, string[]> }; connection?: { notes?: string[] } }>("/api/dashboard/whatsapp", {
      method: "POST",
      body: { action: "connect-manual", wabaId: waba, phoneNumberId: phoneId, accessToken: token, pin: pin.trim() || undefined },
    });
    setBusy(null);
    if (!r.ok) {
      const fe: Record<string, string> = {};
      for (const [k, v] of Object.entries(r.data.details?.fieldErrors ?? {})) if (v?.[0]) fe[k] = v[0];
      if (r.data.field && r.data.error) fe[r.data.field] = r.data.error;
      setErrors(fe);
      if (!Object.keys(fe).length) toast(r.data.error ?? "Could not connect WhatsApp.", "error");
      return;
    }
    setToken("");
    setPin("");
    setReconnect(false);
    setNotes(r.data.connection?.notes ?? []);
    toast("WhatsApp connected. We submitted your message templates to Meta for approval.");
    router.refresh();
  }

  // After the sign-up window closes: wait for the account ids, then hand the code to the server.
  async function finishEmbedded(code: string | undefined) {
    if (!code) {
      setBusy(null);
      return toast(session.current.failure ?? "WhatsApp sign-up was cancelled.", "error");
    }
    // The ids arrive in a separate message a moment after the code. Stop waiting early if the window said it failed.
    for (let i = 0; i < 30 && !session.current.failure && !(session.current.wabaId && session.current.phoneNumberId); i++) await sleep(500);
    const { wabaId, phoneNumberId, failure } = session.current;
    if (failure || !wabaId || !phoneNumberId) {
      setBusy(null);
      return toast(failure ?? "WhatsApp did not finish creating your account. Please try again.", "error");
    }
    const r = await api<{ connection?: { notes?: string[] }; canReset?: boolean }>("/api/dashboard/whatsapp", { method: "POST", body: { action: "connect-embedded", code, wabaId, phoneNumberId, pin: pin.trim() || undefined, resetPin: resetPin && !pin.trim() ? true : undefined } });
    setBusy(null);
    if (!r.ok) {
      // The number already has a two-step PIN we do not know: ask for it, and offer the reset when it is ours to offer.
      // Either way they connect again (the sign-up code works once).
      if (r.data.field === "pin") {
        setShowPin(true);
        setErrors({ pin: r.data.error });
        setCanReset(r.data.canReset === true);
      }
      return toast(r.data.error ?? "Could not connect WhatsApp.", "error");
    }
    setPin("");
    setResetPin(false);
    setCanReset(false);
    setReconnect(false);
    setNotes(r.data.connection?.notes ?? []);
    toast("WhatsApp connected. We submitted your message templates to Meta for approval.");
    router.refresh();
  }

  // Not async, and nothing is awaited before FB.login: the browser only opens the sign-up pop-up for a call made
  // directly from the click. The SDK also wants a plain callback function (it ignores an async one), so the async
  // work is in finishEmbedded.
  function startEmbedded() {
    if (!embedded) return;
    const FB = sdk.current;
    if (!FB) {
      // The SDK did not load (a blocker or a flaky connection). Try again; the pop-up needs a fresh click afterwards.
      setSdkState("loading");
      loadFacebookSdk(embedded.appId, version, sdkSrc).then(
        (loaded) => {
          sdk.current = loaded;
          setSdkState("ready");
          toast("The WhatsApp sign-up window is ready. Press Connect with WhatsApp again.");
        },
        (e: Error) => {
          setSdkState("failed");
          toast(e.message, "error");
        },
      );
      return;
    }
    setBusy("embedded");
    session.current = {};
    FB.login(
      function (resp) {
        void finishEmbedded(resp.authResponse?.code);
      },
      { config_id: embedded.configId, response_type: "code", override_default_response_type: true, extras: { setup: {}, featureType: "", sessionInfoVersion: "3" } },
    );
  }

  async function refresh() {
    setBusy("refresh");
    const r = await api<{ submitted?: string[] }>("/api/dashboard/whatsapp", { method: "POST", body: { action: "refresh" } });
    setBusy(null);
    if (!r.ok) {
      toast(r.data.error ?? "Could not refresh.", "error");
      // A refusal can change what the card must show: Meta rejecting the saved token makes the server mark the connection as
      // needing a reconnect, and without this the card kept saying "Ready" until the page was reloaded.
      router.refresh();
      return;
    }
    toast(r.data.submitted?.length ? `Submitted ${r.data.submitted.length} template(s) to Meta.` : "Template statuses are up to date.");
    router.refresh();
  }

  // The ways to connect: Embedded Signup and/or the form. Shown when nothing is connected, and again to reconnect.
  const connectOptions = (
    <>
      <div className="row">
        {embedded && (
          <Button variant="primary" onClick={startEmbedded} loading={busy === "embedded" || sdkState === "loading"}>
            Connect with WhatsApp
          </Button>
        )}
        <Button onClick={() => setManual((v) => !v)} aria-expanded={manual}>
          {embedded ? "Enter details manually" : "Connect my WhatsApp number"}
        </Button>
      </div>
      {embedded && !manual && (showPin ? (
        <div className="stack stack--sm">
          <Field id="wa-pin-embedded" label="Two-step verification PIN" optional error={errors.pin} help="Only if the number you connect already has a two-step verification PIN. A number without one gets a new PIN from us, and we keep it for you.">
            <Input {...describedBy("wa-pin-embedded", { error: errors.pin, help: true })} inputMode="numeric" autoComplete="off" maxLength={6} value={pin} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPin(e.target.value.replace(/\D/g, ""))} />
          </Field>
          {canReset && (
            <Checkbox
              label={RESET_PIN_LABEL}
              checked={resetPin && !pin.trim()}
              disabled={pin.trim() !== ""}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setResetPin(e.target.checked)}
            />
          )}
        </div>
      ) : (
        <div>
          <Button size="sm" variant="ghost" onClick={() => setShowPin(true)}>
            My number already has a two-step verification PIN
          </Button>
        </div>
      ))}
      {manual && (
        <form className="stack" onSubmit={saveManual} noValidate>
          <Alert tone="info" title="Where to find these">
            In Meta Business Suite open WhatsApp Manager: the <strong>WhatsApp Business Account ID</strong> and <strong>Phone number ID</strong> are on the
            API setup page. Create a permanent token under Business settings, System users, with the whatsapp_business_management and
            whatsapp_business_messaging permissions.
          </Alert>
          <div className="form-grid form-grid--2">
            <Field id="wa-waba" label="WhatsApp Business Account ID" error={errors.wabaId}>
              <Input {...describedBy("wa-waba", { error: errors.wabaId })} inputMode="numeric" autoComplete="off" value={waba} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWaba(e.target.value)} />
            </Field>
            <Field id="wa-phone" label="Phone number ID" error={errors.phoneNumberId}>
              <Input {...describedBy("wa-phone", { error: errors.phoneNumberId })} inputMode="numeric" autoComplete="off" value={phoneId} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPhoneId(e.target.value)} />
            </Field>
          </div>
          <Field id="wa-token" label="Permanent access token" error={errors.accessToken} help="Stored encrypted and never shown again.">
            <Input {...describedBy("wa-token", { error: errors.accessToken, help: true })} type="password" autoComplete="off" value={token} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setToken(e.target.value)} />
          </Field>
          <Field id="wa-pin" label="Two-step verification PIN" optional error={errors.pin} help="Leave blank if the number is already working. Fill it in to register a number that is not registered yet, or if it already has a PIN.">
            <Input {...describedBy("wa-pin", { error: errors.pin, help: true })} inputMode="numeric" autoComplete="off" maxLength={6} value={pin} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPin(e.target.value.replace(/\D/g, ""))} />
          </Field>
          <div className="form-actions">
            <Button type="submit" variant="primary" loading={busy === "manual"}>
              Connect and submit templates
            </Button>
          </div>
        </form>
      )}
    </>
  );

  if (connection) {
    const templatesState = templateState(connection.templates.map((t) => t.status));
    return (
      <div className="stack">
        <div className="row row--between">
          <div className="row row--nowrap">
            <span style={{ color: connection.status === "ACTIVE" ? "var(--success)" : "var(--danger)" }}>
              <IconCheckCircle />
            </span>
            <div>
              <p style={{ fontWeight: 600 }}>
                {connection.displayPhone ?? "WhatsApp number"} {connection.verifiedName ? <span className="muted">· {connection.verifiedName}</span> : null}
              </p>
              <p className="subtle">Messages to your customers are sent from this number.</p>
            </div>
          </div>
          <div className="row">
            {connection.status === "ERROR" ? (
              <Badge tone="danger">Reconnect needed</Badge>
            ) : connection.ready ? (
              <Badge tone="success">Ready</Badge>
            ) : templatesState === "rejected" ? (
              <Badge tone="danger">Templates need attention</Badge>
            ) : templatesState === "not-submitted" ? (
              <Badge tone="warning">Templates not submitted</Badge>
            ) : (
              <Badge tone="warning">Waiting for template approval</Badge>
            )}
            {connection.status === "ERROR" && (
              <Button size="sm" variant="primary" onClick={() => setReconnect((v) => !v)} aria-expanded={reconnect}>
                Reconnect
              </Button>
            )}
            <Button size="sm" variant="danger" onClick={() => setConfirm(true)}>
              Disconnect
            </Button>
          </div>
        </div>
        {connection.status === "ERROR" && (
          <Alert tone="danger" title="WhatsApp stopped accepting the connection">
            {connection.lastError} Customer messages go out by SMS until you reconnect.
          </Alert>
        )}
        {/* Connecting again replaces the saved credentials in place, so there is no need to disconnect first. */}
        {connection.status === "ERROR" && reconnect && <div className="stack">{connectOptions}</div>}
        {connection.status === "ACTIVE" && connection.lastError && <Alert tone="warning">{connection.lastError}</Alert>}
        {connection.status === "ACTIVE" && notes.map((n) => (
          <Alert key={n} tone="info">
            {n}
          </Alert>
        ))}
        {/* The same wording as the go-live checklist, from one place (TEMPLATE_STATE_NOTICE). */}
        {connection.status === "ACTIVE" && templatesState !== "ready" && (
          <Alert tone={templatesState === "pending" ? "info" : "warning"} title={TEMPLATE_STATE_NOTICE[templatesState].title}>
            {TEMPLATE_STATE_NOTICE[templatesState].body}
          </Alert>
        )}
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Message templates</caption>
            <thead>
              <tr>
                <th scope="col">Message</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {connection.templates.map((t) => (
                <tr key={t.name}>
                  <td>
                    {TEMPLATE_LABEL[t.name] ?? t.name}
                    {t.reason && <div className="subtle">{t.reason}</div>}
                  </td>
                  <td>
                    <TemplateBadge status={t.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <Button size="sm" onClick={refresh} loading={busy === "refresh"}>
            Check template status
          </Button>
        </div>
        <ConfirmDialog
          open={confirm}
          onClose={() => setConfirm(false)}
          danger
          busy={busy === "disconnect"}
          title="Disconnect WhatsApp?"
          description="Customer messages will go out by SMS only. Your WhatsApp Business account and templates stay with Meta."
          confirmLabel="Disconnect"
          onConfirm={async () => {
            setBusy("disconnect");
            const r = await api("/api/dashboard/whatsapp", { method: "DELETE" });
            setBusy(null);
            setConfirm(false);
            if (!r.ok) return toast(r.data.error ?? "Could not disconnect.", "error");
            setNotes([]);
            setReconnect(false);
            toast("WhatsApp disconnected.");
            router.refresh();
          }}
        />
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row row--nowrap">
        <span style={{ color: "var(--text-muted)" }}>
          <IconMessage />
        </span>
        <div>
          <p style={{ fontWeight: 600 }}>
            Not connected <Badge>Recommended</Badge>
          </p>
          <p className="subtle">
            Connect your own WhatsApp Business number so confirmations and reminders reach customers from you. Without it, they
            are sent by SMS.
          </p>
        </div>
      </div>
      {connectOptions}
    </div>
  );
}
