import { getOverview, listAudit, type MoneyByCurrency } from "@/lib/admin/data";
import { getHealthReport, type HealthCondition } from "@/lib/health";

/**
 * The admin console's Overview page (everything across all influencers). One function, two callers: the old Next page
 * (app/admin/(console)/page.tsx) and GET /api/admin/overview for the SPA. The caller has already passed the admin gate
 * (`requireAdminPage` / `requireAdminMfa()`). Hand-picked fields only: what the page renders and nothing else (no audit
 * `detail`, no IP addresses, no ids of other records).
 */
export interface AdminOverviewView {
  overview: {
    influencers: { total: number; onboarded: number };
    bookingsByStatus: Record<string, number>;
    /** Captured payment totals (gross, before refunds), per currency. */
    captured: MoneyByCurrency[];
    refunded: MoneyByCurrency[];
    attention: { needsRefund: number; mismatched: number; googleReconnect: number; failedMessages7d: number };
  };
  /** The latest administrator actions, newest first (at most 8). */
  recentAudit: { id: string; createdAt: Date; adminEmail: string; action: string; targetType: string | null }[];
  /** `available: false` when the health report itself could not be built (the page then shows no health alert). */
  health: { available: boolean; unhealthy: { label: string; status: HealthCondition["status"] }[] };
}

export async function loadAdminOverviewView(): Promise<AdminOverviewView> {
  const [o, audit, health] = await Promise.all([getOverview(), listAudit(1), getHealthReport().catch(() => null)]);
  return {
    overview: {
      influencers: { total: o.influencers.total, onboarded: o.influencers.onboarded },
      bookingsByStatus: { ...o.bookingsByStatus },
      captured: o.captured.map((m) => ({ currency: m.currency, amountMinor: m.amountMinor })),
      refunded: o.refunded.map((m) => ({ currency: m.currency, amountMinor: m.amountMinor })),
      attention: {
        needsRefund: o.attention.needsRefund,
        mismatched: o.attention.mismatched,
        googleReconnect: o.attention.googleReconnect,
        failedMessages7d: o.attention.failedMessages7d,
      },
    },
    recentAudit: audit.rows.slice(0, 8).map((a) => ({ id: a.id, createdAt: a.createdAt, adminEmail: a.adminEmail, action: a.action, targetType: a.targetType })),
    health: { available: health !== null, unhealthy: (health?.unhealthy ?? []).map((c) => ({ label: c.label, status: c.status })) },
  };
}
