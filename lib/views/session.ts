import type { AdminContext, MfaGate } from "@/lib/admin/session";
import type { AuthContext } from "@/lib/auth/session";

/**
 * The two session-check payloads (GET /api/auth/session and GET /api/admin/session). Shared with the SPA through
 * `import type` (erased at build time). Hand-picked fields only: no ids, no tokens (doc/10 section 2.2 and 2.8).
 */

export type SessionView =
  | { authenticated: false }
  | {
      authenticated: true;
      user: { email: string; emailVerified: boolean; name: string; slug: string; onboarded: boolean };
    };

export function toSessionView(auth: AuthContext | null): SessionView {
  if (!auth) return { authenticated: false };
  return {
    authenticated: true,
    user: {
      email: auth.email,
      emailVerified: auth.emailVerified,
      name: auth.influencerName,
      slug: auth.influencerSlug,
      onboarded: auth.onboarded,
    },
  };
}

/** `gate` is the two-factor state: "ok", "enroll" (2FA is required but not set up), or "verify" (password-only session). */
export type AdminSessionView =
  | { authenticated: false }
  | { authenticated: true; admin: { name: string; email: string }; gate: MfaGate };

export function toAdminSessionView(admin: AdminContext | null, gate: MfaGate): AdminSessionView {
  if (!admin) return { authenticated: false };
  return { authenticated: true, admin: { name: admin.name, email: admin.email }, gate };
}
