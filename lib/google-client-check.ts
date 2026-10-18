import { googleRedirectUri } from "@/lib/google-credentials";
import { googleEndpoints } from "@/lib/provider-endpoints";

/**
 * Checks a Google OAuth client an influencer pasted (doc/15-influencer-google-credentials.md, section C), without any user involved:
 * the pair is sent to Google's token endpoint with a deliberately invalid authorization code.
 *   invalid_client  -> Google does not know this ID/secret pair (wrong ID, wrong secret, or the two are from different clients)
 *   invalid_grant   -> Google accepted the pair and then rejected the (fake) code: the credentials are good
 * Nothing is granted, no token is issued and nobody is signed in. Plain fetch, injectable for tests.
 */

const CLIENT_ID_PATTERN = /^[0-9]+-[A-Za-z0-9_]+\.apps\.googleusercontent\.com$/;
const CLIENT_SECRET_PATTERN = /^[A-Za-z0-9_-]{20,80}$/;

/** A sentence about what is wrong with the format of the Client ID, or null. */
export function clientIdProblem(value: string): string | null {
  if (CLIENT_ID_PATTERN.test(value)) return null;
  if (value !== value.trim() || /\s/.test(value)) return "The Client ID has a space or line break in it. Copy it again without any spaces.";
  if (/^GOCSPX-/.test(value)) return "That looks like the Client Secret. The Client ID is the long one ending in .apps.googleusercontent.com.";
  return "The Client ID should look like 1234567890-abcdefg.apps.googleusercontent.com. Copy it from Google Cloud, Credentials, your OAuth client.";
}

/** A sentence about what is wrong with the format of the Client Secret (the GOCSPX- prefix is accepted), or null. */
export function clientSecretProblem(value: string): string | null {
  if (CLIENT_SECRET_PATTERN.test(value)) return null;
  if (value !== value.trim() || /\s/.test(value)) return "The Client Secret has a space or line break in it. Copy it again without any spaces.";
  if (value.endsWith(".apps.googleusercontent.com")) return "That looks like the Client ID. The Client Secret is the shorter one, usually starting with GOCSPX-.";
  return "The Client Secret should be 20 to 80 letters, digits, dashes or underscores, usually starting with GOCSPX-.";
}

export type ClientCheckFailure = "format-id" | "format-secret" | "invalid-client" | "unreachable" | "unexpected";

export type ClientCheck = { ok: true } | { ok: false; reason: ClientCheckFailure; message: string };

const bad = (reason: ClientCheckFailure, message: string): ClientCheck => ({ ok: false, reason, message });

export const INVALID_CLIENT_MESSAGE =
  "Google did not accept this Client ID and Client Secret together. Check that both come from the same OAuth client, copy them again without spaces, and that the client type is Web application.";

export async function verifyGoogleClient(
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch = fetch,
  redirectUri: string = googleRedirectUri(),
): Promise<ClientCheck> {
  const idProblem = clientIdProblem(clientId);
  if (idProblem) return bad("format-id", idProblem);
  const secretProblem = clientSecretProblem(clientSecret);
  if (secretProblem) return bad("format-secret", secretProblem);

  let res: Response;
  try {
    res = await fetchImpl(googleEndpoints().token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: "client-check-not-a-real-code",
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return bad("unreachable", "We could not reach Google to check these. Nothing was saved. Try again in a minute.");
  }

  let error = "";
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") error = body.error;
  } catch {
    /* not JSON */
  }
  if (error === "invalid_grant") return { ok: true };
  if (error === "invalid_client") return bad("invalid-client", INVALID_CLIENT_MESSAGE);
  if (res.status >= 500 || res.status === 429) return bad("unreachable", "Google is busy right now. Nothing was saved. Try again in a minute.");
  return bad("unexpected", `Google answered something we did not expect${error ? ` (${error.slice(0, 40)})` : ` (HTTP ${res.status})`}. Nothing was saved. Check the client type is Web application and try again.`);
}
