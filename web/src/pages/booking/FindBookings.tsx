import { FocusedLayout } from "@web/components/site/SiteChrome";
import { EmptyState } from "@web/components/ui/primitives";
import { PageTitle } from "../../lib/head";

/**
 * `/bookings`: "find your bookings" by e-mail. PLACEHOLDER from the foundation branch (mk/00-foundation); the customer portal
 * work package replaces this page with the e-mail form (doc/13-product-build-plan.md, WP-D).
 */
export function Component() {
  return (
    <>
      <PageTitle title="Find your bookings" />
      <FocusedLayout>
        <div className="stack stack--lg">
          <h1 className="focused__title">Find your bookings</h1>
          <EmptyState title="Coming soon">Finding your bookings by e-mail is not available yet.</EmptyState>
        </div>
      </FocusedLayout>
    </>
  );
}
