import { AppLink } from "@web/lib/link";
import { useEffect, useRef, useState } from "react";
import { IconAlertCircle, IconCheckCircle } from "@web/components/icons";
import { focusFirstInvalid } from "@web/components/ui/focus";
import { Alert, Button, Checkbox, Field, Input, describedBy } from "@web/components/ui/primitives";

type Errors = Record<string, string | undefined>;

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data } as {
    ok: boolean;
    status: number;
    data: { error?: string; field?: string; redirect?: string; message?: string; details?: { fieldErrors?: Record<string, string[]> } };
  };
}

function fieldErrors(data: { error?: string; field?: string; details?: { fieldErrors?: Record<string, string[]> } }): Errors {
  const out: Errors = {};
  for (const [k, v] of Object.entries(data.details?.fieldErrors ?? {})) out[k] = v?.[0];
  if (data.field && data.error) out[data.field] = data.error;
  return out;
}

/**
 * After a failed submit, once the error texts are rendered, put the keyboard (and a screen reader) on the first field that has one.
 * Without it the focus stays on the submit button while the message sits above the fold, which on a phone looks like "nothing
 * happened". Bump the returned counter in the same batch as the state that holds the errors: the effect then runs after they have
 * been committed to the DOM, also when the errors come from a server answer (a timer or an animation frame could run before React).
 */
function useFocusFirstInvalid() {
  const formRef = useRef<HTMLFormElement>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (tick > 0) focusFirstInvalid(formRef.current);
  }, [tick]);
  return { formRef, focusOnError: () => setTick((n) => n + 1) };
}

export function LoginForm({ next, notice }: { next?: string; notice?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await post("/api/auth/login", { email, password, next });
    if (!r.ok) {
      setBusy(false);
      setError(r.data.error ?? "Could not sign in. Please try again.");
      return;
    }
    window.location.assign(r.data.redirect ?? "/dashboard");
  }

  return (
    <form className="stack" onSubmit={submit} noValidate>
      {notice && <Alert tone="success">{notice}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
      <Field id="login-email" label="Email">
        <Input id="login-email" type="email" autoComplete="email" required value={email} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)} />
      </Field>
      <Field id="login-password" label="Password">
        <Input
          id="login-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
        />
      </Field>
      <div className="row row--between">
        <AppLink href="/forgot-password" className="text-sm">
          Forgot your password?
        </AppLink>
      </div>
      <Button type="submit" variant="primary" size="lg" block loading={busy}>
        Log in
      </Button>
    </form>
  );
}

function suggest(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function RegisterForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugStatus, setSlugStatus] = useState<{ available: boolean; problem: string | null } | null>(null);
  const [terms, setTerms] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = typeof window !== "undefined" ? window.location.host : "";
  const { formRef, focusOnError } = useFocusFirstInvalid();

  useEffect(() => {
    if (!slugTouched) setSlug(suggest(name));
  }, [name, slugTouched]);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (slug.length < 3) {
      setSlugStatus(null);
      return;
    }
    timer.current = setTimeout(async () => {
      const r = await fetch(`/api/auth/slug-available?slug=${encodeURIComponent(slug)}`).then((x) => x.json()).catch(() => null);
      if (r) setSlugStatus(r);
    }, 350);
  }, [slug]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const local: Errors = {};
    if (!name.trim()) local.name = "Enter your name.";
    if (!/^\S+@\S+\.\S+$/.test(email)) local.email = "Enter a valid email address.";
    if (password.length < 10) local.password = "Use at least 10 characters.";
    if (!terms) local.acceptTerms = "Please accept the Terms and Privacy Policy.";
    if (slugStatus && !slugStatus.available) local.slug = slugStatus.problem ?? "Choose another address.";
    setErrors(local);
    if (Object.keys(local).length) return focusOnError();
    setBusy(true);
    setFormError(null);
    const r = await post("/api/auth/register", { name, email, password, slug, acceptTerms: terms });
    if (!r.ok) {
      setBusy(false);
      const fe = fieldErrors(r.data);
      setErrors(fe);
      if (Object.keys(fe).length) focusOnError();
      else setFormError(r.data.error ?? "Could not create your account.");
      return;
    }
    window.location.assign(r.data.redirect ?? "/onboarding");
  }

  // The live "taken / reserved" answer counts as an error of the field too: the input is marked invalid and tied to the message.
  const slugError = errors.slug ?? (slugStatus && !slugStatus.available ? slugStatus.problem : null);

  return (
    <form ref={formRef} className="stack" onSubmit={submit} noValidate>
      {formError && <Alert tone="danger">{formError}</Alert>}
      <Field id="reg-name" label="Your name" error={errors.name}>
        <Input {...describedBy("reg-name", { error: errors.name })} autoComplete="name" required value={name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)} />
      </Field>
      <Field id="reg-email" label="Email" error={errors.email} help="We send a confirmation link here.">
        <Input {...describedBy("reg-email", { error: errors.email, help: true })} type="email" autoComplete="email" required value={email} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)} />
      </Field>
      <Field id="reg-password" label="Password" error={errors.password} help="At least 10 characters. Avoid common passwords.">
        <Input {...describedBy("reg-password", { error: errors.password, help: true })} type="password" autoComplete="new-password" required value={password} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)} />
      </Field>
      <Field
        id="reg-slug"
        label="Booking page address"
        error={slugError}
        help={slugStatus?.available ? "Available." : "Lowercase letters, numbers and hyphens. You can change it later."}
      >
        <div className="input-group">
          <span className="input-group__addon">{origin || "yoursite"}/</span>
          <Input
            {...describedBy("reg-slug", { error: slugError, help: true })}
            value={slug}
            autoComplete="off"
            spellCheck={false}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              setSlugTouched(true);
              setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
            }}
          />
        </div>
      </Field>
      <div>
        <Checkbox
          checked={terms}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTerms(e.target.checked)}
          aria-invalid={errors.acceptTerms ? true : undefined}
          aria-describedby={errors.acceptTerms ? "reg-terms-error" : undefined}
          label={
            <>
              I agree to the <AppLink href="/terms" target="_blank">Terms of Service</AppLink> and{" "}
              <AppLink href="/privacy" target="_blank">Privacy Policy</AppLink>.
            </>
          }
        />
        {errors.acceptTerms && (
          <p className="field__error" id="reg-terms-error" role="alert">
            <IconAlertCircle size={16} />
            {errors.acceptTerms}
          </p>
        )}
      </div>
      <Button type="submit" variant="primary" size="lg" block loading={busy}>
        Create account
      </Button>
    </form>
  );
}

export function ForgotForm() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await post("/api/auth/forgot-password", { email });
    setBusy(false);
    if (!r.ok) return setError(r.data.error ?? "Something went wrong. Please try again.");
    setSent(r.data.message ?? "If an account exists for that email, a reset link is on its way.");
  }
  if (sent) {
    return (
      <Alert tone="success" title="Check your email">
        {sent} The link works for one hour.
      </Alert>
    );
  }
  return (
    <form className="stack" onSubmit={submit}>
      {error && <Alert tone="danger">{error}</Alert>}
      <Field id="forgot-email" label="Email">
        <Input id="forgot-email" type="email" autoComplete="email" required value={email} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)} />
      </Field>
      <Button type="submit" variant="primary" size="lg" block loading={busy}>
        Send reset link
      </Button>
    </form>
  );
}

export function ResetForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setErrors({ confirm: "The passwords do not match." });
    setBusy(true);
    setErrors({});
    setFormError(null);
    const r = await post("/api/auth/reset-password", { token, password });
    if (!r.ok) {
      setBusy(false);
      const fe = fieldErrors(r.data);
      if (fe.password) setErrors(fe);
      else setFormError(r.data.error ?? "Could not reset your password.");
      return;
    }
    window.location.assign(r.data.redirect ?? "/dashboard");
  }
  return (
    <form className="stack" onSubmit={submit}>
      {formError && (
        <Alert tone="danger" action={<AppLink href="/forgot-password">Request a new link</AppLink>}>
          {formError}
        </Alert>
      )}
      <Field id="reset-password" label="New password" error={errors.password} help="At least 10 characters.">
        <Input {...describedBy("reset-password", { error: errors.password, help: true })} type="password" autoComplete="new-password" required value={password} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)} />
      </Field>
      <Field id="reset-confirm" label="Repeat new password" error={errors.confirm}>
        <Input {...describedBy("reset-confirm", { error: errors.confirm })} type="password" autoComplete="new-password" required value={confirm} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfirm(e.target.value)} />
      </Field>
      <Button type="submit" variant="primary" size="lg" block loading={busy}>
        Set new password
      </Button>
      <p className="subtle">Setting a new password signs you out on every other device.</p>
    </form>
  );
}

/** Confirms the email by POSTing the token (mail scanners that prefetch GET links cannot consume it). */
export function VerifyEmail({ token, loggedIn }: { token: string; loggedIn: boolean }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  async function verify() {
    setState("busy");
    const r = await post("/api/auth/verify-email", { token });
    if (r.ok) setState("done");
    else {
      setState("error");
      setError(r.data.error ?? "This link could not be used.");
    }
  }
  if (state === "done") {
    return (
      <div className="stack">
        <Alert tone="success" title="Email confirmed">
          Thank you. Your booking page can go live once onboarding is complete.
        </Alert>
        <Button variant="primary" size="lg" block onClick={() => window.location.assign(loggedIn ? "/dashboard" : "/login")}>
          {loggedIn ? "Continue to dashboard" : "Log in"}
        </Button>
      </div>
    );
  }
  return (
    <div className="stack">
      {state === "error" && <Alert tone="danger">{error}</Alert>}
      <p className="muted">Press the button to confirm your email address.</p>
      <Button variant="primary" size="lg" block onClick={verify} loading={state === "busy"}>
        <IconCheckCircle />
        Confirm my email
      </Button>
    </div>
  );
}

export function ResendVerification() {
  const [state, setState] = useState<"idle" | "busy" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  return (
    <span>
      {state === "sent" ? (
        <span role="status">A new link is on its way.</span>
      ) : (
        <button
          type="button"
          className="link-button"
          disabled={state === "busy"}
          onClick={async () => {
            setState("busy");
            const r = await post("/api/auth/resend-verification", {});
            if (r.ok) setState("sent");
            else {
              setState("error");
              setError(r.data.error ?? "Could not send the link.");
            }
          }}
        >
          Resend the link
        </button>
      )}
      {state === "error" && <span className="error-text"> {error}</span>}
    </span>
  );
}
