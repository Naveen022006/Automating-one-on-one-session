import { useLocation } from "react-router";
import { FocusedLayout } from "@web/components/site/SiteChrome";
import { matchSpaRoute, type SpaRouteDef } from "@/lib/spa/routes";
import { PageTitle } from "../lib/head";
import { NotFound } from "./NotFound";

/**
 * The placeholder every page module exports until its group branch replaces it (`export const Component = NotBuiltYet`).
 * With `SPA_GROUPS` empty, or without the page's group in it, this screen is never reachable in production: the proxy
 * serves the old Next page for that group. In development (Vite) it tells the developer where the real page still lives.
 */
export function NotBuiltYet() {
  const { pathname, search } = useLocation();
  const match = matchSpaRoute(pathname);

  if (!import.meta.env.DEV) return <NotFound />;

  const route: SpaRouteDef | undefined = match?.route;
  const title = route?.title ?? "Page";
  const template = route?.template ?? "brand";
  const inFrame = route?.group === "dashboard" || route?.group === "admin";
  const target = `${__NEXT_DEV_ORIGIN__}${pathname}${search}`;
  const body = (
    <div className="stack">
      <p className="eyebrow">Development placeholder</p>
      <h1 className="focused__title">Not migrated yet</h1>
      <p className="muted">
        This page has not been moved to the SPA yet. Open <a href={target}>{target}</a> to see the current version.
      </p>
    </div>
  );
  return (
    <>
      <PageTitle title={title} template={template} />
      {/* Dashboard and admin pages already sit inside a frame with its own main#main; others need their own. */}
      {inFrame ? body : <FocusedLayout>{body}</FocusedLayout>}
    </>
  );
}
