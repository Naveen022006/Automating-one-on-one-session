import { useSearchParams } from "react-router";
import { SettingsView } from "@/components/views/dashboard/SettingsView";
import type { DashboardSettingsView } from "@/lib/views/dashboard-settings";
import { useApiQuery } from "../../lib/api";
import { PageTitle } from "../../lib/head";
import type { Jsonify } from "../../lib/jsonify";
import { queryKeys } from "../../lib/query";
import { QueryGate } from "../../lib/states";

/**
 * /dashboard/settings. `?google=<outcome>` is where Google's return trip lands (app/api/google/callback): it only picks
 * the banner above the Google panel, so it is not part of the query key. `#google` / `#whatsapp` anchors are scrolled to
 * by the frame's HashScroller once the panels exist.
 */
export function Component() {
  const [search] = useSearchParams();
  const query = useApiQuery<Jsonify<DashboardSettingsView>>(queryKeys.dashboard("settings"), "/api/dashboard/settings");
  return (
    <>
      <PageTitle title="Settings" template="dashboard" />
      <QueryGate query={query} embedded>
        {(data) => <SettingsView data={data} outcome={search.get("google")} />}
      </QueryGate>
    </>
  );
}
