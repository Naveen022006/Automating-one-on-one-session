import { getAdminAuth, mfaGateStatus } from "@/lib/admin/session";
import { toAdminSessionView } from "@/lib/views/session";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

/**
 * The administrator session and its two-factor gate, for the SPA's admin guards. Deliberately NOT behind
 * requireAdminApi()/requireAdminMfa(): it has to report the gate ("ok", "enroll", "verify") to a session that is not
 * allowed anywhere else, so the guard can send it to enrolment or back to sign-in. It reveals nothing but the admin's own
 * name and email and the gate. Never 401 ("nobody" is `{ authenticated: false }`).
 */
export async function GET() {
  const admin = await getAdminAuth();
  return jsonView(toAdminSessionView(admin, admin ? mfaGateStatus(admin) : "ok"));
}
