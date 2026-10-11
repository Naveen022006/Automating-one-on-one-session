import type { QueryKey } from "@tanstack/react-query";
import { keepPreviousData } from "@tanstack/react-query";
import { useState } from "react";
import { IconShield } from "@web/components/icons";
import { Alert, Button, Card, EmptyState, Skeleton } from "@web/components/ui/primitives";
import { useApiQuery } from "@web/lib/api";
import { queryKeys } from "@web/lib/query";
import type { ActivityPageView } from "@/lib/views/dashboard-activity";

/**
 * The account activity table (doc/13-product-build-plan.md, WP-C): When / What / Device / IP, 25 rows a page, newest first. Used by
 * the "Account activity" card in Settings (the influencer's own entries) and by the admin Influencer page
 * (components/admin/InfluencerActivityPanel.tsx). The sentence in "What" is worded by the server; the browser never sees the stored
 * detail or the raw user agent. The page number is local state (the card is one part of a page, not a page of its own), and the
 * previous page stays on screen while the next one loads.
 */

type Row = ActivityPageView<string>["rows"][number];

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

export function ActivityLog({ keyFor, urlFor, label }: { keyFor: (page: number) => QueryKey; urlFor: (page: number) => string; label: string }) {
  const [page, setPage] = useState(1);
  const query = useApiQuery<ActivityPageView<string>>(keyFor(page), urlFor(page), { placeholderData: keepPreviousData });
  const data = query.data;

  if (data === undefined) {
    if (query.isPending) {
      return (
        <div className="stack stack--sm" role="status" aria-live="polite" aria-busy="true">
          <span className="sr-only">Loading account activity</span>
          <Skeleton width="100%" height={16} />
          <Skeleton width="90%" height={16} />
          <Skeleton width="95%" height={16} />
        </div>
      );
    }
    return (
      <Alert tone="danger" title="Could not load the activity" action={<Button onClick={() => void query.refetch()}>Try again</Button>}>
        {query.error?.status === 429 ? (query.error.serverMessage ?? "Too many requests. Please wait a moment and try again.") : "Your account is not affected. Try again in a moment."}
      </Alert>
    );
  }

  const shown = `${data.rows.length === 0 ? "No entries" : `${data.rows.length} ${data.rows.length === 1 ? "entry" : "entries"} shown`}, page ${data.page} of ${data.pageCount}.`;
  return (
    <div className="stack" aria-busy={query.isPlaceholderData || undefined}>
      <p role="status" className="sr-only">{query.isPlaceholderData ? "Loading…" : shown}</p>
      {data.rows.length === 0 ? (
        <EmptyState icon={<IconShield />} title="No activity yet" />
      ) : (
        <div className="table-wrap">
          <table className="table table--stack">
            <caption className="sr-only">{label}</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">What</th>
                <th scope="col">Device</th>
                <th scope="col">IP</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r: Row) => (
                <tr key={r.id}>
                  <td data-label="When">{when(r.createdAt)}</td>
                  <td data-label="What">
                    {r.summary}
                    {r.actor === "system" && <span className="subtle"> (automatic)</span>}
                  </td>
                  <td data-label="Device" className="subtle">{r.device ?? "—"}</td>
                  <td data-label="IP" className="subtle">{r.ip ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.pageCount > 1 && (
        <nav className="pagination" aria-label="Activity pages">
          <span>
            Page {data.page} of {data.pageCount}
          </span>
          <div className="row">
            <Button size="sm" disabled={data.page <= 1 || query.isPlaceholderData} onClick={() => setPage(data.page - 1)}>
              Previous
            </Button>
            <Button size="sm" disabled={data.page >= data.pageCount || query.isPlaceholderData} onClick={() => setPage(data.page + 1)}>
              Next
            </Button>
          </div>
        </nav>
      )}
    </div>
  );
}

/** The "Account activity" card of the Settings page. */
export function AccountActivityPanel() {
  return (
    <Card title="Account activity">
      <div className="stack">
        <p className="subtle">
          The last sign-ins and changes on your account. If you do not recognise an entry, change your password and log out everywhere.
        </p>
        <ActivityLog keyFor={(page) => queryKeys.dashboard("activity", { page })} urlFor={(page) => `/api/dashboard/activity?page=${page}`} label="Your account activity" />
      </div>
    </Card>
  );
}
