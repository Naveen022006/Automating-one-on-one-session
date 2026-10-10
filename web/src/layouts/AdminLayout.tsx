import { Outlet } from "react-router";
import { AdminShell } from "@/components/admin/AdminShell";
import { PageError, PageLoading } from "../lib/states";
import { useAdminShell } from "../lib/session";

/**
 * The admin console frame (sidebar with badges, account menu; `main#main` is rendered by AdminShell). Mounted by
 * RequireAdmin once the admin session said the gate is open; the shell data is fetched here and is gated again on the
 * server (GET /api/admin/shell, which a stale or password-only session cannot read). A 401/403 is handled globally
 * (lib/api.ts); any other failure shows the usual page error. Renders NO <PageTitle>: a title belongs to the page, see
 * lib/head.tsx.
 */
export function AdminLayout() {
  const shell = useAdminShell();
  if (!shell.data) {
    return shell.isError ? <PageError error={shell.error} onRetry={() => void shell.refetch()} /> : <PageLoading />;
  }
  const { admin, attentionCount, healthCount } = shell.data;
  return (
    <AdminShell admin={admin} attentionCount={attentionCount} healthCount={healthCount}>
      <Outlet />
    </AdminShell>
  );
}
