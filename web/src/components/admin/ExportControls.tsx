import { useState } from "react";
import { useToast } from "@web/components/ui/overlays";
import { ButtonLink, Field, Input } from "@web/components/ui/primitives";
import { istMonthStart, istToday } from "@/lib/india";

export type ExportKind = "payments" | "bookings" | "payouts" | "audit";

const DAY_MS = 86_400_000;
const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T00:00:00.000Z`).getTime());

/** The URL of an export (the server checks every part again). */
export function exportUrl(kind: ExportKind, from: string, to: string): string {
  return `/api/admin/exports/${kind}?${new URLSearchParams({ from, to })}`;
}

/** What is wrong with the chosen days, or null. Mirrors the server's rules (a real day, start not after end, at most 366 days). */
export function exportRangeProblem(from: string, to: string): string | null {
  if (!isDay(from) || !isDay(to)) return "Choose a start and an end date.";
  const days = (new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime()) / DAY_MS + 1;
  if (days < 1) return "The start date is after the end date.";
  if (days > 366) return "Choose a range of at most 366 days.";
  return null;
}

/**
 * "Download CSV" for one kind of admin export, over a date range (the rows CREATED in it; this month by default). It is a plain download link
 * (/api/... is never an SPA route), so it works without JavaScript. With JavaScript the click fetches the file instead, so a refusal
 * ("More than 20,000 rows. Choose a shorter range.") shows as a message and not as a failed download or a JSON page.
 */
export function ExportControls({ kind, label = "Download CSV" }: { kind: ExportKind; label?: string }) {
  const toast = useToast();
  const [from, setFrom] = useState(() => istMonthStart(new Date()));
  const [to, setTo] = useState(() => istToday());
  const [busy, setBusy] = useState(false);
  const problem = exportRangeProblem(from, to);
  const href = exportUrl(kind, from, to);

  async function download(e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault();
    if (problem) return toast(problem, "error");
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(href, { credentials: "same-origin" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        return toast(data.error ?? "Could not create the file.", "error");
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `${kind}-${from}-to-${to}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      toast("Could not create the file. Check your connection and try again.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="row" style={{ alignItems: "flex-end" }} data-export={kind}>
      <Field id={`export-${kind}-from`} label="From">
        <Input id={`export-${kind}-from`} type="date" value={from} max={to || undefined} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFrom(e.target.value)} />
      </Field>
      <Field id={`export-${kind}-to`} label="To">
        <Input id={`export-${kind}-to`} type="date" value={to} min={from || undefined} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTo(e.target.value)} />
      </Field>
      <ButtonLink href={href} download="" onClick={download} aria-disabled={problem || busy ? true : undefined}>
        {busy ? "Preparing…" : label}
      </ButtonLink>
    </div>
  );
}
