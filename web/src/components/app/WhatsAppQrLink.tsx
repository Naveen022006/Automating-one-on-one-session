import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog, useToast } from "@web/components/ui/overlays";
import { Alert, Badge, Button, Checkbox } from "@web/components/ui/primitives";
import {
  WHATSAPP_WEB_URL,
  canStartLink,
  fallbackText,
  formatCountdown,
  isStarting,
  isWhatsAppWebView,
  pollDelayMs,
  safeQrImageSrc,
  secondsLeft,
  sentTodayText,
  shouldMoveFocus,
  startRequest,
  statusAnnouncement,
  testOutcome,
} from "@web/lib/whatsapp-web-ui";
import type { Tone } from "@web/components/ui/primitives";
import type { WhatsAppWebRequest, WhatsAppWebStatus, WhatsAppWebView } from "@/lib/whatsapp-web/types";
import { useApi } from "./ApiProvider";

/**
 * "Link with a QR code (unofficial)": the optional way to send booking messages from the influencer's own WhatsApp as a linked
 * device (doc/14-whatsapp-qr-deviations.md). The screen is honest about what it is: the risk statement is shown in full, linking
 * needs a ticked consent box, and every state says where customer messages go meanwhile.
 *
 * Two parts. `WhatsAppQrPanel` only draws a view it is given (no hooks that need a provider, so every state is testable with a
 * server render). `WhatsAppQrLink` owns the state: it reads and sends commands through the dashboard endpoint, polls every 2 seconds
 * while a code is waiting to be scanned (not while the tab is hidden, and never in another state), and moves focus when the state changes.
 */

type Busy = "start" | "cancel" | "disconnect" | "test" | null;

const STATUS_BADGE: Record<WhatsAppWebStatus, { label: string; tone: Tone }> = {
  "not-linked": { label: "Not linked", tone: "neutral" },
  "waiting-for-scan": { label: "Waiting for scan", tone: "info" },
  linked: { label: "Linked", tone: "success" },
  reconnecting: { label: "Reconnecting", tone: "warning" },
  suspended: { label: "Paused", tone: "danger" },
  "logged-out": { label: "Device removed", tone: "warning" },
};

export const QR_HEADING_ID = "wa-qr-heading";
const ERROR_ID = "wa-qr-error";
const HINT_ID = "wa-qr-consent-hint";

export interface WhatsAppQrPanelProps {
  view: WhatsAppWebView;
  /** "Show QR code" was pressed and the worker has not produced the first code yet. */
  starting: boolean;
  /** The current time, for the countdown (a prop so the render is deterministic). */
  now: number;
  consent: boolean;
  onConsent: (checked: boolean) => void;
  busy: Busy;
  /** The API's own message for the last command that failed, shown next to the buttons. */
  error: string | null;
  /** A positive result worth saying (the test message was queued). */
  notice: string | null;
  /** The last status refresh failed (the screen shows the last known state). */
  refreshFailed: boolean;
  confirmDisconnect: boolean;
  onConfirmDisconnect: (open: boolean) => void;
  onStart: () => void;
  onCancel: () => void;
  onDisconnect: () => void;
  onTest: () => void;
}

const STEPS = [
  "Open WhatsApp on the phone that has the number you want customers to receive messages from.",
  "Tap Settings, then Linked devices, then Link a device.",
  "Point the phone's camera at the code on this page.",
];

function ConsentBlock({ p, actionLabel }: { p: WhatsAppQrPanelProps; actionLabel: string }) {
  const { view, consent, busy } = p;
  const describedBy = [consent ? null : HINT_ID, p.error ? ERROR_ID : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="stack">
      <Alert tone="warning" title="Read this before you link your number">
        {view.riskText}
      </Alert>
      <Checkbox
        id="wa-qr-consent"
        checked={consent}
        disabled={busy !== null}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => p.onConsent(e.target.checked)}
        label="I understand the risks. WhatsApp may restrict or ban this number, and I am linking it anyway."
      />
      <div className="row">
        <Button
          variant="primary"
          onClick={p.onStart}
          loading={busy === "start"}
          disabled={!canStartLink(consent, busy !== null)}
          aria-describedby={describedBy}
        >
          {actionLabel}
        </Button>
      </div>
      {!consent && (
        <p className="subtle" id={HINT_ID}>
          Tick the box above to continue.
        </p>
      )}
    </div>
  );
}

function LinkedFacts({ view }: { view: WhatsAppWebView }) {
  return (
    <dl className="kv">
      <dt>Number</dt>
      <dd>{view.phoneMasked ?? "Not shown"}</dd>
      <dt>Device</dt>
      <dd>{view.deviceLabel ?? "Linked device"}</dd>
      <dt>Messages</dt>
      <dd>{sentTodayText(view.sentToday, view.dailyCap)}</dd>
    </dl>
  );
}

function QrImage({ view, starting, now }: { view: WhatsAppWebView; starting: boolean; now: number }) {
  const src = safeQrImageSrc(view.qrSvg);
  const left = secondsLeft(view.qrExpiresAt, now);
  return (
    <div className="stack stack--sm">
      <div className="qr-frame">
        {src ? (
          // A data: URL in an <img>: the browser draws it as a picture and runs nothing from it. The text of the code is never on the page.
          <img src={src} alt="QR code to link WhatsApp. Scan it with your phone." />
        ) : view.qrSvg ? (
          <p className="qr-frame__empty">The code could not be shown. Cancel and try again.</p>
        ) : (
          <p className="qr-frame__empty">{starting || view.status === "waiting-for-scan" ? "Getting your code ready..." : "No code yet."}</p>
        )}
      </div>
      {src && left !== null && (
        <p className="subtle">{left > 0 ? <>This code refreshes in <strong>{formatCountdown(left)}</strong>.</> : "Getting a new code..."}</p>
      )}
    </div>
  );
}

/** Draws one state of the screen. All behaviour comes in through props. */
export function WhatsAppQrPanel(p: WhatsAppQrPanelProps) {
  const { view, starting } = p;
  const badge = STATUS_BADGE[view.status];
  const fallback = fallbackText(view.officialConnected);
  const waiting = view.status === "waiting-for-scan" || (view.status === "not-linked" && starting);
  const showError = view.lastError && view.status !== "suspended" && view.status !== "logged-out";

  return (
    <div className="stack" data-wa-state={view.status}>
      {/* The one live region of the panel: it changes only when the situation changes (never for the countdown). */}
      <p className="sr-only" role="status" aria-live="polite" id="wa-qr-live">
        {statusAnnouncement(view, starting)}
      </p>

      <div className="row row--between">
        <h3 id={QR_HEADING_ID} tabIndex={-1} style={{ fontSize: "var(--text-md)", margin: 0 }}>
          Link with a QR code <Badge tone="warning">Unofficial</Badge>
        </h3>
        <div className="row">
          {view.fake && <Badge tone="info">Test mode: no real WhatsApp is used</Badge>}
          <Badge tone={waiting && view.status === "not-linked" ? "info" : badge.tone}>{waiting && view.status === "not-linked" ? "Starting" : badge.label}</Badge>
        </div>
      </div>

      {p.error && (
        <div id={ERROR_ID}>
          <Alert tone="danger">{p.error}</Alert>
        </div>
      )}
      {p.refreshFailed && <Alert tone="warning">We could not refresh the status just now. We will keep trying; what you see may be out of date.</Alert>}
      {p.notice && <Alert tone="success">{p.notice}</Alert>}
      {showError && view.lastError && <Alert tone="warning">{view.lastError.text}</Alert>}

      {view.status === "not-linked" && !starting && (
        <>
          <p>
            Link your own WhatsApp number as a linked device, the way WhatsApp Web works, and booking messages go out from it. This is not an official
            WhatsApp service.
          </p>
          <ConsentBlock p={p} actionLabel="Show QR code" />
        </>
      )}

      {waiting && (
        <div className="qr-layout">
          <QrImage view={view} starting={starting} now={p.now} />
          <div className="stack">
            <ol className="qr-steps">
              {STEPS.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <p className="subtle">
              A new code appears here by itself when this one runs out. Linking stops if nobody scans within 5 minutes.
              {view.fake && " This is a test code: it cannot be scanned."}
            </p>
            <div className="row">
              <Button onClick={p.onCancel} loading={p.busy === "cancel"}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {view.status === "linked" && (
        <>
          <LinkedFacts view={view} />
          <p className="subtle">
            Booking messages (confirmation, reminders, changes) go out from this number first, a few at a time and up to the daily limit. This is still
            an unofficial link: WhatsApp can restrict the number without notice.
          </p>
          <div className="row">
            <Button onClick={p.onTest} loading={p.busy === "test"} disabled={p.busy !== null} aria-describedby={p.error ? ERROR_ID : undefined}>
              Send a test message to my own number
            </Button>
            <Button variant="danger" onClick={() => p.onConfirmDisconnect(true)} disabled={p.busy !== null}>
              Disconnect
            </Button>
          </div>
        </>
      )}

      {view.status === "reconnecting" && (
        <>
          <Alert tone="warning" title="Reconnecting to WhatsApp">
            The link to your phone was lost and we are trying to restore it. {fallback} If it does not come back, disconnect and link again.
          </Alert>
          <LinkedFacts view={view} />
          <div className="row">
            <Button variant="danger" onClick={() => p.onConfirmDisconnect(true)} disabled={p.busy !== null}>
              Disconnect
            </Button>
          </div>
        </>
      )}

      {view.status === "suspended" && (
        <>
          <Alert tone="danger" title="Sending from your number is paused">
            {view.suspendedReason ?? view.lastError?.text ?? "WhatsApp or the link reported a problem."} {fallback}
          </Alert>
          <ConsentBlock p={p} actionLabel="Link again" />
          <div className="row">
            <Button variant="danger" onClick={() => p.onConfirmDisconnect(true)} disabled={p.busy !== null}>
              Disconnect and delete the saved login
            </Button>
          </div>
        </>
      )}

      {view.status === "logged-out" && (
        <>
          <Alert tone="warning" title="The linked device was removed">
            WhatsApp reports that this device was removed from your phone, so nothing is sent from it any more. {fallback}
          </Alert>
          <ConsentBlock p={p} actionLabel="Link again" />
        </>
      )}

      <p className="subtle">
        Official WhatsApp Business connection (Meta): <strong>{view.officialConnected ? "active" : "not connected"}</strong>. A number linked by QR code
        sends first; if it cannot send, messages go through the official connection when it is active, then by SMS or e-mail.
      </p>

      <ConfirmDialog
        open={p.confirmDisconnect}
        onClose={() => p.onConfirmDisconnect(false)}
        danger
        busy={p.busy === "disconnect"}
        title="Disconnect this number?"
        description={`We stop sending from it and delete the saved login. Also remove the device on your phone (WhatsApp, Settings, Linked devices). ${fallback}`}
        confirmLabel="Disconnect"
        cancelLabel="Keep it linked"
        onConfirm={p.onDisconnect}
      />
    </div>
  );
}

/** The panel with its behaviour. `initial` is the first answer of the endpoint (the mode picker already asked for it). */
export function WhatsAppQrLink({ initial }: { initial: WhatsAppWebView }) {
  const api = useApi();
  const toast = useToast();
  const apiRef = useRef(api);
  apiRef.current = api;

  const [view, setView] = useState(initial);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failures, setFailures] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [confirm, setConfirm] = useState(false);
  const seq = useRef(0);
  const box = useRef<HTMLDivElement | null>(null);

  const starting = isStarting(startedAt, view, now);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    const r = await apiRef.current<WhatsAppWebView>(WHATSAPP_WEB_URL);
    if (mine !== seq.current) return; // a command was sent meanwhile; its answer is newer
    if (!r.ok || !isWhatsAppWebView(r.data)) {
      setFailures((n) => n + 1);
      return;
    }
    setFailures(0);
    setView(r.data);
  }, []);

  // Polling: every 2 s while a code waits to be scanned (or the first one is being made), slowly while reconnecting, never otherwise
  // and never in a hidden tab. Each answer replaces `view`, which re-arms the timer; a failure backs off.
  useEffect(() => {
    const delay = pollDelayMs({ status: view.enabled ? view.status : null, starting, hidden, failures });
    if (delay === null) return;
    const t = setTimeout(() => void refresh(), delay);
    return () => clearTimeout(t);
  }, [view, starting, hidden, failures, refresh]);

  useEffect(() => {
    const onVisibility = () => {
      const h = document.visibilityState === "hidden";
      setHidden(h);
      if (!h) void refresh(); // back on the tab: do not wait for the next tick
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refresh]);

  // The clock for the countdown and for the "still starting" timeout; stopped when nothing needs it.
  const ticking = !hidden && (view.status === "waiting-for-scan" || starting);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);

  // Focus: when the state changes, the heading of the panel gets it, unless the person is working somewhere else on the page.
  const shown = `${view.status}:${starting}`;
  const previous = useRef(shown);
  useEffect(() => {
    if (previous.current === shown) return;
    previous.current = shown;
    const active = document.activeElement;
    if (shouldMoveFocus(!!active && !!box.current?.contains(active), !active || active === document.body)) {
      document.getElementById("wa-qr-heading")?.focus();
    }
  }, [shown]);

  const later = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (later.current && clearTimeout(later.current)), []);

  async function send(body: WhatsAppWebRequest, key: Exclude<Busy, null>, failure: string): Promise<{ answer: unknown } | null> {
    setBusy(key);
    setError(null);
    setNotice(null);
    seq.current++;
    const r = await apiRef.current<WhatsAppWebView>(WHATSAPP_WEB_URL, { method: "POST", body });
    seq.current++;
    setBusy(null);
    if (!r.ok) {
      setError(r.data.error ?? failure);
      return null;
    }
    if (isWhatsAppWebView(r.data)) setView(r.data);
    else void refresh();
    return { answer: r.data };
  }

  async function start() {
    const body = startRequest(view, consent);
    if (!body) return;
    if (await send(body, "start", "Could not start linking. Please try again.")) {
      setConsent(false);
      setStartedAt(Date.now());
    }
  }

  async function test() {
    const r = await send({ action: "test" }, "test", "Could not send the test message.");
    if (!r) return;
    const outcome = testOutcome(r.answer);
    if (outcome.ok) setNotice(outcome.text);
    else setError(outcome.text);
    later.current = setTimeout(() => void refresh(), 3000); // the count of messages sent today
  }

  async function disconnect() {
    const ok = (await send({ action: "disconnect" }, "disconnect", "Could not disconnect.")) !== null;
    setConfirm(false);
    if (ok) {
      setStartedAt(null);
      toast("Disconnected. Also remove the device on your phone (WhatsApp, Settings, Linked devices).");
    }
  }

  if (!view.enabled) {
    return <Alert tone="info">Linking WhatsApp by QR code is switched off on this platform right now.</Alert>;
  }

  return (
    <div ref={box}>
      <WhatsAppQrPanel
        view={view}
        starting={starting}
        now={now}
        consent={consent}
        onConsent={setConsent}
        busy={busy}
        error={error}
        notice={notice}
        refreshFailed={failures > 0}
        confirmDisconnect={confirm}
        onConfirmDisconnect={setConfirm}
        onStart={() => void start()}
        onCancel={() => void send({ action: "cancel" }, "cancel", "Could not cancel.").then(() => setStartedAt(null))}
        onDisconnect={() => void disconnect()}
        onTest={() => void test()}
      />
    </div>
  );
}
