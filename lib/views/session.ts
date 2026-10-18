import type { AdminContext, MfaGate } from "@/lib/admin/session";
import type { AuthContext } from "@/lib/auth/session";
import { platformEmailEnabled } from "@/lib/email/providers";

/**
 * The two session-check payloads (GET /api/auth/session and GET /api/admin/session). Shared with the SPA through
 * `import type` (erased at build time). Hand-picked fields only: no ids, no tokens (doc/10 section 2.2 and 2.8).
 */

export type SessionView =
  | { authenticated: false; emailEnabled?: boolean }
  | {
      authenticated: true;
      user: { email: string; emailVerified: boolean; name: string; slug: string; onboarded: boolean };
      emailEnabled?: boolean;
    };

/**
 * `emailEnabled`: whether the platform sends e-mail at all (false with EMAIL_PROVIDER=none, doc/15). It decides whether a page may say
 * "we e-mailed you" (verification, password reset). The server always sets it; a client that does not find it assumes true. Only the
 * boolean is exposed, never the provider's name.
 */
export function toSessionView(auth: AuthContext | null, emailEnabled: boolean = platformEmailEnabled()): SessionView {
  if (!auth) return { authenticated: false, emailEnabled };
  return {
    authenticated: true,
    emailEnabled,
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
  | { authenticated: false; emailEnabled?: boolean }
  | { authenticated: true; admin: { name: string; email: string }; gate: MfaGate; emailEnabled?: boolean };

/** `emailEnabled` as for SessionView: the admin pages say "is e-mailed" (payouts, suspensions, security notices) only when it is true. */
export function toAdminSessionView(admin: AdminContext | null, gate: MfaGate, emailEnabled: boolean = platformEmailEnabled()): AdminSessionView {
  if (!admin) return { authenticated: false, emailEnabled };
  return { authenticated: true, admin: { name: admin.name, email: admin.email }, gate, emailEnabled };
}
