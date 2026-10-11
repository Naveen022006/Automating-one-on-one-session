"use client";

/**
 * The bottom navigation bar of the dashboard and the admin console on a phone (<= 900 px, see layouts.css). The sidebar is
 * hidden there, and a bar of five fixed slots cannot hold nine sections, so the first four sections get a slot each and
 * the rest sit behind a fifth "More" button that opens a small list above the bar. Every section stays reachable (before
 * this, Customers, Earnings, Payouts and Messages could not be opened on a phone at all, and neither could Bookings, System
 * health and Audit log in the console).
 *
 * The list closes when a link is chosen, when the route changes, on Escape (focus returns to the button) and on a press
 * outside it. The "More" button is marked current while one of its sections is open.
 */
import Link from "next/link";
import { useEffect, useId, useRef, useState, type ComponentType } from "react";
import { IconMore } from "@/components/icons";

export interface MobileNavItem {
  href: string;
  label: string;
  icon: ComponentType<{ size?: number }>;
  exact?: boolean;
}

export function isNavActive(pathname: string, item: Pick<MobileNavItem, "href" | "exact">): boolean {
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function MobileNav({ pathname, primary, more }: { pathname: string; primary: MobileNavItem[]; more: MobileNavItem[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listId = useId();
  const moreActive = more.some((n) => isNavActive(pathname, n));

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onPress = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPress);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPress);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <nav className="mobile-nav" aria-label="Sections" ref={rootRef}>
      {primary.map((n) => (
        <Link key={n.href} href={n.href} aria-current={isNavActive(pathname, n) ? "page" : undefined}>
          <n.icon size={20} />
          {n.label}
        </Link>
      ))}
      {more.length > 0 && (
        <button
          ref={buttonRef}
          type="button"
          className="mobile-nav__more"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-current={moreActive ? "page" : undefined}
          onClick={() => setOpen((o) => !o)}
        >
          <IconMore size={20} />
          More
        </button>
      )}
      {open && (
        <ul className="mobile-more" id={listId}>
          {more.map((n) => (
            <li key={n.href}>
              <Link href={n.href} aria-current={isNavActive(pathname, n) ? "page" : undefined} onClick={() => setOpen(false)}>
                <n.icon size={18} />
                {n.label}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
