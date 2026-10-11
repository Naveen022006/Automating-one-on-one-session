import { useState } from "react";
import { Alert, Button, Field, Input, describedBy } from "@web/components/ui/primitives";

type Result = { ok: boolean; data: { error?: string; field?: string; redirect?: string; mfaRequired?: boolean; pendingToken?: string; restart?: boolean } };

async function post(url: string, body: unknown): Promise<Result> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { ok: res.ok, data: await res.json().catch(() => ({})) };
}

export function AdminLoginForm({ next }: { next?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Step 2 (only for administrators with two-factor on): the token proving the password was right, and the code.
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await post("/api/admin/auth/login", { email, password, next });
    if (!r.ok) {
      setBusy(false);
      setError(r.data.error ?? "Could not sign in. Please try again.");
      return;
    }
    if (r.data.mfaRequired && r.data.pendingToken) {
      setPassword("");
      setPendingToken(r.data.pendingToken);
      setBusy(false);
      return;
    }
    window.location.assign(r.data.redirect ?? "/admin");
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await post("/api/admin/auth/mfa", { pendingToken, code, next });
    if (!r.ok) {
      setBusy(false);
      setCode("");
      setError(r.data.error ?? "Could not verify the code. Please try again.");
      // The five-minute window ended (or the token is no longer valid): start again from the password.
      if (r.data.restart) setPendingToken(null);
      return;
    }
    window.location.assign(r.data.redirect ?? "/admin");
  }

  if (pendingToken) {
    return (
      <form className="stack" onSubmit={submitCode} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field
          id="admin-code"
          label={useRecovery ? "Recovery code" : "Authentication code"}
          help={useRecovery ? "One of the single-use codes you saved when you set up two-factor. Each works once." : "The 6-digit code from your authenticator app."}
        >
          <Input
            id="admin-code"
            key={useRecovery ? "recovery" : "totp"}
            type="text"
            inputMode={useRecovery ? "text" : "numeric"}
            autoComplete="one-time-code"
            autoCapitalize="none"
            spellCheck={false}
            required
            autoFocus
            maxLength={useRecovery ? 20 : 8}
            value={code}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCode(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          Verify and sign in
        </Button>
        <div className="row row--between">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setUseRecovery(!useRecovery);
              setCode("");
              setError(null);
            }}
          >
            {useRecovery ? "Use my authenticator app" : "Use a recovery code"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setPendingToken(null);
              setCode("");
              setError(null);
            }}
          >
            Back
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form className="stack" onSubmit={submit} noValidate>
      {error && <Alert tone="danger">{error}</Alert>}
      <Field id="admin-email" label="Email">
        <Input id="admin-email" type="email" autoComplete="username" required value={email} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)} />
      </Field>
      <Field id="admin-password" label="Password">
        <Input
          id="admin-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
        />
      </Field>
      <Button type="submit" variant="primary" size="lg" block loading={busy}>
        Sign in
      </Button>
    </form>
  );
}

export function AdminPasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setDone(false);
    const r = await post("/api/admin/auth/change-password", { currentPassword: current, newPassword: next });
    setBusy(false);
    if (!r.ok) {
      setErrors({ [r.data.field ?? "form"]: r.data.error ?? "Could not change the password." });
      return;
    }
    setCurrent("");
    setNext("");
    setDone(true);
  }

  return (
    <form className="stack" onSubmit={submit} noValidate style={{ maxWidth: 420 }}>
      {done && <Alert tone="success">Password changed. Other admin sessions were signed out.</Alert>}
      {errors.form && <Alert tone="danger">{errors.form}</Alert>}
      <Field id="cur-pw" label="Current password" error={errors.currentPassword}>
        <Input
          {...describedBy("cur-pw", { error: errors.currentPassword })}
          type="password"
          autoComplete="current-password"
          required
          value={current}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCurrent(e.target.value)}
        />
      </Field>
      <Field id="new-pw" label="New password" help="At least 10 characters." error={errors.newPassword}>
        <Input
          {...describedBy("new-pw", { error: errors.newPassword })}
          type="password"
          autoComplete="new-password"
          required
          value={next}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNext(e.target.value)}
        />
      </Field>
      <div className="form-actions">
        <Button type="submit" variant="primary" loading={busy}>
          Change password
        </Button>
      </div>
    </form>
  );
}
