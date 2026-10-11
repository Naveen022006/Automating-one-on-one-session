import { AppLink } from "@web/lib/link";
import { usePathname } from "@web/lib/navigate";
import type { ReactNode } from "react";
import {
  IconCalendar,
  IconCard,
  IconLayout,
  IconLock,
  IconLogOut,
  IconSettings,
  IconShield,
  IconSparkline,
  IconUsers,
  IconWallet,
} from "@web/components/icons";
import { Wordmark } from "@web/components/site/SiteChrome";
import { MobileNav } from "@web/components/ui/MobileNav";
import { Menu, ToastProvider } from "@web/components/ui/overlays";
import { Badge } from "@web/components/ui/primitives";

const NAV = [
  { href: "/admin", label: "Overview", icon: IconLayout, exact: true },
  { href: "/admin/influencers", label: "Influencers", icon: IconUsers },
  { href: "/admin/payments", label: "Payments", icon: IconCard },
  { href: "/admin/payouts", label: "Payouts", icon: IconWallet },
  { href: "/admin/bookings", label: "Bookings", icon: IconCalendar },
  { href: "/admin/health", label: "System health", icon: IconSparkline },
  { href: "/admin/audit", label: "Audit log", icon: IconShield },
  { href: "/admin/security", label: "Security", icon: IconLock },
  { href: "/admin/settings", label: "Settings", icon: IconSettings },
];

// The bottom bar of a phone has four slots plus "More", which holds the other sections (web/src/components/ui/MobileNav.tsx).
const MOBILE_PRIMARY = ["/admin", "/admin/influencers", "/admin/payments", "/admin/payouts"];

function isActive(pathname: string, href: string, exact?: boolean) {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

async function signOut() {
  await fetch("/api/admin/auth/logout", { method: "POST" }).catch(() => {});
  window.location.assign("/admin/login");
}

export function AdminShell({
  admin,
  attentionCount,
  healthCount = 0,
  children,
}: {
  admin: { name: string; email: string };
  attentionCount: number;
  /** Unhealthy conditions on the System health page. */
  healthCount?: number;
  children: ReactNode;
}) {
  const pathname = usePathname();
  return (
    <ToastProvider>
      <div className="shell">
        <aside className="sidebar" aria-label="Admin">
          <Wordmark href="/admin" />
          <p className="subtle" style={{ margin: "0 12px" }}>
            <Badge tone="accent">Admin console</Badge>
          </p>
          <nav className="sidebar__nav" aria-label="Sections">
            {NAV.map((n) => (
              <AppLink key={n.href} href={n.href} className="nav-link" aria-current={isActive(pathname, n.href, n.exact) ? "page" : undefined}>
                <n.icon />
                {n.label}
                {n.href === "/admin/payments" && attentionCount > 0 && (
                  <span className="nav-link__badge" aria-label={`${attentionCount} payments need attention`}>
                    {attentionCount}
                  </span>
                )}
                {n.href === "/admin/health" && healthCount > 0 && (
                  <span className="nav-link__badge" aria-label={`${healthCount} system health issues`}>
                    {healthCount}
                  </span>
                )}
              </AppLink>
            ))}
          </nav>
        </aside>
        <div>
          <header className="topbar">
            <span className="sr-only">Signed in as {admin.email}</span>
            <div className="topbar__actions">
              <Menu
                label="Account menu"
                trigger={
                  <span className="row row--nowrap" style={{ gap: 8 }}>
                    <span className="truncate text-sm" style={{ maxWidth: 200 }}>
                      {admin.name}
                    </span>
                  </span>
                }
                items={[
                  { label: "Security", href: "/admin/security", icon: <IconLock size={16} /> },
                  { label: "Settings", href: "/admin/settings", icon: <IconSettings size={16} /> },
                  "separator",
                  { label: "Sign out", onSelect: signOut, icon: <IconLogOut size={16} /> },
                ]}
              />
            </div>
          </header>
          <main id="main" className="app-main">
            {children}
          </main>
        </div>
        <MobileNav pathname={pathname} primary={NAV.filter((n) => MOBILE_PRIMARY.includes(n.href))} more={NAV.filter((n) => !MOBILE_PRIMARY.includes(n.href))} />
      </div>
    </ToastProvider>
  );
}
