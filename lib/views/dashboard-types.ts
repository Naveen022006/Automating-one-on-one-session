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
  googleOutcome: string | null;
  whatsapp: WhatsAppView | null;
  embedded: { appId: string; configId: string; graphVersion?: string; sdkUrl?: string } | null;
  payout: PayoutAccountData | null;
  /** What still stands between this page and going live, and what is merely recommended. */
  checklist: { key: string; label: string; done: boolean; required: boolean }[];
  publicUrl: string;
  email: string;
  emailVerified: boolean;
}
