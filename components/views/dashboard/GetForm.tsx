"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, type FormEvent, type FormHTMLAttributes } from "react";

/**
 * A filter form (search box, date range). Without JavaScript it is a plain GET form: the browser loads `action?field=value`.
 * Once the page is interactive it navigates to that same URL through the router instead, so the SPA changes page without a
 * full reload and the old Next page does a soft navigation. Submitting the URL you are already on looks again.
 *
 * The fields are uncontrolled (`defaultValue`). `values` is what the page was actually loaded for (the server trims a search
 * and fills in default dates); when it changes after the first render, for example on browser Back, the fields are set to it,
 * so the boxes never show a different filter than the list under them.
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
    const form = ref.current;
    if (!form) return;
    for (const [name, value] of Object.entries(JSON.parse(shown) as Record<string, string>)) {
      const field = form.elements.namedItem(name);
      if (field instanceof HTMLInputElement && field.value !== value) field.value = value;
    }
  }, [shown]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params = new URLSearchParams();
    for (const [name, value] of new FormData(event.currentTarget)) if (typeof value === "string") params.append(name, value);
    const target = `${action}?${params}`;
    if (target === window.location.pathname + window.location.search) router.refresh();
    else router.push(target);
  }

  return <form ref={ref} action={action} method="get" onSubmit={submit} {...rest} />;
}
