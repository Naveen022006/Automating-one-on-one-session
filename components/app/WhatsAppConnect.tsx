"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { IconCheckCircle, IconMessage } from "@/components/icons";
import { ConfirmDialog, useToast } from "@/components/ui/overlays";
import { Alert, Badge, Button, Field, Input, describedBy } from "@/components/ui/primitives";
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
  if (status === "APPROVED") return <Badge tone="success">Approved</Badge>;
  if (status === "PENDING" || status === "IN_APPEAL") return <Badge tone="warning">In review</Badge>;
  if (status === "REJECTED") return <Badge tone="danger">Rejected</Badge>;
  if (status === "PAUSED" || status === "DISABLED") return <Badge tone="danger">{status === "PAUSED" ? "Paused" : "Disabled"}</Badge>;
  return <Badge>Not submitted</Badge>;
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

function loadFacebookSdk(appId: string): Promise<FacebookSdk> {
  return new Promise((resolve, reject) => {
    if (window.FB) return resolve(window.FB);
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, autoLogAppEvents: true, xfbml: true, version: "v21.0" });
      resolve(window.FB!);
    };
    const el = document.createElement("script");
    el.src = "https://connect.facebook.net/en_US/sdk.js";
    el.async = true;
    el.onerror = () => reject(new Error("Could not load the WhatsApp sign-up window. Check your connection or ad blocker."));
    document.body.appendChild(el);
  });
}

/**
 * "Connect your WhatsApp number". Meta Embedded Signup when the platform is a configured Meta Tech Provider,
 * otherwise (or additionally) by entering the account ids and a permanent token.
 */
export function WhatsAppConnect({ connection, embedded }: { connection: WhatsAppView | null; embedded: { appId: string; configId: string } | null }) {
  const api = useApi();
  const toast = useToast();
  const router = useRouter();
  const [manual, setManual] = useState(false);
  const [waba, setWaba] = useState("");
  const [phoneId, setPhoneId] = useState("");
  const [token, setToken] = useState("");
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [busy, setBusy] = useState<"manual" | "embedded" | "refresh" | null>(null);
  const [confirm, setConfirm] = useState(false);
  const session = useRef<{ wabaId?: string; phoneNumberId?: string }>({});

  // Embedded Signup reports the new account's ids in a window message, separately from the login code.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (typeof e.origin !== "string" || !/^https:\/\/([a-z0-9-]+\.)?facebook\.com$/.test(e.origin)) return;
      try {
        const data = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
        if (data?.type === "WA_EMBEDDED_SIGNUP" && data.event === "FINISH") {
          session.current = { wabaId: String(data.data?.waba_id ?? ""), phoneNumberId: String(data.data?.phone_number_id ?? "") };
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
    const r = await api<{ details?: { fieldErrors?: Record<string, string[]> } }>("/api/dashboard/whatsapp", {
      method: "POST",
      body: { action: "connect-manual", wabaId: waba, phoneNumberId: phoneId, accessToken: token },
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
    toast("WhatsApp connected. We submitted your message templates to Meta for approval.");
    router.refresh();
  }

  async function startEmbedded() {
    if (!embedded) return;
    setBusy("embedded");
    session.current = {};
    try {
      const FB = await loadFacebookSdk(embedded.appId);
      FB.login(
        async (resp) => {
          const code = resp.authResponse?.code;
          if (!code) {
            setBusy(null);
            return toast("WhatsApp sign-up was cancelled.", "error");
          }
          // The ids arrive in a separate message a moment after the code.
          for (let i = 0; i < 30 && !(session.current.wabaId && session.current.phoneNumberId); i++) await new Promise((r) => setTimeout(r, 500));
          const { wabaId, phoneNumberId } = session.current;
          if (!wabaId || !phoneNumberId) {
            setBusy(null);
            return toast("WhatsApp did not finish creating your account. Please try again.", "error");
          }
          const r = await api("/api/dashboard/whatsapp", { method: "POST", body: { action: "connect-embedded", code, wabaId, phoneNumberId } });
          setBusy(null);
          if (!r.ok) return toast(r.data.error ?? "Could not connect WhatsApp.", "error");
          toast("WhatsApp connected. We submitted your message templates to Meta for approval.");
          router.refresh();
        },
        { config_id: embedded.configId, response_type: "code", override_default_response_type: true, extras: { setup: {}, featureType: "", sessionInfoVersion: "3" } },
      );
    } catch (e) {
      setBusy(null);
      toast((e as Error).message, "error");
    }
  }

  async function refresh() {
    setBusy("refresh");
    const r = await api<{ submitted?: string[] }>("/api/dashboard/whatsapp", { method: "POST", body: { action: "refresh" } });
    setBusy(null);
    if (!r.ok) return toast(r.data.error ?? "Could not refresh.", "error");
    toast(r.data.submitted?.length ? `Submitted ${r.data.submitted.length} template(s) to Meta.` : "Template statuses are up to date.");
    router.refresh();
  }

  if (connection) {
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
            {connection.status === "ERROR" ? <Badge tone="danger">Reconnect needed</Badge> : connection.ready ? <Badge tone="success">Ready</Badge> : <Badge tone="warning">Waiting for template approval</Badge>}
            <Button size="sm" variant="danger" onClick={() => setConfirm(true)}>
              Disconnect
            </Button>
          </div>
        </div>
        {connection.status === "ERROR" && (
          <Alert tone="danger" title="WhatsApp stopped accepting the connection">
            {connection.lastError} Customer messages go out by SMS until you reconnect. Disconnect, then connect again.
          </Alert>
        )}
        {connection.status === "ACTIVE" && connection.lastError && <Alert tone="warning">{connection.lastError}</Alert>}
        {!connection.ready && connection.status === "ACTIVE" && (
          <Alert tone="info">
            Meta reviews each message template, usually within minutes to a day. Until every one is approved, customers get their
            messages by SMS instead.
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
          title="Disconnect WhatsApp?"
          description="Customer messages will go out by SMS only. Your WhatsApp Business account and templates stay with Meta."
          confirmLabel="Disconnect"
          onConfirm={async () => {
            const r = await api("/api/dashboard/whatsapp", { method: "DELETE" });
            setConfirm(false);
            if (!r.ok) return toast(r.data.error ?? "Could not disconnect.", "error");
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
            Not connected <Badge tone="warning">Required to message by WhatsApp</Badge>
          </p>
          <p className="subtle">
            Connect your own WhatsApp Business number so confirmations and reminders reach customers from you. Without it, they
            are sent by SMS.
          </p>
        </div>
      </div>
      <div className="row">
        {embedded && (
          <Button variant="primary" onClick={startEmbedded} loading={busy === "embedded"}>
            Connect with WhatsApp
          </Button>
        )}
        <Button onClick={() => setManual((v) => !v)} aria-expanded={manual}>
          {embedded ? "Enter details manually" : "Connect my WhatsApp number"}
        </Button>
      </div>
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
          <div className="form-actions">
            <Button type="submit" variant="primary" loading={busy === "manual"}>
              Connect and submit templates
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
