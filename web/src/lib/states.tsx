import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Wordmark } from "@/components/site/SiteChrome";
import { NotFoundView } from "@/components/views/system/NotFoundView";
import { Alert, Button, Skeleton } from "@/components/ui/primitives";
import type { ApiError } from "./api";
import { PLACEHOLDER_ATTR } from "./focus-main";

/**
 * Loading, error and not-found states of a page that reads data (doc/10-react-migration-plan.md, section 2.7), so every
 * page handles a failed query the same way:
 *
 *   pending (no data yet)  -> a skeleton. (A background refetch keeps showing the data it already has.)
 *   404                    -> the shared "This page does not exist" screen
 *   429                    -> an alert with the server's own "Too many requests" message
 *   anything else          -> an alert with "Try again" (refetch)
 *
 * 401 and the admin 403s never get here: the global handler in ./api.ts has already moved the browser.
 *
 * Usage: `<QueryGate query={q}>{(data) => <XView data={data} />}</QueryGate>`.
 */

/** A neutral loading placeholder: a few skeleton lines and a polite status for screen readers. */
export function PageLoading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="stack" role="status" aria-live="polite" aria-busy="true" style={{ padding: "24px 0" }}>
      <span className="sr-only">{label}</span>
      <Skeleton width="40%" height={28} />
      <Skeleton width="100%" height={16} />
      <Skeleton width="85%" height={16} />
      <Skeleton width="92%" height={16} />
    </div>
  );
}

export function PageError({ error, onRetry }: { error: ApiError | Error; onRetry?: () => void }) {
  const status = "status" in error ? (error as ApiError).status : 0;
  const serverMessage = "serverMessage" in error ? (error as ApiError).serverMessage : null;
  const message =
    status === 429
      ? (serverMessage ?? "Too many requests. Please wait a moment and try again.")
      : status === 0
        ? error.message
        : "We could not load this page. Your bookings and payments are safe.";
  return (
    <Alert tone="danger" title="Something went wrong" action={status === 429 || !onRetry ? undefined : <Button onClick={onRetry}>Try again</Button>}>
      {message}
    </Alert>
  );
}

/**
 * A public page's frame (brand header and the `main` landmark) around a state that has no page of its own yet: what a customer
 * sees while a profile or a booking is loading, or when loading it failed. Without it the skeleton and the error alert sit bare in
 * the top-left corner of the window (no margins, no header, and no `#main` for the skip link to land on).
 *
 * Its `main` is a PLACEHOLDER (`data-placeholder`): the real page replaces it when the data arrives, so FocusOnNavigate must not
 * focus it (the focused element would disappear and the focus fall to <body>); it keeps watching for the real `main` instead.
 */
export function PublicPageFrame({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="site-header">
        <div className="container site-header__inner">
          <Wordmark />
        </div>
      </header>
      <main id="main" className="container container--narrow" {...{ [PLACEHOLDER_ATTR]: "" }}>
        {children}
      </main>
    </>
  );
}

export function QueryGate<T>({
  query,
  children,
  embedded = false,
  framed = false,
  loading,
}: {
  query: UseQueryResult<T, ApiError>;
  children: (data: T) => ReactNode;
  /** The page lives inside the dashboard or admin frame: a 404 renders inside it instead of as a full screen. */
  embedded?: boolean;
  /** A public page with no frame of its own while it loads (profile, booking, pay, manage): draw the loading and error states inside PublicPageFrame. */
  framed?: boolean;
  loading?: ReactNode;
}) {
  const frame = (node: ReactNode) => (framed ? <PublicPageFrame>{node}</PublicPageFrame> : node);
  if (query.data !== undefined) return <>{children(query.data)}</>;
  if (query.isPending) return <>{frame(loading ?? <PageLoading />)}</>;
  const error = query.error;
  if (error?.status === 404) return <NotFoundView embedded={embedded} />;
  const alert = <PageError error={error ?? new Error("Unknown error")} onRetry={() => void query.refetch()} />;
  // Inside the public frame the alert needs the space the skeleton already has above it.
  return <>{framed ? <PublicPageFrame><div style={{ paddingTop: 24 }}>{alert}</div></PublicPageFrame> : alert}</>;
}
