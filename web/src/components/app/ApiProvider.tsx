/**
 * Client API helper for the logged-in app. Sends JSON, and handles the two auth outcomes centrally:
 *  - 401 `{ reauth: true }` (sensitive action, password older than 8 hours): asks for the password in a dialog,
 *    confirms it with /api/auth/reauth, then retries the original request once.
 *  - 401 otherwise (session gone): sends the user to /login and back.
 */
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Dialog } from "@web/components/ui/overlays";
import { Button, Field, Input, describedBy } from "@web/components/ui/primitives";

export interface ApiResult<T = Record<string, unknown>> {
  ok: boolean;
  status: number;
  data: T & { error?: string; warning?: string | null; field?: string };
}

type ApiFn = <T = Record<string, unknown>>(url: string, init?: { method?: string; body?: unknown }) => Promise<ApiResult<T>>;

async function send(url: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(url, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 429 && !data.error) data.error = "Too many requests. Please wait a moment.";
  return { res, data };
}

const ApiContext = createContext<ApiFn | null>(null);

export function ApiProvider({ children }: { children: ReactNode }) {
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<((ok: boolean) => void) | null>(null);

  const askPassword = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        pending.current = resolve;
        setPassword("");
        setError(null);
        setAsking(true);
      }),
    [],
  );

  const api = useCallback<ApiFn>(
    async (url, init = {}) => {
      let { res, data } = await send(url, init);
      if (res.status === 401 && data.reauth) {
        if (await askPassword()) ({ res, data } = await send(url, init));
      } else if (res.status === 401) {
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
      }
      return { ok: res.ok, status: res.status, data };
    },
    [askPassword],
  );

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { res, data } = await send("/api/auth/reauth", { body: { password } });
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "That password is not correct.");
      return;
    }
    setAsking(false);
    pending.current?.(true);
    pending.current = null;
  }

  function cancel() {
    setAsking(false);
    pending.current?.(false);
    pending.current = null;
  }

  return (
    <ApiContext.Provider value={api}>
      {children}
      <Dialog
        open={asking}
        onClose={cancel}
        title="Confirm your password"
        description="For your security, sensitive actions need your password if you signed in more than 8 hours ago."
      >
        <form onSubmit={confirm} className="stack">
          <Field id="reauth-password" label="Password" error={error}>
            <Input
              {...describedBy("reauth-password", { error })}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
              required
              autoFocus
            />
          </Field>
          <div className="form-actions">
            <Button onClick={cancel} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              Confirm
            </Button>
          </div>
        </form>
      </Dialog>
    </ApiContext.Provider>
  );
}

export function useApi(): ApiFn {
  const api = useContext<ApiFn | null>(ApiContext);
  if (api) return api;
  // Outside the provider (public pages): plain fetch without the reauth dialog.
  return (async (url: string, init?: { method?: string; body?: unknown }) => {
    const { res, data } = await send(url, init);
    return { ok: res.ok, status: res.status, data };
  }) as ApiFn;
}
