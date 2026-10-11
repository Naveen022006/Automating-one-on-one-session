import { isRouteErrorResponse, useRouteError } from "react-router";
import { ErrorView } from "@web/components/views/system/ErrorView";
import { PageTitle } from "../lib/head";
import { NotFound } from "./NotFound";

/**
 * The router's `errorElement`. A crash while rendering a route (or loading its code) lands here
 * instead of a blank page. The screen is the shared ErrorView (it logs `[ui:error]`); "Try again" reloads the
 * page, which is the reliable reset for a broken route. A crash OUTSIDE the router is caught by GlobalError.
 */
export function ErrorPage() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFound />;
  const asError = error instanceof Error ? error : new Error(typeof error === "string" ? error : "Unknown error");
  return (
    <>
      <PageTitle title="Something went wrong" />
      <ErrorView error={asError} reset={() => window.location.reload()} />
    </>
  );
}
