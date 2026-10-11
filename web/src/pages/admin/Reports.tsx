import { PageHead } from "@web/components/app/AppShell";
import { IconBarChart } from "@web/components/icons";
import { EmptyState } from "@web/components/ui/primitives";
import { PageTitle } from "../../lib/head";

/**
 * /admin/reports: the finance report. PLACEHOLDER from the foundation branch (mk/00-foundation); the admin reports work package
 * replaces this page (doc/13-product-build-plan.md, WP-F).
 */
export function Component() {
  return (
    <>
      <PageTitle title="Reports" template="admin" />
      <div className="stack stack--lg">
        <PageHead title="Reports" description="Money held, owed and paid out." />
        <EmptyState icon={<IconBarChart />} title="Coming soon">The finance report is not available yet.</EmptyState>
      </div>
    </>
  );
}
