import type { Metadata } from "next";
import { PageHead } from "@/components/app/AppShell";
import { SessionsBoard } from "@/components/app/SessionsBoard";
import { LinkTabs, Pagination } from "@/components/ui/primitives";
import { requirePageAuth } from "@/lib/auth/guards";
import { listSessions, type SessionView } from "@/lib/dashboard-data";

export const metadata: Metadata = { title: "Sessions" };

const VIEWS: { value: SessionView; label: string; empty: [string, string] }[] = [
  { value: "upcoming", label: "Upcoming", empty: ["No upcoming sessions", "New bookings appear here as soon as they are paid."] },
  { value: "past", label: "Past", empty: ["No past sessions yet", "Sessions move here after they end."] },
  { value: "cancelled", label: "Cancelled", empty: ["No cancellations", "Cancelled bookings and their refunds appear here."] },
  { value: "attention", label: "Needs attention", empty: ["All clear", "Failed Meet links, calendar errors and refunds due show up here."] },
];

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; page?: string; booking?: string }>;
}) {
  const auth = await requirePageAuth("/dashboard/sessions");
  const sp = await searchParams;
  const current = VIEWS.find((v) => v.value === sp.view) ?? VIEWS[0];
  const page = Math.max(1, Number(sp.page) || 1);
  const result = await listSessions(auth.influencerId, current.value, { page });

  return (
    <div className="stack stack--lg">
      <PageHead title="Sessions" description="Every booking, its payment and the messages sent. Select a row for details and actions." />
      <LinkTabs
        items={VIEWS.map((v) => ({
          label: v.label,
          href: `/dashboard/sessions?view=${v.value}`,
          current: v.value === current.value,
          count: v.value === current.value ? result.total : undefined,
        }))}
      />
      <SessionsBoard
        sessions={result.sessions}
        emptyTitle={current.empty[0]}
        emptyBody={current.empty[1]}
        initialBookingId={sp.booking ?? null}
      />
      <Pagination page={result.page} pageCount={result.pageCount} hrefFor={(p) => `/dashboard/sessions?view=${current.value}&page=${p}`} />
    </div>
  );
}
