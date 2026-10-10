import { activeAdminCount, getInfluencerDetail, listInfluencers, type InfluencerRow } from "@/lib/admin/data";
import { prisma } from "@/lib/db";
import { getPayoutAccountView, type PayoutAccountView } from "@/lib/payout-account";
import {
  BLOCKER_LABEL,
  defaultFeeBps,
  effectiveFeeBps,
  formatFeePercent,
  fourEyesEnabled,
  loadPayable,
  payoutApprovalView,
  postPayoutRefunds,
  recentUnapprovedFor,
  summariseCurrencies,
  type Blocker,
  type PayoutApprovalView,
} from "@/lib/payouts";
import { WHATSAPP_BADGE, evaluateReadiness, readinessInput, type ReadinessItem } from "@/lib/readiness";

/**
 * The admin console's Influencers list and Influencer detail pages. One function each, two callers each: the old Next
 * pages (app/admin/(console)/influencers/...) and GET /api/admin/influencers[/:id] for the SPA. The caller has already
 * passed the admin gate (`requireAdminPage` / `requireAdminMfa()`).
 *
 * Both are built field by field from what the pages render. Never in here: password hashes, session or token columns,
 * encrypted payout columns, a full account or UPI number (the payout account is the MASKED view; full details only ever
 * leave through the audited "reveal" action of POST /api/admin/influencers/:id/payout-account), the Google tokens, WhatsApp
 * access tokens or other administrators' sessions.
 */

/** The WhatsApp badge, already worded: the browser must not need lib/readiness (it reaches the database). */
export interface WhatsAppBadgeView {
  text: string;
  tone?: "success" | "warning" | "danger";
}

/* ---------- list ---------- */

export interface AdminInfluencerRowView {
  id: string;
  name: string;
  email: string;
  live: boolean;
  /** Why it is not live (empty when live). */
  blockers: string[];
  emailVerified: boolean;
  google: InfluencerRow["google"];
  whatsapp: WhatsAppBadgeView;
  payout: InfluencerRow["payout"];
  services: number;
  bookings: number;
  grossMinor: number;
}

export interface AdminInfluencersView {
  rows: AdminInfluencerRowView[];
  total: number;
  page: number;
  pageCount: number;
}

export async function loadAdminInfluencersView(page: number, q?: string): Promise<AdminInfluencersView> {
  const data = await listInfluencers(page, q);
  return {
    rows: data.rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      live: r.live,
      blockers: [...r.blockers],
      emailVerified: r.emailVerified,
      google: r.google,
      whatsapp: { text: WHATSAPP_BADGE[r.whatsapp].label, tone: WHATSAPP_BADGE[r.whatsapp].tone },
      payout: r.payout,
      services: r.services,
      bookings: r.bookings,
      grossMinor: r.grossMinor,
    })),
    total: data.total,
    page: data.page,
    pageCount: data.pageCount,
  };
}

/* ---------- detail ---------- */

export interface AdminInfluencerCurrencyView {
  currency: string;
  /** Payable right now, after the platform fee. */
  readyMinor: number;
  readyGrossMinor: number;
  readyFeeMinor: number;
  readyCount: number;
  /** Paid by customers but not payable yet. */
  waitingMinor: number;
  waitingCount: number;
  /** "2 not reconciled yet; 1 refund in progress", worded on the server (the labels live in lib/payouts). */
  waitingText: string;
}

export interface AdminInfluencerPayoutView {
  id: string;
  createdAt: Date;
  /** Where it was sent, masked when the payout was created. */
  destination: string;
  netMinor: number;
  currency: string;
  status: string;
  /** The bank reference (UTR) recorded when it was marked as paid. */
  reference: string | null;
  /** Refunded since it was paid (to recover), in minor units. */
  owedMinor: number;
  /** What the VIEWING administrator may do with it (the creator cannot approve, a second administrator can). */
  approval: PayoutApprovalView;
}

export interface AdminInfluencerView {
  influencer: { id: string; name: string; email: string; slug: string; timezone: string; onboardedAt: Date | null; createdAt: Date; emailVerified: boolean };
  /** The go-live checklist, as the influencer's own dashboard shows it. */
  readinessItems: Pick<ReadinessItem, "key" | "label" | "state" | "required">[];
  connections: {
    google: { state: "none" | "active" | "reconnect"; email: string | null };
    whatsapp: WhatsAppBadgeView;
    gmailSend: boolean;
  };
  /** MASKED details (last four digits, partly hidden UPI handle). Null when the influencer has not added any. */
  payoutAccount: Omit<PayoutAccountView, "updatedAt"> | null;
  fee: { overrideBps: number | null; defaultBps: number; feeBps: number; feePercentText: string };
  /** The payout details are verified, so payouts can be created. */
  verified: boolean;
  /** Four-eyes approval is on but only one administrator can sign in, so nobody could approve a payout. */
  onlyOneAdmin: boolean;
  currencies: AdminInfluencerCurrencyView[];
  payouts: AdminInfluencerPayoutView[];
  services: { id: string; title: string; type: string; capacity: number; durationMin: number; priceMinor: number; currency: string; active: boolean }[];
  bookings: { id: string; serviceTitle: string; startTime: Date; customerName: string; status: string; paidMinor: number; currency: string }[];
}

/** Null when there is no such influencer (the caller answers 404). `adminEmail` is the VIEWER, for the per-viewer approval state. */
export async function loadAdminInfluencerView(id: string, adminEmail: string): Promise<AdminInfluencerView | null> {
  const detail = await getInfluencerDetail(id);
  if (!detail) return null;
  const { influencer: i, bookings } = detail;
  const payout = await getPayoutAccountView(id);
  const feeBps = effectiveFeeBps(i.platformFeeBps);
  const [payable, payouts] = await Promise.all([
    loadPayable(id),
    prisma.payout.findMany({ where: { influencerId: id }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  const currencies = summariseCurrencies(payable, feeBps);
  const owed = new Map(await Promise.all(payouts.filter((p) => p.status === "PAID").map(async (p) => [p.id, await postPayoutRefunds(p.id)] as const)));
  const recentUnapproved = await recentUnapprovedFor(payouts);
  const verified = payout?.status === "VERIFIED";
  const onlyOneAdmin = fourEyesEnabled() && (await activeAdminCount()) < 2;
  const input = readinessInput(
    { ...i, payoutAccount: payout ? { status: payout.status } : null, _count: { rules: await prisma.availabilityRule.count({ where: { influencerId: id } }), services: i.services.filter((s) => s.active).length } },
    i.user?.emailVerifiedAt != null || !i.user,
  );
  const readiness = evaluateReadiness(input);
  const badge = WHATSAPP_BADGE[input.whatsapp];

  return {
    influencer: {
      id: i.id,
      name: i.name,
      email: i.email,
      slug: i.slug,
      timezone: i.timezone,
      onboardedAt: i.onboardedAt,
      createdAt: i.createdAt,
      emailVerified: i.user?.emailVerifiedAt != null,
    },
    readinessItems: readiness.items.map((c) => ({ key: c.key, label: c.label, state: c.state, required: c.required })),
    connections: {
      google: { state: !i.googleToken ? "none" : i.googleToken.status === "ACTIVE" ? "active" : "reconnect", email: i.googleToken?.googleEmail ?? null },
      // The same state as the influencer's own checklist (lib/readiness.ts), with the number when there is one.
      whatsapp: {
        text: i.whatsappConnection?.displayPhone && input.whatsapp !== "error" ? `${i.whatsappConnection.displayPhone}, ${badge.label.toLowerCase()}` : badge.label,
        tone: badge.tone,
      },
      gmailSend: input.gmailSend,
    },
    payoutAccount: payout
      ? {
          method: payout.method,
          accountHolderName: payout.accountHolderName,
          bankName: payout.bankName,
          ifsc: payout.ifsc,
          accountNumber: payout.accountNumber,
          upiId: payout.upiId,
          status: payout.status,
          rejectionReason: payout.rejectionReason,
        }
      : null,
    fee: { overrideBps: i.platformFeeBps, defaultBps: defaultFeeBps(), feeBps, feePercentText: formatFeePercent(feeBps) },
    verified,
    onlyOneAdmin,
    currencies: currencies.map((c) => ({
      currency: c.currency,
      readyMinor: c.readyMinor,
      readyGrossMinor: c.readyGrossMinor,
      readyFeeMinor: c.readyFeeMinor,
      readyCount: c.readyCount,
      waitingMinor: c.waitingMinor,
      waitingCount: c.waitingCount,
      waitingText: (Object.entries(c.waitingByReason) as [Blocker, number][]).map(([r, n]) => `${n} ${BLOCKER_LABEL[r].toLowerCase()}`).join("; "),
    })),
    payouts: payouts.map((p) => ({
      id: p.id,
      createdAt: p.createdAt,
      destination: p.destination,
      netMinor: p.netMinor,
      currency: p.currency,
      status: p.status,
      reference: p.reference,
      owedMinor: owed.get(p.id) ?? 0,
      approval: payoutApprovalView(p, adminEmail, process.env, recentUnapproved.get(p.id) ?? 0),
    })),
    services: i.services.map((s) => ({
      id: s.id,
      title: s.title,
      type: s.type,
      capacity: s.capacity,
      durationMin: s.durationMin,
      priceMinor: s.priceMinor,
      currency: s.currency,
      active: s.active,
    })),
    bookings: bookings.map((b) => ({
      id: b.id,
      serviceTitle: b.session.service.title,
      startTime: b.session.startTime,
      customerName: b.customerName,
      status: b.status,
      paidMinor: b.payments.filter((p) => p.status === "CAPTURED" || p.status === "REFUNDED").reduce((n, p) => n + p.amountMinor, 0),
      currency: b.session.service.currency,
    })),
  };
}
