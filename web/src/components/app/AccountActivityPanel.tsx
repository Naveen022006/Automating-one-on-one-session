import type { QueryKey } from "@tanstack/react-query";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { IconShield } from "@web/components/icons";
import { Alert, Button, Card, EmptyState, Field, Select, Skeleton } from "@web/components/ui/primitives";
import { useApiQuery } from "@web/lib/api";
import { queryKeys } from "@web/lib/query";
import type { ActivityAction } from "@/lib/activity-actions";
import type { ActivityPageView } from "@/lib/views/dashboard-activity";
import { formatDateTime } from "@/lib/india";

/**
 * The account activity table (doc/13-product-build-plan.md, WP-C): When / What / Device / IP, 25 rows a page, newest first. Used by
 * the "Account activity" card in Settings (the influencer's own entries) and by the admin Influencer page
 * (components/admin/InfluencerActivityPanel.tsx). The sentence in "What" is worded by the server; the browser never sees the stored
 * detail or the raw user agent. The page number and the filter are local state (the card is one part of a page, not a page of its
 * own), and the previous page stays on screen while the next one loads.
 */

type Row = ActivityPageView<string>["rows"][number];

/** Window event the forms that write an entry without reloading the page dispatch (a password change, the password prompt): the card reads the log again. */
export const ACTIVITY_CHANGED_EVENT = "sa:activity-changed";

/** The quick filters: the entries somebody investigating an account looks for first. `satisfies` keeps every value a real action. */
const FILTERS = [
  { value: "", label: "All activity" },
  { value: "auth.login_failed", label: "Failed sign-ins" },
  { value: "auth.login", label: "Sign-ins" },
  { value: "auth.password_changed", label: "Password changes" },
  { value: "payout_account.updated", label: "Payout details" },
  { value: "booking.refunded", label: "Refunds" },
  { value: "service.updated", label: "Service changes" },
  { value: "customers.erased", label: "Customer erasures" },
  { value: "google.connected", label: "Google connections" },
] satisfies { value: "" | ActivityAction; label: string }[];

function when(iso: string): string {
  return formatDateTime(new Date(iso), { weekday: false });
}

const loadingLines = (
  <div className="stack stack--sm" role="status" aria-live="polite" aria-busy="true">
    <span className="sr-only">Loading account activity</span>
    <Skeleton width="100%" height={16} />
    <Skeleton width="90%" height={16} />
    <Skeleton width="95%" height={16} />
  </div>
);

type LogProps = { keyFor: (page: number, action: string) => QueryKey; urlFor: (page: number, action: string) => string; label: string };

/**
 * The table, loaded once the page is on screen. The query starts in an effect-driven second render, not during the first one, so a
 * view that contains this card can still be rendered to static markup without a QueryClient (the Settings and Influencer view tests
 * do exactly that); in the browser the first paint shows the loading lines for one frame.
 */
export function ActivityLog(props: LogProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <ActivityLogTable {...props} /> : loadingLines;
}

function ActivityLogTable({ keyFor, urlFor, label }: LogProps) {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState("");
  const queryClient = useQueryClient();
  const query = useApiQuery<ActivityPageView<string>>(keyFor(page, action), urlFor(page, action), { placeholderData: keepPreviousData });

  // The forms that write an entry without reloading the page announce it; read the log again.
  useEffect(() => {
    const reload = () => void queryClient.invalidateQueries({ queryKey: keyFor(1, "").slice(0, 2) });
    window.addEventListener(ACTIVITY_CHANGED_EVENT, reload);
    return () => window.removeEventListener(ACTIVITY_CHANGED_EVENT, reload);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The last page that loaded: the pager stays usable when the next one fails.
  const lastGood = useRef<ActivityPageView<string> | null>(null);
  if (query.data !== undefined && !query.isPlaceholderData) lastGood.current = query.data;
  const data = query.data ?? lastGood.current;
  const failed = query.isError;
  const pageCount = data?.pageCount ?? 1;

  if (data === null || data === undefined) {
    if (!failed) return loadingLines;
    return (
      <Alert tone="danger" title="Could not load the activity" action={<Button onClick={() => void query.refetch()}>Try again</Button>}>
        {query.error?.status === 429 ? (query.error.serverMessage ?? "Too many requests. Please wait a moment and try again.") : "Your account is not affected. Try again in a moment."}
      </Alert>
    );
  }

  const busy = query.isPlaceholderData || query.isFetching;
  const shown = failed
    ? "Could not load this page."
    : `${data.rows.length === 0 ? "No entries" : `${data.rows.length} ${data.rows.length === 1 ? "entry" : "entries"} shown`}, page ${data.page} of ${data.pageCount}.`;
  return (
    <div className="stack" aria-busy={query.isPlaceholderData || undefined}>
      <Field id={"activity-filter"} label="Show">
        <Select
          id={"activity-filter"}
          value={action}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
            setAction(e.target.value);
            setPage(1);
          }}
        >
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </Select>
      </Field>
      <p role="status" className="sr-only">{query.isPlaceholderData ? "Loading…" : shown}</p>
      {failed ? (
        <Alert
          tone="danger"
          title="Could not load this page"
          action={
            <div className="row">
              <Button size="sm" onClick={() => void query.refetch()}>Try again</Button>
              {page > 1 && <Button size="sm" onClick={() => setPage(1)}>Back to page 1</Button>}
            </div>
          }
        >
          {query.error?.status === 429 ? (query.error.serverMessage ?? "Too many requests. Please wait a moment and try again.") : "Your account is not affected."}
        </Alert>
      ) : data.rows.length === 0 ? (
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
      {(pageCount > 1 || page > 1) && (
        <nav className="pagination" aria-label="Activity pages">
          <span>
            Page {page} of {Math.max(pageCount, page)}
          </span>
          <div className="row">
            <Button size="sm" disabled={page <= 1 || busy} onClick={() => setPage(page - 1)}>
              Previous
            </Button>
            <Button size="sm" disabled={page >= pageCount || busy || failed} onClick={() => setPage(page + 1)}>
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
        <ActivityLog
          keyFor={(page, action) => queryKeys.dashboard("activity", { page, action })}
          urlFor={(page, action) => `/api/dashboard/activity?page=${page}${action ? `&action=${encodeURIComponent(action)}` : ""}`}
          label="Your account activity"
        />
      </div>
    </Card>
  );
}
