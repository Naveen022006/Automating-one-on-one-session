import Link from "next/link";
import { IconMessage } from "@/components/icons";
import { PageHead } from "@/components/app/AppShell";
import { EmptyState, LinkTabs, Pagination, StatusPill } from "@/components/ui/primitives";
import type { Jsonify } from "@/lib/jsonify";
import type { DashboardMessagesView, MessageStatusFilter } from "@/lib/views/dashboard-messages";

const CHANNEL: Record<string, string> = { WHATSAPP: "WhatsApp", SMS: "SMS", EMAIL: "Email" };
const TEMPLATE: Record<string, string> = {
  "booking-confirmation": "Confirmation",
  "reminder-24h": "24 h reminder",
  "reminder-15m": "15 min reminder",
  reschedule: "Reschedule notice",
  "booking-rescheduled": "Reschedule email",
  cancellation: "Cancellation notice",
  "booking-cancelled": "Cancellation email",
  receipt: "Receipt",
};
const FILTERS: { value: MessageStatusFilter; label: string }[] = [
  { value: "", label: "All" },
  { value: "FAILED", label: "Failed" },
  { value: "PENDING", label: "Queued" },
  { value: "DELIVERED", label: "Delivered" },
];

function at(iso: string) {
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** The Messages page body. Rendered by the old Next page and by the SPA page from the same JSON. */
export function MessagesView({ data }: { data: Jsonify<DashboardMessagesView> }) {
  const { status } = data;

  return (
    <div className="stack stack--lg">
      <PageHead title="Messages" description="Every confirmation, reminder and notice sent to customers, with its delivery status." />
      <LinkTabs items={FILTERS.map((f) => ({ label: f.label, href: `/dashboard/messages${f.value ? `?status=${f.value}` : ""}`, current: f.value === status }))} />
      {data.messages.length === 0 ? (
        <EmptyState icon={<IconMessage />} title={status ? "Nothing here" : "No messages yet"}>
          {status === "FAILED" ? "Every message was delivered." : "Messages appear once customers book."}
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table table--stack">
            <thead>
              <tr>
                <th scope="col">Message</th>
                <th scope="col">Customer</th>
                <th scope="col">Channel</th>
                <th scope="col">Status</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {data.messages.map((m) => (
                // One row per (booking, channel, template) in the database, so this key is unique.
                <tr key={`${m.bookingId}:${m.channel}:${m.template}`}>
                  <td data-label="Message">
                    {TEMPLATE[m.template] ?? m.template}
                    {m.error && <div className="error-text break">{m.error}</div>}
                  </td>
                  <td data-label="Customer">
                    <Link href={`/dashboard/sessions?view=${new Date(m.sessionStart) > new Date() ? "upcoming" : "past"}&booking=${m.bookingId}`}>{m.customerName}</Link>
                    <div className="subtle">{m.serviceTitle}</div>
                  </td>
                  <td data-label="Channel">{CHANNEL[m.channel] ?? m.channel}</td>
                  <td data-label="Status">
                    <StatusPill kind="message" status={m.status} />
                  </td>
                  <td data-label="Updated" className="tabular">{at(m.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={data.page} pageCount={data.pageCount} hrefFor={(p) => `/dashboard/messages?${status ? `status=${status}&` : ""}page=${p}`} />
    </div>
  );
}
