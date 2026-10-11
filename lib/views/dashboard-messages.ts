import { listMessages } from "@/lib/dashboard-data";
import { parsePageParam } from "./dashboard-params";

/**
 * The Messages page's data, for GET /api/dashboard/messages. Scoped to the influencer id from the
 * login session.
 */

/** The filter tabs; "" means all. Any other `?status=` is treated as "". */
export const MESSAGE_STATUS_FILTERS = ["", "FAILED", "PENDING", "DELIVERED"] as const;
export type MessageStatusFilter = (typeof MESSAGE_STATUS_FILTERS)[number];

export function parseMessageStatus(value: string | null | undefined): MessageStatusFilter {
  return MESSAGE_STATUS_FILTERS.find((s) => s === value) ?? "";
}

export interface DashboardMessageRow {
  bookingId: string;
  customerName: string;
  serviceTitle: string;
  /** ISO time of the session the message is about (the page links to "upcoming" or "past" by it). */
  sessionStart: string;
  channel: string;
  template: string;
  status: string;
  error: string | null;
  /** ISO time of the last status change. */
  at: string;
}

export interface DashboardMessagesView {
  status: MessageStatusFilter;
  page: number;
  pageCount: number;
  messages: DashboardMessageRow[];
}

export async function loadMessagesView(
  influencerId: string,
  params: { status?: string | null; page?: string | null },
): Promise<DashboardMessagesView> {
  const status = parseMessageStatus(params.status);
  const result = await listMessages(influencerId, { status: status || null, page: parsePageParam(params.page) });
  return {
    status,
    page: result.page,
    pageCount: result.pageCount,
    messages: result.messages.map((m) => ({
      bookingId: m.bookingId,
      customerName: m.customerName,
      serviceTitle: m.serviceTitle,
      sessionStart: m.sessionStart,
      channel: m.channel,
      template: m.template,
      status: m.status,
      error: m.error,
      at: m.at,
    })),
  };
}
