"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import {
  IconCalendar,
  IconClock,
  IconExternal,
  IconLayout,
  IconLogOut,
  IconMessage,
  IconSettings,
  IconSparkline,
  IconWallet,
  IconUser,
  IconUsers,
  IconVideo,
} from "@/components/icons";
import { Wordmark } from "@/components/site/SiteChrome";
import { Menu, ToastProvider } from "@/components/ui/overlays";
import { Avatar } from "@/components/ui/primitives";
import { ApiProvider } from "./ApiProvider";

const NAV = [
  { href: "/dashboard", label: "Overview", icon: IconLayout, exact: true },
  { href: "/dashboard/sessions", label: "Sessions", icon: IconCalendar },
  { href: "/dashboard/services", label: "Services", icon: IconVideo },
  { href: "/dashboard/availability", label: "Availability", icon: IconClock },
  { href: "/dashboard/customers", label: "Customers", icon: IconUsers },
  { href: "/dashboard/earnings", label: "Earnings", icon: IconSparkline },
  { href: "/dashboard/payouts", label: "Payouts", icon: IconWallet },
  { href: "/dashboard/messages", label: "Messages", icon: IconMessage },
  { href: "/dashboard/settings", label: "Settings", icon: IconSettings },
];
const MOBILE = ["/dashboard", "/dashboard/sessions", "/dashboard/services", "/dashboard/availability", "/dashboard/settings"];

function isActive(pathname: string, href: string, exact?: boolean) {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

async function logout() {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  window.location.assign("/login");
}

export function AppShell({
  user,
  attentionCount,
  children,
}: {
  user: { name: string; email: string; slug: string; photoUrl: string | null };
  attentionCount: number;
  children: ReactNode;
}) {
  const pathname = usePathname();
  return (
    <ToastProvider>
      <ApiProvider>
        <div className="shell">
          <aside className="sidebar" aria-label="Dashboard">
            <Wordmark href="/dashboard" />
            <nav className="sidebar__nav" aria-label="Sections">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href} className="nav-link" aria-current={isActive(pathname, n.href, n.exact) ? "page" : undefined}>
                  <n.icon />
                  {n.label}
                  {n.href === "/dashboard" && attentionCount > 0 && (
                    <span className="nav-link__badge" aria-label={`${attentionCount} items need attention`}>
                      {attentionCount}
                    </span>
                  )}
                </Link>
              ))}
            </nav>
            <div className="sidebar__foot">
              <a className="nav-link" href={`/${user.slug}`} target="_blank" rel="noopener noreferrer">
                <IconExternal />
                View booking page
              </a>
            </div>
          </aside>
          <div>
            <header className="topbar">
              <span className="sr-only">Signed in as {user.email}</span>
              <div className="topbar__actions">
                <Menu
                  label="Account menu"
                  trigger={
                    <span className="row row--nowrap" style={{ gap: 8 }}>
                      <Avatar name={user.name} src={user.photoUrl} size="sm" />
                      <span className="truncate text-sm" style={{ maxWidth: 160 }}>
                        {user.name}
                      </span>
                    </span>
                  }
                  items={[
                    { label: "Settings", href: "/dashboard/settings", icon: <IconUser size={16} /> },
                    { label: "View booking page", href: `/${user.slug}`, icon: <IconExternal size={16} /> },
                    "separator",
                    { label: "Log out", onSelect: logout, icon: <IconLogOut size={16} /> },
                  ]}
                />
              </div>
            </header>
            <main id="main" className="app-main">
              {children}
            </main>
          </div>
          <nav className="mobile-nav" aria-label="Sections">
            {NAV.filter((n) => MOBILE.includes(n.href)).map((n) => (
              <Link key={n.href} href={n.href} aria-current={isActive(pathname, n.href, n.exact) ? "page" : undefined}>
                <n.icon size={20} />
                {n.label}
              </Link>
            ))}
          </nav>
        </div>
      </ApiProvider>
    </ToastProvider>
  );
}

export function PageHead({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}
