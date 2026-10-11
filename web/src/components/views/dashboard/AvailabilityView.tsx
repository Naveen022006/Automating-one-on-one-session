import { PageHead } from "@web/components/app/AppShell";
import { BlockedDays, WeeklyHours } from "@web/components/app/AvailabilityEditor";
import type { Jsonify } from "@/lib/jsonify";
import type { DashboardAvailabilityView } from "@/lib/views/dashboard-availability";

/** The Availability page body. Rendered by the SPA page from the endpoint's JSON. */
export function AvailabilityView({ data }: { data: Jsonify<DashboardAvailabilityView> }) {
  return (
    <div className="stack stack--lg">
      <PageHead title="Availability" description="Your weekly hours and days off. Customers can only book open times inside these hours." />
      <WeeklyHours timezone={data.timezone} rules={data.rules} />
      <BlockedDays timezone={data.timezone} blocked={data.blocked} />
    </div>
  );
}
