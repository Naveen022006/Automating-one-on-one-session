import { SettingsView } from "@/components/views/admin/SettingsView";
import { PageLoading, QueryGate } from "../../lib/states";
import { PageTitle } from "../../lib/head";
import { useAdminSession } from "../../lib/session";

/** `/admin/settings`: needs nothing but the administrator's own email, which the admin session (already cached by the guard) has. */
export function Component() {
  const session = useAdminSession();
  return (
    <>
      <PageTitle title="Settings" template="admin" />
      <QueryGate query={session} embedded>
        {(s) => (s.authenticated ? <SettingsView email={s.admin.email} /> : <PageLoading />)}
      </QueryGate>
    </>
  );
}
