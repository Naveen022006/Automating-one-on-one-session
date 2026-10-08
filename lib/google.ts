/**
 * Minimal Google OAuth + Calendar client over plain fetch (no googleapis dependency).
 *
 * Errors are classified because the create-meeting job reacts to each differently:
 *  - GoogleReconnectError: the influencer's grant is dead. Do not retry; ask them to reconnect.
 *  - GoogleTransientError: rate limit, 5xx, network, misconfiguration. Retry later.
 *  - GoogleRequestError:   Google rejected this specific request. Retrying will not help.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_URL = "https://www.googleapis.com/calendar/v3";

/** Narrowest scope that allows creating/updating/deleting events (Phase 5 needs update + delete). */
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

export class GoogleReconnectError extends Error {}
export class GoogleTransientError extends Error {}
export class GoogleRequestError extends Error {}

export interface CalendarEvent {
  id: string;
  /** "confirmed" | "tentative" | "cancelled" */
  status: string;
  meetLink: string | null;
  /** Meet creation is asynchronous on Google's side: "pending" means the link is not ready yet. */
  conferenceStatus: "success" | "pending" | "failure" | "none";
}

export interface NewEvent {
  /** Caller-chosen id (5-1024 chars of a-v and 0-9). Makes the insert idempotent. */
  id: string;
  summary: string;
  description: string;
  start: Date;
  end: Date;
  attendee: { email: string; displayName: string };
  /** Dedupes the Meet creation request itself. */
  conferenceRequestId: string;
}

export interface GoogleClient {
  refreshAccessToken(refreshToken: string): Promise<string>;
  /** Resolves "exists" when an event with this id is already on the calendar. */
  insertEvent(accessToken: string, event: NewEvent): Promise<CalendarEvent | "exists">;
  getEvent(accessToken: string, eventId: string): Promise<CalendarEvent | null>;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env("GOOGLE_CLIENT_ID"),
    redirect_uri: env("GOOGLE_REDIRECT_URI"),
    response_type: "code",
    scope: CALENDAR_SCOPE,
    // offline + consent: Google only returns a refresh token on the first grant unless consent is forced.
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH_URL}?${params}`;
}

interface GoogleApiErrorBody {
  error?: string | { code?: number; message?: string; status?: string; errors?: { reason?: string }[] };
  error_description?: string;
}

async function readError(res: Response): Promise<{ reason: string; message: string }> {
  const text = await res.text().catch(() => "");
  let body: GoogleApiErrorBody = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON error body */
  }
  if (typeof body.error === "string") {
    return { reason: body.error, message: body.error_description ?? body.error };
  }
  return {
    reason: body.error?.errors?.[0]?.reason ?? body.error?.status ?? String(res.status),
    message: body.error?.message ?? (text.slice(0, 200) || `HTTP ${res.status}`),
  };
}

const RETRYABLE_403 = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "backendError"]);
// accessNotConfigured: the Calendar API is not enabled on the Cloud project. Operator-fixable, so retry/hold the booking.
const CONFIG_403 = new Set(["accessNotConfigured", "projectNotLinked"]);

function classifyCalendarError(status: number, reason: string, message: string): Error {
  const text = `Google Calendar ${status} ${reason}: ${message}`;
  if (status === 401) return new GoogleReconnectError(text);
  if (status === 403) {
    if (RETRYABLE_403.has(reason) || CONFIG_403.has(reason)) return new GoogleTransientError(text);
    if (reason === "insufficientPermissions" || /insufficient authentication scopes/i.test(message)) {
      return new GoogleReconnectError(text);
    }
    return new GoogleRequestError(text);
  }
  if (status === 429 || status >= 500 || status === 408) return new GoogleTransientError(text);
  return new GoogleRequestError(text);
}

interface RawEvent {
  id?: string;
  status?: string;
  hangoutLink?: string;
  conferenceData?: {
    createRequest?: { status?: { statusCode?: string } };
    entryPoints?: { entryPointType?: string; uri?: string }[];
  };
}

function toCalendarEvent(raw: RawEvent): CalendarEvent {
  const video = raw.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri;
  const code = raw.conferenceData?.createRequest?.status?.statusCode;
  const meetLink = raw.hangoutLink ?? video ?? null;
  return {
    id: raw.id ?? "",
    status: raw.status ?? "confirmed",
    meetLink,
    conferenceStatus: meetLink ? "success" : code === "pending" ? "pending" : code === "failure" ? "failure" : "none",
  };
}

export function createGoogleClient(fetchImpl: typeof fetch = fetch): GoogleClient {
  const call = async (url: string, init: RequestInit): Promise<Response> => {
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      throw new GoogleTransientError(`Google request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return {
    async refreshAccessToken(refreshToken) {
      const res = await call(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env("GOOGLE_CLIENT_ID"),
          client_secret: env("GOOGLE_CLIENT_SECRET"),
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      });
      if (!res.ok) {
        const { reason, message } = await readError(res);
        // invalid_grant = revoked, expired (unused 6 months / testing-mode 7 days), or password changed.
        if (reason === "invalid_grant") throw new GoogleReconnectError(`Refresh token rejected: ${message}`);
        // Anything else (invalid_client, 5xx...) is our configuration or Google being down, not the influencer.
        throw new GoogleTransientError(`Token refresh failed (${res.status} ${reason}): ${message}`);
      }
      const body = (await res.json()) as { access_token?: string };
      if (!body.access_token) throw new GoogleTransientError("Token refresh returned no access_token");
      return body.access_token;
    },

    async insertEvent(accessToken, event) {
      const res = await call(`${CALENDAR_URL}/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          id: event.id,
          summary: event.summary,
          description: event.description,
          start: { dateTime: event.start.toISOString(), timeZone: "UTC" },
          end: { dateTime: event.end.toISOString(), timeZone: "UTC" },
          attendees: [{ email: event.attendee.email, displayName: event.attendee.displayName }],
          guestsCanInviteOthers: false,
          guestsCanModify: false,
          reminders: { useDefault: true },
          conferenceData: {
            createRequest: {
              requestId: event.conferenceRequestId,
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          },
        }),
      });
      if (res.status === 409) return "exists";
      if (!res.ok) {
        const { reason, message } = await readError(res);
        throw classifyCalendarError(res.status, reason, message);
      }
      return toCalendarEvent((await res.json()) as RawEvent);
    },

    async getEvent(accessToken, eventId) {
      const res = await call(`${CALENDAR_URL}/calendars/primary/events/${encodeURIComponent(eventId)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.status === 404 || res.status === 410) return null;
      if (!res.ok) {
        const { reason, message } = await readError(res);
        throw classifyCalendarError(res.status, reason, message);
      }
      return toCalendarEvent((await res.json()) as RawEvent);
    },
  };
}

export const google: GoogleClient = createGoogleClient();

/** Exchanges the OAuth callback `code`. Needs a refresh token; without one the connection would die within the hour. */
export async function exchangeCode(
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ refreshToken: string; scope: string }> {
  let res: Response;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env("GOOGLE_CLIENT_ID"),
        client_secret: env("GOOGLE_CLIENT_SECRET"),
        redirect_uri: env("GOOGLE_REDIRECT_URI"),
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new GoogleTransientError(`Google request failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    const { reason, message } = await readError(res);
    throw new GoogleRequestError(`Code exchange failed (${res.status} ${reason}): ${message}`);
  }
  const body = (await res.json()) as { refresh_token?: string; scope?: string };
  if (!body.refresh_token) {
    throw new GoogleRequestError(
      "Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and connect again.",
    );
  }
  return { refreshToken: body.refresh_token, scope: body.scope ?? "" };
}
