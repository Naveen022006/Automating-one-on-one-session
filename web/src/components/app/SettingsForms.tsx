import { useRouter } from "@web/lib/navigate";
import { useEffect, useState } from "react";
import { IconLogOut } from "@web/components/icons";
import { ConfirmDialog, Switch, useToast } from "@web/components/ui/overlays";
import { Alert, Avatar, Button, Field, Input, Select, Textarea, describedBy } from "@web/components/ui/primitives";
import type { ProfileData } from "@/lib/views/dashboard-types";
import { useApi } from "./ApiProvider";
import { formatDateTime } from "@/lib/india";

export function ProfileForm({ profile, onSaved, submitLabel = "Save profile" }: { profile: ProfileData; onSaved?: () => void; submitLabel?: string }) {
  const api = useApi();
  const toast = useToast();
  const router = useRouter();
  const [name, setName] = useState(profile.name);
  const [bio, setBio] = useState(profile.bio ?? "");
  const [photoUrl, setPhotoUrl] = useState(profile.photoUrl ?? "");
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const local: Record<string, string> = {};
    if (!name.trim()) local.name = "Enter your name.";
    if (photoUrl && !/^https:\/\//.test(photoUrl)) local.photoUrl = "Use an https:// link to an image.";
    setErrors(local);
    if (Object.keys(local).length) return;
    setBusy(true);
    const r = await api("/api/dashboard/profile", { method: "PATCH", body: { name, bio: bio || null, photoUrl: photoUrl || null } });
    setBusy(false);
    if (!r.ok) {
      if (r.data.field) setErrors({ [r.data.field]: r.data.error });
      return toast(r.data.error ?? "Could not save.", "error");
    }
    toast("Profile saved.");
    router.refresh();
    onSaved?.();
  }

  return (
    <form className="stack" onSubmit={save} noValidate>
      <div className="row row--nowrap" style={{ alignItems: "center" }}>
        <Avatar name={name || "?"} src={photoUrl || null} size="lg" />
        <p className="subtle">Your photo and bio appear on your public booking page.</p>
      </div>
      <div className="form-grid">
        <Field id="p-name" label="Name" error={errors.name}>
          <Input {...describedBy("p-name", { error: errors.name })} value={name} maxLength={100} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)} autoComplete="name" />
        </Field>
      </div>
      <Field id="p-photo" label="Photo link" optional error={errors.photoUrl} help="An https:// link to a square image you host (for example your Instagram or website photo).">
        <Input {...describedBy("p-photo", { error: errors.photoUrl, help: true })} type="url" value={photoUrl} maxLength={500} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPhotoUrl(e.target.value.trim())} placeholder="https://" />
      </Field>
      <Field id="p-bio" label="Short bio" optional help="Two or three sentences about who you help and how.">
        <Textarea id="p-bio" value={bio} maxLength={1000} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setBio(e.target.value)} />
      </Field>
      <div className="form-actions">
        <Button type="submit" variant="primary" loading={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

export function SlugForm({ slug, origin }: { slug: string; origin: string }) {
  const api = useApi();
  const toast = useToast();
  const router = useRouter();
  const [value, setValue] = useState(slug);
  const [status, setStatus] = useState<{ available: boolean; problem: string | null } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (value === slug || value.length < 3) return setStatus(null);
    const t = setTimeout(async () => {
      const r = await fetch(`/api/auth/slug-available?slug=${encodeURIComponent(value)}`).then((x) => x.json()).catch(() => null);
      if (r) setStatus(r);
    }, 350);
    return () => clearTimeout(t);
  }, [value, slug]);

  async function save() {
    setBusy(true);
    const r = await api("/api/dashboard/profile", { method: "PATCH", body: { slug: value } });
    setBusy(false);
    setConfirm(false);
    if (!r.ok) return toast(r.data.error ?? "Could not change the address.", "error");
    toast("Booking page address changed.");
    router.refresh();
  }

  return (
    <div className="stack">
      <Field id="slug" label="Booking page address" error={status && !status.available ? status.problem : null} help={status?.available ? "Available." : "Lowercase letters, numbers and hyphens."}>
        <div className="input-group">
          <span className="input-group__addon">{origin}/</span>
          <Input {...describedBy("slug", { error: status && !status.available, help: true })} value={value} spellCheck={false} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} />
        </div>
      </Field>
      <div className="form-actions">
        <Button variant="primary" disabled={value === slug || !status?.available} onClick={() => setConfirm(true)}>
          Change address
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={save}
        busy={busy}
        title="Change your booking page address?"
        description={`Links you shared to ${origin}/${slug} will stop working. Existing customers' manage links keep working.`}
        confirmLabel="Change address"
        cancelLabel="Keep current address"
      />
    </div>
  );
}

export function NotificationPrefs({ notifyByEmail }: { notifyByEmail: boolean }) {
  const api = useApi();
  const toast = useToast();
  const [on, setOn] = useState(notifyByEmail);
  return (
    <Switch
      checked={on}
      onChange={async (next) => {
        setOn(next);
        const r = await api("/api/dashboard/profile", { method: "PATCH", body: { notifyByEmail: next } });
        if (!r.ok) {
          setOn(!next);
          toast(r.data.error ?? "Could not save.", "error");
        } else {
          toast(next ? "Email alerts on." : "Email alerts off. Alerts still show in the dashboard.");
          window.dispatchEvent(new Event("sa:activity-changed")); // the account activity card lists the change
        }
      }}
      label="Email me when something needs attention (Google reconnect, failed messages, refunds due)"
    />
  );
}

/** Dispatched on `window` by PasswordForm after the server ended the other sessions; DeviceSessions reloads its list on it. */
export const SESSIONS_CHANGED_EVENT = "sa:sessions-changed";

export function PasswordForm() {
  const api = useApi();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [busy, setBusy] = useState(false);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    const r = await api("/api/auth/change-password", { body: { currentPassword: current, newPassword: next } });
    setBusy(false);
    if (!r.ok) {
      if (r.data.field) return setErrors({ [r.data.field]: r.data.error });
      return toast(r.data.error ?? "Could not change the password.", "error");
    }
    setCurrent("");
    setNext("");
    toast("Password changed. Other devices were signed out.");
    // The server ended every other session: the "Signed-in devices" list below must not keep showing them.
    window.dispatchEvent(new Event(SESSIONS_CHANGED_EVENT));
    // ...and the account activity card below lists the password change.
    window.dispatchEvent(new Event("sa:activity-changed"));
  }
  return (
    <form className="stack" onSubmit={save}>
      <div className="form-grid form-grid--2">
        <Field id="pw-current" label="Current password" error={errors.currentPassword}>
          <Input {...describedBy("pw-current", { error: errors.currentPassword })} type="password" autoComplete="current-password" value={current} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCurrent(e.target.value)} required />
        </Field>
        <Field id="pw-new" label="New password" error={errors.newPassword} help="At least 10 characters.">
          <Input {...describedBy("pw-new", { error: errors.newPassword, help: true })} type="password" autoComplete="new-password" value={next} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNext(e.target.value)} required />
        </Field>
      </div>
      <div className="form-actions">
        <Button type="submit" variant="primary" loading={busy} disabled={!current || !next}>
          Change password
        </Button>
      </div>
    </form>
  );
}

interface DeviceSession {
  id: string;
  createdAt: string;
  lastUsedAt: string;
  userAgent: string | null;
  ip: string | null;
  current: boolean;
}

function device(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export function DeviceSessions() {
  const api = useApi();
  const toast = useToast();
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load() {
    const r = await api<{ sessions: DeviceSession[] }>("/api/auth/sessions");
    if (r.ok) setSessions((r.data as { sessions: DeviceSession[] }).sessions);
  }
  useEffect(() => {
    void load();
    // PasswordForm announces that it ended the other sessions; read the list again.
    const reload = () => void load();
    window.addEventListener(SESSIONS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(SESSIONS_CHANGED_EVENT, reload);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="stack">
      {sessions === null ? (
        <p className="subtle">Loading…</p>
      ) : (
        <ul className="stack stack--sm" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {sessions.map((s) => (
            <li key={s.id} className="row row--between">
              <div>
                <p style={{ fontWeight: 600 }}>
                  {device(s.userAgent)} {s.current && <span className="subtle">(this device)</span>}
                </p>
                <p className="subtle">
                  Last active {formatDateTime(new Date(s.lastUsedAt), { weekday: false })}
                  {s.ip ? ` · ${s.ip}` : ""}
                </p>
              </div>
              {!s.current && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    const r = await api("/api/auth/sessions", { method: "DELETE", body: { sessionId: s.id } });
                    if (!r.ok) {
                      // A device that is already gone (signed out from elsewhere, or by a password change) is not listed any more.
                      void load();
                      return toast(r.status === 404 ? "That device was already signed out." : (r.data.error ?? "Could not sign out that device."), r.status === 404 ? "success" : "error");
                    }
                    toast("Device signed out.");
                    void load();
                  }}
                >
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button variant="danger" onClick={() => setConfirmAll(true)}>
          <IconLogOut size={16} /> Log out everywhere
        </Button>
      </div>
      <ConfirmDialog
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        danger
        busy={busy}
        title="Log out on every device?"
        description="You will be signed out here too and need to log in again."
        confirmLabel="Log out everywhere"
        onConfirm={async () => {
          setBusy(true);
          const r = await api("/api/auth/logout-all", { body: {} });
          setBusy(false);
          if (!r.ok) return toast(r.data.error ?? "Could not log out everywhere.", "error");
          window.location.assign("/login");
        }}
      />
    </div>
  );
}

export function VerifyBanner({ email }: { email: string }) {
  const [state, setState] = useState<"idle" | "sent" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Alert
      tone="warning"
      title="Confirm your email"
      action={
        state === "sent" ? (
          <span className="text-sm">Sent</span>
        ) : (
          <Button
            size="sm"
            onClick={async () => {
              const r = await fetch("/api/auth/resend-verification", { method: "POST" });
              const data = await r.json().catch(() => ({}));
              if (r.ok) setState("sent");
              else {
                setState("error");
                setMsg(data.error ?? "Could not send.");
              }
            }}
          >
            Resend link
          </Button>
        )
      }
    >
      We sent a link to {email}. Your booking page goes live once it is confirmed.
      {state === "error" && msg && <span className="error-text"> {msg}</span>}
    </Alert>
  );
}
