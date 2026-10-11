import { FocusedLayout } from "@web/components/site/SiteChrome";
import { EmptyState } from "@web/components/ui/primitives";
import { PageTitle } from "../../lib/head";

/**
 * `/bookings/:token`: the customer's list of bookings behind an e-mailed access link. PLACEHOLDER from the foundation branch
 * (mk/00-foundation); the customer portal work package replaces this page (doc/13-product-build-plan.md, WP-D). It must keep
 * the `no-referrer` policy once it reads the token: see pages/booking/Manage.tsx.
 */
export function Component() {
  return (
    <>
      <meta name="referrer" content="no-referrer" />
      <PageTitle title="Your bookings" />
      <FocusedLayout>
        <div className="stack stack--lg">
          <h1 className="focused__title">Your bookings</h1>
          <EmptyState title="Coming soon">This page is not available yet.</EmptyState>
        </div>
      </FocusedLayout>
    </>
  );
}
