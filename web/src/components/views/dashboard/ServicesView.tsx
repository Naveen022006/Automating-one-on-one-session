import { PageHead } from "@web/components/app/AppShell";
import { ServicesManager } from "@web/components/app/ServicesManager";
import type { Jsonify } from "@/lib/jsonify";
import type { DashboardServicesView } from "@/lib/views/dashboard-services";

/** The Services page body. Rendered by the SPA page from the endpoint's JSON. */
export function ServicesView({ data }: { data: Jsonify<DashboardServicesView> }) {
  return (
    <div className="stack stack--lg">
      <PageHead title="Services" description="What customers can book. Hidden services stay on existing bookings but cannot be booked." />
      <ServicesManager services={data.services} />
    </div>
  );
}
