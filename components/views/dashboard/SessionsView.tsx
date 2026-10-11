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
 * appears (a link from the Messages page). `busy` is set by the SPA page while it still shows the previous tab or page and the
 * next one is loading (the old page leaves it undefined).
 */
export function SessionsView({ data, bookingId = null, busy }: { data: Jsonify<DashboardSessionsView>; bookingId?: string | null; busy?: boolean }) {
  const current = VIEWS.find((v) => v.value === data.view) ?? VIEWS[0];
  // Tabs and pagination are links that no longer reload the page, so nothing announces the new list: this line does (a live region whose text changes).
  const found = `${current.label}: ${data.total} ${data.total === 1 ? "session" : "sessions"}, page ${data.page} of ${data.pageCount}.`;

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
      <p role="status" className="sr-only">{busy ? "Loading…" : found}</p>
      <div className="stack stack--lg" aria-busy={busy || undefined}>
        <SessionsBoard sessions={data.sessions} emptyTitle={current.empty[0]} emptyBody={current.empty[1]} initialBookingId={bookingId} />
        <Pagination page={data.page} pageCount={data.pageCount} hrefFor={(p) => `/dashboard/sessions?view=${current.value}&page=${p}`} />
      </div>
    </div>
  );
}
