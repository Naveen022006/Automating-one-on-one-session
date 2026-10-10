import { useQuery, type QueryKey, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query";
import { appNavigate } from "./navigate";

/**
 * Fetching JSON from the Next API, and the global reaction to "you are not signed in" (doc/10-react-migration-plan.md,
 * section 2.7). All requests are same-origin and carry the cookies automatically (`credentials: "same-origin"`); the SPA
 * never reads or stores a token.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** The parsed JSON body when there was one (`{ error: string, ... }` for the API's own errors), else null. */
    readonly data: unknown,
    readonly url: string,
    message?: string,
  ) {
    super(message ?? `Request failed (${status})`);
    this.name = "ApiError";
  }

  /** The API's own `error` sentence, when it sent one. */
  get serverMessage(): string | null {
    const e = (this.data as { error?: unknown } | null)?.error;
    return typeof e === "string" ? e : null;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** GET a JSON object. Throws ApiError for every non-2xx answer, a body that is not JSON, and a network failure (status 0). */
export async function apiGet<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" }, signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, null, url, "We could not reach the server. Check your connection and try again.");
  }
  let data: unknown = null;
  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  if (isJson) data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data, url, (data as { error?: unknown } | null)?.error as string | undefined);
  if (!isJson || data === null) throw new ApiError(res.status, null, url, "The server sent an unexpected response.");
  return data as T;
}

export type ApiQueryOptions<T> = Omit<UseQueryOptions<T, ApiError, T, QueryKey>, "queryKey" | "queryFn" | "enabled"> & { enabled?: boolean };

/**
 * TanStack Query over apiGet. `key` must contain everything the URL depends on (see queryKeys in ./query.ts), so a
 * different slug/page/filter is a different cache entry. Pass `url: null` to wait (the query stays disabled).
 * Defaults (query.ts): always fresh on mount, no refetch on focus, no retry on 4xx.
 */
export function useApiQuery<T>(key: QueryKey, url: string | null, options: ApiQueryOptions<T> = {}): UseQueryResult<T, ApiError> {
  return useQuery<T, ApiError, T, QueryKey>({
    ...options,
    queryKey: key,
    queryFn: ({ signal }) => apiGet<T>(url as string, signal),
    enabled: url !== null && (options.enabled ?? true),
  });
}

/* ---------- global reaction to auth errors ---------- */

let leaving = false;

function isMfaDenied(data: unknown): data is { mfaRequired: true; mfaAction: "enroll" | "verify" } {
  const d = data as { mfaRequired?: unknown; mfaAction?: unknown } | null;
  return d?.mfaRequired === true && (d.mfaAction === "enroll" || d.mfaAction === "verify");
}

/**
 * Called by the QueryCache for EVERY failed query (see query.ts). Pure UX: the server already refused the request.
 *  - 401 from an influencer endpoint  -> full reload to /login?next=<current page>
 *  - 401 from /api/admin/*            -> full reload to /admin/login?next=<current page>
 *  - 403 { mfaRequired } from /api/admin/*: "enroll" -> client navigation to /admin/security,
 *    "verify" (a password-only session of an admin with 2FA) -> full reload to /admin/login?next=
 * A full reload (not a client route change) on sign-in is intentional: it drops the in-memory query cache, so no data of the
 * previous session can be shown to the next one. A 401 that asks for the password again (`reauth`) is a dialog concern of
 * ApiProvider, never a redirect. Never redirects away from a login page (no loops).
 */
export function handleApiAuthError(error: unknown): void {
  if (!isApiError(error) || leaving) return;
  const admin = error.url.startsWith("/api/admin/");
  const loginPath = admin ? "/admin/login" : "/login";
  const here = window.location.pathname + window.location.search;
  const toLogin = () => {
    if (window.location.pathname === loginPath) return;
    leaving = true;
    window.location.assign(`${loginPath}?next=${encodeURIComponent(here)}`);
  };
  if (error.status === 401 && (error.data as { reauth?: unknown } | null)?.reauth !== true) {
    toLogin();
  } else if (admin && error.status === 403 && isMfaDenied(error.data)) {
    if (error.data.mfaAction === "verify") toLogin();
    else if (window.location.pathname !== "/admin/security") appNavigate("/admin/security", { replace: true });
  }
}
