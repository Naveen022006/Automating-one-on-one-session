import { graphVersion } from "./whatsapp-graph-version";

/**
 * The base URL of every Google and Meta call, in one place (doc/11-provider-simulator.md).
 *
 * Normally these are the real services. For local development the app can be pointed at the mock server in
 * scripts/mock-providers by setting MOCK_PROVIDERS_URL (npm run dev:mock does that for the processes it starts). That is
 * the ONLY switch: no client, job, route or component has a fake branch, they just ask this module where to send the
 * request. This module is also the only place that reads MOCK_PROVIDERS_URL (lib/env.ts checks it at start-up through
 * mockProvidersOverride), and tests/mock-providers-boundary.test.ts keeps it that way.
 *
 * The override is honoured only when ALL of these hold, and ignored (the real services are used) otherwise:
 *   - NODE_ENV is unset, "development" or "test" (anything else, including "production" and "staging", is inert);
 *   - no serverless platform marker is set (Vercel, AWS Lambda, Netlify);
 *   - APP_URL is SET and is a local address (localhost, 127.0.0.1, [::1], *.localhost): unset does not count as local;
 *   - MOCK_PROVIDERS_URL is a plain loopback origin (http://127.0.0.1:<port>, localhost or [::1]), nothing else.
 * Every check fails closed, and values are never trimmed. Nothing is cached: each call reads the environment it is given.
 */

type EnvRecord = Record<string, string | undefined>;

export const REAL_ENDPOINTS = {
  googleAuth: "https://accounts.google.com/o/oauth2/v2/auth",
  googleToken: "https://oauth2.googleapis.com/token",
  googleRevoke: "https://oauth2.googleapis.com/revoke",
  googleCalendar: "https://www.googleapis.com/calendar/v3",
  gmailSend: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
  graphOrigin: "https://graph.facebook.com",
} as const;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const LOCALHOST_NAME = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.localhost$/;

function parseUrl(raw: string | undefined): URL | null {
  // The URL parser strips surrounding spaces, but the app reads the value exactly as given: padding is a different value.
  if (!raw || raw !== raw.trim()) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** localhost, 127.0.0.1, [::1] or *.localhost, over http(s), no credentials, and not padded with whitespace. */
export function isLocalAppUrl(raw: string | undefined): boolean {
  const u = parseUrl(raw);
  if (!u || (u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return false;
  return LOCAL_HOSTS.has(u.hostname) || LOCALHOST_NAME.test(u.hostname);
}

/** http(s)://127.0.0.1|localhost|[::1][:port] with the path "/" only, no query, fragment, credentials or padding. */
export function isLoopbackMockUrl(raw: string | undefined): boolean {
  const u = parseUrl(raw);
  if (!u || (u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return false;
  if (/[?#\\]/.test(raw!) || u.pathname !== "/" || u.search || u.hash) return false;
  return LOCAL_HOSTS.has(u.hostname);
}

export type MockOverride = { active: true; origin: string } | { active: false; problem: string | null };

/** THE guard. Pure: no logging, reads only the record it is given. `problem` says why a SET variable is ignored. */
export function mockProvidersOverride(env: EnvRecord = process.env): MockOverride {
  const raw = env.MOCK_PROVIDERS_URL;
  if (raw === undefined || raw === "") return { active: false, problem: null };
  if (!(env.NODE_ENV === undefined || env.NODE_ENV === "" || env.NODE_ENV === "development" || env.NODE_ENV === "test")) {
    return { active: false, problem: "is ignored because NODE_ENV is not development or test" };
  }
  if (env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME || env.LAMBDA_TASK_ROOT || env.NETLIFY) {
    return { active: false, problem: "is ignored on a serverless platform" };
  }
  if (!isLocalAppUrl(env.APP_URL)) {
    return { active: false, problem: "is ignored because APP_URL is not set to a local address (localhost, 127.0.0.1, [::1], *.localhost)" };
  }
  if (!isLoopbackMockUrl(raw)) {
    return { active: false, problem: "is ignored: it must be http://127.0.0.1:<port> (or localhost / [::1]) with no path, query or credentials" };
  }
  return { active: true, origin: new URL(raw).origin };
}

export interface GoogleEndpoints {
  auth: string;
  token: string;
  revoke: string;
  calendar: string;
  gmailSend: string;
}

export function googleEndpoints(env: EnvRecord = process.env): GoogleEndpoints {
  const mock = mockProvidersOverride(env);
  if (!mock.active) {
    return {
      auth: REAL_ENDPOINTS.googleAuth,
      token: REAL_ENDPOINTS.googleToken,
      revoke: REAL_ENDPOINTS.googleRevoke,
      calendar: REAL_ENDPOINTS.googleCalendar,
      gmailSend: REAL_ENDPOINTS.gmailSend,
    };
  }
  const g = `${mock.origin}/google`;
  return {
    auth: `${g}/o/oauth2/v2/auth`,
    token: `${g}/token`,
    revoke: `${g}/revoke`,
    calendar: `${g}/calendar/v3`,
    gmailSend: `${g}/gmail/v1/users/me/messages/send`,
  };
}

/** The origin of the Graph API, without a version: graph.facebook.com, or the mock's /meta. */
export function graphOrigin(env: EnvRecord = process.env): string {
  const mock = mockProvidersOverride(env);
  return mock.active ? `${mock.origin}/meta` : REAL_ENDPOINTS.graphOrigin;
}

/** The base URL of every Graph call: the origin plus the configured API version. */
export function graphBase(env: EnvRecord = process.env): string {
  return `${graphOrigin(env)}/${graphVersion(env)}`;
}

/** The mock's Facebook SDK (Embedded Signup sign-up window), only while the override is active. Otherwise undefined. */
export function mockFacebookSdkUrl(env: EnvRecord = process.env): string | undefined {
  const mock = mockProvidersOverride(env);
  return mock.active ? `${mock.origin}/meta/en_US/sdk.js` : undefined;
}
