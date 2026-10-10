import { SecurityView } from "@/components/views/admin/SecurityView";
import type { AdminSecurityView } from "@/lib/views/admin-security";
import { useApiQuery } from "../../lib/api";
import { PageTitle } from "../../lib/head";
import type { Jsonify } from "../../lib/jsonify";
import { queryKeys } from "../../lib/query";
import { QueryGate } from "../../lib/states";

/**
 * `/admin/security`: GET /api/admin/security, the one console read open to an administrator who still has to enrol two-factor
 * (the guard sends them here). Enrolling, regenerating recovery codes and turning 2FA off call `router.refresh()`, which
 * refetches this, the admin session (the gate) and the sidebar.
 */
export function Component() {
  const query = useApiQuery<Jsonify<AdminSecurityView>>(queryKeys.admin("security"), "/api/admin/security");
  return (
    <>
      <PageTitle title="Security" template="admin" />
      <QueryGate query={query} embedded>
        {(data) => <SecurityView data={data} />}
      </QueryGate>
    </>
  );
}
