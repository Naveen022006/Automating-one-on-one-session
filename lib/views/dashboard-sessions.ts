import { listSessions, type SessionRow, type SessionView } from "@/lib/dashboard-data";
import { parsePageParam } from "./dashboard-params";

/**
 * The Sessions page's data. Served by
 * GET /api/dashboard/sessions. Always scoped to the influencer id from the login session.
 */

/** The tabs, in display order. The first is the default for a missing or unknown `?view=`. */
export const SESSION_VIEWS: readonly SessionView[] = ["upcoming", "requests", "past", "cancelled", "attention"];

export function parseSessionView(value: string | null | undefined): SessionView {
  return SESSION_VIEWS.find((v) => v === value) ?? SESSION_VIEWS[0];
}

export interface DashboardSessionsView {
  /** The tab actually shown (an unknown `?view=` falls back to "upcoming"). */
  view: SessionView;
  total: number;
  page: number;
  pageCount: number;
  /** The rows SessionsBoard renders; it is handed exactly this shape. */
  sessions: SessionRow[];
}

export async function loadSessionsView(
  influencerId: string,
  params: { view?: string | null; page?: string | null },
  now?: Date,
): Promise<DashboardSessionsView> {
  const view = parseSessionView(params.view);
  const result = await listSessions(influencerId, view, { page: parsePageParam(params.page), now });
  return { view, total: result.total, page: result.page, pageCount: result.pageCount, sessions: result.sessions };
}
