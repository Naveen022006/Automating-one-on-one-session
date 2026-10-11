import type { AuthContext } from "@/lib/auth/session";
import { appUrl } from "@/lib/brand";
import { getOverview, type AttentionItem, type SessionRow } from "@/lib/dashboard-data";
import type { CurrencyEarnings } from "@/lib/dashboard";
import { CONNECTION_KEYS, loadReadiness, type Readiness } from "@/lib/readiness";

/**
 * The dashboard Overview's data. Served by
 * GET /api/dashboard/overview. The caller has already authenticated (`requireApiAuth`).
 *
 * The DTO holds what the page renders and nothing else: getOverview() also returns the Google connection status and a
 * per-service earnings breakdown, which this page never showed, so they are not sent.
 */
export interface DashboardOverviewView {
  /** For "Hello, <first name>". */
  firstName: string;
  readiness: Readiness;
  /** True when nothing blocks the booking page except steps that are not about email or a connection. */
  live: boolean;
  /** The influencer's public booking page, for the copy field. */
  publicUrl: string;
  overview: {
    upcoming: SessionRow[];
    sessionsThisWeek: number;
    attention: AttentionItem[];
    /** This month's captured payments net of refunds; only the per-currency totals are shown. */
    monthEarnings: { totalsByCurrency: CurrencyEarnings[] };
  };
}

export async function loadOverviewView(auth: AuthContext): Promise<DashboardOverviewView> {
  const [overview, readiness] = await Promise.all([getOverview(auth.influencerId, auth.emailVerified), loadReadiness(auth.influencerId, auth.emailVerified)]);
  const live = readiness.blockers.every((b) => b.key !== "email" && !(CONNECTION_KEYS as readonly string[]).includes(b.key));
  return {
    firstName: auth.influencerName.split(" ")[0],
    readiness,
    live,
    publicUrl: `${appUrl()}/${auth.influencerSlug}`,
    overview: {
      upcoming: overview.upcoming,
      sessionsThisWeek: overview.sessionsThisWeek,
      attention: overview.attention,
      monthEarnings: { totalsByCurrency: overview.monthEarnings.totalsByCurrency },
    },
  };
}
