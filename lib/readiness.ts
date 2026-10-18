import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { SUPPORT_EMAIL } from "@/lib/brand";
import { GMAIL_SEND_SCOPE } from "@/lib/google";
import { TEMPLATE_STATE_NOTICE } from "@/lib/message-templates";
import { whatsappTemplateState } from "@/lib/whatsapp-connection";

/**
 * Go-live readiness: what an influencer must have connected before their booking page takes bookings and money.
 *
 *   always      verified email, one active service, weekly availability
 *   by default  Google Calendar (Meet links are created on it) and payout details (so earnings can be paid out)
 *   optional    WhatsApp (their own number) and Gmail sending. Without them customers are messaged by SMS and the
 *               platform's email address, so they are recommended rather than blocking. Set READINESS_REQUIRED to make
 *               them required, e.g. READINESS_REQUIRED=google,gmail,whatsapp,payout
 *
 * Everything here is pure except `loadReadiness`, so the rules and the matching database filter are unit-tested.
 */

export type ReadinessKey = "email" | "service" | "availability" | "google" | "gmail" | "whatsapp" | "payout" | "account";
export const CONNECTION_KEYS = ["google", "gmail", "whatsapp", "payout"] as const;
type ConnectionKey = (typeof CONNECTION_KEYS)[number];
const BASICS: ReadinessKey[] = ["email", "service", "availability"];

/**
 * Whether a blocker keeps the booking page offline. Services and weekly hours are not part of "live" (a page with
 * nothing to book simply shows nothing); the email, the required connections and the account's standing are. This is the
 * single place that rule lives: the public page, the admin list and the dashboard overview all ask it.
 */
export function isLiveBlocker(key: ReadinessKey): boolean {
  return key === "email" || key === "account" || (CONNECTION_KEYS as readonly string[]).includes(key);
}

/**
 * True when a new page needs an administrator's approval before it goes live (READINESS_REQUIRED contains "approval").
 * READINESS_BYPASS=true turns it off outside production, like the connections; it never bypasses a suspension.
 */
export function approvalRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.READINESS_BYPASS === "true" && env.NODE_ENV !== "production") return false;
  const wanted = (env.READINESS_REQUIRED ?? "google,payout").split(",").map((s) => s.trim().toLowerCase());
  return wanted.includes("approval");
}

/** Which connections are required. Basics are always required. READINESS_BYPASS=true turns the connections off outside production. */
export function requiredConnections(env: NodeJS.ProcessEnv = process.env): ConnectionKey[] {
  if (env.READINESS_BYPASS === "true" && env.NODE_ENV !== "production") return [];
  const raw = env.READINESS_REQUIRED ?? "google,payout";
  const wanted = raw.split(",").map((s) => s.trim().toLowerCase());
  return CONNECTION_KEYS.filter((k) => wanted.includes(k));
}

export interface ReadinessInput {
  emailVerified: boolean;
  activeServices: number;
  availabilityRules: number;
  google: "none" | "active" | "reconnect";
  gmailSend: boolean;
  /**
   * ready: every template approved. pending: submitted, Meta is reviewing. rejected: Meta rejected or paused one.
   * not-submitted: one never reached Meta. error: the connection itself stopped working.
   */
  whatsapp: "none" | "ready" | "pending" | "rejected" | "not-submitted" | "error";
  payout: "none" | "pending" | "verified" | "rejected";
  /** Set while the platform has suspended the account (the reason is shown to the influencer, never who did it). */
  suspended: { reason: string } | null;
  /** An administrator approved the page. Only matters while approvalRequired() is on. */
  approved: boolean;
}

/** The short badge the admin console shows for each WhatsApp state, the same states as the influencer's own checklist. */
export const WHATSAPP_BADGE: Record<ReadinessInput["whatsapp"], { label: string; tone?: "success" | "warning" | "danger" }> = {
  none: { label: "Not connected" },
  ready: { label: "Ready", tone: "success" },
  pending: { label: "Templates in review", tone: "warning" },
  rejected: { label: "Templates need fixing", tone: "danger" },
  "not-submitted": { label: "Templates not submitted", tone: "warning" },
  error: { label: "Reconnect needed", tone: "danger" },
};

export interface ReadinessItem {
  key: ReadinessKey;
  label: string;
  /** done | todo | attention (connected before but now needs action) */
  state: "done" | "todo" | "attention";
  required: boolean;
  detail: string;
  /** Where the influencer fixes it; null when there is nothing for them to do but wait (the platform's review). */
  href: string | null;
}

export interface Readiness {
  items: ReadinessItem[];
  /** Required items that are not done: why the page is not live. */
  blockers: ReadinessItem[];
  ready: boolean;
}

export function evaluateReadiness(
  input: ReadinessInput,
  required: ConnectionKey[] = requiredConnections(),
  opts: { approvalRequired: boolean } = { approvalRequired: approvalRequired() },
): Readiness {
  const req = new Set<ReadinessKey>([...BASICS, ...required]);
  const item = (key: ReadinessKey, label: string, state: ReadinessItem["state"], detail: string, href: string): ReadinessItem => ({
    key,
    label,
    state,
    required: req.has(key),
    detail,
    href,
  });

  const items: ReadinessItem[] = [
    item("email", "Confirm your email", input.emailVerified ? "done" : "todo", input.emailVerified ? "Your email is confirmed." : "Confirm your email so your page can go live. If this site sends no e-mail, an administrator confirms it for you.", "/dashboard/settings"),
    item("service", "Add a service", input.activeServices > 0 ? "done" : "todo", input.activeServices > 0 ? `${input.activeServices} active service${input.activeServices > 1 ? "s" : ""}.` : "Add at least one service customers can book.", "/dashboard/services"),
    item("availability", "Set your weekly hours", input.availabilityRules > 0 ? "done" : "todo", input.availabilityRules > 0 ? "Your weekly hours are set." : "Add the times you are available.", "/dashboard/availability"),
    item(
      "google",
      "Connect Google Calendar",
      input.google === "active" ? "done" : input.google === "reconnect" ? "attention" : "todo",
      input.google === "active" ? "Meet links are created on your calendar." : input.google === "reconnect" ? "Google stopped accepting the connection. Reconnect to keep creating Meet links." : "Create your own Google client, save it, then connect Google Calendar. Meet links are created on your own calendar.",
      "/dashboard/settings#google",
    ),
    item(
      "gmail",
      "Send customer emails from your Gmail",
      input.gmailSend && input.google === "active" ? "done" : "todo",
      input.gmailSend && input.google === "active" ? "Confirmations come from your own address." : "Allow it when you connect Google. Without it customers are messaged by WhatsApp or SMS and may get no e-mail at all.",
      "/dashboard/settings#google",
    ),
    item(
      "whatsapp",
      "Connect your WhatsApp number",
      input.whatsapp === "ready" || input.whatsapp === "pending" ? "done" : input.whatsapp === "none" ? "todo" : "attention",
      input.whatsapp === "ready"
        ? "Customers are messaged from your number."
        : input.whatsapp === "pending" || input.whatsapp === "rejected" || input.whatsapp === "not-submitted"
          ? `Connected. ${TEMPLATE_STATE_NOTICE[input.whatsapp].body}` // the same text as the settings card
          : input.whatsapp === "error"
            ? "WhatsApp stopped accepting the connection. Reconnect it."
            : "Message customers from your own WhatsApp number. Without it they get SMS.",
      "/dashboard/settings#whatsapp",
    ),
    item(
      "payout",
      "Add your payout details",
      input.payout === "pending" || input.payout === "verified" ? "done" : input.payout === "rejected" ? "attention" : "todo",
      input.payout === "verified" ? "Verified. You can be paid out." : input.payout === "pending" ? "Added. We verify them before the first payout." : input.payout === "rejected" ? "We could not verify your details. Please correct them." : "Where we send your earnings.",
      "/dashboard/payouts",
    ),
  ];
  // Account standing is appended only when it applies, so a normal account sees exactly the items above. A suspension is
  // never optional and is not affected by READINESS_BYPASS.
  if (input.suspended) {
    items.push({
      key: "account",
      label: "Account in good standing",
      state: "attention",
      required: true,
      // The reason may already end with a full stop: one is enough.
      detail: `Suspended by the platform: ${input.suspended.reason.replace(/[.\s]+$/, "")}. Contact ${SUPPORT_EMAIL} to resolve it.`,
      href: "/contact",
    });
  } else if (opts.approvalRequired && !input.approved) {
    items.push({
      key: "account",
      label: "Platform review",
      state: "todo",
      required: true,
      detail: "We review new booking pages before they go live. You will get an e-mail.",
      href: null,
    });
  }
  // A connection whose templates are rejected or unsent is flagged but never blocks, exactly like one still in review:
  // buildPublicInfluencerWhere below only asks for an ACTIVE connection, and the two must agree.
  const connectedWithTemplateTrouble = input.whatsapp === "rejected" || input.whatsapp === "not-submitted";
  const blockers = items.filter((i) => i.required && i.state !== "done" && !(i.key === "whatsapp" && connectedWithTemplateTrouble));
  return { items, blockers, ready: blockers.length === 0 };
}

/**
 * The same rules as a Prisma filter, so a hold, a slot lookup or the sitemap can never include a page the dashboard
 * says is not live. Mirrors evaluateReadiness (tested to stay in sync).
 */
export function buildPublicInfluencerWhere(env: NodeJS.ProcessEnv = process.env): Prisma.InfluencerWhereInput {
  const required = requiredConnections(env);
  const and: Prisma.InfluencerWhereInput[] = [
    { onboardedAt: { not: null } },
    { OR: [{ user: { is: null } }, { user: { is: { emailVerifiedAt: { not: null } } } }] },
  ];
  and.push({ suspendedAt: null });
  if (approvalRequired(env)) and.push({ approvedAt: { not: null } });
  if (required.includes("google")) and.push({ googleToken: { is: { status: "ACTIVE" } } });
  if (required.includes("gmail")) and.push({ googleToken: { is: { status: "ACTIVE", scope: { contains: GMAIL_SEND_SCOPE } } } });
  if (required.includes("whatsapp")) and.push({ whatsappConnection: { is: { status: "ACTIVE" } } });
  if (required.includes("payout")) and.push({ payoutAccount: { is: { status: { in: ["PENDING_REVIEW", "VERIFIED"] } } } });
  return { AND: and };
}

export async function loadReadiness(influencerId: string, emailVerified: boolean): Promise<Readiness> {
  const row = await prisma.influencer.findUniqueOrThrow({
    where: { id: influencerId },
    select: {
      suspendedAt: true,
      suspendedReason: true,
      approvedAt: true,
      googleToken: { select: { status: true, scope: true } },
      payoutAccount: { select: { status: true } },
      whatsappConnection: { select: { status: true, templates: true } },
      _count: { select: { rules: true, services: { where: { active: true } } } },
    },
  });
  return evaluateReadiness(readinessInput(row, emailVerified));
}

/** Shapes the rows the dashboard, public page and admin list already load into the pure input. */
export function readinessInput(
  row: {
    suspendedAt: Date | null;
    suspendedReason: string | null;
    approvedAt: Date | null;
    googleToken: { status: string; scope: string } | null;
    payoutAccount: { status: string } | null;
    whatsappConnection: { status: string; templates: unknown } | null;
    _count: { rules: number; services: number };
  },
  emailVerified: boolean,
): ReadinessInput {
  const wa = row.whatsappConnection;
  return {
    emailVerified,
    activeServices: row._count.services,
    availabilityRules: row._count.rules,
    google: !row.googleToken ? "none" : row.googleToken.status === "ACTIVE" ? "active" : "reconnect",
    gmailSend: row.googleToken?.scope.split(/\s+/).includes(GMAIL_SEND_SCOPE) ?? false,
    whatsapp: !wa ? "none" : wa.status === "ERROR" ? "error" : whatsappTemplateState(wa.templates),
    payout: !row.payoutAccount ? "none" : row.payoutAccount.status === "VERIFIED" ? "verified" : row.payoutAccount.status === "REJECTED" ? "rejected" : "pending",
    suspended: row.suspendedAt ? { reason: row.suspendedReason ?? "No reason was recorded" } : null,
    approved: row.approvedAt != null,
  };
}
