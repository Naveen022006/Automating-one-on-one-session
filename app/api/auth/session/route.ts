import { getAuth } from "@/lib/auth/session";
import { toSessionView } from "@/lib/views/session";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

/**
 * Who is signed in, for the SPA (landing header, login/register redirects, verify-email, the onboarding guard).
 * Never 401: "nobody" is a normal answer, `{ authenticated: false }`. Only hand-picked fields leave the server (no ids,
 * no tokens). A database failure surfaces as the usual 500, so the SPA shows its error state instead of treating an
 * outage as "signed out".
 */
export async function GET() {
  return jsonView(toSessionView(await getAuth()));
}
