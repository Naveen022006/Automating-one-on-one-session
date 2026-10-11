import { AppLink } from "@web/lib/link";
import { FocusedLayout } from "@web/components/site/SiteChrome";
import { ButtonLink } from "@web/components/ui/primitives";

/**
 * The "404" screen. Rendered by the old Next `app/not-found.tsx` and by the SPA's NotFound page, so both look and read
 * the same (doc/10-react-migration-plan.md, F8).
 *
 * `embedded`: render only the card content, for a not-found route that lives INSIDE the dashboard or admin frame (which
 * already provides the `<main id="main">`); a second `main` would duplicate the landmark and its id.
 */
export function NotFoundView({ embedded = false }: { embedded?: boolean }) {
  const content = (
    <div className="stack stack--lg">
      <p className="eyebrow">404</p>
      <h1 className="focused__title">This page does not exist</h1>
      <p className="muted">
        The link may be mistyped, or the booking page may have moved to a new address. If you were sent here by a host, ask
        them for their current link.
      </p>
      <div className="row">
        <ButtonLink href="/" variant="primary">
          Go to the home page
        </ButtonLink>
        <AppLink href="/contact">Contact us</AppLink>
      </div>
    </div>
  );
  return embedded ? content : <FocusedLayout>{content}</FocusedLayout>;
}
