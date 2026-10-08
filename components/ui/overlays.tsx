"use client";

/**
 * Client overlays built on the native <dialog> element (focus trapping, Escape to close and inert background come
 * from the browser), plus dropdown menu, toast and switch.
 */
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { IconCheckCircle, IconAlertCircle, IconX } from "@/components/icons";
import { Button, cx } from "./primitives";

/* ---------- Dialog ---------- */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e: React.MouseEvent<HTMLDialogElement>) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <>
          <div className="dialog__header">
            <h2 className="dialog__title" id={titleId}>
              {title}
            </h2>
            {description && <p className="muted text-sm" style={{ marginTop: 6 }}>{description}</p>}
          </div>
          {children && <div className="dialog__body">{children}</div>}
          {footer && <div className="dialog__footer">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

/** Confirmation for destructive actions. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Keep it",
  danger,
  busy,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  children?: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? "danger-solid" : "primary"} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

/* ---------- Drawer ---------- */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="drawer"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e: React.MouseEvent<HTMLDialogElement>) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <>
          <header className="drawer__header">
            <div>
              <h2 id={titleId} className="section-title">
                {title}
              </h2>
              {subtitle && <p className="subtle" style={{ marginTop: 4 }}>{subtitle}</p>}
            </div>
            <Button variant="ghost" className="btn--icon" onClick={onClose} aria-label="Close">
              <IconX />
            </Button>
          </header>
          <div className="drawer__body">{children}</div>
          {footer && <footer className="drawer__footer">{footer}</footer>}
        </>
      )}
    </dialog>
  );
}

/* ---------- Dropdown menu ---------- */
export function Menu({
  label,
  trigger,
  items,
}: {
  label: string;
  trigger: ReactNode;
  items: ({ label: string; onSelect?: () => void; href?: string; danger?: boolean; icon?: ReactNode } | "separator")[];
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="menu" ref={rootRef}>
      <Button
        variant="ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
      </Button>
      {open && (
        <ul className="menu__list" role="menu" id={menuId}>
          {items.map((it, i) =>
            it === "separator" ? (
              <li key={`sep-${i}`} className="menu__sep" role="separator" />
            ) : (
              <li key={it.label} role="none">
                {it.href ? (
                  <a role="menuitem" className={cx("menu__item", it.danger && "menu__item--danger")} href={it.href}>
                    {it.icon}
                    {it.label}
                  </a>
                ) : (
                  <button
                    role="menuitem"
                    type="button"
                    className={cx("menu__item", it.danger && "menu__item--danger")}
                    onClick={() => {
                      setOpen(false);
                      it.onSelect?.();
                    }}
                  >
                    {it.icon}
                    {it.label}
                  </button>
                )}
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

/* ---------- Toast ---------- */
interface ToastItem {
  id: number;
  message: string;
  tone: "success" | "error";
}
const ToastContext = createContext<(message: string, tone?: "success" | "error") => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((message: string, tone: "success" | "error" = "success") => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs, { id, message, tone }]);
    setTimeout(() => setItems((xs) => xs.filter((t) => t.id !== id)), tone === "error" ? 8000 : 4500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div key={t.id} className={cx("toast", t.tone === "error" && "toast--error")} role={t.tone === "error" ? "alert" : "status"}>
            {t.tone === "error" ? <IconAlertCircle size={18} /> : <IconCheckCircle size={18} />}
            <span>{t.message}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))}>
              <IconX size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext<(message: string, tone?: "success" | "error") => void>(ToastContext);
}

/* ---------- Switch ---------- */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  id?: string;
}) {
  const auto = useId();
  const labelId = `${id ?? auto}-label`;
  return (
    <span className="switch">
      <button
        id={id}
        type="button"
        role="switch"
        className="switch__track"
        aria-checked={checked}
        aria-labelledby={labelId}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      />
      <span id={labelId} onClick={() => !disabled && onChange(!checked)}>
        {label}
      </span>
    </span>
  );
}

/* ---------- Tabs (in-page) ---------- */
export function Tabs({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: { value: string; label: string; count?: number }[];
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          className="tab"
          aria-selected={t.value === value}
          tabIndex={t.value === value ? 0 : -1}
          onClick={() => onChange(t.value)}
          onKeyDown={(e: React.KeyboardEvent<HTMLButtonElement>) => {
            const i = tabs.findIndex((x) => x.value === value);
            if (e.key === "ArrowRight") onChange(tabs[(i + 1) % tabs.length].value);
            if (e.key === "ArrowLeft") onChange(tabs[(i - 1 + tabs.length) % tabs.length].value);
          }}
        >
          {t.label}
          {t.count !== undefined && <span className="tab__count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/* ---------- Copy button ---------- */
export function CopyField({ value, label = "Copy link" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy">
      <code title={value}>{value}</code>
      <Button
        size="sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            /* clipboard blocked: the value is still selectable */
          }
        }}
      >
        {copied ? "Copied" : label}
      </Button>
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </div>
  );
}
