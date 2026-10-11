import { Outlet } from "react-router";
import { AppShell } from "@web/components/app/AppShell";
import { useDashboardShell } from "../lib/session";

/**
 * The dashboard frame (sidebar, account menu, mobile nav; `main#main` is rendered by AppShell). Only mounted by
 * RequireInfluencer once the shell query has data, so `data` is always present here; the null check is for the types.
 * It deliberately renders NO <PageTitle>: a title belongs to the page, see lib/head.tsx.
 */
export function DashboardLayout() {
  const { data } = useDashboardShell();
  if (!data) return null;
  const { user, attentionCount } = data;
  return (
    <AppShell user={{ name: user.name, email: user.email, slug: user.slug, photoUrl: user.photoUrl }} attentionCount={attentionCount}>
      <Outlet />
    </AppShell>
  );
}
