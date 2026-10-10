import { PageHead } from "@/components/app/AppShell";
import { SessionsBoard } from "@/components/app/SessionsBoard";
import { LinkTabs, Pagination } from "@/components/ui/primitives";
import type { SessionView } from "@/lib/dashboard-data";
import type { Jsonify } from "@/lib/jsonify";
import type { DashboardSessionsView } from "@/lib/views/dashboard-sessions";

const VIEWS: { value: SessionView; label: string; empty: [string, string] }[] = [
  { value: "upcoming", label: "Upcoming", empty: ["No upcoming sessions", "New bookings appear here as soon as they are paid."] },
  { value: "requests", label: "Requests", empty: ["No requests waiting", "When a customer asks to book a service that needs your approval, it shows up here."] },
  { value: "past", label: "Past", empty: ["No past sessions yet", "Sessions move here after they end."] },
  { value: "cancelled", label: "Cancelled", empty: ["No cancellations", "Cancelled bookings and their refunds appear here."] },
  { value: "attention", label: "Needs attention", empty: ["All clear", "Failed Meet links, calendar errors and refunds due show up here."] },
];

/**
 * The Sessions page body. `bookingId` is the `?booking=` URL parameter: it opens that booking's drawer when the board first
 * appears (a link from the Messages page).
 */
export function SessionsView({ data, bookingId = null }: { data: Jsonify<DashboardSessionsView>; bookingId?: string | null }) {
  const current = VIEWS.find((v) => v.value === data.view) ?? VIEWS[0];

  return (
    <div className="stack stack--lg">
      <PageHead title="Sessions" description="Every booking, its payment and the messages sent. Select a row for details and actions." />
      <LinkTabs
        items={VIEWS.map((v) => ({
          label: v.label,
          href: `/dashboard/sessions?view=${v.value}`,
          current: v.value === current.value,
          count: v.value === current.value ? data.total : undefined,
        }))}
      />
      <SessionsBoard sessions={data.sessions} emptyTitle={current.empty[0]} emptyBody={current.empty[1]} initialBookingId={bookingId} />
      <Pagination page={data.page} pageCount={data.pageCount} hrefFor={(p) => `/dashboard/sessions?view=${current.value}&page=${p}`} />
    </div>
  );
}
