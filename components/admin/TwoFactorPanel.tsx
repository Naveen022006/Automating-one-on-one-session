"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useToast } from "@/components/ui/overlays";
import { Alert, Badge, Button, Field, Input } from "@/components/ui/primitives";

type Reply = { ok: boolean; data: { error?: string; secret?: string; uri?: string; recoveryCodes?: string[] } };

async function post(body: unknown): Promise<Reply> {
  const res = await fetch("/api/admin/security/2fa", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { ok: res.ok, data: await res.json().catch(() => ({})) };
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function groups(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

/** The one-time list of recovery codes, with copy and download. The caller decides what "done" does. */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const toast = useToast();
  const [saved, setSaved] = useState(false);
  const text = codes.join("\n");

  function download() {
    const url = URL.createObjectURL(new Blob([`Admin console recovery codes (each works once)\n\n${text}\n`], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "admin-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="stack">
      <Alert tone="warning" title="Save these recovery codes now">
        Each code works once if you lose your authenticator. They are shown only this one time and cannot be shown again; store them somewhere safe, such as a password manager.
      </Alert>
      <ul className="money" style={{ columns: 2, listStyle: "none", padding: 0, margin: 0 }} aria-label="Recovery codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="row">
        <Button size="sm" onClick={async () => toast((await copy(text)) ? "Recovery codes copied." : "Could not copy. Select the codes and copy them by hand.", "success")}>
          Copy codes
        </Button>
        <Button size="sm" onClick={download}>
          Download .txt
        </Button>
      </div>
      <label className="row row--nowrap" style={{ gap: 8 }}>
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I have saved these codes
      </label>
      <div className="form-actions">
        <Button variant="primary" disabled={!saved} onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

/** A "type a fresh code to confirm" form used by regenerate and disable. */
function CodeConfirm({ label, help, cta, danger, busy, error, onSubmit }: { label: string; help: string; cta: string; danger?: boolean; busy: boolean; error?: string; onSubmit: (code: string) => void }) {
  const [code, setCode] = useState("");
  return (
    <form
      className="stack"
      style={{ maxWidth: 420 }}
      onSubmit={(e: React.FormEvent) => {
        e.preventDefault();
        onSubmit(code);
        setCode("");
      }}
    >
      <Field id={`code-${cta}`} label={label} help={help} error={error}>
        <Input id={`code-${cta}`} inputMode="numeric" autoComplete="one-time-code" spellCheck={false} required maxLength={20} value={code} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCode(e.target.value)} />
      </Field>
      <div className="form-actions">
        <Button type="submit" variant={danger ? "danger-solid" : "secondary"} loading={busy}>
          {cta}
        </Button>
      </div>
    </form>
  );
}

export function TwoFactorPanel({ enabled, recoveryCodesLeft, required }: { enabled: boolean; recoveryCodesLeft: number; required: boolean }) {
  const toast = useToast();
  const router = useRouter();
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"setup" | "enable" | "regenerate" | "disable" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  async function start() {
    setBusy("setup");
    setError(null);
    const r = await post({ action: "setup" });
    setBusy(null);
    if (!r.ok || !r.data.secret || !r.data.uri) return setError(r.data.error ?? "Could not start the setup.");
    setSetup({ secret: r.data.secret, uri: r.data.uri });
  }

  async function enable(e: React.FormEvent) {
    e.preventDefault();
    setBusy("enable");
    setError(null);
    const r = await post({ action: "enable", code });
    setBusy(null);
    if (!r.ok || !r.data.recoveryCodes) {
      setCode("");
      return setError(r.data.error ?? "Could not turn on two-factor authentication.");
    }
    setSetup(null);
    setCode("");
    setCodes(r.data.recoveryCodes);
    toast("Two-factor authentication is on.");
  }

  async function confirm(action: "regenerate" | "disable", typed: string) {
    setBusy(action);
    setError(null);
    const r = await post({ action, code: typed });
    setBusy(null);
    if (!r.ok) return setError(r.data.error ?? "Could not complete that.");
    if (action === "regenerate" && r.data.recoveryCodes) {
      setCodes(r.data.recoveryCodes);
      return;
    }
    toast("Two-factor authentication is off.");
    router.refresh();
  }

  if (codes) {
    return (
      <RecoveryCodes
        codes={codes}
        onDone={() => {
          setCodes(null);
          router.refresh();
        }}
      />
    );
  }

  if (enabled) {
    return (
      <div className="stack stack--lg">
        <div className="row">
          <Badge tone="success">On</Badge>
          <span className="muted">
            {recoveryCodesLeft} recovery code{recoveryCodesLeft === 1 ? "" : "s"} left.
          </span>
        </div>
        {recoveryCodesLeft <= 2 && <Alert tone="warning">You are running low on recovery codes. Generate a new set below.</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="stack">
          <h3 className="card__title">New recovery codes</h3>
          <p className="muted">Replaces all your current recovery codes. Enter a fresh code from your authenticator app to confirm; a code can be used only once, so wait for the next one if you just signed in.</p>
          <CodeConfirm label="Authentication code" help="6 digits from your authenticator app." cta="Generate new codes" busy={busy === "regenerate"} onSubmit={(c) => confirm("regenerate", c)} />
        </div>
        <div className="stack">
          <h3 className="card__title">Turn off two-factor authentication</h3>
          <p className="muted">
            {required ? "Two-factor is required here, so you will have to set it up again before you can use the console." : "Anyone with your password could then sign in."} Enter a fresh code
            to confirm.
          </p>
          <CodeConfirm label="Authentication code" help="6 digits from your authenticator app, or a recovery code." cta="Turn off" danger busy={busy === "disable"} onSubmit={(c) => confirm("disable", c)} />
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row">
        <Badge tone={required ? "danger" : "neutral"}>Off</Badge>
        <span className="muted">Add a second step at sign-in with an authenticator app (Google Authenticator, Authy, 1Password and similar).</span>
      </div>
      {required && <Alert tone="warning">Two-factor authentication is required. Set it up to use the rest of the admin console.</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
      {!setup ? (
        <div className="form-actions">
          <Button variant="primary" onClick={start} loading={busy === "setup"}>
            Set up two-factor authentication
          </Button>
        </div>
      ) : (
        <form className="stack" onSubmit={enable} style={{ maxWidth: 560 }}>
          <ol className="stack" style={{ paddingLeft: 20, margin: 0 }}>
            <li>
              In your authenticator app, add an account and enter this key (time-based, 6 digits):
              <div className="money" style={{ margin: "8px 0", userSelect: "all" }} data-testid="totp-secret">
                {groups(setup.secret)}
              </div>
              <Button size="sm" onClick={async () => toast((await copy(setup.secret)) ? "Key copied." : "Could not copy the key.")}>
                Copy key
              </Button>
            </li>
            <li>
              Or open this link on a device with an authenticator app:
              <Field id="totp-uri" label="Setup link (otpauth)" help="Contains your secret key. Do not share it.">
                <Input id="totp-uri" readOnly value={setup.uri} onFocus={(e: React.FocusEvent<HTMLInputElement>) => e.currentTarget.select()} />
              </Field>
              <Button size="sm" onClick={async () => toast((await copy(setup.uri)) ? "Link copied." : "Could not copy the link.")}>
                Copy link
              </Button>
            </li>
            <li>
              Enter the 6-digit code the app shows now:
              <Field id="totp-code" label="Authentication code">
                <Input id="totp-code" inputMode="numeric" autoComplete="one-time-code" spellCheck={false} required maxLength={10} value={code} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCode(e.target.value)} />
              </Field>
            </li>
          </ol>
          <div className="form-actions">
            <Button onClick={() => setSetup(null)} disabled={busy === "enable"}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy === "enable"}>
              Turn on
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
