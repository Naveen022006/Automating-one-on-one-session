import { describeDevice, summariseActivity } from "@/lib/activity-actions";
import { prisma } from "@/lib/db";

/**
 * The "Account activity" card's data, for GET /api/dashboard/activity (and, with the viewer's wording, for GET
 * /api/admin/influencers/:id/activity, lib/views/admin-influencer-activity.ts). The caller has already passed its gate and names the
 * influencer: an influencer only ever passes their own id from the login session.
 *
 * Built field by field. Never in here: the stored `detail` JSON (the sentence is built from it on the server), the raw user agent
 * (a short "Chrome on Windows" instead), the influencer id, or anything of a customer (the log stores none).
 *
 * One page of ACTIVITY_PAGE_SIZE (25) rows per request, newest first, and the page number is bounded to 1 to ACTIVITY_MAX_PAGE (400):
 * there is no way to read the whole log in one call.
 */

export const ACTIVITY_PAGE_SIZE = 25;
export const ACTIVITY_MAX_PAGE = 400;

/** `?page=` as a whole number from 1 to 400; anything else (missing, 0, negative, 2.5, "abc", 1e9, 401) is page 1. */
export function parseActivityPage(value: string | null | undefined): number {
  if (value === null || value === undefined || !/^\d{1,3}$/.test(value)) return 1;
  const n = Number.parseInt(value, 10);
  return n >= 1 && n <= ACTIVITY_MAX_PAGE ? n : 1;
}

export interface ActivityRowView<Actor extends string> {
  id: string;
  /** ISO time. */
  createdAt: string;
  action: string;
  /** The sentence for the row, built on the server. */
  summary: string;
  actor: Actor;
  ip: string | null;
  /** "Chrome on Windows", or null when the request carried no user agent. */
  device: string | null;
}

export interface ActivityPageView<Actor extends string> {
  page: number;
  pageCount: number;
  rows: ActivityRowView<Actor>[];
}

export type DashboardActivityView = ActivityPageView<"you" | "system">;

/** One page of an influencer's activity with `actorLabel` turning the stored actor ("influencer" | "system") into the viewer's word. */
export async function loadActivityPage<Actor extends string>(
  influencerId: string,
  page: number,
  actorLabel: (actor: string) => Actor,
): Promise<ActivityPageView<Actor>> {
  const where = { influencerId };
  const [total, rows] = await Promise.all([
    prisma.influencerActivity.count({ where }),
    prisma.influencerActivity.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * ACTIVITY_PAGE_SIZE,
      take: ACTIVITY_PAGE_SIZE,
      select: { id: true, createdAt: true, actor: true, action: true, detail: true, ip: true, userAgent: true },
    }),
  ]);
  return {
    page,
    pageCount: Math.min(ACTIVITY_MAX_PAGE, Math.max(1, Math.ceil(total / ACTIVITY_PAGE_SIZE))),
    rows: rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      action: r.action,
      summary: summariseActivity(r.action, r.detail),
      actor: actorLabel(r.actor),
      ip: r.ip,
      device: describeDevice(r.userAgent),
    })),
  };
}

export async function loadDashboardActivityView(influencerId: string, params: { page?: string | null }): Promise<DashboardActivityView> {
  return loadActivityPage(influencerId, parseActivityPage(params.page), (actor) => (actor === "system" ? "system" : "you"));
}
