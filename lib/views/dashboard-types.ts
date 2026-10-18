import type { IntakeQuestion } from "@/lib/intake";

/**
 * The data shapes that the dashboard view functions (lib/views/dashboard-*.ts, server) and the dashboard components in
 * web/src/components/app (browser) both speak. They live here, as plain types without React, so server code never has to
 * import a component file. The browser imports them with `import type`, which is erased before bundling.
 */

/** One weekly availability window. */
export interface RuleRow {
  id: string;
  weekday: number;
  startTime: string;
  endTime: string;
  timezone: string;
}

/** One blocked day. */
export interface BlockedRow {
  id: string;
  date: string;
  reason: string | null;
}

/** The Google connection as the Settings card and the onboarding step show it. */
export type GoogleStatusView =
  | { state: "not-connected"; requestsGmail?: boolean; liveEvents?: number; previousEmail?: string | null }
  | { state: "connected"; email: string | null; connectedAt: string; gmailSend: boolean; liveEvents?: number; gmailFailing?: boolean }
  | { state: "reconnect-needed"; email: string | null; reason: string | null; liveEvents?: number };

/**
 * The influencer's Google OAuth client as the three-step Google card shows it (doc/15). Hand-picked: the client ID is not a secret,
 * the secret is only ever reported as "saved" and never leaves the server.
 */
export interface GoogleClientView {
  /** GOOGLE_CLIENT_MODE: "own" (bring your own client), "platform" (the site's shared one) or "either". */
  mode: "own" | "platform" | "either";
  hasOwnClient: boolean;
  /** The full client ID (it is not secret), or null when none is saved. */
  clientId: string | null;
  clientSecretSaved: boolean;
  /** When Google last accepted the saved pair (ISO), or null. */
  checkedAt: string | null;
  /** The exact redirect URI the influencer adds to their client, computed on the server. */
  redirectUri: string;
  /** The site origin ("Authorized JavaScript origins"), with its scheme. */
  origin: string;
  /** The OAuth scopes to put on the consent screen: Calendar, Gmail (optional), then the two identity scopes. */
  requiredScopes: string[];
  /** Whether "Connect" can start: an own client is saved, or the mode lets the shared client be used. */
  canConnect: boolean;
  /** Which client the CURRENT connection was made with, or null when not connected. */
  grantClient: "own" | "platform" | null;
}

/** The WhatsApp connection as the Settings card and the onboarding step show it (no ids, no tokens). */
export interface WhatsAppView {
  displayPhone: string | null;
  verifiedName: string | null;
  source: string;
  status: "ACTIVE" | "ERROR";
  lastError: string | null;
  templates: { name: string; status: string; reason: string | null }[];
  ready: boolean;
}

/** The profile fields the Settings form and the onboarding step edit. */
export interface ProfileData {
  name: string;
  bio: string | null;
  photoUrl: string | null;
  timezone: string;
  slug: string;
  notifyByEmail: boolean;
}

/** The payout details the form shows: masked values only. */
export interface PayoutAccountData {
  method: "BANK" | "UPI";
  accountHolderName: string;
  bankName: string | null;
  ifsc: string | null;
  accountNumber: string | null;
  upiId: string | null;
  status: "PENDING_REVIEW" | "VERIFIED" | "REJECTED";
  rejectionReason: string | null;
}

/** One service as the Services page and the onboarding step edit it. */
export interface ServiceAdmin {
  id: string;
  title: string;
  description: string | null;
  durationMin: number;
  priceMinor: number;
  currency: string;
  type: "ONE_TO_ONE" | "GROUP";
  capacity: number;
  active: boolean;
  refundPolicy: "FULL" | "NOTICE_24H" | "NONE";
  intakeQuestions: IntakeQuestion[];
  minNoticeHours: number;
  maxAdvanceDays: number;
  prepNotes: string | null;
  requiresApproval: boolean;
}

/** Everything the onboarding wizard needs. */
export interface OnboardingData {
  step: number;
  profile: ProfileData;
  services: ServiceAdmin[];
  rules: RuleRow[];
  blocked: BlockedRow[];
  google: GoogleStatusView;
  googleClient: GoogleClientView;
  googleOutcome: string | null;
  whatsapp: WhatsAppView | null;
  embedded: { appId: string; configId: string; graphVersion?: string; sdkUrl?: string } | null;
  payout: PayoutAccountData | null;
  /** What still stands between this page and going live, and what is merely recommended. */
  checklist: { key: string; label: string; done: boolean; required: boolean }[];
  publicUrl: string;
  email: string;
  emailVerified: boolean;
  /** False when the platform sends no e-mail (EMAIL_PROVIDER=none): the verify banner then says an administrator verifies accounts. */
  emailEnabled: boolean;
}
