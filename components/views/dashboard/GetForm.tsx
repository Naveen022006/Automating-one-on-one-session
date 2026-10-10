"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, type FormEvent, type FormHTMLAttributes } from "react";

/** `action?field=value&...` for a submitted form. Only text values count (a file field has none). */
export function getFormUrl(action: string, entries: Iterable<[string, unknown]>): string {
  const params = new URLSearchParams();
  for (const [name, value] of entries) if (typeof value === "string") params.append(name, value);
  return `${action}?${params}`;
}

/** Sets each named field of `form` to its entry in `values` when it differs; a field that already shows it (typed text) is left alone. */
export function setFieldValues(form: { elements: { namedItem(name: string): unknown } }, values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) {
    const field = form.elements.namedItem(name) as { value?: unknown } | null;
    if (field && typeof field.value === "string" && field.value !== value) field.value = value;
  }
}

/**
 * A filter form (search box, date range). Without JavaScript it is a plain GET form: the browser loads `action?field=value`.
 * Once the page is interactive it navigates to that same URL through the router instead, so the SPA changes page without a
 * full reload and the old Next page does a soft navigation. Submitting the URL you are already on looks again.
 *
 * The fields are uncontrolled (`defaultValue`). `values` is what the page was actually loaded for (the server trims a search
 * and fills in default dates); when it changes after the first render, for example on browser Back, the fields are set to it,
 * so the boxes never show a different filter than the list under them.
 *
 * A full page load was announced by screen readers; this soft navigation is not, so each view that uses the form also renders a
 * visually hidden `role="status"` line describing the new result (see CustomersView, EarningsView).
 */
export function GetForm({
  action,
  values,
  ...rest
}: Omit<FormHTMLAttributes<HTMLFormElement>, "action" | "method" | "onSubmit"> & { action: string; values: Record<string, string> }) {
  const router = useRouter();
  const ref = useRef<HTMLFormElement>(null);
  const shown = JSON.stringify(values);

  useEffect(() => {
    if (ref.current) setFieldValues(ref.current, JSON.parse(shown) as Record<string, string>);
  }, [shown]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = getFormUrl(action, new FormData(event.currentTarget));
    if (target === window.location.pathname + window.location.search) router.refresh();
    else router.push(target);
  }

  return <form ref={ref} action={action} method="get" onSubmit={submit} {...rest} />;
}
