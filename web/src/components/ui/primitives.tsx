/**
 * Server-safe design-system primitives (no hooks). Client-only components live next to this file.
 * Styling comes from app/styles/components.css; every value traces back to app/styles/tokens.css.
 */
import { AppLink } from "@web/lib/link";
import type { ReactNode } from "react";
import { IconAlert, IconAlertCircle, IconCheckCircle, IconInfo } from "@web/components/icons";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/* ---------- Button ---------- */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-solid" | "ink";
export type ButtonSize = "sm" | "md" | "lg";

function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", block?: boolean, extra?: string) {
  return cx(
    "btn",
    variant !== "secondary" && `btn--${variant}`,
    size !== "md" && `btn--${size}`,
    block && "btn--block",
    extra,
  );
}

export function Button({
  variant,
  size,
  block,
  loading,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  loading?: boolean;
}) {
  return (
    <button
      type={type}
      className={buttonClass(variant, size, block, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className="btn__spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function ButtonLink({
  href,
  variant,
  size,
  block,
  className,
  children,
  external,
  ...rest
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  external?: boolean;
}) {
  const cls = buttonClass(variant, size, block, className);
  if (external) {
    return (
      <a href={href} className={cls} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
      </a>
    );
  }
  return (
    <AppLink href={href} className={cls} {...rest}>
      {children}
    </AppLink>
  );
}

/* ---------- Field + inputs ---------- */
export function Field({
  id,
  label,
  help,
  error,
  optional,
  children,
  className,
}: {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  error?: string | null;
  optional?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("field", className)}>
      <label className="field__label" htmlFor={id}>
        {label} {optional && <span className="field__optional">(optional)</span>}
      </label>
      {children}
      {help && !error && (
        <p className="field__help" id={`${id}-help`}>
          {help}
        </p>
      )}
      {error && (
        <p className="field__error" id={`${id}-error`} role="alert">
          <IconAlertCircle size={16} />
          {error}
        </p>
      )}
    </div>
  );
}

/** aria wiring for an input inside <Field id=...>. */
export function describedBy(id: string, opts: { help?: unknown; error?: unknown }) {
  return {
    id,
    "aria-invalid": opts.error ? (true as const) : undefined,
    "aria-describedby": opts.error ? `${id}-error` : opts.help ? `${id}-help` : undefined,
  };
}

export function Input({ className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx("input", className)} {...rest} />;
}
export function Select({ className, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx("select", className)} {...rest}>
      {children}
    </select>
  );
}
export function Textarea({ className, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx("textarea", className)} {...rest} />;
}
export function Checkbox({
  label,
  className,
  disabled,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className={cx("choice", disabled && "choice--disabled", className)}>
      <input type="checkbox" disabled={disabled} {...rest} />
      <span>{label}</span>
    </label>
  );
}
export function Radio({
  label,
  className,
  disabled,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className={cx("choice", disabled && "choice--disabled", className)}>
      <input type="radio" disabled={disabled} {...rest} />
      <span>{label}</span>
    </label>
  );
}

/* ---------- Card ---------- */
export function Card({
  title,
  actions,
  footer,
  children,
  className,
  bodyClassName,
  as: Tag = "section",
  ...rest
}: {
  title?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  as?: "section" | "div" | "article";
} & Omit<React.HTMLAttributes<HTMLElement>, "title">) {
  return (
    <Tag className={cx("card", className)} {...rest}>
      {(title || actions) && (
        <header className="card__header">
          {typeof title === "string" ? <h2 className="card__title">{title}</h2> : title}
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      {children !== undefined && <div className={cx("card__body", bodyClassName)}>{children}</div>}
      {footer && <footer className="card__footer">{footer}</footer>}
    </Tag>
  );
}

export function Stat({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
      {hint && <span className="subtle">{hint}</span>}
    </div>
  );
}

/* ---------- Badge / status pill ---------- */
export type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "accent";

export function Badge({ tone = "neutral", plain, children }: { tone?: Tone; plain?: boolean; children: ReactNode }) {
  return <span className={cx("pill", tone !== "neutral" && `pill--${tone}`, plain && "pill--plain")}>{children}</span>;
}

const BOOKING_STATUS: Record<string, { label: string; tone: Tone }> = {
  REQUESTED: { label: "Awaiting approval", tone: "warning" },
  HELD: { label: "Held", tone: "neutral" },
  PENDING_PAYMENT: { label: "Awaiting payment", tone: "warning" },
  PAID: { label: "Paid, link pending", tone: "info" },
  SCHEDULED: { label: "Scheduled", tone: "success" },
  COMPLETED: { label: "Completed", tone: "neutral" },
  EXPIRED: { label: "Expired", tone: "neutral" },
  CANCELLED: { label: "Cancelled", tone: "danger" },
  FAILED: { label: "Needs attention", tone: "danger" },
};
const MESSAGE_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: "Queued", tone: "neutral" },
  SENT: { label: "Sent", tone: "info" },
  DELIVERED: { label: "Delivered", tone: "success" },
  READ: { label: "Read", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
};
const PAYMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  CREATED: { label: "Not paid", tone: "neutral" },
  CAPTURED: { label: "Paid", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
  REFUNDED: { label: "Refunded", tone: "info" },
};

/** Maps booking, message and payment statuses to a consistent label + colour. */
export function StatusPill({ kind, status }: { kind: "booking" | "message" | "payment"; status: string }) {
  const map = kind === "booking" ? BOOKING_STATUS : kind === "message" ? MESSAGE_STATUS : PAYMENT_STATUS;
  const s = map[status] ?? { label: status.toLowerCase().replace(/_/g, " "), tone: "neutral" as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/* ---------- Alert ---------- */
export function Alert({
  tone = "info",
  title,
  children,
  action,
  role,
}: {
  tone?: "info" | "success" | "warning" | "danger";
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  role?: "alert" | "status";
}) {
  const Icon = tone === "success" ? IconCheckCircle : tone === "info" ? IconInfo : tone === "warning" ? IconAlert : IconAlertCircle;
  return (
    <div className={cx("alert", `alert--${tone}`)} role={role ?? (tone === "danger" ? "alert" : "status")}>
      <Icon size={18} />
      <div style={{ flex: 1 }}>
        {title && <p className="alert__title">{title}</p>}
        {children && <div>{children}</div>}
      </div>
      {action}
    </div>
  );
}

/* ---------- Empty state / skeleton ---------- */
export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon && <div className="empty__icon">{icon}</div>}
      <h3 className="empty__title">{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ width = "100%", height = 16, style }: { width?: number | string; height?: number | string; style?: React.CSSProperties }) {
  return <span className="skeleton" style={{ width, height, ...style }} aria-hidden="true" />;
}

/* ---------- Avatar ---------- */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

export function Avatar({ name, src, size }: { name: string; src?: string | null; size?: "sm" | "md" | "lg" }) {
  return (
    <span className={cx("avatar", size && size !== "md" && `avatar--${size}`)} aria-hidden={src ? undefined : true}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- arbitrary influencer-hosted URL; next/image would need every host allow-listed
        <img src={src} alt={name} loading="lazy" referrerPolicy="no-referrer" />
      ) : (
        initials(name)
      )}
    </span>
  );
}

/* ---------- Stepper / breadcrumb / pagination ---------- */
export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="stepper" aria-label="Progress">
      {steps.map((s, i) => {
        const state = i < current ? "done" : i === current ? "current" : "todo";
        return (
          <li key={s} className="stepper__item" data-state={state} aria-current={state === "current" ? "step" : undefined}>
            <span className="stepper__dot">{state === "done" ? "✓" : i + 1}</span>
            <span className="stepper__label">{s}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function Breadcrumb({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="breadcrumb">
        {items.map((it, i) => (
          <li key={`${it.label}-${i}`}>
            {it.href && i < items.length - 1 ? <AppLink href={it.href}>{it.label}</AppLink> : <span aria-current="page">{it.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function Pagination({
  page,
  pageCount,
  hrefFor,
}: {
  page: number;
  pageCount: number;
  hrefFor: (page: number) => string;
}) {
  if (pageCount <= 1) return null;
  return (
    <nav className="pagination" aria-label="Pagination">
      <span>
        Page {page} of {pageCount}
      </span>
      <div className="row">
        {page > 1 ? <ButtonLink href={hrefFor(page - 1)} size="sm">Previous</ButtonLink> : <Button size="sm" disabled>Previous</Button>}
        {page < pageCount ? <ButtonLink href={hrefFor(page + 1)} size="sm">Next</ButtonLink> : <Button size="sm" disabled>Next</Button>}
      </div>
    </nav>
  );
}

/* ---------- Tooltip (CSS only; content also exposed to assistive tech) ---------- */
export function Tooltip({ content, children }: { content: string; children: ReactNode }) {
  return (
    <span className="tooltip">
      {children}
      <span className="tooltip__bubble" role="tooltip">
        {content}
      </span>
    </span>
  );
}

/* ---------- Link tabs (route-based) ---------- */
export function LinkTabs({ items }: { items: { label: string; href: string; current: boolean; count?: number }[] }) {
  return (
    <nav className="tabs" aria-label="Filter">
      {items.map((t) => (
        <AppLink key={t.href} href={t.href} className="tab" aria-current={t.current ? "page" : undefined}>
          {t.label}
          {t.count !== undefined && <span className="tab__count">{t.count}</span>}
        </AppLink>
      ))}
    </nav>
  );
}
