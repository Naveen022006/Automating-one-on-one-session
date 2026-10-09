"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import {
  IconCalendar,
  IconCard,
  IconLayout,
  IconLogOut,
  IconSettings,
  IconShield,
  IconUsers,
  IconWallet,
} from "@/components/icons";
import { Wordmark } from "@/components/site/SiteChrome";
import { Menu, ToastProvider } from "@/components/ui/overlays";
import { Badge } from "@/components/ui/primitives";

const NAV = [
  { href: "/admin", label: "Overview", icon: IconLayout, exact: true },
  { href: "/admin/influencers", label: "Influencers", icon: IconUsers },
  { href: "/admin/payments", label: "Payments", icon: IconCard },
  { href: "/admin/payouts", label: "Payouts", icon: IconWallet },
  { href: "/admin/bookings", label: "Bookings", icon: IconCalendar },
  { href: "/admin/audit", label: "Audit log", icon: IconShield },
  { href: "/admin/settings", label: "Settings", icon: IconSettings },
];

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
  children,
}: {
  admin: { name: string; email: string };
  attentionCount: number;
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
              <Link key={n.href} href={n.href} className="nav-link" aria-current={isActive(pathname, n.href, n.exact) ? "page" : undefined}>
                <n.icon />
                {n.label}
                {n.href === "/admin/payments" && attentionCount > 0 && (
                  <span className="nav-link__badge" aria-label={`${attentionCount} payments need attention`}>
                    {attentionCount}
                  </span>
                )}
              </Link>
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
        <nav className="mobile-nav" aria-label="Sections">
          {NAV.filter((n) => ["/admin", "/admin/influencers", "/admin/payments", "/admin/payouts", "/admin/settings"].includes(n.href)).map((n) => (
            <Link key={n.href} href={n.href} aria-current={isActive(pathname, n.href, n.exact) ? "page" : undefined}>
              <n.icon size={20} />
              {n.label}
            </Link>
          ))}
        </nav>
      </div>
    </ToastProvider>
  );
}
